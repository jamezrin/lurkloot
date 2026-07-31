import React, { useEffect, useMemo, useState } from "react";
import { Download, RotateCcw, Terminal, Upload } from "lucide-react";
import type { CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { SHOW_ADVANCED_SETTINGS_KEY } from "./constants";
import { AdvancedSettingsSwitch, SettingsGroup, SettingsSearchBox, SettingsSection } from "./settingsControls";
import { buildSettingsRegistry, type SettingsChangeOptions } from "./settingsRegistry";
import { filterSettingsTree } from "./settingsSearch";
import { usePopupRuntime, useT } from "./context";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export function SettingsView({ suggestions, onSearchCategories, settings, onSettingsChange, onExportCredentials, onExportSettings, onImportSettings, onReset, exportConfirmationResetKey, compatibilityRegistry, compatibilityResolution }: {
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: SettingsChangeOptions): Promise<void>;
  // Optional: when provided, the settings view shows an "Export credentials"
  // action for the headless CLI. The extension wires it; the demo omits it.
  onExportCredentials?: () => void | Promise<void>;
  // Optional: download the current settings as a portable JSON file.
  onExportSettings?: () => void | Promise<void>;
  // Optional: prompt for a settings file and apply it. Resolves false when the
  // user cancels the file picker, throws when the file is invalid/corrupt.
  onImportSettings?: () => Promise<boolean>;
  onReset?: () => Promise<void>;
  exportConfirmationResetKey: number;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  compatibilityResolution?: PopupCompatibilityResolution;
}) {
  const t = useT();
  const { adapter, preview } = usePopupRuntime();
  const [query, setQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [exportArmed, setExportArmed] = useState(false);
  const [importArmed, setImportArmed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);
  useEffect(() => {
    setExportArmed(false);
    setImportArmed(false);
    setImportFailed(false);
    setResetArmed(false);
    setResetFailed(false);
  }, [exportConfirmationResetKey]);

  async function confirmImport(): Promise<void> {
    if (!onImportSettings || importing) return;
    setImporting(true);
    setImportFailed(false);
    try {
      const applied = await onImportSettings();
      if (applied) setImportArmed(false);
    } catch {
      setImportArmed(true);
      setImportFailed(true);
    } finally {
      setImporting(false);
    }
  }

  async function confirmReset(): Promise<void> {
    if (!onReset || resetting) return;
    setResetting(true);
    setResetFailed(false);
    try {
      await onReset();
    } catch {
      setResetArmed(true);
      setResetFailed(true);
    } finally {
      setResetting(false);
    }
  }

  useEffect(() => {
    if (preview) return;
    let mounted = true;
    void adapter.getStorage(SHOW_ADVANCED_SETTINGS_KEY).then((stored) => {
      if (mounted) setShowAdvanced(stored[SHOW_ADVANCED_SETTINGS_KEY] === true);
    });
    return () => {
      mounted = false;
    };
  }, [adapter, preview]);

  function toggleAdvanced(value: boolean): void {
    setShowAdvanced(value);
    if (preview) return;
    void adapter.setStorage({ [SHOW_ADVANCED_SETTINGS_KEY]: value });
  }

  const sections = useMemo(
    () => buildSettingsRegistry({ t, settings, onSettingsChange, suggestions, onSearchCategories, compatibilityRegistry, compatibilityResolution }),
    [t, settings, onSettingsChange, suggestions, onSearchCategories, compatibilityRegistry, compatibilityResolution],
  );
  const visible = useMemo(
    () => filterSettingsTree(sections, { t, query, showAdvanced }),
    [sections, t, query, showAdvanced],
  );
  const searching = query.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SettingsSearchBox value={query} onChange={setQuery} />
        <AdvancedSettingsSwitch checked={showAdvanced} onChange={toggleAdvanced} />
      </div>

      {visible.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">{t("settingsSearchNoResults", query.trim())}</p>
      ) : (
        <div className="space-y-6">
          {visible.map((section) => (
            <SettingsSection
              key={section.id}
              id={section.id}
              title={t(section.titleKey)}
              icon={section.icon}
              iconNode={section.iconNode}
              // While searching, a section holding matches opens regardless of
              // the state the user left it in, and that state is not overwritten.
              forceExpanded={searching}
            >
              {section.rows.length > 0 ? (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                  {section.rows.map((row) => <React.Fragment key={row.id}>{row.render()}</React.Fragment>)}
                </div>
              ) : null}
              {section.groups.map((group) => (
                <SettingsGroup key={group.id} title={t(group.titleKey)} description={group.description} badge={group.badge} advanced={group.advanced}>
                  {group.entries.map((entry) => <React.Fragment key={entry.id}>{entry.render()}</React.Fragment>)}
                </SettingsGroup>
              ))}
            </SettingsSection>
          ))}
        </div>
      )}

      {(onExportSettings || onImportSettings) && !searching ? (
        <div className="pt-2">
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t("settingsExportTitle")}</span>
            <span className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800/70" />
          </div>
          {importArmed ? (
            <div className="space-y-2 px-1 py-1">
              <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{t("settingsImportConfirm")}</p>
              {importFailed ? <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{t("settingsImportFailed")}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={importing}
                  className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => {
                    setImportArmed(false);
                    setImportFailed(false);
                  }}
                >
                  {t("settingsImportCancel")}
                </button>
                <button
                  type="button"
                  disabled={importing}
                  className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-50"
                  onClick={() => void confirmImport()}
                >
                  {t("settingsImportConfirmButton")}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 px-1 pb-1">
              <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("settingsExportHint")}</p>
              <div className="flex flex-wrap justify-end gap-2">
                {onExportSettings ? (
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    onClick={() => void onExportSettings()}
                  >
                    <Download size={13} />
                    {t("settingsExportButton")}
                  </button>
                ) : null}
                {onImportSettings ? (
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    onClick={() => setImportArmed(true)}
                  >
                    <Upload size={13} />
                    {t("settingsImportButton")}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {onExportCredentials && !searching ? (
        <div className="pt-2">
          {/* Labelled like a group header so the action reads as deliberate
              rather than orphaned, without becoming a settings section: this is
              an action, not a setting. The header's own trailing rule is the
              separator — a border on this wrapper would stack a second line
              directly above it. */}
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t("cliExportTitle")}</span>
            <span className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800/70" />
          </div>
          {exportArmed ? (
            <div className="space-y-2 px-1 py-1">
              <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{t("cliExportConfirm")}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => setExportArmed(false)}
                >
                  {t("cliExportCancel")}
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                  onClick={() => {
                    setExportArmed(false);
                    void onExportCredentials();
                  }}
                >
                  {t("cliExportConfirmButton")}
                </button>
              </div>
            </div>
          ) : (
            // The hint gets the full width so it wraps as prose instead of a
            // ragged column beside the button. The button stays secondary here
            // and the accent is spent on the confirm step, which is the one
            // that actually writes session tokens to disk.
            <div className="space-y-2 px-1 pb-1">
              <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("cliExportHint")}</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => setExportArmed(true)}
                >
                  <Terminal size={13} />
                  {t("cliExportButton")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {onReset && !searching ? (
        <div className="pt-2">
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-red-500 dark:text-red-400">{t("factoryResetTitle")}</span>
            <span className="h-px flex-1 bg-red-100 dark:bg-red-950" />
          </div>
          {resetArmed ? (
            <div className="space-y-2 px-1 py-1">
              <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{t("factoryResetConfirm")}</p>
              {resetFailed ? <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{t("factoryResetFailed")}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={resetting}
                  className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => {
                    setResetArmed(false);
                    setResetFailed(false);
                  }}
                >
                  {t("factoryResetCancel")}
                </button>
                <button
                  type="button"
                  disabled={resetting}
                  className="rounded-xl bg-red-600 px-3 py-1.5 text-xs font-semibold text-white outline-none transition-colors hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
                  onClick={() => void confirmReset()}
                >
                  {t(resetting ? "factoryResetProgress" : resetFailed ? "factoryResetRetry" : "factoryResetConfirmButton")}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 px-1 pb-1">
              <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("factoryResetHint")}</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-xl border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 outline-none transition-colors hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-400 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                  onClick={() => {
                    setResetArmed(true);
                    setResetFailed(false);
                  }}
                >
                  <RotateCcw size={13} />
                  {t("factoryResetButton")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
