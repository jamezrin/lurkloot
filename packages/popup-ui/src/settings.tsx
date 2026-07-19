import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell,
  Gift,
  Play,
  Radio,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import type {
  CategorySelection,
  ExtensionSettings,
  LanguageOverride,
  Platform,
} from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { LOCALE_OPTIONS } from "@lurkloot/shared/i18n";
import {
  CampaignFilterSettingRow,
  ForgetExcludedCampaignsRow,
  NumberSettingRow,
  SelectSettingRow,
  SettingRow,
  SettingsSection,
} from "./settingsControls";
import { PlatformSettingsGroup, SettingsPlatformSwitch } from "./settingsPlatform";
import { useT } from "./context";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";
import { CompatibilitySettings } from "./compatibilitySettings";

export function SettingsView({ suggestions, onSearchCategories, settings, onSettingsChange, onExportCredentials, exportConfirmationResetKey, compatibilityRegistry, compatibilityResolution, initialPlatform = "twitch" }: {
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: { tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }): Promise<void>;
  // Optional: when provided, the settings view shows an "Export credentials"
  // action for the headless CLI. The extension wires it; the demo omits it.
  onExportCredentials?: () => void | Promise<void>;
  exportConfirmationResetKey: number;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  compatibilityResolution?: PopupCompatibilityResolution;
  initialPlatform?: Platform;
}) {
  const t = useT();
  const [platformTab, setPlatformTab] = useState<Platform>(initialPlatform);
  const [exportArmed, setExportArmed] = useState(false);
  useEffect(() => setExportArmed(false), [exportConfirmationResetKey]);
  const set = (key: keyof ExtensionSettings) => (value: boolean) => onSettingsChange({ [key]: value } as SettingsPatch);
  const pollIntervalSeconds = Math.round(settings.pollIntervalMinutes * 60);
  const tabPlaybackDisabled = settings.tablessMode;
  const tabPlaybackDisabledReason = t("tablessDisabledReason");
  const setPlatformFarmAllCategories = (platform: Platform) => (farmAllCategories: boolean) => onSettingsChange(
    {
      platform: {
        [platform]: {
          farmAllCategories,
        },
      },
    },
    { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
  );
  const setPlatformCategories = (platform: Platform) => (categories: CategorySelection[]) => onSettingsChange(
    {
      platform: {
        [platform]: {
          categories,
        },
      },
    },
    { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
  );
  const setPlatformExcludedChannels = (platform: Platform) => (excludedChannels: string[]) => onSettingsChange(
    {
      platform: {
        [platform]: {
          excludedChannels,
        },
      },
    },
    { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
  );
  const setPlatformAutoClaimBonus = (platform: Platform) => (value: boolean) => onSettingsChange(
    platform === "twitch"
      ? { platform: { twitch: { autoClaimChannelPoints: value } } }
      : { platform: { kick: { autoClaimChallenges: value } } },
  );

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settingsGeneralTitle")} description={t("settingsGeneralDescription")} icon={SettingsIcon}>
        <SelectSettingRow<LanguageOverride>
          title={t("settingsLanguageTitle")}
          description={t("settingsLanguageDescription")}
          value={settings.languageOverride}
          options={LOCALE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.value === "browser" ? t(option.labelKey) : `${option.nativeName} (${t(option.labelKey)})`,
          }))}
          onChange={(value) => onSettingsChange({ languageOverride: value })}
        />
        <SettingRow title={t("pauseManualTitle")} description={t("pauseManualDescription")} checked={settings.pauseOnManualWatch} onChange={set("pauseOnManualWatch")} />
        <SettingRow title={t("autoStartTitle")} description={t("autoStartDescription")} checked={settings.autoStartDropFarming} onChange={set("autoStartDropFarming")} />
        <SettingRow title={t("hideTipsTitle")} description={t("hideTipsDescription")} checked={!settings.showTips} onChange={(hideTips) => onSettingsChange({ showTips: !hideTips })} />
      </SettingsSection>
      <SettingsSection title={t("notificationsTitle")} description={t("notificationsDescription")} icon={Bell}>
        <SettingRow title={t("rewardEarnedTitle")} description={t("rewardEarnedDescription")} checked={settings.notifyRewardEarned} onChange={set("notifyRewardEarned")} />
        <SettingRow title={t("noDropsLeftTitle")} description={t("noDropsLeftDescription")} checked={settings.notifyNoDropsLeft} onChange={set("notifyNoDropsLeft")} />
      </SettingsSection>
      <SettingsSection title={t("dropsSettingsTitle")} description={t("dropsSettingsDescription")} icon={Gift}>
        <SettingRow title={t("autoClaimTitle")} description={t("autoClaimDescription")} checked={settings.autoClaim} onChange={set("autoClaim")} />
        <SelectSettingRow
          title={t("campaignPriorityTitle")}
          description={t("campaignPriorityDescription")}
          value={settings.priorityMode}
          options={[
            { value: "priority_list_only", label: t("priorityListOnly") },
            { value: "ending_soonest", label: t("endingSoonest") },
            { value: "lowest_availability", label: t("lowAvailabilityFirst") },
          ]}
          onChange={(value) => onSettingsChange({ priorityMode: value }, { tickAfterSave: true })}
        />
        <CampaignFilterSettingRow value={settings.campaignVisibility} onChange={(campaignVisibility) => onSettingsChange({ campaignVisibility })} />
        <ForgetExcludedCampaignsRow
          count={settings.excludedCampaignIds.length}
          onForget={() => onSettingsChange({ excludedCampaignIds: [] }, { tickAfterSave: true })}
        />
      </SettingsSection>
      <SettingsSection title={t("watchQueueSettingsTitle")} description={t("watchQueueSettingsDescription")} icon={Play}>
        <SettingRow title={t("watchQueueFallbackOnlyTitle")} description={t("watchQueueFallbackOnlyDescription")} checked={settings.watchQueueFallbackOnly} onChange={set("watchQueueFallbackOnly")} />
      </SettingsSection>
      <SettingsSection title={t("platformSettingsTitle")} description={t("platformSettingsDescription")} icon={Radio} divided={false}>
        <SettingsPlatformSwitch active={platformTab} onChange={setPlatformTab} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={platformTab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.15 }} className="space-y-3">
            <PlatformSettingsGroup platform={platformTab} suggestions={suggestions[platformTab]} settings={settings} onFarmAllCategoriesChange={setPlatformFarmAllCategories(platformTab)} onCategoriesChange={setPlatformCategories(platformTab)} onSearchCategories={(query) => onSearchCategories(platformTab, query)} onExcludedChannelsChange={setPlatformExcludedChannels(platformTab)} onAutoClaimBonusChange={setPlatformAutoClaimBonus(platformTab)} />
          </motion.div>
        </AnimatePresence>
      </SettingsSection>
      <SettingsSection title={t("farmingTabsTitle")} description={t("farmingTabsDescription")} icon={Play}>
        <SettingRow title={t("tablessTitle")} description={t("tablessDescription")} checked={settings.tablessMode} onChange={(value) => onSettingsChange({ tablessMode: value }, { tickAfterSave: true })} />
        <SettingRow title={t("autoCloseTabsTitle")} description={t("autoCloseTabsDescription")} checked={settings.autoCloseFinishedDrops} onChange={set("autoCloseFinishedDrops")} />
        <SettingRow title={t("muteTabsTitle")} description={t("muteTabsDescription")} checked={settings.muteFarmingTabs} onChange={set("muteFarmingTabs")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />
        <SettingRow title={t("keepVideosUnmutedTitle")} description={t("keepVideosUnmutedDescription")} checked={settings.keepFarmingVideosUnmuted !== false} onChange={set("keepFarmingVideosUnmuted")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />
        <SelectSettingRow
          title={t("adFocusTitle")}
          description={t("adFocusDescription")}
          value={settings.adFocusMode ?? "window"}
          options={[
            { value: "none", label: t("off") },
            { value: "tab", label: t("tabOnly") },
            { value: "window", label: t("tabAndWindow") },
          ]}
          onChange={(value) => onSettingsChange({ adFocusMode: value })}
          disabled={tabPlaybackDisabled}
          disabledReason={tabPlaybackDisabledReason}
        />
      </SettingsSection>
      <SettingsSection title={t("advancedTitle")} description={t("advancedDescription")} icon={SlidersHorizontal}>
        <NumberSettingRow title={t("schedulerIntervalTitle")} description={t("schedulerIntervalDescription")} value={pollIntervalSeconds} min={30} max={3600} suffix={t("secondsSuffix")} onChange={(value) => onSettingsChange({ pollIntervalMinutes: value / 60 })} />
        <SettingRow
          title={t("postClaimHandoffTitle")}
          description={t("postClaimHandoffDescription")}
          checked={settings.postClaimHandoff}
          onChange={set("postClaimHandoff")}
        />
        <NumberSettingRow
          title={t("postClaimHandoffIntervalTitle")}
          description={t("postClaimHandoffIntervalDescription")}
          value={settings.postClaimHandoffIntervalSeconds}
          min={1}
          max={30}
          suffix={t("secondsSuffix")}
          disabled={!settings.postClaimHandoff}
          disabledReason={t("postClaimHandoffDescription")}
          onChange={(value) => onSettingsChange({ postClaimHandoffIntervalSeconds: value })}
        />
        <NumberSettingRow
          title={t("postClaimHandoffMaxTitle")}
          description={t("postClaimHandoffMaxDescription")}
          value={settings.postClaimHandoffMaxSeconds}
          min={5}
          max={120}
          suffix={t("secondsSuffix")}
          disabled={!settings.postClaimHandoff}
          disabledReason={t("postClaimHandoffDescription")}
          onChange={(value) => onSettingsChange({ postClaimHandoffMaxSeconds: value })}
        />
        <SettingRow
          title={t("skipUnfinishableRewardsTitle")}
          description={t("skipUnfinishableRewardsDescription")}
          checked={settings.skipUnfinishableRewards}
          onChange={(value) => onSettingsChange({ skipUnfinishableRewards: value }, { tickAfterSave: true })}
        />
        <NumberSettingRow
          title={t("deadlineSafetyMarginTitle")}
          description={t("deadlineSafetyMarginDescription")}
          value={settings.deadlineSafetyMarginMinutes}
          min={0}
          max={60}
          suffix={t("minutesSuffix")}
          onChange={(value) => onSettingsChange({ deadlineSafetyMarginMinutes: value }, { tickAfterSave: true })}
          disabled={!settings.skipUnfinishableRewards}
          disabledReason={t("deadlineSafetyMarginDisabledReason")}
        />
        <SettingRow title={t("diagnosticLoggingTitle")} description={t("diagnosticLoggingDescription")} checked={settings.diagnosticLogging} onChange={set("diagnosticLogging")} />
        {compatibilityRegistry && compatibilityResolution ? <CompatibilitySettings settings={settings.compatibility} registry={compatibilityRegistry} resolution={compatibilityResolution} onChange={onSettingsChange} /> : null}
      </SettingsSection>
      {onExportCredentials && (
        <SettingsSection title={t("cliExportTitle")} description={t("cliExportDescription")} icon={Terminal}>
          {exportArmed ? (
            <div className="space-y-2 px-1 py-1">
              <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                {t("cliExportConfirm")}
              </p>
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
                className="shrink-0 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                onClick={() => setExportArmed(true)}
              >
                {t("cliExportButton")}
              </button>
            </div>
          )}
        </SettingsSection>
      )}
    </div>
  );
}
