// Every place the v1.14.0 engine performs provider, tab or timer I/O (or an
// async wait on unrelated work) while it holds a lock. v1.15.0 (#583) removes
// them: each entry names the issue that does, and that issue deletes its entry
// in the same PR. lockedIoAllowlist.test.ts scans the source both ways: a call
// from LOCKED_IO_CALLS inside a lock that is not listed fails, and a listed call
// that is no longer inside its lock fails. The list's length is pinned to
// LOCKED_IO_ALLOWLIST_SIZE, so it can only shrink. docs/architecture.md
// ("Background controller ownership and concurrency") explains the locks.

export type LockedIoKind = "provider" | "tab" | "timer" | "async-wait";

// The lock that is held around the call:
// - a lock helper whose argument body must contain the call, or
// - "caller" when the whole function runs inside a lock its caller took
//   (runSchedulerTick runs inside runTick's withStateLock).
export type LockedIoLock = "withStateLock" | "withSettingsLock" | "withHeartbeatLane" | "caller";

export type LockedIoOwner = 586 | 587 | 588 | 589 | 590 | 593 | 595 | 596 | 597 | 598 | 599;

export interface LockedIoEntry {
  readonly id: string;
  // Relative to packages/core/src.
  readonly file: `background/${string}.ts` | "core/scheduler.ts";
  // The named function that contains the lock (or, for "caller", the call).
  readonly site: string;
  readonly lock: LockedIoLock;
  // A literal substring of the call, as it appears in the source.
  readonly call: string;
  readonly kind: LockedIoKind;
  readonly owner: LockedIoOwner;
}

