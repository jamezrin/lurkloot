import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  Gift,
  Play,
  Radio,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from "lucide-react";
import type {
  CategorySelection,
  ExtensionSettings,
  LanguageOverride,
  Platform,
} from "@stream-autopilot/shared/models";
import type { SettingsPatch } from "@stream-autopilot/shared/settings";
import { LOCALE_OPTIONS } from "@stream-autopilot/shared/i18n";
import {
  CampaignFilterSettingRow,
  ForgetExcludedCampaignsRow,
  LogLevelSettingRow,
  NumberSettingRow,
  SelectSettingRow,
  SettingRow,
  SettingsSection,
} from "./settingsControls";
import { PlatformSettingsGroup, SettingsPlatformSwitch } from "./settingsPlatform";
import { useT } from "./context";
import type { GameItem } from "./types";

export function SettingsView({ suggestions, onSearchCategories, settings, onSettingsChange, initialPlatform = "twitch" }: {
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: { tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }): Promise<void>;
  initialPlatform?: Platform;
}) {
  const t = useT();
  const [platformTab, setPlatformTab] = useState<Platform>(initialPlatform);
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
            <PlatformSettingsGroup platform={platformTab} suggestions={suggestions[platformTab]} settings={settings} onFarmAllCategoriesChange={setPlatformFarmAllCategories(platformTab)} onCategoriesChange={setPlatformCategories(platformTab)} onSearchCategories={(query) => onSearchCategories(platformTab, query)} onExcludedChannelsChange={setPlatformExcludedChannels(platformTab)} />
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
        <LogLevelSettingRow value={settings.enabledLogLevels} onChange={(levels) => onSettingsChange({ enabledLogLevels: levels })} />
      </SettingsSection>
    </div>
  );
}
