import React, { useEffect, useMemo, useState } from "react";
import { Download, RotateCcw, Terminal, Upload } from "lucide-react";
import type { CategorySelection, ExtensionSettings, Platform, TwitchExtensionProviderId } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { PLATFORMS } from "./constants";
import { SettingsGroup, SettingsSearchBox, SettingsSection } from "./settingsControls";
import { buildSettingsRegistry, type SettingsChangeOptions } from "./settingsRegistry";
import { filterSettingsTree } from "./settingsSearch";
import { useT } from "./context";
import { ViewToolbar } from "./viewToolbar";
import { cn, scrollIntoPanel } from "./primitives";
import { AboutSection } from "./about";
import { TwitchExtensionSettings, twitchExtensionSearchText } from "./twitchExtensions";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export function SettingsView({ suggestions, onSearchCategories, settings, onSettingsChange, onExtensionEnabledChange, onExportCredentials, onExportSettings, onImportSettings, onReset, exportConfirmationResetKey, compatibilityRegistry, compatibilityResolution, focusGroupId, onOpenGames, version }: {
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  settings: ExtensionSettings;
  onExtensionEnabledChange?(provider: TwitchExtensionProviderId, enabled: boolean): Promise<boolean>;
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
  focusGroupId?: string;
  onOpenGames?(platform: Platform): void;
  // The extension version, shown with the project links in the About section.
  version?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
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

  const rootRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusGroupId) return;
    // General groups render as whole sections, platform groups as groups
    // inside their platform's section; either anchor finds the target.
    scrollIntoPanel(rootRef.current?.querySelector(`[id="settings-group-${focusGroupId}"], [id="settings-section-${focusGroupId}"]`));
  }, [focusGroupId]);

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

  const sections = useMemo(
    () => buildSettingsRegistry({ t, settings, onSettingsChange, suggestions, onSearchCategories, compatibilityRegistry, compatibilityResolution, onOpenGames }),
    [t, settings, onSettingsChange, suggestions, onSearchCategories, compatibilityRegistry, compatibilityResolution, onOpenGames],
  );
  const visible = useMemo(
    () => filterSettingsTree(sections, { t, query, showAdvanced: true }),
    [sections, t, query],
  );
  const searching = query.trim().length > 0;
  const hasActions = Boolean(onExportSettings || onImportSettings || onExportCredentials || onReset);
  const actionSearchText = [
    t("settingsSectionAdvancedActions"),
    t("settingsSectionAdvancedActionsDescription"),
    t("settingsExportTitle"),
    t("settingsExportHint"),
    t("settingsExportButton"),
    t("settingsImportButton"),
    t("cliExportTitle"),
    t("cliExportHint"),
    t("cliExportButton"),
    t("factoryResetTitle"),
    t("factoryResetHint"),
    t("factoryResetButton"),
  ].join(" ").toLocaleLowerCase();
  const showExtensions = Boolean(onExtensionEnabledChange) && (!searching || twitchExtensionSearchText(t).includes(query.trim().toLocaleLowerCase()));
  const showActions = hasActions && (!searching || actionSearchText.includes(query.trim().toLocaleLowerCase()));
  const generalSection = visible.find((section) => section.id === "general");
  const platformSections = (Object.keys(PLATFORMS) as Platform[])
    .map((id) => visible.find((section) => section.id === id))
    .filter((section): section is NonNullable<typeof section> => Boolean(section));

  const extensionSettings = showExtensions && onExtensionEnabledChange ? (
    <TwitchExtensionSettings
      query={query}
      settings={settings}
      onChange={onExtensionEnabledChange}
      onAutoOpenPacksChange={(autoOpenPacks) => onSettingsChange({ twitchExtensions: { nopixel: { autoOpenPacks } } }, { tickAfterSave: true, tickAfterSavePlatforms: ["twitch"] })}
      onTakeoversChange={(allowTakeovers) => onSettingsChange({ twitchExtensions: { fortnite: { allowTakeovers } } }, { tickAfterSave: true, tickAfterSavePlatforms: ["twitch"] })}
    />
  ) : null;

  function renderGroupContent(group: typeof sections[number]["groups"][number], includeDescription = true): React.ReactNode {
    return (
      <>
        {includeDescription && group.description ? <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{group.description}</p> : null}
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {group.entries.map((entry) => <React.Fragment key={entry.id}>{entry.render()}</React.Fragment>)}
        </div>
      </>
    );
  }

  return (
    <div ref={rootRef} className="space-y-3">
      <ViewToolbar>
        <div className="ms-auto w-full max-w-[16rem]">
          <SettingsSearchBox compact value={query} onChange={setQuery} />
        </div>
      </ViewToolbar>

      {visible.length === 0 && !showActions && !showExtensions ? (
        <p className="px-1 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">{t("settingsSearchNoResults", query.trim())}</p>
      ) : searching ? (
        <div className="space-y-4">
          {visible.flatMap((section) => [
            section.rows.length > 0 ? (
              <SettingsSection
                key={`${section.id}.rows`}
                id={`${section.id}.rows`}
                title={PLATFORMS[section.id as Platform].label}
              >
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                  {section.rows.map((row) => <React.Fragment key={row.id}>{row.render()}</React.Fragment>)}
                </div>
              </SettingsSection>
            ) : null,
            ...section.groups.map((group) => (
              <SettingsSection
                key={group.id}
                id={group.id}
                title={section.id === "general" ? t(group.titleKey) : `${PLATFORMS[section.id as Platform].label} · ${t(group.titleKey)}`}
              >
                {renderGroupContent(group, false)}
              </SettingsSection>
            )),
            section.id === "twitch" ? <React.Fragment key="twitch.extensions">{extensionSettings}</React.Fragment> : null,
          ])}
        </div>
      ) : (
        <div className="space-y-4">
          {generalSection?.groups.map((group) => group.id !== "general.advanced" ? (
            <SettingsSection key={group.id} id={group.id} title={t(group.titleKey)} description={group.description}>
              {renderGroupContent(group, false)}
            </SettingsSection>
          ) : null)}

          {platformSections.map((section) => (
            <React.Fragment key={section.id}>
              <SettingsSection
                id={section.id}
                title={PLATFORMS[section.id as Platform].label}
                description={section.description}
              >
                {section.rows.length > 0 ? (
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                    {section.rows.map((row) => <React.Fragment key={row.id}>{row.render()}</React.Fragment>)}
                  </div>
                ) : null}
                {section.groups.map((group) => (
                  <SettingsGroup key={group.id} id={group.id} title={t(group.titleKey)} description={group.description} badge={group.badge}>
                    {group.entries.map((entry) => <React.Fragment key={entry.id}>{entry.render()}</React.Fragment>)}
                  </SettingsGroup>
                ))}
              </SettingsSection>
              {section.id === "twitch" ? extensionSettings : null}
            </React.Fragment>
          ))}

          {generalSection?.groups.find((group) => group.id === "general.advanced") ? (
            <SettingsSection id="general.advanced" title={t("settingsGroupAdvanced")} description={generalSection.groups.find((group) => group.id === "general.advanced")!.description}>
              {renderGroupContent(generalSection.groups.find((group) => group.id === "general.advanced")!, false)}
            </SettingsSection>
          ) : null}
        </div>
      )}

      {searching && !visible.some(section => section.id === "twitch") ? extensionSettings : null}

      {showActions ? (
        <SettingsSection id="actions" title={t("settingsSectionAdvancedActions")} description={t("settingsSectionAdvancedActionsDescription")}>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {onExportSettings || onImportSettings ? (
              importArmed ? (
                <ActionRow
                  title={t("settingsExportTitle")}
                  hint={t("settingsImportConfirm")}
                  tone="warning"
                  error={importFailed ? t("settingsImportFailed") : undefined}
                >
                  <ActionButton
                    disabled={importing}
                    onClick={() => {
                      setImportArmed(false);
                      setImportFailed(false);
                    }}
                  >
                    {t("settingsImportCancel")}
                  </ActionButton>
                  <ActionButton primary disabled={importing} onClick={() => void confirmImport()}>
                    {t("settingsImportConfirmButton")}
                  </ActionButton>
                </ActionRow>
              ) : (
                <ActionRow
                  title={t("settingsExportTitle")}
                  hint={t("settingsExportHint")}
                  stack
                  error={exportSettingsFailed ? t("settingsExportFailed") : undefined}
                >
                  {onExportSettings ? (
                    <ActionButton disabled={exportingSettings} onClick={() => void confirmExportSettings()}>
                      <Download size={12} />
                      {t("settingsExportButton")}
                    </ActionButton>
                  ) : null}
                  {onImportSettings ? (
                    <ActionButton onClick={() => setImportArmed(true)}>
                      <Upload size={12} />
                      {t("settingsImportButton")}
                    </ActionButton>
                  ) : null}
                </ActionRow>
              )
            ) : null}

            {onExportCredentials ? (
              exportArmed ? (
                <ActionRow title={t("cliExportTitle")} hint={t("cliExportConfirm")} tone="warning">
                  <ActionButton onClick={() => setExportArmed(false)}>{t("cliExportCancel")}</ActionButton>
                  {/* The button stays secondary until here: the confirm step is
                      the one that actually writes session tokens to disk. */}
                  <ActionButton
                    primary
                    onClick={() => {
                      setExportArmed(false);
                      void onExportCredentials();
                    }}
                  >
                    {t("cliExportConfirmButton")}
                  </ActionButton>
                </ActionRow>
              ) : (
                <ActionRow title={t("cliExportTitle")} hint={t("cliExportHint")}>
                  <ActionButton onClick={() => setExportArmed(true)}>
                    <Terminal size={12} />
                    {t("cliExportButton")}
                  </ActionButton>
                </ActionRow>
              )
            ) : null}

            {onReset ? (
              resetArmed ? (
                <ActionRow
                  title={t("factoryResetTitle")}
                  hint={t("factoryResetConfirm")}
                  danger
                  error={resetFailed ? t("factoryResetFailed") : undefined}
                >
                  <ActionButton
                    disabled={resetting}
                    onClick={() => {
                      setResetArmed(false);
                      setResetFailed(false);
                    }}
                  >
                    {t("factoryResetCancel")}
                  </ActionButton>
                  <ActionButton danger primary disabled={resetting} onClick={() => void confirmReset()}>
                    {t(resetting ? "factoryResetProgress" : resetFailed ? "factoryResetRetry" : "factoryResetConfirmButton")}
                  </ActionButton>
                </ActionRow>
              ) : (
                <ActionRow title={t("factoryResetTitle")} hint={t("factoryResetHint")} danger>
                  <ActionButton
                    danger
                    onClick={() => {
                      setResetArmed(true);
                      setResetFailed(false);
                    }}
                  >
                    <RotateCcw size={12} />
                    {t("factoryResetButton")}
                  </ActionButton>
                </ActionRow>
              )
            ) : null}
          </div>
        </SettingsSection>
      ) : null}

      {version && !searching ? <AboutSection version={version} /> : null}
    </div>
  );
}

