import React from "react";
import { Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import type { CategorySelection, ExtensionSettings, LanguageOverride, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { LOCALE_OPTIONS } from "@lurkloot/shared/i18n";
import { PLATFORMS } from "./constants";
import {
  CampaignFilterSettingRow,
  ForgetExcludedCampaignsRow,
  NumberSettingRow,
  SelectSettingRow,
  SettingRow,
} from "./settingsControls";
import { PlatformCategorySettings, PlatformExcludedChannels } from "./settingsPlatform";
import { PlatformCompatibilitySettings } from "./compatibilitySettings";
import type { SettingsEntryNode, SettingsGroupNode, SettingsSectionNode, TranslateFn } from "./settingsSearch";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export interface SettingsChangeOptions {
  tickAfterSave?: boolean;
  tickAfterSavePlatforms?: Platform[];
}

// This context builds the full inventory of *settings*. The CLI credential
// export is deliberately not a registry entry: it is an action (not a
// setting), it owns its own arm/confirm state, and it renders as a
// standalone button at the foot of the settings view. See settings.tsx.
export interface SettingsRegistryContext {
  t: TranslateFn;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: SettingsChangeOptions): Promise<void>;
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  compatibilityResolution?: PopupCompatibilityResolution;
}

export interface SettingsEntryDef extends SettingsEntryNode {
  render(): React.ReactNode;
}

export type SettingsGroupDef = SettingsGroupNode<SettingsEntryDef>;

export interface SettingsSectionDef extends SettingsSectionNode<SettingsEntryDef> {
  // Exactly one of icon/iconNode is set per section: General uses a plain
  // lucide icon, while Twitch/Kick use a colored platform mark (iconNode) so
  // the two sections don't render identically.
  icon?: LucideIcon;
  iconNode?: React.ReactNode;
}

// The shape of a settings patch's `platform` block, keyed by platform. Typing
// platformPatch's second argument against `PlatformPatch[P]` (rather than
// `Record<string, unknown>`) means a typo'd key or a wrong-shaped value fails
// `pnpm typecheck` instead of silently writing a dead key that mergeSettings
// drops at the next save.
type PlatformPatch = NonNullable<SettingsPatch["platform"]>;

export function buildSettingsRegistry(ctx: SettingsRegistryContext): SettingsSectionDef[] {
  const { t, settings, onSettingsChange } = ctx;
  const setFlag = (key: keyof ExtensionSettings) => (value: boolean) => void onSettingsChange({ [key]: value } as SettingsPatch);
  const tabPlaybackDisabled = settings.tablessMode;
  const tabPlaybackDisabledReason = t("tablessDisabledReason");

  const platformPatch = <P extends Platform>(platform: P, patch: NonNullable<PlatformPatch[P]>) =>
    onSettingsChange({ platform: { [platform]: patch } } as SettingsPatch, { tickAfterSave: true, tickAfterSavePlatforms: [platform] });

  const general: SettingsSectionDef = {
    id: "general",
    titleKey: "settingsSectionGeneral",
    icon: SettingsIcon,
    rows: [],
    groups: [
      {
        id: "general.appearance",
        titleKey: "settingsGroupAppearance",
        entries: [
          {
            id: "general.appearance.language",
            titleKey: "settingsLanguageTitle",
            descriptionKey: "settingsLanguageDescription",
            render: () => (
              <SelectSettingRow<LanguageOverride>
                title={t("settingsLanguageTitle")}
                description={t("settingsLanguageDescription")}
                value={settings.languageOverride}
                options={LOCALE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.value === "browser" ? t(option.labelKey) : `${option.nativeName} (${t(option.labelKey)})`,
                }))}
                onChange={(value) => void onSettingsChange({ languageOverride: value })}
              />
            ),
          },
          {
            id: "general.appearance.autoStart",
            titleKey: "autoStartTitle",
            descriptionKey: "autoStartDescription",
            render: () => <SettingRow title={t("autoStartTitle")} description={t("autoStartDescription")} checked={settings.autoStartDropFarming} onChange={setFlag("autoStartDropFarming")} />,
          },
          {
            id: "general.appearance.pauseOnManualWatch",
            titleKey: "pauseManualTitle",
            descriptionKey: "pauseManualDescription",
            render: () => <SettingRow title={t("pauseManualTitle")} description={t("pauseManualDescription")} checked={settings.pauseOnManualWatch} onChange={setFlag("pauseOnManualWatch")} />,
          },
          {
            id: "general.appearance.hideTips",
            titleKey: "hideTipsTitle",
            descriptionKey: "hideTipsDescription",
            render: () => <SettingRow title={t("hideTipsTitle")} description={t("hideTipsDescription")} checked={!settings.showTips} onChange={(hideTips) => void onSettingsChange({ showTips: !hideTips })} />,
          },
        ],
      },
      {
        id: "general.notifications",
        titleKey: "settingsGroupNotifications",
        entries: [
          {
            id: "general.notifications.rewardEarned",
            titleKey: "rewardEarnedTitle",
            descriptionKey: "rewardEarnedDescription",
            render: () => <SettingRow title={t("rewardEarnedTitle")} description={t("rewardEarnedDescription")} checked={settings.notifyRewardEarned} onChange={setFlag("notifyRewardEarned")} />,
          },
          {
            id: "general.notifications.noDropsLeft",
            titleKey: "noDropsLeftTitle",
            descriptionKey: "noDropsLeftDescription",
            render: () => <SettingRow title={t("noDropsLeftTitle")} description={t("noDropsLeftDescription")} checked={settings.notifyNoDropsLeft} onChange={setFlag("notifyNoDropsLeft")} />,
          },
        ],
      },
      {
        id: "general.drops",
        titleKey: "settingsGroupDrops",
        entries: [
          {
            id: "general.drops.autoClaim",
            titleKey: "autoClaimTitle",
            descriptionKey: "autoClaimDescription",
            render: () => <SettingRow title={t("autoClaimTitle")} description={t("autoClaimDescription")} checked={settings.autoClaim} onChange={setFlag("autoClaim")} />,
          },
          {
            id: "general.drops.priorityMode",
            titleKey: "campaignPriorityTitle",
            descriptionKey: "campaignPriorityDescription",
            render: () => (
              <SelectSettingRow
                title={t("campaignPriorityTitle")}
                description={t("campaignPriorityDescription")}
                value={settings.priorityMode}
                options={[
                  { value: "priority_list_only", label: t("priorityListOnly") },
                  { value: "ending_soonest", label: t("endingSoonest") },
                  { value: "lowest_availability", label: t("lowAvailabilityFirst") },
                ]}
                onChange={(value) => void onSettingsChange({ priorityMode: value }, { tickAfterSave: true })}
              />
            ),
          },
          {
            id: "general.drops.watchQueueFallbackOnly",
            titleKey: "watchQueueFallbackOnlyTitle",
            descriptionKey: "watchQueueFallbackOnlyDescription",
            render: () => <SettingRow title={t("watchQueueFallbackOnlyTitle")} description={t("watchQueueFallbackOnlyDescription")} checked={settings.watchQueueFallbackOnly} onChange={setFlag("watchQueueFallbackOnly")} />,
          },
          {
            id: "general.drops.campaignVisibility",
            titleKey: "visibleCampaignsTitle",
            descriptionKey: "visibleCampaignsDescription",
            render: () => <CampaignFilterSettingRow value={settings.campaignVisibility} onChange={(campaignVisibility) => void onSettingsChange({ campaignVisibility })} />,
          },
          {
            id: "general.drops.forgetExcluded",
            titleKey: "forgetExcludedTitle",
            descriptionKey: "forgetExcludedDescription",
            render: () => <ForgetExcludedCampaignsRow count={settings.excludedCampaignIds.length} onForget={() => void onSettingsChange({ excludedCampaignIds: [] }, { tickAfterSave: true })} />,
          },
        ],
      },
      {
        id: "general.farmingTabs",
        titleKey: "settingsGroupFarmingTabs",
        entries: [
          {
            id: "general.farmingTabs.tabless",
            titleKey: "tablessTitle",
            descriptionKey: "tablessDescription",
            render: () => <SettingRow title={t("tablessTitle")} description={t("tablessDescription")} checked={settings.tablessMode} onChange={(value) => void onSettingsChange({ tablessMode: value }, { tickAfterSave: true })} />,
          },
          {
            id: "general.farmingTabs.autoClose",
            titleKey: "autoCloseTabsTitle",
            descriptionKey: "autoCloseTabsDescription",
            render: () => <SettingRow title={t("autoCloseTabsTitle")} description={t("autoCloseTabsDescription")} checked={settings.autoCloseFinishedDrops} onChange={setFlag("autoCloseFinishedDrops")} />,
          },
          {
            id: "general.farmingTabs.mute",
            titleKey: "muteTabsTitle",
            descriptionKey: "muteTabsDescription",
            render: () => <SettingRow title={t("muteTabsTitle")} description={t("muteTabsDescription")} checked={settings.muteFarmingTabs} onChange={setFlag("muteFarmingTabs")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />,
          },
          {
            id: "general.farmingTabs.keepUnmuted",
            titleKey: "keepVideosUnmutedTitle",
            descriptionKey: "keepVideosUnmutedDescription",
            render: () => <SettingRow title={t("keepVideosUnmutedTitle")} description={t("keepVideosUnmutedDescription")} checked={settings.keepFarmingVideosUnmuted !== false} onChange={setFlag("keepFarmingVideosUnmuted")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />,
          },
          {
            id: "general.farmingTabs.adFocus",
            titleKey: "adFocusTitle",
            descriptionKey: "adFocusDescription",
            render: () => (
              <SelectSettingRow
                title={t("adFocusTitle")}
                description={t("adFocusDescription")}
                value={settings.adFocusMode ?? "window"}
                options={[
                  { value: "none", label: t("off") },
                  { value: "tab", label: t("tabOnly") },
                  { value: "window", label: t("tabAndWindow") },
                ]}
                onChange={(value) => void onSettingsChange({ adFocusMode: value })}
                disabled={tabPlaybackDisabled}
                disabledReason={tabPlaybackDisabledReason}
              />
            ),
          },
        ],
      },
      {
        // Scheduler tuning and diagnostics are one group, not two: each section
        // gets exactly one advanced group, and a lone "Diagnostics" group would
        // hold a single toggle.
        id: "general.advanced",
        titleKey: "settingsGroupAdvanced",
        advanced: true,
        entries: [
          {
            id: "general.advanced.pollInterval",
            titleKey: "schedulerIntervalTitle",
            descriptionKey: "schedulerIntervalDescription",
            render: () => <NumberSettingRow title={t("schedulerIntervalTitle")} description={t("schedulerIntervalDescription")} value={Math.round(settings.pollIntervalMinutes * 60)} min={30} max={3600} suffix={t("secondsSuffix")} onChange={(value) => void onSettingsChange({ pollIntervalMinutes: value / 60 })} />,
          },
          {
            id: "general.advanced.postClaimHandoff",
            titleKey: "postClaimHandoffTitle",
            descriptionKey: "postClaimHandoffDescription",
            render: () => <SettingRow title={t("postClaimHandoffTitle")} description={t("postClaimHandoffDescription")} checked={settings.postClaimHandoff} onChange={setFlag("postClaimHandoff")} />,
          },
          {
            id: "general.advanced.postClaimHandoffInterval",
            titleKey: "postClaimHandoffIntervalTitle",
            descriptionKey: "postClaimHandoffIntervalDescription",
            render: () => <NumberSettingRow title={t("postClaimHandoffIntervalTitle")} description={t("postClaimHandoffIntervalDescription")} value={settings.postClaimHandoffIntervalSeconds} min={1} max={30} suffix={t("secondsSuffix")} disabled={!settings.postClaimHandoff} disabledReason={t("postClaimHandoffDescription")} onChange={(value) => void onSettingsChange({ postClaimHandoffIntervalSeconds: value })} />,
          },
          {
            id: "general.advanced.postClaimHandoffMax",
            titleKey: "postClaimHandoffMaxTitle",
            descriptionKey: "postClaimHandoffMaxDescription",
            render: () => <NumberSettingRow title={t("postClaimHandoffMaxTitle")} description={t("postClaimHandoffMaxDescription")} value={settings.postClaimHandoffMaxSeconds} min={5} max={120} suffix={t("secondsSuffix")} disabled={!settings.postClaimHandoff} disabledReason={t("postClaimHandoffDescription")} onChange={(value) => void onSettingsChange({ postClaimHandoffMaxSeconds: value })} />,
          },
          {
            id: "general.advanced.skipUnfinishable",
            titleKey: "skipUnfinishableRewardsTitle",
            descriptionKey: "skipUnfinishableRewardsDescription",
            render: () => <SettingRow title={t("skipUnfinishableRewardsTitle")} description={t("skipUnfinishableRewardsDescription")} checked={settings.skipUnfinishableRewards} onChange={(value) => void onSettingsChange({ skipUnfinishableRewards: value }, { tickAfterSave: true })} />,
          },
          {
            id: "general.advanced.deadlineSafetyMargin",
            titleKey: "deadlineSafetyMarginTitle",
            descriptionKey: "deadlineSafetyMarginDescription",
            render: () => <NumberSettingRow title={t("deadlineSafetyMarginTitle")} description={t("deadlineSafetyMarginDescription")} value={settings.deadlineSafetyMarginMinutes} min={0} max={60} suffix={t("minutesSuffix")} onChange={(value) => void onSettingsChange({ deadlineSafetyMarginMinutes: value }, { tickAfterSave: true })} disabled={!settings.skipUnfinishableRewards} disabledReason={t("deadlineSafetyMarginDisabledReason")} />,
          },
          {
            id: "general.advanced.diagnosticLogging",
            titleKey: "diagnosticLoggingTitle",
            descriptionKey: "diagnosticLoggingDescription",
            render: () => <SettingRow title={t("diagnosticLoggingTitle")} description={t("diagnosticLoggingDescription")} checked={settings.diagnosticLogging} onChange={setFlag("diagnosticLogging")} />,
          },
        ],
      },
    ],
  };

  const platformSection = (platform: Platform, titleKey: string): SettingsSectionDef => {
    // The old SettingsPlatformSwitch rendered its selected platform this way;
    // it's the only styling carried forward now that the switch is gone.
    const details = PLATFORMS[platform];
    const iconNode = (
      <span
        className="flex h-4 w-4 items-center justify-center rounded text-[10px] font-black"
        style={{ backgroundColor: details.color, color: platform === "kick" ? "#07140a" : "#fff" }}
      >
        {details.mark}
      </span>
    );

    const claimEntry: SettingsEntryDef = platform === "twitch"
      ? {
        id: "twitch.autoClaimChannelPoints",
        titleKey: "autoClaimChannelPointsTitle",
        descriptionKey: "autoClaimChannelPointsDescription",
        render: () => <SettingRow title={t("autoClaimChannelPointsTitle")} description={t("autoClaimChannelPointsDescription")} checked={settings.platform.twitch.autoClaimChannelPoints} onChange={(value) => void onSettingsChange({ platform: { twitch: { autoClaimChannelPoints: value } } })} />,
      }
      : {
        id: "kick.autoClaimChallenges",
        titleKey: "autoClaimChallengesTitle",
        descriptionKey: "autoClaimChallengesDescription",
        render: () => <SettingRow title={t("autoClaimChallengesTitle")} description={t("autoClaimChallengesDescription")} checked={settings.platform.kick.autoClaimChallenges} onChange={(value) => void onSettingsChange({ platform: { kick: { autoClaimChallenges: value } } })} />,
      };

    const groups: SettingsGroupDef[] = [
      {
        id: `${platform}.categories`,
        titleKey: "settingsGroupCategories",
        entries: [
          {
            id: `${platform}.categories.farmAll`,
            titleKey: "farmAllCategoriesTitle",
            descriptionKey: "farmAllCategoriesDescription",
            // "Farm drops in every $1 category" — without this the search
            // haystack holds the literal "$1" instead of "Twitch"/"Kick", and
            // a query for the platform name never finds this entry.
            descriptionSubstitution: details.label,
            render: () => (
              <PlatformCategorySettings
                platform={platform}
                suggestions={ctx.suggestions[platform]}
                settings={settings}
                onFarmAllCategoriesChange={(farmAllCategories) => void platformPatch(platform, { farmAllCategories })}
                onCategoriesChange={(categories) => void platformPatch(platform, { categories })}
                onSearchCategories={(query) => ctx.onSearchCategories(platform, query)}
              />
            ),
          },
        ],
      },
      {
        id: `${platform}.channels`,
        titleKey: "settingsGroupExcludedChannels",
        entries: [
          {
            id: `${platform}.channels.excluded`,
            titleKey: "excludedChannelsTitle",
            descriptionKey: "excludedChannelsDescription",
            render: () => (
              <PlatformExcludedChannels
                platform={platform}
                settings={settings}
                onExcludedChannelsChange={(excludedChannels) => void platformPatch(platform, { excludedChannels })}
              />
            ),
          },
        ],
      },
    ];

    if (ctx.compatibilityRegistry && ctx.compatibilityResolution) {
      const compatibilityRegistry = ctx.compatibilityRegistry;
      const compatibilityResolution = ctx.compatibilityResolution;
      groups.push({
        id: `${platform}.compatibility`,
        titleKey: "settingsGroupCompatibility",
        advanced: true,
        entries: [
          {
            id: `${platform}.compatibility.rows`,
            titleKey: "compatibilitySectionTitle",
            descriptionKey: "compatibilitySectionDescription",
            render: () => (
              <PlatformCompatibilitySettings
                platform={platform}
                settings={settings.compatibility}
                registry={compatibilityRegistry}
                resolution={compatibilityResolution}
                onChange={(patch) => void onSettingsChange(patch)}
              />
            ),
          },
        ],
      });
    }

    return { id: platform, titleKey, iconNode, rows: [claimEntry], groups };
  };

  return [
    general,
    platformSection("twitch", "settingsSectionTwitch"),
    platformSection("kick", "settingsSectionKick"),
  ];
}
