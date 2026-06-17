import { browser } from "wxt/browser";
import type { ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import type { TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import { DEFAULT_STATE, mergeSchedulerState } from "@lurkloot/core/defaults";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";

export { DEFAULT_STATE };

const SETTINGS_KEY = "settings";
const STATE_KEY = "schedulerState";
// Captured Client-Integrity bundle, kept separate from scheduler state because
// it is transient device/session-scoped auth rather than farming progress.
const TWITCH_INTEGRITY_KEY = "twitchIntegrity";

export async function loadSettings(): Promise<ExtensionSettings> {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  return mergeSettings(data[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadState(): Promise<SchedulerState> {
  const data = await browser.storage.local.get(STATE_KEY);
  return mergeSchedulerState(data[STATE_KEY] as Partial<SchedulerState> | undefined);
}

export async function saveState(state: SchedulerState): Promise<void> {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

export async function loadTwitchIntegrity(): Promise<TwitchIntegrity | undefined> {
  const data = await browser.storage.local.get(TWITCH_INTEGRITY_KEY);
  return data[TWITCH_INTEGRITY_KEY] as TwitchIntegrity | undefined;
}

export async function saveTwitchIntegrity(value: TwitchIntegrity): Promise<void> {
  await browser.storage.local.set({ [TWITCH_INTEGRITY_KEY]: value });
}

export async function resetStorage(): Promise<void> {
  await browser.storage.local.set({
    [SETTINGS_KEY]: DEFAULT_SETTINGS,
    [STATE_KEY]: DEFAULT_STATE,
  });
}