// One action per row, laid out like a setting: what it does on the left, its
// buttons on the right. Arming an action swaps the row's hint for the
// confirmation and its buttons for cancel/confirm, in place.
function ActionRow({ title, hint, tone, danger = false, stack = false, error, children }: {
  title: string;
  hint: string;
  tone?: "warning";
  danger?: boolean;
  // Two peer buttons stack, so their labels do not squeeze the hint.
  stack?: boolean;
  error?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2.5">
      <div className="min-w-0">
        <div className={cn("text-[12.5px] font-semibold", danger ? "text-red-600 dark:text-red-400" : "text-zinc-800 dark:text-zinc-100")}>{title}</div>
        <div className={cn("mt-0.5 max-w-[46ch] text-[11px] leading-snug", tone === "warning" ? "text-amber-700 dark:text-amber-300" : "text-zinc-500 dark:text-zinc-400")}>{hint}</div>
        {error ? <p role="alert" className="mt-1 text-[11px] font-medium text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
      <div className={cn("flex shrink-0 gap-1.5", stack ? "flex-col items-stretch" : "items-center")}>{children}</div>
    </div>
  );
}

function ActionButton({ primary = false, danger = false, disabled, onClick, children }: {
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 disabled:opacity-50",
        primary && danger && "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-400 dark:bg-red-700 dark:hover:bg-red-600",
        primary && !danger && "bg-[var(--ink)] text-[var(--ink-contrast)] focus-visible:ring-[var(--accent-ring)]",
        !primary && danger && "border border-red-200 text-red-600 hover:bg-red-50 focus-visible:ring-red-400 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40",
        !primary && !danger && "border border-zinc-200 text-zinc-700 hover:bg-zinc-50 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800",
      )}
    >
      {children}
    </button>
  );
}
