import { resolveCompatibility } from "@lurkloot/core";
import { TWITCH_HLS_HEARTBEAT_ID } from "@lurkloot/shared/compatibility";
import type { CoreRuntimeMessage, RuntimeSnapshot, TwitchHlsGrantIntent } from "@lurkloot/shared/messages";
import type { ExtensionSettings, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";

// Twitch's video CDN. Playlist and segment hosts are nested ttvnw.net names,
// outside the required twitch.tv grant. Optional: requested when Twitch is
// turned on and the resolved watch heartbeat is the HLS variant.
export const TWITCH_HLS_HOST_ORIGIN = "https://*.ttvnw.net/*";

/** Twitch is on and its resolved watch heartbeat is HLS, which needs the video CDN. */
export function twitchWatchesWithHls(settings: ExtensionSettings): boolean {
  return settings.platform.twitch.enabled
    && resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }).compatibility.twitch.heartbeat === TWITCH_HLS_HEARTBEAT_ID;
}

/** Twitch is on, the resolved watch heartbeat is HLS, and the video CDN grant is absent. */
export function shouldSuspendTwitchForMissingHlsHost(settings: ExtensionSettings, hasVideoCdnAccess: boolean): boolean {
  return !hasVideoCdnAccess && twitchWatchesWithHls(settings);
}

/** The one place that keeps Twitch from watching with HLS without the video
 * CDN grant. The background runs it after an update, when the grant is
 * revoked, and after a settings change that could not show the prompt (an
 * import). Turns Twitch off and resolves what that returned; the next manual
 * enable is the gesture that asks for the host. */
export async function enforceTwitchHlsGrant<T>(deps: {
  loadSettings(): Promise<ExtensionSettings>;
  hasVideoCdnAccess(): Promise<boolean>;
  disableTwitch(): Promise<T>;
}): Promise<T | undefined> {
  const settings = await deps.loadSettings();
  if (!twitchWatchesWithHls(settings)) return undefined;
  if (await deps.hasVideoCdnAccess()) return undefined;
  return deps.disableTwitch();
}

/** A core message that changes what the HLS gate decides: the Twitch switch,
 * or a settings save that touches it or Twitch's compatibility selection. Such
 * a message is newer than a pending grant intent, and can itself start HLS. */
export function touchesTwitchHlsGate(message: CoreRuntimeMessage): boolean {
  switch (message.type) {
    case "setAutomation":
    case "setPlatformEnabled":
      return message.platform === "twitch";
    case "saveSettings":
      return message.settingsPatch.platform?.twitch?.enabled !== undefined
        || message.settingsPatch.compatibility?.twitch !== undefined;
    default:
      return false;
  }
}

/** Wraps the core message handler for the HLS gate. A message that touches it
 * first supersedes a grant intent still waiting, so that intent cannot land
 * after it. Afterwards Twitch is turned back off if it would now watch with
 * HLS without the grant, which a change that could not prompt (an import)
 * can cause; the answer is then the snapshot after that. */
export function gateTwitchHlsMessages<Sender>(deps: {
  handle(message: CoreRuntimeMessage, sender?: Sender): Promise<unknown>;
  cancelIntent(): Promise<void>;
  enforce(): Promise<unknown>;
  reportEnforcementFailure(): void;
}): (message: CoreRuntimeMessage, sender?: Sender) => Promise<unknown> {
  return async (message, sender) => {
    if (!touchesTwitchHlsGate(message)) return deps.handle(message, sender);
    await deps.cancelIntent();
    const result = await deps.handle(message, sender);
    try {
      return (await deps.enforce()) ?? result;
    } catch {
      deps.reportEnforcementFailure();
      return result;
    }
  };
}

// The Chrome permission prompt closes the action popup before the click's
// continuation can apply the change. The popup records this intent without
// awaiting, then asks. Background completion is the only writer: it applies
// the intent after the allow, whether the popup is gone or asks it to.
export const TWITCH_HLS_GRANT_INTENT_KEY = "twitchHlsGrantIntent";
const GRANT_INTENT_TTL_MS = 2 * 60_000;

export type { TwitchHlsGrantIntent };

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

/** Records the intent and shows the video CDN prompt. Resolves whether the
 * host was granted; a decline drops the intent. Must be called before any
 * await in the click handler: the click is the user gesture. */
export async function promptTwitchHlsGrant(options: {
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

/** The popup's side of the grant: prompt, then have the background apply the
 * intent and answer with the snapshot that results. Resolves undefined on a
 * decline. The popup never applies the change itself, so it lands once. */
export async function requestTwitchHlsGrant(options: {
  storage: GrantIntentStorage;
  request(details: { origins: string[] }): Promise<boolean>;
  now(): number;
  complete(): Promise<RuntimeSnapshot>;
}, intent: TwitchHlsGrantIntent): Promise<RuntimeSnapshot | undefined> {
  const granted = await promptTwitchHlsGrant(options, intent);
  return granted ? options.complete() : undefined;
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
    // A newer user change to the Twitch switch or its compatibility selection
    // supersedes an intent still waiting for the grant.
    cancel,
    // The popup survived the prompt and asks for the result now. Joins a run
    // the grant event already started, so the intent is applied once.
    flush: schedule,
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
