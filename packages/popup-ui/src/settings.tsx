import React, { useEffect, useMemo, useRef, useState } from "react";
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
  const [exportingSettings, setExportingSettings] = useState(false);
  const [exportSettingsFailed, setExportSettingsFailed] = useState(false);
  const [importArmed, setImportArmed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);
  useEffect(() => {
    setExportArmed(false);
    setExportingSettings(false);
    setExportSettingsFailed(false);
    setImportArmed(false);
    setImportFailed(false);
    setResetArmed(false);
    setResetFailed(false);
  }, [exportConfirmationResetKey]);

  // Export needs no arm/confirm step (it only reads, never mutates), but it
  // still needs a busy/failure state like import and reset: a slow or failed
  // download (disk full, permission denied) should not look identical to a
  // successful one, and a second click while one is in flight should be a
  // no-op rather than racing two downloads.
  async function confirmExportSettings(): Promise<void> {
    if (!onExportSettings || exportingSettings) return;
    setExportingSettings(true);
    setExportSettingsFailed(false);
    try {
      await onExportSettings();
    } catch {
      setExportSettingsFailed(true);
    } finally {
      setExportingSettings(false);
    }
  }

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
  const topBarRef = useRef<HTMLDivElement>(null);

  // Not scrollIntoView: that only guarantees the target clears the *viewport*
  // edge, not our own sticky search/jump-nav bar layered on top of it, so the
  // section header would land hidden underneath. Scroll by the bar's live
  // height instead — measured, not hardcoded, so it holds regardless of
  // locale or how many lines the chip row wraps to.
  function jumpTo(id: string): void {
    const target = document.getElementById(`settings-section-${id}`);
    const scrollParent = target?.closest(".nice-scroll") as HTMLElement | null;
    if (!target || !scrollParent) {
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const barHeight = topBarRef.current?.offsetHeight ?? 0;
    const targetTop = target.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top + scrollParent.scrollTop;
    scrollParent.scrollTo({ top: targetTop - barHeight - 8, behavior: "smooth" });
  }

  return (
    <div className="space-y-4">
      <div ref={topBarRef} className="sticky top-0 z-20 -mx-3 space-y-2 bg-zinc-50 px-3 pb-2 pt-3 dark:bg-zinc-950">
        <SettingsSearchBox value={query} onChange={setQuery} />
        <AdvancedSettingsSwitch checked={showAdvanced} onChange={toggleAdvanced} />
        {!searching && visible.length > 1 ? (
          <nav aria-label={t("settingsSectionJumpNavLabel")} className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {visible.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => jumpTo(section.id)}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-600 outline-none transition-colors hover:border-[var(--accent-ring)] hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
              >
                {section.iconNode ?? (section.icon ? <section.icon size={12} /> : null)}
                {t(section.titleKey)}
              </button>
            ))}
          </nav>
        ) : null}
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

      {(onExportSettings || onImportSettings || onExportCredentials || onReset) && !searching ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 px-1">
            <span className="text-[12px] font-bold uppercase tracking-wide text-zinc-700 dark:text-zinc-200">{t("settingsSectionAdvancedActions")}</span>
          </div>
          <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/70 bg-white dark:divide-zinc-800/70 dark:border-zinc-800 dark:bg-zinc-900/40">
            {onExportSettings || onImportSettings ? (
              <div className="p-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t("settingsExportTitle")}</div>
                {importArmed ? (
                  <div className="mt-1.5 space-y-2">
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
                  <div className="mt-1.5 space-y-2">
                    <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("settingsExportHint")}</p>
                    {exportSettingsFailed ? <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{t("settingsExportFailed")}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      {onExportSettings ? (
                        <button
                          type="button"
                          disabled={exportingSettings}
                          className="flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          onClick={() => void confirmExportSettings()}
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

            {onExportCredentials ? (
              <div className="p-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t("cliExportTitle")}</div>
                {exportArmed ? (
                  <div className="mt-1.5 space-y-2">
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
                  // The button stays secondary here and the accent is spent on the
                  // confirm step, which is the one that actually writes session
                  // tokens to disk.
                  <div className="mt-1.5 space-y-2">
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

            {onReset ? (
              <div className="p-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-red-500 dark:text-red-400">{t("factoryResetTitle")}</div>
                {resetArmed ? (
                  <div className="mt-1.5 space-y-2">
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
                  <div className="mt-1.5 space-y-2">
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
        </div>
      ) : null}
    </div>
  );
}
