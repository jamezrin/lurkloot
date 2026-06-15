import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Clock3,
  Gift,
  Info,
  Play,
  RotateCcw,
  Settings as SettingsIcon,
} from "lucide-react";
import type { CategorySearchResult, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeSettings, type SettingsPatch } from "@lurkloot/shared/settings";
import { effectiveLocale, isRtlLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import { I18nContext, PopupRuntimeContext } from "./context";
import {
  PLATFORMS,
  RATE_NUDGE_MIN_DAYS,
  SCREENSHOT_VARIANTS,
  SELECTED_PLATFORM_KEY,
} from "./constants";
import type {
  GameItem,
  PopupAdapter,
  PopupInitialState,
  PopupTab,
  ScreenshotVariant,
  TFunction,
} from "./types";
import {
  campaignViewFromCampaign,
  channelViewFromSession,
  fallbackGame,
  gameItemsFromCampaigns,
  isCampaignVisible,
  prioritiesFromOrder,
  sortCampaignsForPopup,
  streamerItemFromFallback,
} from "./viewModels";
import { IconButton, SubTabs, cn } from "./primitives";
import { ActivityLog } from "./activity";
import { AttributionFooter } from "./footer";
import { RateNudge, shouldShowRateNudge } from "./rateNudge";
import { DropsPanel } from "./drops";
import { WatchQueuePanel } from "./watchQueue";
import { AutomationHero, PlatformSwitcher } from "./automation";
import { SettingsView } from "./settings";
export function screenshotVariant(id: string | null | undefined): ScreenshotVariant {
  return SCREENSHOT_VARIANTS[id ?? "twitch-drops"] ?? SCREENSHOT_VARIANTS["twitch-drops"];
}

function isPlatform(value: unknown): value is Platform {
  return value === "twitch" || value === "kick";
}

export function Popup({ adapter, initialState }: { adapter: PopupAdapter; initialState?: PopupInitialState }): React.ReactElement {
  const preview = initialState?.preview ?? false;
  const initialVariant = initialState?.variant ?? screenshotVariant("twitch-drops");
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [overrideCatalog, setOverrideCatalog] = useState<MessageCatalog | undefined>();
  const [fallbackCatalog, setFallbackCatalog] = useState<MessageCatalog | undefined>();
  const [platform, setPlatform] = useState<Platform>(preview ? initialVariant.platform : "twitch");
  const [tab, setTab] = useState<PopupTab>(preview && initialVariant.view === "watchQueue" ? "watchQueue" : "drops");
  const [settingsOpen, setSettingsOpen] = useState(preview && initialVariant.view === "settings");
  const [activityOpen, setActivityOpen] = useState(preview && initialVariant.view === "activity");
  const [refreshing, setRefreshing] = useState(false);
  const [resumingAutomation, setResumingAutomation] = useState(false);
  const [pendingAutomation, setPendingAutomation] = useState<Partial<Record<Platform, boolean>>>({});
  const settingsRef = useRef<ExtensionSettings | null>(null);
  const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const wasSettingsOpen = useRef(settingsOpen);
  const resumeRefreshRun = useRef(0);
  const languageOverride = initialState?.locale ?? snapshot?.settings.languageOverride ?? DEFAULT_SETTINGS.languageOverride;
  const locale = effectiveLocale(languageOverride, adapter.getUiLanguage());
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";
  const t: TFunction = (key, substitutions) => {
    if (languageOverride === "browser") {
      const message = adapter.getMessage(key, substitutions);
      if (message) return message;
    }
    const message = translateFromCatalogs(key, substitutions, overrideCatalog, fallbackCatalog ?? overrideCatalog ?? {});
    return message === key ? adapter.getMessage(key, substitutions) || message : message;
  };

  useEffect(() => {
    let cancelled = false;
    void loadCatalog("en").then((catalog) => {
      if (!cancelled) setFallbackCatalog(catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  useEffect(() => {
    let cancelled = false;
    if (languageOverride === "browser") {
      setOverrideCatalog(undefined);
      return () => {
        cancelled = true;
      };
    }
    void loadCatalog(languageOverride).then((catalog) => {
      if (!cancelled) setOverrideCatalog(catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter, languageOverride]);

  function snapshotWithMergedSettings(nextSnapshot: RuntimeSnapshot): RuntimeSnapshot {
    const settings = mergeSettings(nextSnapshot.settings);
    settingsRef.current = settings;
    return { ...nextSnapshot, settings };
  }

  function snapshotPreservingLocalSettings(nextSnapshot: RuntimeSnapshot): RuntimeSnapshot {
    const settings = settingsRef.current ?? mergeSettings(nextSnapshot.settings);
    settingsRef.current = settings;
    return { ...nextSnapshot, settings };
  }

  function hasTemporaryDisabledSession(nextSnapshot: RuntimeSnapshot, currentSettings: ExtensionSettings): boolean {
    return (["twitch", "kick"] as Platform[]).some((resumePlatform) => (
      currentSettings.running
      && currentSettings.platform[resumePlatform].enabled
      && nextSnapshot.state.sessions[resumePlatform].status === "paused"
      && nextSnapshot.state.sessions[resumePlatform].message === "Automation disabled"
    ));
  }

  useEffect(() => {
    void Promise.all([
      adapter.send<RuntimeSnapshot>({ type: "getSnapshot" }),
      preview
        ? Promise.resolve({ [SELECTED_PLATFORM_KEY]: initialVariant.platform })
        : adapter.getStorage(SELECTED_PLATFORM_KEY),
    ]).then(([nextSnapshot, stored]) => {
      const savedPlatform = stored[SELECTED_PLATFORM_KEY];
      if (isPlatform(savedPlatform)) setPlatform(savedPlatform);
      setSnapshot(snapshotWithMergedSettings(nextSnapshot));
    });
  }, [adapter, initialVariant.platform, preview]);

  useEffect(() => {
    if (preview || !settingsOpen || !adapter.connectSettingsSession) return;
    return adapter.connectSettingsSession();
  }, [adapter, preview, settingsOpen]);

  useEffect(() => {
    if (!wasSettingsOpen.current || settingsOpen) {
      wasSettingsOpen.current = settingsOpen;
      return;
    }

    wasSettingsOpen.current = settingsOpen;
    const currentSettings = settingsRef.current;
    const shouldResume = Boolean(currentSettings?.running && Object.values(currentSettings.platform).some((platformSettings) => platformSettings.enabled));
    if (!shouldResume) return;

    const run = resumeRefreshRun.current + 1;
    resumeRefreshRun.current = run;
    setResumingAutomation(true);

    void settingsSaveQueue.current.catch(() => undefined).then(async () => {
      for (let attempt = 0; attempt < 12 && resumeRefreshRun.current === run; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const nextSnapshot = await adapter.send<RuntimeSnapshot>({ type: "getSnapshot" });
        const nextSettings = settingsRef.current ?? mergeSettings(nextSnapshot.settings);
        setSnapshot(snapshotPreservingLocalSettings(nextSnapshot));
        if (!hasTemporaryDisabledSession(nextSnapshot, nextSettings)) break;
      }
      if (resumeRefreshRun.current === run) setResumingAutomation(false);
    });
  }, [adapter, settingsOpen]);

  useEffect(() => {
    return () => {
      resumeRefreshRun.current += 1;
    };
  }, []);

  // Keep the snapshot (and its Activity log) live while the popup is open, so
  // background scheduler ticks are reflected without needing a manual refresh.
  useEffect(() => {
    if (preview) return;
    const interval = setInterval(() => {
      void adapter.send<RuntimeSnapshot>({ type: "getSnapshot" }).then((nextSnapshot) => {
        // Keep the locally-held settings rather than the refreshed ones so an
        // in-flight edit is never clobbered mid-typing. The tradeoff: a setting
        // changed by the background (e.g. startup auto-pausing `running`) is not
        // reflected until the popup is reopened.
        setSnapshot((current) => {
          if (current) {
            settingsRef.current = current.settings;
            return { ...nextSnapshot, settings: current.settings };
          }
          return snapshotPreservingLocalSettings(nextSnapshot);
        });
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [adapter, preview]);

  function selectPlatform(nextPlatform: Platform): void {
    setPlatform(nextPlatform);
    if (!preview) void adapter.setStorage({ [SELECTED_PLATFORM_KEY]: nextPlatform });
  }

  async function updateSettings(patch: SettingsPatch, options?: { tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }): Promise<void> {
    if (!snapshot) return;
    const settingsPatch = patch;
    const nextSettings = applySettingsPatch(settingsRef.current ?? snapshot.settings, settingsPatch);
    settingsRef.current = nextSettings;
    setSnapshot((current) => current ? { ...current, settings: nextSettings } : current);
    const save = settingsSaveQueue.current.catch(() => undefined).then(async () => {
      const nextSnapshot = await adapter.send<RuntimeSnapshot>({
        type: "saveSettings",
        settingsPatch,
        tickAfterSave: options?.tickAfterSave,
        tickAfterSavePlatforms: options?.tickAfterSavePlatforms,
      });
      setSnapshot({ ...nextSnapshot, settings: settingsRef.current ?? mergeSettings(nextSnapshot.settings) });
    });
    settingsSaveQueue.current = save;
    await save;
  }

  async function setAutomation(enabled: boolean): Promise<void> {
    if (!snapshot || pendingAutomation[platform] != null) return;
    const pendingPlatform = platform;
    setPendingAutomation((current) => ({ ...current, [pendingPlatform]: enabled }));
    try {
      setSnapshot(snapshotWithMergedSettings(await adapter.send<RuntimeSnapshot>({ type: "setAutomation", platform: pendingPlatform, enabled })));
    } catch (error) {
      console.error("Failed to update automation", error);
    } finally {
      setPendingAutomation((current) => {
        const { [pendingPlatform]: _completed, ...rest } = current;
        return rest;
      });
    }
  }

  async function refreshNow(): Promise<void> {
    if (!snapshot || refreshing) return;
    setRefreshing(true);
    try {
      setSnapshot(snapshotWithMergedSettings(await adapter.send<RuntimeSnapshot>({ type: "tickNow" })));
    } finally {
      setRefreshing(false);
    }
  }

  async function searchCategories(searchPlatform: Platform, query: string): Promise<CategorySelection[]> {
    const result = await adapter.send<CategorySearchResult>({ type: "searchCategories", platform: searchPlatform, query });
    return result.categories;
  }

  if (!snapshot) {
    return (
      <PopupRuntimeContext.Provider value={{ adapter, preview }}>
      <I18nContext.Provider value={{ t, dir, locale }}>
        <main dir={dir} className="grid h-[600px] w-[400px] place-items-center border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400" data-platform="twitch">
          {t("loading")}
        </main>
      </I18nContext.Provider>
      </PopupRuntimeContext.Provider>
    );
  }

  const settings = mergeSettings(snapshot.settings);
  const excludedIds = new Set(settings.excludedCampaignIds);
  const rawCampaigns = sortCampaignsForPopup(snapshot.state.campaigns[platform].filter((campaign) => isCampaignVisible(campaign, settings, excludedIds)), settings);
  const session = snapshot.state.sessions[platform];
  const sessionChannel = channelViewFromSession(session);
  const campaigns = rawCampaigns.map((campaign, index) => campaignViewFromCampaign(campaign, index, session, excludedIds.has(campaign.id)));
  const games = gameItemsFromCampaigns(snapshot.state.campaigns[platform], t);
  // Categories that currently have active drop campaigns, surfaced as one-tap
  // "Has active drops" suggestions in the category filter editor (zero network).
  const dropCategorySuggestions: Record<Platform, GameItem[]> = {
    twitch: gameItemsFromCampaigns(snapshot.state.campaigns.twitch, t),
    kick: gameItemsFromCampaigns(snapshot.state.campaigns.kick, t),
  };
  const gameMap = Object.fromEntries(games.map((game) => [game.id, game]));
  const watchQueueChannels = settings.platform[platform].watchQueueChannels;
  const watchQueue = watchQueueChannels.map((username) => streamerItemFromFallback(username, session, t));
  const automation = {
    twitch: pendingAutomation.twitch ?? (settings.running && settings.platform.twitch.enabled),
    kick: pendingAutomation.kick ?? (settings.running && settings.platform.kick.enabled),
  };
  const enabled = automation[platform];
  const automationPending = pendingAutomation[platform] != null;
  const activeCampaign = campaigns.find((campaign) => campaign.farmingChannel);
  const farmingChannel = activeCampaign?.farmingChannel ?? sessionChannel;

  return (
      <PopupRuntimeContext.Provider value={{ adapter, preview }}>
      <I18nContext.Provider value={{ t, dir, locale }}>
    <main
      dir={dir}
      data-platform={platform}
      className="flex h-[600px] w-[400px] flex-col overflow-hidden border border-zinc-200/80 bg-zinc-50 shadow-2xl shadow-black/30 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="relative shrink-0 border-b border-zinc-200/70 bg-white/85 px-3 pb-3 pt-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-linear-to-r from-transparent via-[var(--accent)] to-transparent" />
        <header className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/logo-ring.svg" alt="Lurkloot" width={36} height={36} className="h-9 w-9 rounded-xl shadow-sm" style={{ boxShadow: "0 4px 14px -4px var(--accent-glow)" }} />
            <div className="min-w-0 leading-tight">
              <div className="font-display truncate text-[15px] font-bold tracking-normal text-zinc-900 dark:text-zinc-50">Lurkloot</div>
              <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: enabled ? "var(--accent)" : "#a1a1aa" }} />
                {settingsOpen ? t("settingsTitle") : activityOpen ? t("activityTitle") : resumingAutomation ? t("resumingAutomation") : `${enabled ? t("activeStatus") : t("pausedStatus")} · ${PLATFORMS[platform].label}`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {settingsOpen || activityOpen ? (
              <IconButton
                label={t("back")}
                onClick={() => { setSettingsOpen(false); setActivityOpen(false); }}
              >
                <ArrowLeft size={16} />
              </IconButton>
            ) : (
              <>
                <IconButton label={t("refreshSchedule")} onClick={() => void refreshNow()} disabled={refreshing}>
                  <RotateCcw size={16} className={cn(refreshing && "animate-spin")} />
                </IconButton>
                <IconButton label={t("openActivity")} onClick={() => { setActivityOpen(true); setSettingsOpen(false); }}>
                  <Clock3 size={16} />
                </IconButton>
                <IconButton label={t("openSettings")} onClick={() => { setSettingsOpen(true); setActivityOpen(false); }}>
                  <SettingsIcon size={16} />
                </IconButton>
              </>
            )}
          </div>
        </header>
        {!settingsOpen && !activityOpen ? (
          <PlatformSwitcher
            active={platform}
            automation={automation}
            onChange={selectPlatform}
          />
        ) : null}
      </div>

      <div className="nice-scroll min-h-0 flex-1 overflow-y-auto text-zinc-700 dark:text-zinc-300">
        <div className="space-y-3 p-3">
          <AnimatePresence mode="wait" initial={false}>
            {settingsOpen ? (
              <motion.div key="settings" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 14 }} transition={{ duration: 0.18 }} className="space-y-2.5">
                <SettingsView suggestions={dropCategorySuggestions} onSearchCategories={searchCategories} settings={settings} onSettingsChange={updateSettings} initialPlatform={platform} />
              </motion.div>
            ) : activityOpen ? (
              <motion.div key="activity" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 14 }} transition={{ duration: 0.18 }}>
                <ActivityLog events={snapshot.state.events} platform={platform} lastTickAt={snapshot.state.lastTickAt} enabledLogLevels={settings.enabledLogLevels} />
              </motion.div>
            ) : (
              <motion.div key="main" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.18 }} className="space-y-3">
                <AnimatePresence initial={false}>
                  {!preview && shouldShowRateNudge(snapshot.state.installedAt, settings.rateNudgeStatus, new Date(), RATE_NUDGE_MIN_DAYS) ? (
                    <RateNudge
                      key="rate-nudge"
                      onRate={() => void updateSettings({ rateNudgeStatus: "rated" })}
                      onDismiss={() => void updateSettings({ rateNudgeStatus: "dismissed" })}
                    />
                  ) : null}
                </AnimatePresence>
                <AutomationHero platformLabel={PLATFORMS[platform].label} enabled={enabled} pending={automationPending} farmingTitle={activeCampaign?.title} farmingChannel={farmingChannel} statusMessage={resumingAutomation ? t("resumingAutomation") : session.message} onChange={setAutomation} />
                <div className="flex items-start gap-2 rounded-xl px-2.5 py-2 text-[11px]" style={{ backgroundColor: "var(--accent-softer)" }}>
                  <Info size={13} className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
                  <p className="leading-snug text-zinc-600 dark:text-zinc-300">
                    {t("priorityHint")}
                  </p>
                </div>
                <SubTabs
                  tabs={[
                    { id: "drops", label: t("dropsTab"), icon: Gift, count: campaigns.length },
                    { id: "watchQueue", label: t("watchQueueTab"), icon: Play, count: `${watchQueue.length}/20` },
                  ]}
                  active={tab}
                  onChange={setTab}
                />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
                    {tab === "drops" ? (
                      <DropsPanel
                        campaigns={campaigns}
                        gameMap={gameMap}
                        onReorder={(ordered) => updateSettings({ campaignPriorities: prioritiesFromOrder(ordered) })}
                        onToggleExclude={(id) => {
                          const next = new Set(settings.excludedCampaignIds);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return updateSettings({ excludedCampaignIds: [...next] }, { tickAfterSave: true });
                        }}
                      />
                    ) : (
                      <WatchQueuePanel
                        platform={platform}
                        streamers={watchQueue}
                        onChange={(ordered) => updateSettings(
                          {
                            platform: {
                              [platform]: {
                                watchQueueChannels: ordered.map((streamer) => streamer.id),
                              },
                            },
                          },
                          { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
                        )}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      {settingsOpen ? <AttributionFooter version={adapter.version} /> : null}
    </main>
    </I18nContext.Provider>
    </PopupRuntimeContext.Provider>
  );
}
