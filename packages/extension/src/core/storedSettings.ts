import type { ExtensionSettings } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import {
  SETTINGS_SCHEMA_VERSION_KEY,
  UnsupportedSettingsVersionError,
  migrateSettings,
} from "@lurkloot/shared/settingsSchema";
import { isRecord } from "@lurkloot/shared/records";

export interface StoredSettingsRead {
  settings: ExtensionSettings;
  // True when the canonical result should be written back.
  persist: boolean;
}

// Turns the raw stored settings document into usable settings.
//
// A document from a newer build (a downgrade, or a worktree build copied over
// the loaded one) is read best-effort and never written back on load: the
// newer build can still open it unchanged. Throwing here instead left every
// settings read failing, the popup stuck loading and the factory reset unable
// to run. The next save writes this build's version, dropping the properties
// this build does not know. Some saves need no user action (startup
// normalization, a provider losing its permission), so that can happen soon
// after a downgraded build starts.
//
// A version that is not a non-negative integer was never written by any
// build. Replaying every migration on a current document is a no-op, so it is
// migrated from version 0 and written back.
export function readStoredSettings(raw: unknown): StoredSettingsRead {
  try {
    const migration = migrateSettings(raw);
    return {
      settings: mergeSettings(migration.settings as Partial<ExtensionSettings>),
      persist: migration.changed,
    };
  } catch (error) {
    if (!(error instanceof UnsupportedSettingsVersionError) || !isRecord(raw)) throw error;
    const { [SETTINGS_SCHEMA_VERSION_KEY]: _version, ...rest } = raw;
    if (error.reason === "future") {
      return { settings: mergeSettings(rest as Partial<ExtensionSettings>), persist: false };
    }
    const migration = migrateSettings(rest);
    return {
      settings: mergeSettings(migration.settings as Partial<ExtensionSettings>),
      persist: true,
    };
  }
}
