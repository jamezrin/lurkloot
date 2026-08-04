import { browser } from "wxt/browser";
import type { ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import type { LegacyEventLogEntry, StoredLegacyEvent } from "@lurkloot/shared/events";
import type { TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import { DEFAULT_STATE, mergeSchedulerState } from "@lurkloot/core/defaults";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";
import { migrateSettings, withSchemaVersion } from "@lurkloot/shared/settingsSchema";
import { clearActivityEvents, importLegacyActivityEvents } from "./activityStorage";

export { DEFAULT_STATE };

const SETTINGS_KEY = "settings";
const STATE_KEY = "schedulerState";
// Captured Client-Integrity bundle, kept separate from scheduler state because
// it is transient device/session-scoped auth rather than farming progress.
const TWITCH_INTEGRITY_KEY = "twitchIntegrity";
type LegacyStoredSchedulerState = Partial<SchedulerState> & { events?: LegacyEventLogEntry[] };
let settingsStorageMutation: Promise<void> = Promise.resolve();
let stateStorageMutation: Promise<void> = Promise.resolve();

function withSettingsStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = settingsStorageMutation.then(operation, operation);
  settingsStorageMutation = run.then(() => undefined, () => undefined);
  return run;
}

function withStateStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = stateStorageMutation.then(operation, operation);
  stateStorageMutation = run.then(() => undefined, () => undefined);
  return run;
}

// Reads, migrates, normalizes and — only when the stored document was not
// already at the current schema version — persists the canonical envelope, all
// under the settings lock so a migration write can never overwrite a newer
// concurrent save. A future schema version throws without writing rather than
// replacing data this build does not understand.
export async function loadSettings(): Promise<ExtensionSettings> {
  return withSettingsStorageLock(async () => {
    const data = await browser.storage.local.get(SETTINGS_KEY);
    const migration = migrateSettings(data[SETTINGS_KEY]);
    // migration.diagnostics is deliberately unused: browser storage upgrades
    // itself, so there is nothing for a user to act on. The CLI surfaces its
    // diagnostics as startup warnings because its config file is never rewritten.
    const settings = mergeSettings(migration.settings as Partial<ExtensionSettings>);
    if (migration.changed) {
      try {
        // Persists the normalized settings, not the migrated raw payload, so a
        // property mergeSettings does not recognize is dropped here. That is
        // not new: saveSettings has always written the normalized object
        // wholesale, so an unrecognized property would not have survived the
        // user's next settings change either.
        await browser.storage.local.set({ [SETTINGS_KEY]: withSchemaVersion(settings) });
      } catch {
        // Startup continues on the canonical in-memory settings. The stored
        // document is untouched, so the next load retries the same migration.
      }
    }
    return settings;
  });
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await withSettingsStorageLock(async () => {
    await browser.storage.local.set({ [SETTINGS_KEY]: withSchemaVersion(settings) });
  });
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
  await withSettingsStorageLock(async () => {
    await withStateStorageLock(async () => {
      await browser.storage.local.clear();
      await browser.storage.local.set({
        [SETTINGS_KEY]: withSchemaVersion(DEFAULT_SETTINGS),
        [STATE_KEY]: DEFAULT_STATE,
      });
    });
  });
  await clearActivityEvents();
}

interface PersistedTwitchDiscoveryState {
  restore(snapshot: unknown): void;
  snapshot(): SchedulerState["twitchDiscovery"];
  clear(): void;
}

// Binds the browser-free Twitch cache lifecycle to the extension's existing
// scheduler-state document. Hydration happens once per MV3 worker evaluation;
// later state reads cannot restore an older snapshot over fresher in-memory
// details, while every state save carries the latest bounded snapshot.
export function createTwitchDiscoveryStateStorage(discoveryState: PersistedTwitchDiscoveryState) {
  let hydrated = false;
  let hydration: Promise<SchedulerState> | undefined;
  const ensureHydrated = (): Promise<SchedulerState> => {
    hydration ??= loadState().then((state) => {
      discoveryState.restore(state.twitchDiscovery);
      hydrated = true;
      return state;
    });
    return hydration;
  };

  return {
    async loadState(): Promise<SchedulerState> {
      if (!hydrated) return ensureHydrated();
      return loadState();
    },
    async saveState(state: SchedulerState): Promise<void> {
      await ensureHydrated();
      const snapshot = discoveryState.snapshot();
      const nextState = { ...state, twitchDiscovery: snapshot };
      if (!snapshot) delete nextState.twitchDiscovery;
      await saveState(nextState);
    },
    async resetStorage(): Promise<void> {
      await ensureHydrated();
      discoveryState.clear();
      await resetStorage();
    },
  };
}
