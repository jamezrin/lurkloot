import type { DropCampaign, DropReward, EngineSettings, Platform, PlaybackTelemetry, SchedulerState } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import type { CompatibilityResolution, ResolvedCompatibility } from "@lurkloot/shared/compatibility";
import { isWatchReward } from "@lurkloot/shared/rewards";
import type { PlatformAdapter } from "../platforms/adapter";
import { withActivityDiagnostics } from "../core/activityDiagnostics";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { platformLabel } from "./helpers";
import type { BackgroundControllerDeps, ControllerCalls, TickAdapterHandle, TickDiagnosticContext } from "./types";

const EN_RUNTIME_MESSAGES: Record<string, string> = {
  notificationRewardClaimed: "Reward claimed",
  notificationRewardEarned: "Reward earned",
  notificationNoDropsLeft: "No drops left",
  notificationRewardFromCampaign: "$1 from $2",
  notificationNoDropsLeftMessage: "$1 has no eligible drops to farm.",
  notificationChallengeClaimed: "Challenge reward claimed",
  notificationChallengeReward: "You won a $1 card from your $2 challenge.",
};

function newlyEarnedRewards(
  previous: SchedulerState,
  next: SchedulerState,
): Array<{ campaign: DropCampaign; reward: DropReward }> {
  const previousStatuses = new Map<string, DropReward["status"]>();
  for (const platform of ["twitch", "kick"] as Platform[]) {
    for (const campaign of previous.campaigns[platform]) {
      for (const reward of campaign.rewards) {
        previousStatuses.set(`${platform}:${campaign.id}:${reward.id}`, reward.status);
      }
    }
  }

  const earned: Array<{ campaign: DropCampaign; reward: DropReward }> = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    for (const campaign of next.campaigns[platform]) {
      for (const reward of campaign.rewards) {
        const before = previousStatuses.get(`${platform}:${campaign.id}:${reward.id}`);
        const wasKnownAndUnearned = before !== undefined && before !== "claimable" && before !== "claimed";
        if ((reward.status === "claimable" || reward.status === "claimed") && wasKnownAndUnearned) {
          earned.push({ campaign, reward });
        }
      }
    }
  }
  return earned;
}

function hasEarnableReward(campaign: DropCampaign): boolean {
  return campaign.status === "active"
    && !hasCampaignEnded(campaign)
    && campaign.accountLinked !== false
    && (!campaign.eligibility || campaign.eligibility === "eligible")
    && campaign.rewards.some((reward) => isWatchReward(reward) && reward.status !== "claimed" && reward.status !== "claimable" && reward.preconditionsMet !== false);
}

function hasCampaignEnded(campaign: DropCampaign): boolean {
  if (!campaign.endsAt) return false;
  const endsAt = Date.parse(campaign.endsAt);
  return !Number.isNaN(endsAt) && endsAt < Date.now();
}

// Compatibility reporting, adapter handles, event reporting and notifications.
export function createReporting<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  { reportingSlice }: Pick<ControllerSlices<S>, "reportingSlice">,
  calls: Pick<ControllerCalls<S>, "selectionFingerprint">,
): Pick<ControllerCalls<S>,
  | "createAdapters"
  | "createAdapter"
  | "createSelectedAdapters"
  | "createTickAdapterHandle"
  | "withEventCollector"
  | "clearOperationalEvents"
  | "diagnosticEvent"
  | "reportBestEffort"
  | "playbackEvents"
  | "safeNotify"
  | "tr"
  | "emitNotifications"
