import React, { useEffect, useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import type { CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { SHOW_ADVANCED_SETTINGS_KEY } from "./constants";
import { AdvancedSettingsSwitch, SettingsGroup, SettingsSearchBox, SettingsSection } from "./settingsControls";
import { buildSettingsRegistry, type SettingsChangeOptions } from "./settingsRegistry";
import { filterSettingsTree } from "./settingsSearch";
import { usePopupRuntime, useT } from "./context";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export function SettingsView({ suggestions, onSearchCategories, settings, onSettingsChange, onExportCredentials, exportConfirmationResetKey, compatibilityRegistry, compatibilityResolution }: {
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: SettingsChangeOptions): Promise<void>;
  // Optional: when provided, the settings view shows an "Export credentials"
  // action for the headless CLI. The extension wires it; the demo omits it.
  onExportCredentials?: () => void | Promise<void>;
  exportConfirmationResetKey: number;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  compatibilityResolution?: PopupCompatibilityResolution;
}) {
  const t = useT();
  const { adapter, preview } = usePopupRuntime();
  const [query, setQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [exportArmed, setExportArmed] = useState(false);
  useEffect(() => setExportArmed(false), [exportConfirmationResetKey]);

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
                <SettingsGroup key={group.id} title={t(group.titleKey)} advanced={group.advanced}>
                  {group.entries.map((entry) => <React.Fragment key={entry.id}>{entry.render()}</React.Fragment>)}
                </SettingsGroup>
              ))}
            </SettingsSection>
          ))}
        </div>
      )}

      {onExportCredentials && !searching ? (
        <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800/70">
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
            <div className="flex items-center justify-between gap-3 px-1 py-1">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("cliExportHint")}</p>
              <button
                type="button"
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                onClick={() => setExportArmed(true)}
              >
                <Terminal size={13} />
                {t("cliExportButton")}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
