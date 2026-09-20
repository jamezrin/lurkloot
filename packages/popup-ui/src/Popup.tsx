import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Clock3,
  RotateCcw,
  Settings as SettingsIcon,
} from "lucide-react";
import type { ActivityPage, CategorySearchResult, CliCredentialBlob, DiagnosticsExport, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { CategorySelection, ExtensionSettings, Platform, TwitchExtensionProviderId } from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeSettings, type SettingsPatch } from "@lurkloot/shared/settings";
import { buildSettingsExportPayload, parseSettingsImportPayload } from "@lurkloot/shared/settingsExport";
import { effectiveLocale, isRtlLocale, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import { buildFailureReport } from "@lurkloot/shared/failureReport";
import { I18nContext, PopupRuntimeContext } from "./context";
import { createTranslator } from "./translator";
import { WorkspaceRail, viewForPlatform, type PopupView } from "./shell";
import { GamesPanel } from "./games";
import {
  GITHUB_STAR_NUDGE_MIN_DAYS,
  PLATFORM_INVENTORY_URLS,
  PLATFORMS,
  RATE_NUDGE_MIN_DAYS,
  SCREENSHOT_VARIANTS,
  SCREENSHOT_WATCHLIST_LIVE,
  SELECTED_PLATFORM_KEY,
} from "./constants";
import type {
  GameItem,
  PopupAdapter,
  PopupInitialState,
  ScreenshotVariant,
  TFunction,
} from "./types";
import { variantShowsPopup } from "./types";
import {
  campaignViewFromCampaign,
  channelViewFromSession,
  fallbackGame,
  gameItemsFromCampaigns,
  campaignSection,
  pinCampaignAt,
  rankCampaigns,
  unpinCampaign,
  streamerItemFromFallback,
} from "./viewModels";
import { IconButton, cn } from "./primitives";
import { ActivityLog } from "./activity";
import {
  advanceActivityRequestScope,
  applyActivityMutationForRequest,
  beginActivityMutation,
  beginDiagnosticsExport,
  buildActivityExport,
  buildDiagnosticsExportFilename,
  createActivityMutationSequence,
  createActivityRequestScope,
  createActivityStream,
  createDiagnosticsExportRequest,
  isActivityRequestCurrent,
  isDiagnosticsExportCurrent,
  type ActivityRequestScope,
  type ActivityStream,
} from "./activity.logic";
import { AttributionFooter } from "./footer";
import { RateNudge, shouldShowGithubStarNudge, shouldShowRateNudge } from "./rateNudge";
import { GithubStarNudge } from "./githubStarNudge";
import { popupNoticeSlot } from "./popupNoticeSlot";
import { UpdateNotice } from "./updateNotice";
import { QueuePanel } from "./queue";
import { CompletedPanel } from "./completed";
import { CriticalFailurePanel } from "./criticalFailure";
import { openHttpsLink } from "./links";
import { IdleWatchlistPanel } from "./idleWatchlist";
import { AutomationStatusLine, PlatformBar } from "./automation";
import { automationPresentation, type AutomationPresentation } from "./automationStatus";
import { changeTwitchExtensionEnabled, TwitchExtensionDrops } from "./twitchExtensions";
import { SettingsView } from "./settings";
import { TipsBanner } from "./tips";
export function screenshotVariant(id: string | null | undefined): ScreenshotVariant {
  return SCREENSHOT_VARIANTS[id ?? "drops"] ?? SCREENSHOT_VARIANTS.drops;
}

function isPlatform(value: unknown): value is Platform {
  return value === "twitch" || value === "kick";
}

export function Popup({ adapter, initialState }: { adapter: PopupAdapter; initialState?: PopupInitialState }): React.ReactElement {
  const preview = initialState?.preview ?? false;
  const initialVariant = initialState?.variant ?? screenshotVariant("drops");
  const watchlistShot = preview && variantShowsPopup(initialVariant) && initialVariant.view === "watchlist";
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [overrideCatalog, setOverrideCatalog] = useState<MessageCatalog | undefined>();
  const [fallbackCatalog, setFallbackCatalog] = useState<MessageCatalog | undefined>();
  const [platform, setPlatform] = useState<Platform>(
    preview && variantShowsPopup(initialVariant) ? initialVariant.platform : "twitch",
  );
  const [watchlistAdding, setWatchlistAdding] = useState(false);
  // One destination at a time. Platform is the other axis and is independent of
  // it, so every view keeps working on either platform.
  const [view, setView] = useState<PopupView>(() => {
    if (!preview || !variantShowsPopup(initialVariant)) return "queue";
    if (initialVariant.view === "settings") return "settings";
    return initialVariant.view === "watchlist" ? "watchlist" : "queue";
  });
  const [settingsOpenGeneration, setSettingsOpenGeneration] = useState(0);
  const settingsOpen = view === "settings";
  const activityOpen = view === "activity";
  const [activityStream, setActivityStream] = useState<ActivityStream>(createActivityStream);
  const [diagnosticStream, setDiagnosticStream] = useState<ActivityStream>(createActivityStream);
  const [reportEvents, setReportEvents] = useState<ActivityHistoryRecord[]>([]);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticSearchQuery, setDiagnosticSearchQuery] = useState("");
  const [loadingMoreActivity, setLoadingMoreActivity] = useState(false);
  const [clearActivityArmed, setClearActivityArmed] = useState(false);
  const [clearingActivity, setClearingActivity] = useState(false);
  const [clearActivityFailed, setClearActivityFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingChangelogVersion, setPendingChangelogVersion] = useState<string>();
  const [pendingAutomation, setPendingAutomation] = useState<Partial<Record<Platform, boolean>>>({});
  // Request to jump to a campaign in the drops list (expand + scroll). The seq
  // counter lets repeated clicks on the same campaign re-trigger the effect.
  const [campaignFocus, setCampaignFocus] = useState<{ id: string; seq: number } | null>(null);
  const settingsRef = useRef<ExtensionSettings | null>(null);
  const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const snapshotRequestGenerationRef = useRef(0);
  const activityRequestScopeRef = useRef(createActivityRequestScope(platform));
  const diagnosticsExportRequestRef = useRef(createDiagnosticsExportRequest(platform));
  const activityMutationSequenceRef = useRef(createActivityMutationSequence());
  const diagnosticMutationSequenceRef = useRef(createActivityMutationSequence());
  const activityClearInFlightRef = useRef(false);
  const [activityRequestGeneration, setActivityRequestGeneration] = useState(0);
  const trimmedDiagnosticSearchQuery = diagnosticSearchQuery.trim();
  const languageOverride = initialState?.locale ?? snapshot?.settings.languageOverride ?? DEFAULT_SETTINGS.languageOverride;
  const locale = effectiveLocale(languageOverride, adapter.getUiLanguage());
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";
  const t: TFunction = createTranslator({
    languageOverride,
    overrideCatalog,
    fallbackCatalog,
    getMessage: (key, substitutions) => adapter.getMessage(key, substitutions),
  });

  function invalidateActivityRequests(
    nextPlatform: Platform = activityRequestScopeRef.current.platform,
    nextQuery: string = activityRequestScopeRef.current.query,
  ): ActivityRequestScope {
    const nextScope = advanceActivityRequestScope(activityRequestScopeRef.current, nextPlatform, nextQuery);
    activityRequestScopeRef.current = nextScope;
    setActivityRequestGeneration(nextScope.generation);
    setLoadingMoreActivity(false);
    return nextScope;
  }

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

  const previewPlatform = variantShowsPopup(initialVariant) ? initialVariant.platform : "twitch";

  useEffect(() => {
    void Promise.all([
      adapter.send<RuntimeSnapshot>({ type: "getSnapshot" }),
      preview
        ? Promise.resolve({ [SELECTED_PLATFORM_KEY]: previewPlatform })
        : adapter.getStorage(SELECTED_PLATFORM_KEY),
    ]).then(([nextSnapshot, stored]) => {
      const savedPlatform = stored[SELECTED_PLATFORM_KEY];
      if (isPlatform(savedPlatform)) setPlatform(savedPlatform);
      setSnapshot(snapshotWithMergedSettings(nextSnapshot));
    });
  }, [adapter, previewPlatform, preview]);

  useEffect(() => {
    if (!watchlistShot || !snapshot) return;
    document.getElementById("idle-watchlist")?.scrollIntoView?.({ block: "start" });
  }, [snapshot, watchlistShot]);

  useEffect(() => {
    if (preview || !adapter.getPendingChangelogVersion) return;
    void adapter.getPendingChangelogVersion().then(setPendingChangelogVersion);
  }, [adapter, preview]);

  useEffect(() => {
    if (!activityOpen || preview || clearingActivity) return;
    let cancelled = false;
    const requestScope = activityRequestScopeRef.current;
    const refresh = () => {
      if (activityClearInFlightRef.current || !isActivityRequestCurrent(requestScope, activityRequestScopeRef.current)) return;
      const refreshRequest = beginActivityMutation(activityMutationSequenceRef.current);
      void adapter.send<ActivityPage>({ type: "getActivity", platform: requestScope.platform, category: "activity", limit: 80 }).then((page) => {
        if (!cancelled) {
          setActivityStream((current) => applyActivityMutationForRequest(
            current,
            page,
            "refresh",
            requestScope,
            activityRequestScopeRef.current,
            activityMutationSequenceRef.current,
            refreshRequest,
          ));
        }
      }).catch(() => undefined);
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activityOpen, activityRequestGeneration, adapter, clearingActivity, preview]);

  useEffect(() => {
    if (activityRequestScopeRef.current.platform !== platform || activityRequestScopeRef.current.query) {
      invalidateActivityRequests(platform, "");
    }
    setActivityStream(createActivityStream());
    setDiagnosticStream(createActivityStream());
    setDiagnosticSearchQuery("");
    setShowDiagnostics(false);
    setClearActivityArmed(false);
    setClearActivityFailed(false);
  }, [platform]);

  useEffect(() => {
    if (activityRequestScopeRef.current.query === trimmedDiagnosticSearchQuery) return;
    invalidateActivityRequests(platform, trimmedDiagnosticSearchQuery);
    setDiagnosticStream(createActivityStream());
  }, [platform, trimmedDiagnosticSearchQuery]);

  useEffect(() => {
    if (!snapshot?.settings.diagnosticLogging) handleShowDiagnosticsChange(false);
  }, [snapshot?.settings.diagnosticLogging]);

  // The failure report needs recent activity, but the Activity view's stream is
  // only populated once the user opens that tab — and the panel lives on the
  // drops tab, so the report would otherwise be emptiest for exactly the user who
  // is about to file an issue. Fetch a page of our own while the panel is up.
  const criticalFailureFlagged = snapshot?.state.criticalHealth?.[platform]?.status === "flagged";
  useEffect(() => {
    if (!criticalFailureFlagged || preview) return undefined;
    let cancelled = false;
    void adapter.send<ActivityPage>({ type: "getActivity", platform, category: "activity", limit: 40 })
      .then((page) => {
        if (!cancelled) setReportEvents(page.events);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [adapter, platform, preview, criticalFailureFlagged]);

  useEffect(() => {
    if (!activityOpen || preview || clearingActivity || !showDiagnostics || !snapshot?.settings.diagnosticLogging) return;
    let cancelled = false;
    const requestScope = activityRequestScopeRef.current;
    const refresh = () => {
      if (activityClearInFlightRef.current || !isActivityRequestCurrent(requestScope, activityRequestScopeRef.current)) return;
      const refreshRequest = beginActivityMutation(diagnosticMutationSequenceRef.current);
      void adapter.send<ActivityPage>({ type: "getActivity", platform: requestScope.platform, category: "diagnostic", query: requestScope.query || undefined, limit: 80 }).then((page) => {
        if (!cancelled) {
          setDiagnosticStream((current) => applyActivityMutationForRequest(
            current,
            page,
            "refresh",
            requestScope,
            activityRequestScopeRef.current,
            diagnosticMutationSequenceRef.current,
            refreshRequest,
          ));
        }
      }).catch(() => undefined);
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activityOpen, activityRequestGeneration, adapter, clearingActivity, preview, showDiagnostics, snapshot?.settings.diagnosticLogging]);

  function loadMoreActivity(): void {
    if (activityClearInFlightRef.current || clearingActivity || loadingMoreActivity) return;
    const requestScope = activityRequestScopeRef.current;
    const requests: Promise<void>[] = [];
    // Only the visible view pages: the toggle switches between the streams
    // instead of merging them, so paging the hidden one just burns requests.
    if (!showDiagnostics && activityStream.nextCursor) {
      const cursor = activityStream.nextCursor;
      const pageRequest = beginActivityMutation(activityMutationSequenceRef.current);
      requests.push(adapter.send<ActivityPage>({ type: "getActivity", platform: requestScope.platform, category: "activity", cursor, limit: 80 })
        .then((page) => {
          setActivityStream((current) => applyActivityMutationForRequest(
            current,
            page,
            "page",
            requestScope,
            activityRequestScopeRef.current,
            activityMutationSequenceRef.current,
            pageRequest,
          ));
        }));
    }
    if (showDiagnostics && snapshot?.settings.diagnosticLogging && diagnosticStream.nextCursor) {
      const cursor = diagnosticStream.nextCursor;
      const pageRequest = beginActivityMutation(diagnosticMutationSequenceRef.current);
      requests.push(adapter.send<ActivityPage>({ type: "getActivity", platform: requestScope.platform, category: "diagnostic", query: requestScope.query || undefined, cursor, limit: 80 })
        .then((page) => {
          setDiagnosticStream((current) => applyActivityMutationForRequest(
            current,
            page,
            "page",
            requestScope,
            activityRequestScopeRef.current,
            diagnosticMutationSequenceRef.current,
            pageRequest,
          ));
        }));
    }
    if (requests.length === 0) return;
    setLoadingMoreActivity(true);
    void Promise.allSettled(requests).finally(() => {
      if (isActivityRequestCurrent(requestScope, activityRequestScopeRef.current)) setLoadingMoreActivity(false);
    });
  }

  function clearActivityHistory(): void {
    if (activityClearInFlightRef.current) return;
    if (!clearActivityArmed) {
      setClearActivityArmed(true);
      setClearActivityFailed(false);
      return;
    }
    activityClearInFlightRef.current = true;
    invalidateActivityRequests();
    setClearingActivity(true);
    setClearActivityFailed(false);
    void adapter.send<void>({ type: "clearActivity" }).then(() => {
      activityClearInFlightRef.current = false;
      invalidateActivityRequests();
      setActivityStream(createActivityStream());
      setDiagnosticStream(createActivityStream());
      setDiagnosticSearchQuery("");
      invalidateActivityRequests(platform, "");
      setClearActivityArmed(false);
      setClearingActivity(false);
    }).catch(() => {
      activityClearInFlightRef.current = false;
      setClearActivityArmed(false);
      setClearActivityFailed(true);
      setClearingActivity(false);
    });
  }

  function dismissUpdateNotice(): void {
    setPendingChangelogVersion(undefined);
    void adapter.dismissPendingChangelogVersion?.();
  }

  // Keep the snapshot (and its Activity log) live while the popup is open, so
  // background scheduler ticks are reflected without needing a manual refresh.
  useEffect(() => {
    if (preview) return;
    const interval = setInterval(() => {
      const generation = snapshotRequestGenerationRef.current;
      void adapter.send<RuntimeSnapshot>({ type: "getSnapshot" }).then((nextSnapshot) => {
        if (generation !== snapshotRequestGenerationRef.current) return;
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
    if (nextPlatform !== activityRequestScopeRef.current.platform) {
      invalidateActivityRequests(nextPlatform, "");
      diagnosticsExportRequestRef.current = beginDiagnosticsExport(
        diagnosticsExportRequestRef.current,
        nextPlatform,
      );
    }
    setDiagnosticSearchQuery("");
    setPlatform(nextPlatform);
    // The watchlist add form belongs to the platform it was opened on: leaving
    // it open would submit a name typed for one platform into the other's list.
    setWatchlistAdding(false);
    // Extensions are Twitch-only: switching to Kick while standing in that view
    // would leave the rail pointing at a destination it no longer lists.
    setView((current: PopupView) => viewForPlatform(current, nextPlatform));
    if (!preview) void adapter.setStorage({ [SELECTED_PLATFORM_KEY]: nextPlatform });
  }

  // Every rail destination goes through here so leaving Activity always settles
  // its in-flight requests, and entering Settings always rearms the one-shot
  // export confirmation.
  function changeView(nextView: PopupView): void {
    if (nextView === view) return;
    if (activityOpen) closeActivityView();
    if (nextView === "settings") setSettingsOpenGeneration((current) => current + 1);
    setView(nextView);
  }

  function closeActivityView(): void {
    if (activityOpen) {
      invalidateActivityRequests(platform, "");
      diagnosticsExportRequestRef.current = beginDiagnosticsExport(
        diagnosticsExportRequestRef.current,
        platform,
      );
    }
    setClearActivityArmed(false);
    setClearActivityFailed(false);
    setDiagnosticSearchQuery("");
    setDiagnosticStream(createActivityStream());
  }

  function handleShowDiagnosticsChange(nextShowDiagnostics: boolean): void {
    if (showDiagnostics && !nextShowDiagnostics) {
      invalidateActivityRequests(platform, "");
      diagnosticsExportRequestRef.current = beginDiagnosticsExport(
        diagnosticsExportRequestRef.current,
        platform,
      );
      setDiagnosticSearchQuery("");
      setDiagnosticStream(createActivityStream());
    }
    setShowDiagnostics(nextShowDiagnostics);
  }

  async function exportDiagnosticsLog(): Promise<number | undefined> {
    const downloadFile = adapter.downloadFile;
    if (!downloadFile) return undefined;
    const request = beginDiagnosticsExport(diagnosticsExportRequestRef.current, platform);
    diagnosticsExportRequestRef.current = request;
    const exportedAt = new Date();
    const result = await adapter.send<DiagnosticsExport>({ type: "exportDiagnostics", platform: request.platform });
    if (!isDiagnosticsExportCurrent(request, diagnosticsExportRequestRef.current)) return undefined;
    downloadFile(
      buildDiagnosticsExportFilename(request.platform, exportedAt),
      buildActivityExport({
        events: result.events,
        platform: request.platform,
        diagnostics: true,
        coverage: "full",
        version: adapter.version,
        userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
        locale,
        at: exportedAt.toISOString(),
      }, t),
      "text/plain",
    );
    return result.events.length;
  }

  async function setExtensionEnabled(provider: TwitchExtensionProviderId, enabled: boolean): Promise<boolean> {
    const result = await changeTwitchExtensionEnabled(adapter, provider, enabled);
    if (enabled && !result) return false;
    const next = await adapter.send<RuntimeSnapshot>({ type: "tickNow" });
    setSnapshot(snapshotWithMergedSettings(next));
    return result;
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

  // Addressed by platform rather than "the selected one": each platform tab now
  // carries its own switch, so either can be toggled without selecting it first.
  async function setAutomation(pendingPlatform: Platform, enabled: boolean): Promise<void> {
    if (!snapshot || pendingAutomation[pendingPlatform] != null) return;
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

  // Undoes the pause caused by manually closing the managed watch tab. Keeps
  // the user's enabled/running settings untouched — only the pause is cleared.
  async function resumeAfterManualClose(): Promise<void> {
    if (!snapshot) return;
    const resumingPlatform = platform;
    try {
      setSnapshot(snapshotWithMergedSettings(await adapter.send<RuntimeSnapshot>({ type: "resumeAfterManualClose", platform: resumingPlatform })));
    } catch (error) {
      console.error("Failed to resume farming", error);
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

  // Exports the session tokens the headless CLI's `login --import` consumes.
  // Gated behind inline confirmation in the settings view; available only when
  // the host adapter supports credential export (the live extension, not demo).
  const exportCredentials = adapter.exportCredentials
    ? async () => {
        const blob = await adapter.send<CliCredentialBlob>({ type: "exportCliCredentials" });
        adapter.exportCredentials?.(blob);
      }
    : undefined;

  const resetExtension = adapter.resetExtension
    ? async () => {
        await settingsSaveQueue.current.catch(() => undefined);
        snapshotRequestGenerationRef.current += 1;
        const nextSnapshot = await adapter.resetExtension!();
        settingsRef.current = mergeSettings(nextSnapshot.settings);
        invalidateActivityRequests("twitch");
        setActivityStream(createActivityStream());
        setDiagnosticStream(createActivityStream());
        setShowDiagnostics(false);
        setPlatform("twitch");
        setWatchlistAdding(false);
        setPendingChangelogVersion(undefined);
        setSnapshot(snapshotWithMergedSettings(nextSnapshot));
        setView("queue");
      }
    : undefined;

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

  // Downloads the current settings as a portable JSON file. Available only
  // when the host adapter supports it (the live extension, not the demo).
  const exportSettings = adapter.exportSettings
    ? () => adapter.exportSettings?.(buildSettingsExportPayload(settingsRef.current ?? settings))
    : undefined;

  // Prompts for a settings file, validates/migrates it (never trusting file
  // contents), and applies the result as a full patch — the same save path
  // every other settings mutation uses, so it goes through the same queue and
  // storage lock. Returns false when the user cancels the file picker.
  const importSettings = adapter.importSettings
    ? async () => {
        const raw = await adapter.importSettings!();
        if (raw == null) return false;
        const { settings: imported } = parseSettingsImportPayload(raw);
        await updateSettings(imported as SettingsPatch, { tickAfterSave: true });
        return true;
      }
    : undefined;

  const compatibilityResolution = adapter.resolveCompatibility?.(settings.compatibility);
  const excludedIds = new Set(settings.excludedCampaignIds);
  // Every campaign the platform reported, in scheduler order. Each view picks
  // the sections it owns (campaignSection), so a campaign is never missing from
  // the popup entirely — it is in the Queue, under Skipped or Upcoming, or in
  // Completed.
  const rawCampaigns = rankCampaigns(snapshot.state.campaigns[platform], settings);
  const session = snapshot.state.sessions[platform];
  const sessionChannel = channelViewFromSession(session);
  const criticalFailure = snapshot.state.criticalHealth?.[platform];
  // Only the flagged platform loses its drops list; the other one keeps working.
  const criticalFailureReason = settings.criticalFailurePromptEnabled && criticalFailure?.status === "flagged"
    ? criticalFailure.reason
    : undefined;
  const campaigns = rawCampaigns.map((campaign, index) => campaignViewFromCampaign(
    campaign,
    index,
    session,
    excludedIds.has(campaign.id),
    {
      skipUnfinishableRewards: settings.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
      settings,
    },
  ));
  const games = gameItemsFromCampaigns(snapshot.state.campaigns[platform], t);
  // Categories that currently have active drop campaigns, surfaced as one-tap
  // "Has active drops" suggestions in the category filter editor (zero network).
  const dropCategorySuggestions: Record<Platform, GameItem[]> = {
    twitch: gameItemsFromCampaigns(snapshot.state.campaigns.twitch, t),
    kick: gameItemsFromCampaigns(snapshot.state.campaigns.kick, t),
  };
  const gameMap = Object.fromEntries(games.map((game) => [game.id, game]));
  const idleWatchlistChannels = settings.platform[platform].idleWatchlistChannels;
  const idleWatchlist = idleWatchlistChannels.map((username) => streamerItemFromFallback(username, session, t));
  const screenshotWatchlist = watchlistShot
    ? idleWatchlist.map((item) => {
        const live = SCREENSHOT_WATCHLIST_LIVE[item.id];
        if (!live) return item;
        return { ...item, name: live.displayName, live: true, viewers: live.viewers, subtitle: live.subtitle };
      })
    : idleWatchlist;
  const automation = {
    twitch: pendingAutomation.twitch ?? settings.platform.twitch.enabled,
    kick: pendingAutomation.kick ?? settings.platform.kick.enabled,
  };
  const automationPending: Record<Platform, boolean> = {
    twitch: pendingAutomation.twitch != null,
    kick: pendingAutomation.kick != null,
  };
  const automationPresentationByPlatform = Object.fromEntries(
    (Object.keys(PLATFORMS) as Platform[]).map((id) => [id, automationPresentation({
      platform: id,
      enabled: automation[id],
      pending: pendingAutomation[id] != null,
      authHealth: snapshot.state.authHealth[id],
      session: snapshot.state.sessions[id],
      manualClosePaused: Boolean(snapshot.state.manualClosePause?.[id]),
      manualWatch: snapshot.state.manualWatch?.[id],
    })]),
  ) as Record<Platform, AutomationPresentation>;
  const presentation = automationPresentationByPlatform[platform];
  const activeCampaign = campaigns.find((campaign) => campaign.farmingChannel);
  const farmingChannel = activeCampaign?.farmingChannel ?? sessionChannel;
  const onFarmingTitleClick = activeCampaign
    ? () => setCampaignFocus((prev) => ({ id: activeCampaign.id, seq: (prev?.seq ?? 0) + 1 }))
    : undefined;
  const mainViewOpen = !settingsOpen && !activityOpen;
  // How many campaigns each game has in play right now, keyed the way a
  // CategorySelection id compares (lowercased), for the Games view's counts.
  const gameCampaignCounts = campaigns.reduce<Record<string, number>>((counts, campaign) => {
    if (campaign.section !== "queue" && campaign.section !== "skipped") return counts;
    const key = campaign.gameId.toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const railCounts: Partial<Record<PopupView, number>> = {
    queue: campaigns.filter((campaign) => campaign.section === "queue").length,
    // Both tabs of that view, so the rail's number matches what it opens onto.
    completed: campaigns.filter((campaign) => campaign.section === "completed" || campaign.section === "expired").length,
    games: settings.platform[platform].categoryMode === "all"
      ? dropCategorySuggestions[platform].length
      : settings.platform[platform].categories.length,
    watchlist: settings.platform[platform].idleWatchlistChannels.length,
  };
  const VIEW_TITLE_KEYS: Record<PopupView, string> = {
    queue: "navQueue",
    completed: "navCompleted",
    games: "navGames",
    watchlist: "navIdleWatchlist",
    extensions: "navExtensions",
    activity: "activityTitle",
    settings: "settingsTitle",
  };
  const viewTitle = t(VIEW_TITLE_KEYS[view]);
  const updateNotice = pendingChangelogVersion && adapter.changelogUrl
    ? { version: pendingChangelogVersion, href: adapter.changelogUrl(pendingChangelogVersion) }
    : undefined;
  const now = new Date();
  const noticeSlot = popupNoticeSlot({
    preview,
    hasUpdateNotice: Boolean(updateNotice),
    showRateNudge: shouldShowRateNudge(snapshot.state.installedAt, settings.rateNudgeStatus, now, RATE_NUDGE_MIN_DAYS),
    showGithubStarNudge: shouldShowGithubStarNudge(snapshot.state.installedAt, settings.githubStarNudgeStatus, now, GITHUB_STAR_NUDGE_MIN_DAYS),
  });

  return (
      <PopupRuntimeContext.Provider value={{ adapter, preview }}>
      <I18nContext.Provider value={{ t, dir, locale }}>
    <main
      dir={dir}
      data-platform={platform}
      data-view={view}
      className="@container flex h-[600px] w-[720px] overflow-hidden border border-zinc-200/80 bg-zinc-50 shadow-2xl shadow-black/30 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <WorkspaceRail
        view={view}
        platform={platform}
        counts={railCounts}
        presentation={automationPresentationByPlatform}
        automation={automation}
        automationPending={automationPending}
        version={adapter.version}
        onViewChange={changeView}
        onPlatformChange={selectPlatform}
        onAutomationToggle={setAutomation}
        onOpenInventory={() => openHttpsLink(PLATFORM_INVENTORY_URLS[platform], adapter.openLink)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The status strip sits above every view, so what is being farmed is
            never more than a glance away — including from Settings, where the
            old header hid it entirely. */}
        <div className="relative shrink-0 border-b border-zinc-200/70 bg-white/85 px-3 py-1.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-linear-to-r from-transparent via-[var(--accent)] to-transparent" />
          <AutomationStatusLine
            platform={platform}
            presentation={presentation}
            farmingTitle={session.supplementalWatch ? session.supplementalWatch.id === "nopixel" ? "NoPixelV" : "Fortnite" : activeCampaign?.title}
            farmingChannel={farmingChannel}
            watchingIdleWatchlist={!activeCampaign && Boolean(farmingChannel) && !session.supplementalWatch}
            onFarmingTitleClick={session.supplementalWatch ? undefined : onFarmingTitleClick}
            onResume={resumeAfterManualClose}
          />
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
          <h1 className="font-display truncate text-[14px] font-bold text-zinc-900 dark:text-zinc-50">{viewTitle}</h1>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton label={t("refreshSchedule")} onClick={() => void refreshNow()} disabled={refreshing}>
              <RotateCcw size={16} className={cn(refreshing && "animate-spin")} />
            </IconButton>
          </div>
        </div>

        <div id="popup-platform-panel" className="nice-scroll min-h-0 flex-1 overflow-y-auto text-zinc-700 dark:text-zinc-300">
          <div className="space-y-2 p-3 pt-2">
            {/* The view itself is swapped outright rather than cross-faded: the
                rail makes navigation frequent, and an exit animation would hold
                the outgoing panel on screen every time. Notices below keep their
                own enter/exit, which is where motion earns its place. */}
            <div className="space-y-3">
                <AnimatePresence initial={false}>
                  {noticeSlot === "update" && updateNotice ? (
                    <UpdateNotice
                      key="update-notice"
                      version={updateNotice.version}
                      href={updateNotice.href}
                      onDismiss={dismissUpdateNotice}
                    />
                  ) : null}
                  {noticeSlot === "rate" ? (
                    <RateNudge
                      key="rate-nudge"
                      onRate={() => void updateSettings({ rateNudgeStatus: "rated" })}
                      onDismiss={() => void updateSettings({ rateNudgeStatus: "dismissed" })}
                    />
                  ) : null}
                  {noticeSlot === "github-star" ? (
                    <GithubStarNudge
                      key="github-star-nudge"
                      onStar={() => void updateSettings({ githubStarNudgeStatus: "starred" })}
                      onDismiss={() => void updateSettings({ githubStarNudgeStatus: "dismissed" })}
                    />
                  ) : null}
                </AnimatePresence>
                {view === "settings" ? (
                  <SettingsView suggestions={dropCategorySuggestions} onSearchCategories={searchCategories} settings={settings} onSettingsChange={updateSettings} onExtensionEnabledChange={adapter.requestTwitchExtensionPermission ? setExtensionEnabled : undefined} onExportCredentials={exportCredentials} onExportSettings={exportSettings} onImportSettings={importSettings} onReset={resetExtension} exportConfirmationResetKey={settingsOpenGeneration} compatibilityRegistry={adapter.compatibilityRegistry} compatibilityResolution={compatibilityResolution} focusGroupId={preview && variantShowsPopup(initialVariant) && initialVariant.view === "settings" ? "general.drops" : undefined} />
                ) : view === "activity" ? (
                  <ActivityLog
                    activityEvents={activityStream.events}
                    diagnosticEvents={diagnosticStream.events}
                    platform={platform}
                    lastTickAt={snapshot.state.lastTickAt}
                    diagnosticLogging={settings.diagnosticLogging}
                    showDiagnostics={showDiagnostics}
                    hasMore={Boolean(showDiagnostics ? diagnosticStream.nextCursor : activityStream.nextCursor)}
                    clearArmed={clearActivityArmed}
                    clearFailed={clearActivityFailed}
                    loadingMore={loadingMoreActivity}
                    clearing={clearingActivity}
                    version={adapter.version}
                    locale={locale}
                    searchQuery={diagnosticSearchQuery}
                    onSearchQueryChange={setDiagnosticSearchQuery}
                    searchingDiagnostics={Boolean(trimmedDiagnosticSearchQuery)}
                    onShowDiagnosticsChange={handleShowDiagnosticsChange}
                    onLoadMore={loadMoreActivity}
                    onClear={clearActivityHistory}
                    writeClipboard={adapter.writeClipboard}
                    onExportAll={adapter.downloadFile ? exportDiagnosticsLog : undefined}
                  />
                ) : view === "games" ? (
                  <GamesPanel
                    platform={platform}
                    settings={settings}
                    suggestions={dropCategorySuggestions[platform]}
                    campaignCounts={gameCampaignCounts}
                    onCategoryModeChange={(categoryMode) => void updateSettings(
                      { platform: { [platform]: { categoryMode } } },
                      { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
                    )}
                    onCategoriesChange={(categories) => void updateSettings(
                      { platform: { [platform]: { categories } } },
                      { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
                    )}
                    onFavouritesChange={(favouriteCategories) => void updateSettings(
                      { platform: { [platform]: { favouriteCategories } } },
                      { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
                    )}
                    onBlockedChange={(blockedCategories) => void updateSettings(
                      { platform: { [platform]: { blockedCategories } } },
                      { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
                    )}
                    onSearchCategories={(query) => searchCategories(platform, query)}
                  />
                ) : view === "watchlist" ? (
                  // Keyed by platform so the add field's own text cannot survive
                  // a platform switch either.
                  <IdleWatchlistPanel
                    key={platform}
                    platform={platform}
                    streamers={screenshotWatchlist}
                    expanded
                    collapsible={false}
                    adding={watchlistAdding}
                    onExpandedChange={() => undefined}
                    onAddingChange={setWatchlistAdding}
                    onChange={(ordered) => updateSettings(
                      {
                        platform: {
                          [platform]: {
                            idleWatchlistChannels: ordered.map((streamer) => streamer.id),
                          },
                        },
                      },
                      { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
                    )}
                  />
                ) : view === "extensions" ? (
                  <TwitchExtensionDrops settings={settings} summaries={snapshot.state.twitchExtensions} activeProvider={snapshot.state.sessions.twitch.status === "watching" && snapshot.state.sessions.twitch.watchMode === "tabless" ? snapshot.state.sessions.twitch.supplementalWatch?.id : undefined} onSetup={() => adapter.openLink("https://help.twitch.tv/s/article/how-to-configure-extensions")} />
                ) : criticalFailureReason ? (
                  // A flagged platform loses its lists entirely: every drops
                  // view would be lying about what is being farmed.
                  <CriticalFailurePanel
                    platform={platform}
                    reason={criticalFailureReason}
                    buildReport={() => buildFailureReport({
                      platform,
                      version: adapter.version,
                      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
                      locale,
                      at: new Date().toISOString(),
                      settings,
                      state: snapshot.state,
                      events: reportEvents.length > 0 ? reportEvents : activityStream.events,
                    })}
                    onDismiss={() => {
                      void adapter.send({ type: "dismissCriticalFailure", platform })
                        .then(() => refreshNow())
                        .catch(() => undefined);
                    }}
                    openLink={adapter.openLink}
                    writeClipboard={adapter.writeClipboard ?? (async () => false)}
                  />
                ) : view === "completed" ? (
                  <CompletedPanel
                    campaigns={campaigns}
                    gameMap={gameMap}
                    focus={campaignFocus}
                    refreshing={refreshing}
                    onRefreshCampaign={() => refreshNow()}
                  />
                ) : (
                  <>
                    {settings.showTips ? <TipsBanner initialIndex={preview ? 0 : undefined} preview={preview} /> : null}
                    <QueuePanel
                      campaigns={campaigns}
                      gameMap={gameMap}
                      focus={campaignFocus}
                      refreshing={refreshing}
                      strategy={settings.priorityMode}
                      pinnedCount={settings.campaignPins.length}
                      farmPinnedOnly={settings.farmPinnedOnly}
                      onStrategyChange={(priorityMode) => void updateSettings({ priorityMode }, { tickAfterSave: true })}
                      onUnpinAll={() => void updateSettings({ campaignPins: [] }, { tickAfterSave: true })}
                      onFarmPinnedOnlyChange={(farmPinnedOnly) => void updateSettings({ farmPinnedOnly }, { tickAfterSave: true })}
                      onRefreshCampaign={() => refreshNow()}
                      onPinChange={(campaignId, position) => updateSettings(
                        {
                          campaignPins: position == null
                            ? unpinCampaign(settings.campaignPins, campaignId)
                            : pinCampaignAt(settings.campaignPins, campaignId, position),
                        },
                        { tickAfterSave: true },
                      )}
                      onToggleExclude={(id) => {
                        const next = new Set(settings.excludedCampaignIds);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return updateSettings({ excludedCampaignIds: [...next] }, { tickAfterSave: true });
                      }}
                      onOpenGames={() => changeView("games")}
                      onOpenSettings={() => changeView("settings")}
                    />
                  </>
                )}
            </div>
          </div>
        </div>
      </div>
      {settingsOpen ? <AttributionFooter version={adapter.version} /> : null}
    </main>
    </I18nContext.Provider>
    </PopupRuntimeContext.Provider>
  );
}
