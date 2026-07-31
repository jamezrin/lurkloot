// Builds and parses the portable settings file the popup and the CLI both
// produce for "move my configuration" (issue #252). The payload only ever
// carries ExtensionSettings fields: mergeSettings() reads settings by name, so
// any extra property on an imported file — however it got there — is silently
// dropped rather than merged in. That is what keeps this format safe to hand
// to another person: it can never carry a credential, token, cookie, or
// session value, because none of those live on ExtensionSettings in the first
// place.

import type { ExtensionSettings } from "./models";
import { mergeSettings } from "./settings";
import { CURRENT_SETTINGS_SCHEMA_VERSION, migrateSettings, type SettingsMigrationDiagnostic } from "./settingsSchema";

export const SETTINGS_EXPORT_KIND = "lurkloot-settings";

export interface SettingsExportPayload {
  kind: typeof SETTINGS_EXPORT_KIND;
  schemaVersion: number;
  exportedAt: string;
  settings: ExtensionSettings;
}

export class InvalidSettingsImportError extends Error {
  constructor(reason: string) {
    super(`Not a lurkloot settings file: ${reason}`);
    this.name = "InvalidSettingsImportError";
  }
}

export function buildSettingsExportPayload(settings: ExtensionSettings): SettingsExportPayload {
  return {
    kind: SETTINGS_EXPORT_KIND,
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    // Normalized first, so the file on disk always reflects what the running
    // extension actually holds rather than whatever partial shape called in.
    settings: mergeSettings(settings),
  };
}

export interface SettingsImportResult {
  settings: ExtensionSettings;
  diagnostics: SettingsMigrationDiagnostic[];
}

// Re-runs the same migrate-then-normalize pipeline every host already applies
// to its own persisted document (see storage.ts#loadSettings), so an import
// degrades exactly like opening an old or new build would: unknown/removed
// properties are dropped, renamed ones are carried forward, and a schema
// version newer than this build understands throws UnsupportedSettingsVersionError
// rather than corrupting state.
export function parseSettingsImportPayload(raw: unknown): SettingsImportResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidSettingsImportError("expected a JSON object");
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.kind !== SETTINGS_EXPORT_KIND) {
    throw new InvalidSettingsImportError(`unrecognized "kind"`);
  }
  if (typeof envelope.settings !== "object" || envelope.settings === null || Array.isArray(envelope.settings)) {
    throw new InvalidSettingsImportError(`missing "settings"`);
  }

  const rawSettings = { ...(envelope.settings as Record<string, unknown>), schemaVersion: envelope.schemaVersion };
  const migration = migrateSettings(rawSettings);
  const settings = mergeSettings(migration.settings as Partial<ExtensionSettings>);
  return { settings, diagnostics: migration.diagnostics };
}
