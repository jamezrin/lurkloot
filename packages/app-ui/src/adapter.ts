import type { PopupAdapter, PopupHostCapabilities } from "@lurkloot/popup-ui";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { LanguageOverride } from "@lurkloot/shared/models";
import { LOCALE_OPTIONS } from "@lurkloot/shared/i18n";
import type { ControlPlaneClient } from "./api";

/** What the CLI host behind `lurkloot serve` supports (#977). It farms without
 * tabs, runs no Twitch Extension providers, exports no credentials and keeps
 * none of the extension's preferences or its activity history. The language
 * is the app's own: it lives in this browser, not in config.json. */
export const CLI_HOST_CAPABILITIES: Readonly<PopupHostCapabilities> = Object.freeze({
  tabs: false,
  twitchExtensions: false,
  credentialExport: false,
  extensionPreferences: false,
  language: true,
  activityHistory: false,
});

// UI-only preferences go to localStorage under this prefix: the selected
// platform, the language. Nothing the farming engine reads lives here.
export const STORAGE_PREFIX = "lurkloot.app.";
// Kept outside the prefix: it is a plain string, not one of the JSON values
// getStorage hands to the popup.
export const LANGUAGE_STORAGE_KEY = "lurkloot.language";

const LANGUAGES = new Set<string>(LOCALE_OPTIONS.map((option) => option.value));

export function readLanguageOverride(storage: Storage): LanguageOverride {
  const stored = storage.getItem(LANGUAGE_STORAGE_KEY);
  return stored && LANGUAGES.has(stored) ? (stored as LanguageOverride) : "browser";
}

function isSnapshot(value: unknown): value is RuntimeSnapshot {
  return (
    typeof value === "object"
    && value !== null
    && "settings" in value
    && "state" in value
    && typeof (value as { settings: unknown }).settings === "object"
  );
}

export interface HttpPopupAdapterOptions {
  client: ControlPlaneClient;
  version: string;
  storage: Storage;
  // Lookup for keys while the language follows the browser: the browser
  // language's catalog, preloaded before the app mounts.
  getMessage(key: string, substitutions?: string | string[]): string;
  uiLanguage: string;
  openLink(url: string): void;
  // Every failed message, for the app to show. The popup itself rolls a
  // failed change back but has nowhere to say why.
  onError?(error: unknown, message: RuntimeMessage): void;
  // Every answered message, so the app can clear a connection warning.
  onSuccess?(message: RuntimeMessage): void;
  onLanguageChange?(language: LanguageOverride): void;
}

/** The popup's adapter over `lurkloot serve`'s control plane.
 *
 * `send` posts the popup's own RuntimeMessage to `/v1/session/messages` and
 * returns its `result`. The language is the one setting the CLI config cannot
 * hold, so it is kept here: taken out of every settings save, stored in
 * localStorage, and put back on every snapshot the server returns. */
export function createHttpPopupAdapter(options: HttpPopupAdapterOptions): PopupAdapter {
  const { client, storage } = options;

  const withLanguage = <T>(result: T): T => {
    if (!isSnapshot(result)) return result;
    return {
      ...result,
      settings: { ...result.settings, languageOverride: readLanguageOverride(storage) },
    } as T;
  };

  const post = async <T>(message: RuntimeMessage): Promise<T> => {
    try {
      const answer = await client.request<{ result: T }>("POST", "/v1/session/messages", message);
      options.onSuccess?.(message);
      return withLanguage(answer.result);
    } catch (error) {
      options.onError?.(error, message);
      throw error;
    }
  };

  return {
    version: options.version,
    hostCapabilities: CLI_HOST_CAPABILITIES,
    // No store distributes the CLI, so there is nothing to rate.
    reviewStore: null,
    async send<T>(message: RuntimeMessage): Promise<T> {
      if (message.type === "saveSettings" && "languageOverride" in message.settingsPatch) {
        const { languageOverride, ...rest } = message.settingsPatch;
        if (languageOverride !== undefined) {
          storage.setItem(LANGUAGE_STORAGE_KEY, languageOverride);
          options.onLanguageChange?.(languageOverride);
        }
        // Nothing left for the CLI: answer with the current snapshot, which
        // now carries the new language.
        if (Object.keys(rest).length === 0) return post<T>({ type: "getSnapshot" });
        return post<T>({ ...message, settingsPatch: rest });
      }
      return post<T>(message);
    },
    async getStorage(keys) {
      const wanted = keys === undefined ? undefined : Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (let index = 0; index < storage.length; index += 1) {
        const stored = storage.key(index);
        if (!stored?.startsWith(STORAGE_PREFIX)) continue;
        const key = stored.slice(STORAGE_PREFIX.length);
        if (wanted && !wanted.includes(key)) continue;
        try {
          result[key] = JSON.parse(storage.getItem(stored) ?? "null");
        } catch {
          // A value written by something else; leave it out.
        }
      }
      return result;
    },
    async setStorage(values) {
      for (const [key, value] of Object.entries(values)) {
        storage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
      }
    },
    getMessage: options.getMessage,
    getUiLanguage: () => options.uiLanguage,
    openLink: options.openLink,
    async writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
  };
}
