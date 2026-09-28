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
//   (none now: Kick page-context recovery left runTick's lock in #598).
export type LockedIoLock = "withStateLock" | "withPlatformLock" | "withSettingsLock" | "withHeartbeatLane" | "caller";

export type LockedIoOwner = 586 | 587 | 588 | 589 | 590 | 595 | 596 | 597 | 598 | 599;

export interface LockedIoEntry {
  readonly id: string;
  // Relative to packages/core/src.
  readonly file: `background/${string}.ts`;
  // The named function that contains the lock (or, for "caller", the call).
  readonly site: string;
  readonly lock: LockedIoLock;
  // A literal substring of the call, as it appears in the source.
  readonly call: string;
  readonly kind: LockedIoKind;
  readonly owner: LockedIoOwner;
}

export const LOCKED_IO_ALLOWLIST: readonly LockedIoEntry[] = [
  // runTick's own withStateLock body, around and after the scheduler tick.
  { id: "tick-tabless-watchers", file: "background/tickRun.ts", site: "runTick", lock: "withStateLock", call: "reconcileTablessWatchers(", kind: "provider", owner: 586 },

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
  { id: "playback-ad-focus", file: "background/manualWatch.ts", site: "recordPlaybackTelemetry", lock: "withStateLock", call: "tabs.watch.applyAdFocus(", kind: "tab", owner: 596 },

  // Kick page-context recovery runs after the tick commit, inside runTick's lock.

  // Claims outside the tick.
  { id: "manual-claim", file: "background/claims.ts", site: "claimRewardNow", lock: "withStateLock", call: "adapter.claimReward(", kind: "provider", owner: 597 },
  { id: "drop-claims-refresh", file: "background/claims.ts", site: "runDropClaims", lock: "withStateLock", call: "adapter.refreshCampaigns(", kind: "provider", owner: 597 },
  { id: "drop-claims-claim", file: "background/claims.ts", site: "runDropClaims", lock: "withStateLock", call: "claimReadyRewards(", kind: "provider", owner: 597 },
  { id: "kick-challenge-claims", file: "background/kickChallenges.ts", site: "runKickChallengeClaims", lock: "withStateLock", call: "adapter.claimChallenges?.(", kind: "provider", owner: 588 },

  // Settings writes reschedule jobs while holding the settings lock.
  { id: "settings-claim-alarms", file: "background/settingsTransitions.ts", site: "commitSettings", lock: "withSettingsLock", call: "reconcileManualWatchClaimAlarms(", kind: "timer", owner: 597 },
  { id: "startup-claim-alarms", file: "background/settingsTransitions.ts", site: "normalizeStartupSettings", lock: "withSettingsLock", call: "reconcileManualWatchClaimAlarms(", kind: "timer", owner: 597 },
];

// The size of the list. The test requires the list to be exactly this long, so
// removing an entry means lowering it in the same change. Never raise it.
//
// #585 raised it once, from 40 to 44, to list v1.14.0 sites #584's source scan
// could not see and the runtime lock tracker found: I/O under withPlatformLock,
// under `adapters[platform]`, and in a function its caller runs under a lock.
// The scan now recognizes all three. That was a correction to the baseline,
// not new locked I/O.
export const LOCKED_IO_ALLOWLIST_SIZE = 16;

// Calls that count as locked I/O when they appear inside a lock: ports and
// adapter methods that reach a provider, a tab or a timer, and the controller
// helpers that wrap them. Storage loads/saves and event publication are not
// listed; #585 covers publication order separately.
export const LOCKED_IO_CALLS = [
  "adapter.claimReward", "adapter.claimChannelPoints", "adapter.claimChallenges", "adapter.refreshCampaigns",
  "adapter.checkAuthHealth", "adapter.searchCategories", "claimTwitchChannelPointsFromPush",
  "watcher.start", "watcher.stop", "controller.start", "controller.stop",
  "tabs.watch.open", "tabs.watch.stop", "tabs.watch.closeManaged", "tabs.watch.applyAdFocus",
  "tabs.pageContexts.release", "tabs?.watch.open", "tabs?.watch.stop", "tabs?.watch.closeManaged",
  "tabs?.watch.applyAdFocus", "tabs?.pageContexts.release", "ports.tabs?.watch.open", "ports.tabs?.watch.stop",
  "ports.tabs?.watch.closeManaged", "ports.tabs?.watch.applyAdFocus", "ports.tabs?.pageContexts.release",
  "pageContexts.recover",
  "ports.tabs?.pageContexts.discardRecoveryEvidence", "ports.jobs.ensure", "ports.jobs.cancel", "ports.jobs.get",
  "integrityPort.ensure", "port.ensure", "ports.twitch.integrity?.cancelAcquisition", "supplementalSources.select",
  "ports.credentials?.checkAvailability", "wait", "options.selectSupplementalWatchTarget",
  "claimReadyRewards", "stopPageContextTabs", "applyAdFocusForState", "reconcileTablessWatchers",
  "reconcileDiscoverySignalControllers", "reconcileDiscoverySignalsAfterCommit", "reconcileTwitchChannelPointsPush",
  "reconcileTwitchChannelPointsPushAfterCommit", "rescheduleTwitchChannelPointsJob", "runTwitchChannelPointsClaim",
  "claims.unlessRunning", "claims.afterRunning", "gate.unlessRunning", "stopDiscoverySignalController",
  "stopDiscoverySignalControllers", "stopTwitchChannelPointsPush", "ensureSchedulerAlarms",
  "reconcileManualWatchClaimAlarms", "reconcileTwitchChannelPointsAlarm", "scheduleTwitchIntegrityRefresh",
  "scheduleTwitchIntegrityRefreshBestEffort", "clearTwitchIntegrityAlarm", "clearTwitchIntegrityAlarmBestEffort",
  "refreshAuthHealth", "probeAuthHealth", "checkAuthHealth", "prepareSelection",
] as const;
