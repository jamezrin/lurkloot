import { browser } from "wxt/browser";
import type { ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import type { LegacyEventLogEntry, StoredLegacyEvent } from "@lurkloot/shared/events";
import type { TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import { DEFAULT_STATE, mergeSchedulerState } from "@lurkloot/core/defaults";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";
import { clearActivityEvents, importLegacyActivityEvents } from "./activityStorage";

export { DEFAULT_STATE };

const SETTINGS_KEY = "settings";
const STATE_KEY = "schedulerState";
// Captured Client-Integrity bundle, kept separate from scheduler state because
// it is transient device/session-scoped auth rather than farming progress.
const TWITCH_INTEGRITY_KEY = "twitchIntegrity";
type LegacyStoredSchedulerState = Partial<SchedulerState> & { events?: LegacyEventLogEntry[] };
let stateStorageMutation: Promise<void> = Promise.resolve();

function withStateStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = stateStorageMutation.then(operation, operation);
  stateStorageMutation = run.then(() => undefined, () => undefined);
  return run;
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  const stored = data[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  const settings = mergeSettings(stored);
  if (hasLegacyWatchQueueSettings(stored)) {
    try {
      await browser.storage.local.set({ [SETTINGS_KEY]: settings });
    } catch {
      // Loading remains available if the one-time migration write fails. The
      // legacy aliases stay readable, so a later load can safely retry it.
    }
  }
  return settings;
}

function hasLegacyWatchQueueSettings(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(settings, "watchQueueFallbackOnly")) return true;
  if (!settings.platform || typeof settings.platform !== "object" || Array.isArray(settings.platform)) return false;
  return Object.values(settings.platform as Record<string, unknown>).some((platform) =>
    Boolean(
      platform
      && typeof platform === "object"
      && !Array.isArray(platform)
      && Object.prototype.hasOwnProperty.call(platform, "watchQueueChannels"),
    ));
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadState(): Promise<SchedulerState> {
  return withStateStorageLock(async () => {
    const data = await browser.storage.local.get(STATE_KEY);
    const stored = data[STATE_KEY] as LegacyStoredSchedulerState | undefined;
    const state = mergeSchedulerState(stored);
    const legacyEvents = stored?.events ?? [];
    // One-time migration from the former rolling array embedded in operational
    // scheduler state. A failed import is harmless and retried on the next load.
    if (legacyEvents.length > 0) {
      try {
        const normalized = legacyEvents.map((event): StoredLegacyEvent => ({
          ...event,
          category: event.category ?? "diagnostic",
          legacy: true,
        }));
        await importLegacyActivityEvents(normalized);
        const latest = await browser.storage.local.get(STATE_KEY);
        const latestStored = ((latest[STATE_KEY] as LegacyStoredSchedulerState | undefined) ?? state) as LegacyStoredSchedulerState;
        const { events: _events, ...operationalState } = latestStored;
        await browser.storage.local.set({ [STATE_KEY]: operationalState });
      } catch {
        // Activity history is best-effort; a database failure must not prevent
        // the scheduler from loading its operational state.
      }
    }
    return state;
  });
}

export async function saveState(state: SchedulerState): Promise<void> {
  await withStateStorageLock(async () => {
    const data = await browser.storage.local.get(STATE_KEY);
    const legacyEvents = (data[STATE_KEY] as LegacyStoredSchedulerState | undefined)?.events;
    await browser.storage.local.set({
      [STATE_KEY]: legacyEvents?.length ? { ...state, events: legacyEvents } : state,
    });
  });
}

export async function loadTwitchIntegrity(): Promise<TwitchIntegrity | undefined> {
  const data = await browser.storage.local.get(TWITCH_INTEGRITY_KEY);
  return data[TWITCH_INTEGRITY_KEY] as TwitchIntegrity | undefined;
}

export async function saveTwitchIntegrity(value: TwitchIntegrity): Promise<void> {
  await browser.storage.local.set({ [TWITCH_INTEGRITY_KEY]: value });
}

export async function resetStorage(): Promise<void> {
  await withStateStorageLock(async () => {
    await browser.storage.local.set({
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [STATE_KEY]: DEFAULT_STATE,
    });
  });
  try {
    await clearActivityEvents();
  } catch {
    // Resetting operational state still succeeds if activity storage is
    // unavailable or has already been removed by the browser.
  }
}
