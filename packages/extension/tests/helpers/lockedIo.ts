// Provider, tab and timer I/O must never run while a lock is held (#583, #585).
// v1.14.0 did so at 44 sites. Each v1.15.0 issue moved its sites out, and #591
// deleted the allowlist that tracked them once it was empty: there are no
// exceptions. lockedIo.test.ts scans the source for these calls inside a lock,
// and the runtime lock tracker (lockTracker.ts) fails any guarded port called
// while one is held. docs/architecture.md ("Background controller ownership and
// concurrency") explains the locks.

// The lock helpers whose argument body runs while the lock is held.
export const LOCKS = ["withStateLock", "withPlatformLock", "withSettingsLock", "withHeartbeatLane"] as const;

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