export const LOCKED_IO_ALLOWLIST: readonly LockedIoEntry[] = [
  // runSchedulerTick runs inside runTick's withStateLock(…, platforms). #599
  // moves each effect out of the lock into its effect executor; #587 prepares
  // supplemental selection outside the lock.
  { id: "tick-reward-claims", file: "core/scheduler.ts", site: "runSchedulerTick", lock: "caller", call: "claimReadyRewards(", kind: "provider", owner: 599 },
  { id: "tick-channel-points", file: "core/scheduler.ts", site: "runSchedulerTick", lock: "caller", call: "adapter.claimChannelPoints(", kind: "provider", owner: 599 },
  { id: "tick-kick-challenges", file: "core/scheduler.ts", site: "runSchedulerTick", lock: "caller", call: "adapter.claimChallenges(", kind: "provider", owner: 599 },
  { id: "tick-legacy-refresh", file: "core/scheduler.ts", site: "runSchedulerTick", lock: "caller", call: "adapter.refreshCampaigns(", kind: "provider", owner: 599 },
  { id: "tick-watch-tab-open", file: "core/scheduler.ts", site: "runSchedulerTick", lock: "caller", call: "adapter.prepareWatchTab(", kind: "tab", owner: 599 },
  { id: "tick-watch-tab-stop", file: "core/scheduler.ts", site: "runSchedulerTick", lock: "caller", call: "adapter.stopWatchTab?.(", kind: "tab", owner: 599 },
  { id: "tick-page-context-release", file: "core/scheduler.ts", site: "runSchedulerTick", lock: "caller", call: "stopPageContextTabs(", kind: "tab", owner: 599 },
  { id: "tick-supplemental-selection", file: "core/scheduler.ts", site: "runSchedulerTick", lock: "caller", call: "options.selectSupplementalWatchTarget!(", kind: "provider", owner: 587 },

  // runTick's own withStateLock body, around and after runSchedulerTick.
  { id: "tick-supplemental-host-call", file: "background/tickRun.ts", site: "runTick", lock: "withStateLock", call: "deps.selectSupplementalWatchTarget!(", kind: "provider", owner: 587 },
  { id: "tick-fallback-selection", file: "background/tickRun.ts", site: "runTick", lock: "withStateLock", call: "prepareSelection(", kind: "async-wait", owner: 587 },
  { id: "tick-discovery-signals", file: "background/tickRun.ts", site: "runTick", lock: "withStateLock", call: "reconcileDiscoverySignalControllers(", kind: "provider", owner: 587 },
  { id: "tick-ad-focus", file: "background/tickRun.ts", site: "runTick", lock: "withStateLock", call: "applyAdFocusForState(", kind: "tab", owner: 587 },
  { id: "tick-tabless-watchers", file: "background/tickRun.ts", site: "runTick", lock: "withStateLock", call: "reconcileTablessWatchers(", kind: "provider", owner: 586 },
  { id: "tick-channel-points-push", file: "background/tickRun.ts", site: "runTick", lock: "withStateLock", call: "reconcileTwitchChannelPointsPush(", kind: "provider", owner: 590 },

  // Heartbeat lane: the watcher starts while its platform's lane is held.
  { id: "heartbeat-watcher-start", file: "background/heartbeat.ts", site: "preparePlatformHeartbeatContext", lock: "withHeartbeatLane", call: "watcher.start(", kind: "provider", owner: 586 },

  // Auth transitions stop observers directly, under the platform lock (#595
  // replaces the calls with the observers' own after-commit hooks).
  { id: "auth-persist-discovery-signal", file: "background/authHealth.ts", site: "persistAuthHealth", lock: "withStateLock", call: "stopDiscoverySignalController(", kind: "provider", owner: 595 },
  { id: "auth-persist-channel-points", file: "background/authHealth.ts", site: "persistAuthHealth", lock: "withStateLock", call: "stopTwitchChannelPointsPush(", kind: "provider", owner: 595 },
  { id: "auth-setup-discovery-signal", file: "background/authHealth.ts", site: "reportAuthSetupFailures", lock: "withStateLock", call: "stopDiscoverySignalController(", kind: "provider", owner: 595 },
  { id: "auth-setup-channel-points", file: "background/authHealth.ts", site: "reportAuthSetupFailures", lock: "withStateLock", call: "stopTwitchChannelPointsPush(", kind: "provider", owner: 595 },
  { id: "auth-invalidate-discovery-signal", file: "background/authHealth.ts", site: "invalidateAuthHealth", lock: "withStateLock", call: "stopDiscoverySignalController(", kind: "provider", owner: 595 },
  { id: "auth-invalidate-channel-points", file: "background/authHealth.ts", site: "invalidateAuthHealth", lock: "withStateLock", call: "stopTwitchChannelPointsPush(", kind: "provider", owner: 595 },

  // Manual watch, playback and tab events.
  { id: "tab-removed-discovery-signals", file: "background/manualWatch.ts", site: "handleTabRemoved", lock: "withStateLock", call: "stopDiscoverySignalControllers(", kind: "provider", owner: 596 },
  { id: "playback-ad-focus", file: "background/manualWatch.ts", site: "recordPlaybackTelemetry", lock: "withStateLock", call: "deps.applyAdFocus(", kind: "tab", owner: 596 },

  // Host reset closes tabs while holding the settings and platform locks.
  { id: "reset-close-watch-tabs", file: "background/lifecycle.ts", site: "prepareForHostReset", lock: "withStateLock", call: "deps.closeManagedTabs(", kind: "tab", owner: 598 },
  { id: "reset-stop-page-contexts", file: "background/lifecycle.ts", site: "prepareForHostReset", lock: "withStateLock", call: "deps.stopPageContextTabs(", kind: "tab", owner: 598 },
  { id: "reset-ad-focus", file: "background/lifecycle.ts", site: "prepareForHostReset", lock: "withStateLock", call: "deps.applyAdFocus?.(", kind: "tab", owner: 598 },

  // Claims outside the tick.
  { id: "manual-claim", file: "background/claims.ts", site: "claimRewardNow", lock: "withStateLock", call: "adapter.claimReward(", kind: "provider", owner: 597 },
  { id: "drop-claims-refresh", file: "background/claims.ts", site: "runDropClaims", lock: "withStateLock", call: "adapter.refreshCampaigns(", kind: "provider", owner: 597 },
  { id: "drop-claims-claim", file: "background/claims.ts", site: "runDropClaims", lock: "withStateLock", call: "claimReadyRewards(", kind: "provider", owner: 597 },
  { id: "kick-challenge-claims", file: "background/kickChallenges.ts", site: "runKickChallengeClaims", lock: "withStateLock", call: "adapter.claimChallenges?.(", kind: "provider", owner: 588 },

  // Twitch integrity schedules or clears its refresh alarm under a lock.
  { id: "integrity-load-schedule", file: "background/twitchIntegrity.ts", site: "loadStoredTwitchIntegrity", lock: "withStateLock", call: "scheduleTwitchIntegrityRefreshBestEffort(", kind: "timer", owner: 589 },
  { id: "integrity-refresh-schedule", file: "background/twitchIntegrity.ts", site: "runTwitchIntegrityRefresh", lock: "withSettingsLock", call: "scheduleTwitchIntegrityRefreshBestEffort(", kind: "timer", owner: 589 },
  { id: "integrity-refresh-clear", file: "background/twitchIntegrity.ts", site: "runTwitchIntegrityRefresh", lock: "withSettingsLock", call: "clearTwitchIntegrityAlarmBestEffort(", kind: "timer", owner: 589 },
  { id: "integrity-capture-schedule", file: "background/twitchIntegrity.ts", site: "captureTwitchIntegrity", lock: "withSettingsLock", call: "scheduleTwitchIntegrityRefreshBestEffort(", kind: "timer", owner: 589 },
  { id: "integrity-restore-schedule", file: "background/twitchIntegrity.ts", site: "restoreTwitchIntegritySchedule", lock: "withStateLock", call: "scheduleTwitchIntegrityRefreshBestEffort(", kind: "timer", owner: 589 },

  // Settings writes reschedule jobs while holding the settings lock.
  { id: "settings-scheduler-alarms", file: "background/settingsTransitions.ts", site: "commitSettings", lock: "withSettingsLock", call: "ensureSchedulerAlarms(", kind: "timer", owner: 593 },
  { id: "settings-claim-alarms", file: "background/settingsTransitions.ts", site: "commitSettings", lock: "withSettingsLock", call: "reconcileManualWatchClaimAlarms(", kind: "timer", owner: 597 },
  { id: "settings-channel-points-alarm", file: "background/settingsTransitions.ts", site: "commitSettings", lock: "withSettingsLock", call: "reconcileTwitchChannelPointsAlarm(", kind: "timer", owner: 590 },
  { id: "startup-claim-alarms", file: "background/settingsTransitions.ts", site: "normalizeStartupSettings", lock: "withSettingsLock", call: "reconcileManualWatchClaimAlarms(", kind: "timer", owner: 597 },
  { id: "startup-channel-points-alarm", file: "background/settingsTransitions.ts", site: "normalizeStartupSettings", lock: "withSettingsLock", call: "reconcileTwitchChannelPointsAlarm(", kind: "timer", owner: 590 },
];

