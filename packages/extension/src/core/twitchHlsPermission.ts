import { resolveCompatibility } from "@lurkloot/core";
import { TWITCH_HLS_HEARTBEAT_ID } from "@lurkloot/core/twitch/heartbeat";
import type { ExtensionSettings, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";

// Twitch's video CDN. Playlist and segment hosts are nested ttvnw.net names,
// outside the required twitch.tv grant. Optional: requested when Twitch is
// turned on and the resolved watch heartbeat is the HLS variant.
export const TWITCH_HLS_HOST_ORIGIN = "https://*.ttvnw.net/*";

/** Twitch is on, the resolved watch heartbeat is HLS, and the video CDN grant is absent. */
export function shouldSuspendTwitchForMissingHlsHost(settings: ExtensionSettings, hasVideoCdnAccess: boolean): boolean {
  if (hasVideoCdnAccess || !settings.platform.twitch.enabled) return false;
  return resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }).compatibility.twitch.heartbeat === TWITCH_HLS_HEARTBEAT_ID;
}

/** Turn Twitch off when an extension restart would farm HLS without the video CDN grant.
 * The next manual enable is the gesture that asks for the permission. */
export async function suspendTwitchUntilHlsHostGranted(deps: {
  loadSettings(): Promise<ExtensionSettings>;
  hasVideoCdnAccess(): Promise<boolean>;
  disableTwitch(): Promise<void>;
}): Promise<void> {
  const settings = await deps.loadSettings();
  if (!shouldSuspendTwitchForMissingHlsHost(settings, false)) return;
  if (await deps.hasVideoCdnAccess()) return;
  await deps.disableTwitch();
}

// The Chrome permission prompt closes the action popup before the click's
// continuation can enable Twitch. The popup records this intent without
// awaiting, then asks. Background completion applies it after the allow.
export const TWITCH_HLS_GRANT_INTENT_KEY = "twitchHlsGrantIntent";
const GRANT_INTENT_TTL_MS = 2 * 60_000;

export type TwitchHlsGrantIntent =
  | { type: "setAutomation"; platform: "twitch"; enabled: true }
  | { type: "saveSettings"; settingsPatch: SettingsPatch; tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] };

interface GrantIntentStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

function isPlatform(value: unknown): value is Platform {
  return value === "twitch" || value === "kick";
}

export function twitchHlsGrantIntent(value: unknown): TwitchHlsGrantIntent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pending = (value as { pending?: unknown }).pending;
  if (!pending || typeof pending !== "object") return undefined;
  const message = pending as { type?: unknown; platform?: unknown; enabled?: unknown; settingsPatch?: unknown; tickAfterSave?: unknown; tickAfterSavePlatforms?: unknown };
  switch (message.type) {
    case "setAutomation":
      if (message.platform !== "twitch" || message.enabled !== true) return undefined;
      return { type: "setAutomation", platform: "twitch", enabled: true };
    case "saveSettings":
      if (!message.settingsPatch || typeof message.settingsPatch !== "object" || Array.isArray(message.settingsPatch)) return undefined;
      return {
        type: "saveSettings",
        settingsPatch: message.settingsPatch as SettingsPatch,
        ...(message.tickAfterSave === true ? { tickAfterSave: true } : {}),
        ...(Array.isArray(message.tickAfterSavePlatforms)
          ? { tickAfterSavePlatforms: message.tickAfterSavePlatforms.filter(isPlatform) }
          : {}),
      };
    default:
      return undefined;
  }
}

export async function requestTwitchHlsGrant(options: {
  storage: GrantIntentStorage;
  request(details: { origins: string[] }): Promise<boolean>;
  now(): number;
}, intent: TwitchHlsGrantIntent): Promise<boolean> {
  const saved = options.storage.set({
    [TWITCH_HLS_GRANT_INTENT_KEY]: { at: options.now(), pending: intent },
  });
  // Call before any await. The popup's click is the user gesture.
  let grant: Promise<boolean>;
  try {
    grant = options.request({ origins: [TWITCH_HLS_HOST_ORIGIN] });
  } catch (error) {
    await saved.catch(() => undefined);
    await options.storage.remove(TWITCH_HLS_GRANT_INTENT_KEY);
    throw error;
  }
  try {
    const [, granted] = await Promise.all([saved, grant]);
    if (!granted) await options.storage.remove(TWITCH_HLS_GRANT_INTENT_KEY);
    return granted;
  } catch (error) {
    await options.storage.remove(TWITCH_HLS_GRANT_INTENT_KEY);
    throw error;
  }
}

export function createTwitchHlsGrantCompletion(options: {
  storage: GrantIntentStorage;
  now(): number;
  contains(details: { origins: string[] }): Promise<boolean>;
  complete(intent: TwitchHlsGrantIntent): Promise<void>;
}) {
  let generation = 0;
  let cancelledAt = -Infinity;
  let dirty = false;
  let running: Promise<void> | undefined;

  function cancel(): Promise<void> {
    generation += 1;
    cancelledAt = options.now();
    return options.storage.remove(TWITCH_HLS_GRANT_INTENT_KEY);
  }

  async function consume(): Promise<void> {
    const current = generation;
    if (!await options.contains({ origins: [TWITCH_HLS_HOST_ORIGIN] })) return;
    if (generation !== current) return;
    const stored = await options.storage.get(TWITCH_HLS_GRANT_INTENT_KEY);
    const record = stored[TWITCH_HLS_GRANT_INTENT_KEY];
    if (record === undefined) return;
    await options.storage.remove(TWITCH_HLS_GRANT_INTENT_KEY);
    const intent = twitchHlsGrantIntent(record);
    const at = record && typeof record === "object" ? (record as { at?: unknown }).at : undefined;
    if (!intent || typeof at !== "number" || !Number.isFinite(at) || at <= cancelledAt || at > options.now() || options.now() - at > GRANT_INTENT_TTL_MS) return;
    if (generation !== current) return;
    await options.complete(intent);
  }

  function schedule(): Promise<void> {
    if (running) {
      dirty = true;
      return running;
    }
    const run = (async () => {
      do {
        dirty = false;
        await consume();
      } while (dirty);
    })().finally(() => {
      running = undefined;
    });
    running = run;
    return run;
  }

  return {
    cancel,
    async added(details: { origins?: string[] }) {
      if (!details.origins?.includes(TWITCH_HLS_HOST_ORIGIN)) return;
      await schedule();
    },
    async removed(details: { origins?: string[] }) {
      if (details.origins?.includes(TWITCH_HLS_HOST_ORIGIN)) await cancel();
    },
    async changed(changes: Record<string, { newValue?: unknown }>) {
      const next = changes[TWITCH_HLS_GRANT_INTENT_KEY]?.newValue;
      if (!next || typeof next !== "object" || typeof (next as { at?: unknown }).at !== "number") return;
      await schedule();
    },
  };
}