> {
  const { selectionFingerprint } = lateBound(calls);

  const warningFieldLabel = (platform: Platform, field: string): string => {
    if (platform === "twitch") {
      if (field === "profile") return "Twitch profile";
      if (field === "heartbeatTransport") return "Twitch heartbeat";
      return "Twitch inventory";
    }
    return field === "profile" ? "Kick profile" : "Kick claim";
  };

  function reportAdapterCompatibility(
    construction: {
      compatibility: ResolvedCompatibility;
      warnings: CompatibilityResolution["warnings"];
    },
    settings: S,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): void {
    for (const warning of construction.warnings) {
      if (!platforms.includes(warning.platform) || !settings.platform[warning.platform].enabled) continue;
      const key = `${warning.code}:${warning.platform}:${warning.field}:${warning.resolved}:${selectionFingerprint(warning.requested)}`;
      if (reportingSlice.reportedCompatibilityWarnings.has(key)) continue;
      const reason = warning.code === "unknown_selection" ? "Unknown" : "Host-incompatible";
      emit({
        category: "diagnostic",
        platform: warning.platform,
        level: "warn",
        message: `${reason} ${warningFieldLabel(warning.platform, warning.field)} compatibility selection; using ${warning.resolved}`,
        ...(warning.field === "profile"
          ? { compatibilityProfile: warning.resolved }
          : { compatibilityCapability: warning.resolved, compatibilityVersion: warning.resolved }),
      });
      reportingSlice.reportedCompatibilityWarnings.add(key);
    }
    for (const platform of platforms) {
      if (!settings.platform[platform].enabled) continue;
      const profile = construction.compatibility[platform].profile;
      const capabilities = platform === "twitch"
        ? [construction.compatibility.twitch.heartbeat, construction.compatibility.twitch.inventory]
        : [construction.compatibility.kick.claim];
      const capability = capabilities[0];
      const key = [profile, ...capabilities].join(":");
      if (reportingSlice.reportedCompatibility.get(platform) === key) continue;
      emit({
        category: "diagnostic",
        platform,
        level: "info",
        message: `Using compatibility profile ${profile} (${capabilities.join(", ")})`,
        compatibilityProfile: profile,
        compatibilityCapability: capability,
        compatibilityCapabilities: capabilities,
        compatibilityVersion: capability,
      });
      reportingSlice.reportedCompatibility.set(platform, key);
    }
  }

  function createAdapters(settings: S, emit: EventEmitter): Record<Platform, PlatformAdapter> {
    const construction = deps.createAdapters(emit, settings);
    reportAdapterCompatibility(construction, settings, emit, PLATFORMS);
    return construction.adapters;
  }

  function createAdapter(
    platform: Platform,
    settings: S,
    emit: EventEmitter,
    reportCompatibility = false,
  ): PlatformAdapter {
    const construction = deps.createAdapter(platform, emit, settings);
    if (reportCompatibility) {
      reportAdapterCompatibility(construction, settings, emit, [platform]);
    }
    return construction.adapter;
  }

  function createSelectedAdapters(
    settings: S,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): Record<Platform, PlatformAdapter> {
    if (platforms.length === PLATFORMS.length) return createAdapters(settings, emit);
    const adapters: Partial<Record<Platform, PlatformAdapter>> = {};
    for (const platform of platforms) {
      adapters[platform] = createAdapter(platform, settings, emit, true);
    }
    return adapters as Record<Platform, PlatformAdapter>;
  }

  function createTickAdapterHandle(platform: Platform, tickContext: TickDiagnosticContext): TickAdapterHandle<S> {
    let pendingEvents: EngineEvent[] | undefined = [];
    const routeReports = new Set<Promise<void>>();
    let adapter: PlatformAdapter | undefined;
    let construction: ReturnType<BackgroundControllerDeps<S>["createAdapter"]> | undefined;
    let compatibilityReported = false;
    let settingsFingerprint: string | undefined;
    return {
      platform,
      adapter(settings, emit, reportCompatibility = false) {
        const nextFingerprint = JSON.stringify(settings);
        if (!adapter || settingsFingerprint !== nextFingerprint) {
          this.drain(emit);
          construction = deps.createAdapter(platform, routeDiagnosticEmitter((event) => pendingEvents?.push(event), routeReports, tickContext), settings);
          adapter = construction.adapter;
          settingsFingerprint = nextFingerprint;
          compatibilityReported = false;
        }
        if (reportCompatibility && !compatibilityReported && construction) {
          reportAdapterCompatibility(construction, settings, (event) => pendingEvents?.push(event), [platform]);
          compatibilityReported = true;
        }
        this.drain(emit);
        return adapter;
      },
      drain(emit) {
        for (const event of pendingEvents?.splice(0) ?? []) emit(event);
        adapter?.flushRouteDiagnostics?.(routeDiagnosticEmitter(emit, routeReports, tickContext));
      },
      close() {
        pendingEvents = undefined;
      },
      async settleRouteReports() {
        await Promise.allSettled([...routeReports]);
      },
    };
  }

  async function withEventCollector<T>(
    operation: (emit: EventEmitter, events: EngineEvent[]) => Promise<T>,
    tickContext?: TickDiagnosticContext,
  ): Promise<T> {
    const events: EngineEvent[] = [];
    const routeReports = new Set<Promise<void>>();
    let collect: EventEmitter | undefined = (event) => events.push(event);
    const emit = withActivityDiagnostics(routeDiagnosticEmitter((event) => collect?.(event), routeReports, tickContext));
    try {
      return await operation(emit, events);
    } finally {
      // A timed-out auth request can finish later. Only its safe transport
      // diagnostics still have a destination; discard late operational events.
      collect = undefined;
      await Promise.allSettled([...routeReports]);
    }
  }

  function routeDiagnosticEmitter(
    emit: EventEmitter,
    routeReports: Set<Promise<void>>,
    tickContext?: TickDiagnosticContext,
  ): EventEmitter {
    return (event) => {
      if (event.category !== "diagnostic" || event.platform !== "kick"
        || (event.code !== "kick_fetch_route" && event.code !== "kick_fetch_summary"
          && event.code !== "kick_fetch_lifecycle_failed")) {
        emit(event);
        return;
      }
      // These describe transport work, not accepted auth/scheduler state. Report
      // them once even if their operation is aborted, superseded, or times out.
      const report = reportBestEffort([{
        ...event,
        emittedAt: event.emittedAt ?? new Date().toISOString(),
        ...tickContext,
      }]);
      routeReports.add(report);
      reportingSlice.pendingRouteReports.add(report);
      const settled = () => {
        routeReports.delete(report);
        reportingSlice.pendingRouteReports.delete(report);
      };
      void report.then(settled, settled);
    };
  }

  function clearOperationalEvents(events: EngineEvent[]): void {
    // Route diagnostics bypass the operational collector in
    // routeDiagnosticEmitter, so only compatibility evidence can remain here.
    const retainedEvents = events.filter((event) =>
      event.category === "diagnostic"
      && (event.compatibilityProfile !== undefined || event.compatibilityCapability !== undefined));
    events.splice(0, events.length, ...retainedEvents);
  }

  // Reports a single diagnostic immediately rather than collecting it into a
  // tick's event batch. Tick lifecycle lines must land as they happen: batching
  // them would defeat the point of timing a tick that is still running.
  function diagnosticEvent(
    level: "debug" | "info" | "warn",
    message: string,
    platform?: Platform,
    tickContext?: TickDiagnosticContext,
    data?: DiagnosticEvent["data"],
  ): void {
    void reportBestEffort([{
      category: "diagnostic",
      level,
      message,
      platform,
      ...tickContext,
      ...(data === undefined ? {} : { data }),
    }]);
  }

  async function reportBestEffort(events: readonly EngineEvent[]): Promise<void> {
    if (events.length === 0 || !deps.reportEvents) return;
    const correlateControllerRun = (events: readonly EngineEvent[]): EngineEvent[] =>
      events.map((event) =>
        event.category === "diagnostic"
          ? { ...event, controllerRunId: reportingSlice.controllerRunId }
          : event);
    const correlatedEvents = correlateControllerRun(events);
    if (correlatedEvents.some((event) => event.category === "diagnostic")) {
      reportingSlice.controllerRunAnnouncement ??= (async () => {
        try {
          await deps.reportEvents?.([{
            category: "diagnostic",
            level: "debug",
            message: `Background controller run ${reportingSlice.controllerRunLabel} started`,
            controllerRunId: reportingSlice.controllerRunId,
          }]);
        } catch {
          // Host event persistence/output is best-effort.
        }
      })();
      await reportingSlice.controllerRunAnnouncement;
    }
    try {
      await deps.reportEvents(correlatedEvents);
    } catch {
      // Host event persistence/output is best-effort.
    }
  }

  function playbackEvents(
    platform: Platform,
    previous: PlaybackTelemetry | undefined,
    telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">,
  ): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    const log = (level: DiagnosticEvent["level"], message: string) => {
      events.push({ category: "diagnostic", platform, level, message });
    };

    if (telemetry.adActive && !previous?.adActive) {
      log("info", "Ad started; keeping the watch tab counting down");
    } else if (!telemetry.adActive && previous?.adActive) {
      log("debug", "Ad finished");
    }
    if (telemetry.blockedPlaybackCount > 0 && (previous?.blockedPlaybackCount ?? 0) === 0) {
      log("warn", `Playback was blocked for ${telemetry.blockedPlaybackCount} video(s); re-muted to keep farming`);
    }
    if (telemetry.videoCount === 0 && (previous?.videoCount ?? -1) !== 0) {
      log("warn", "No video element found in the watch tab");
    }
    if (telemetry.playingVideoCount !== (previous?.playingVideoCount ?? -1) || telemetry.videoCount !== (previous?.videoCount ?? -1)) {
      log("debug", `Playback telemetry: ${telemetry.playingVideoCount}/${telemetry.videoCount} videos playing${telemetry.documentHidden ? " (tab hidden)" : ""}`);
    }
    return events;
  }

  async function safeNotify(title: string, message: string): Promise<void> {
    if (!deps.createNotification) return;
    try {
      await deps.createNotification({ title, message });
    } catch {
      // Notification delivery is best-effort and must not fail scheduler ticks.
    }
  }

  async function tr(key: string, substitutions?: string | string[]): Promise<string> {
    const translated = await deps.translate?.(key, substitutions);
    if (translated) return translated;
    const template = EN_RUNTIME_MESSAGES[key] ?? key;
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions == null
        ? []
        : [substitutions];
    return values.reduce((text, value, index) => text.replaceAll(`$${index + 1}`, value), template);
  }

  async function emitNotifications(
    settings: EngineSettings,
    previous: SchedulerState,
    next: SchedulerState,
    tickEvents: readonly EngineEvent[] = [],
  ): Promise<void> {
    if (settings.notifyRewardEarned) {
      for (const reward of newlyEarnedRewards(previous, next)) {
        await safeNotify(
          await tr("notificationRewardEarned"),
          await tr("notificationRewardFromCampaign", [reward.reward.name, reward.campaign.name]),
        );
      }
      // Challenge claims never enter SchedulerState, so they come from the tick's
      // events instead of a state diff. They ride notifyRewardEarned deliberately:
      // one more toggle for a single event type is not worth the settings surface.
      for (const event of tickEvents) {
        if (event.category !== "activity" || event.code !== "challenge_claimed") continue;
        await safeNotify(
          await tr("notificationChallengeClaimed"),
          await tr("notificationChallengeReward", [event.data.rarity, event.data.recurrence]),
        );
      }
    }

    if (settings.notifyNoDropsLeft) {
      const isDropsExhausted = (state: SchedulerState, platform: Platform): boolean =>
        state.sessions[platform].status === "idle"
        && state.campaigns[platform].length > 0
        && state.campaigns[platform].every((campaign) => !hasEarnableReward(campaign));

      for (const platform of ["twitch", "kick"] as Platform[]) {
        if (
          settings.platform[platform].enabled
          // Only on the transition into the exhausted state, so the
          // notification fires once instead of re-firing every tick (~1/min)
          // for as long as the platform stays out of earnable drops.
          && isDropsExhausted(next, platform)
          && !isDropsExhausted(previous, platform)
        ) {
          await safeNotify(
            await tr("notificationNoDropsLeft"),
            await tr("notificationNoDropsLeftMessage", platformLabel(platform)),
          );
        }
      }
    }
  }

  return {
    createAdapters,
    createAdapter,
    createSelectedAdapters,
    createTickAdapterHandle,
    withEventCollector,
    clearOperationalEvents,
    diagnosticEvent,
    reportBestEffort,
    playbackEvents,
    safeNotify,
    tr,
    emitNotifications,
  };
}