// The size of the list. The test requires the list to be exactly this long, so
// removing an entry means lowering it in the same change. Never raise it.
export const LOCKED_IO_ALLOWLIST_SIZE = 40;

// Calls that count as locked I/O when they appear inside a lock: ports and
// adapter methods that reach a provider, a tab or a timer, and the controller
// helpers that wrap them. Storage loads/saves and event publication are not
// listed; #585 covers publication order separately.
export const LOCKED_IO_CALLS = [
  "adapter.claimReward", "adapter.claimChannelPoints", "adapter.claimChallenges", "adapter.refreshCampaigns",
  "adapter.checkAuthHealth", "adapter.searchCategories", "adapter.prepareWatchTab", "adapter.stopWatchTab",
  "watcher.start", "watcher.stop", "controller.start", "controller.stop",
  "deps.closeManagedTabs", "deps.stopPageContextTabs", "deps.applyAdFocus", "deps.reconcilePageContextRecovery",
  "deps.discardPageContextRecoveryEvidence", "deps.createAlarm", "deps.clearAlarm", "deps.getAlarm",
  "deps.ensureTwitchIntegrity", "deps.cancelTwitchIntegrityAcquisition", "deps.selectSupplementalWatchTarget",
  "deps.checkCredentialAvailability", "deps.wait", "options.selectSupplementalWatchTarget",
  "claimReadyRewards", "stopPageContextTabs", "applyAdFocusForState", "reconcileTablessWatchers",
  "reconcileDiscoverySignalControllers", "reconcileTwitchChannelPointsPush", "stopDiscoverySignalController",
  "stopDiscoverySignalControllers", "stopTwitchChannelPointsPush", "ensureSchedulerAlarms",
  "reconcileManualWatchClaimAlarms", "reconcileTwitchChannelPointsAlarm", "scheduleTwitchIntegrityRefresh",
  "scheduleTwitchIntegrityRefreshBestEffort", "clearTwitchIntegrityAlarm", "clearTwitchIntegrityAlarmBestEffort",
  "refreshAuthHealth", "probeAuthHealth", "checkAuthHealth", "prepareSelection",
] as const;
