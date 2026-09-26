import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { createAuthHealth } from "./authHealth";
import { createChannelPoints } from "./channelPoints";
import { createClaims } from "./claims";
import {
  KICK_ALARM_NAME,
  KICK_CHALLENGES_ALARM_NAME,
  KICK_DROP_CLAIMS_ALARM_NAME,
  TWITCH_ALARM_NAME,
  TWITCH_CHANNEL_POINTS_ALARM_NAME,
  TWITCH_DROP_CLAIMS_ALARM_NAME,
  TWITCH_INTEGRITY_ALARM_NAME,
  WATCH_ALARM_NAME,
} from "./constants";
import {
  createAuthHealthSlice,
  createChannelPointsSlice,
  createClaimSlice,
  createDiscoverySignalSlice,
  createHeartbeatSlice,
  createKickChallengeSlice,
  createLifecycleSlice,
  createReportingSlice,
  createSettingsSlice,
  createStateCommitSlice,
  createTickAdmissionSlice,
  createTwitchIntegritySlice,
} from "./context";
import { createDiscovery } from "./discovery";
import { createDiscoverySignals } from "./discoverySignals";
import { createHeartbeats } from "./heartbeat";
import { createKickChallenges } from "./kickChallenges";
import { createLifecycle } from "./lifecycle";
import { createManualWatch } from "./manualWatch";
import { createMessageHandler } from "./messages";
import { createReporting } from "./reporting";
import { createSettingsTransitions } from "./settingsTransitions";
import { createStateCommit } from "./stateCommit";
import { createTickAdmission } from "./tickAdmission";
import { createTickRun } from "./tickRun";
import { createTwitchIntegrity } from "./twitchIntegrity";
import type { BackgroundControllerDeps, ControllerCalls, TickTrigger } from "./types";

export {
  ALARM_NAME,
  TWITCH_ALARM_NAME,
  KICK_ALARM_NAME,
  WATCH_ALARM_NAME,
  TWITCH_CHANNEL_POINTS_ALARM_NAME,
  TWITCH_DROP_CLAIMS_ALARM_NAME,
  KICK_DROP_CLAIMS_ALARM_NAME,
  KICK_CHALLENGES_ALARM_NAME,
  TWITCH_INTEGRITY_ALARM_NAME,
  TWITCH_INTEGRITY_REFRESH_LEAD_MS,
  TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS,
} from "./constants";
export { isRankingOnlyPatch } from "./settingsTransitions";
export type { ClaimedRewards, TickTrigger, CredentialAvailability, BackgroundControllerDeps } from "./types";

interface BackgroundAlarmController {
  tickAndHandOff(platforms?: Platform[], trigger?: TickTrigger): Promise<SchedulerState | undefined>;
  runWatchHeartbeat(): Promise<void>;
  runTwitchChannelPointsClaim(): Promise<void>;
  runDropClaims(platform: Platform): Promise<void>;
  runKickChallengeClaims(): Promise<void>;
  runTwitchIntegrityRefresh(): Promise<void>;
}

export function createBackgroundAlarmListener(controller: BackgroundAlarmController) {
  return (alarm: { name: string }): void => {
    if (alarm.name === TWITCH_ALARM_NAME) {
      void controller.tickAndHandOff(["twitch"], "alarm");
    } else if (alarm.name === KICK_ALARM_NAME) {
      void controller.tickAndHandOff(["kick"], "alarm");
    } else if (alarm.name === WATCH_ALARM_NAME) {
      void controller.runWatchHeartbeat();
    } else if (alarm.name === TWITCH_CHANNEL_POINTS_ALARM_NAME) {
      void controller.runTwitchChannelPointsClaim();
    } else if (alarm.name === TWITCH_DROP_CLAIMS_ALARM_NAME) {
      void controller.runDropClaims("twitch");
    } else if (alarm.name === KICK_DROP_CLAIMS_ALARM_NAME) {
      void controller.runDropClaims("kick");
    } else if (alarm.name === KICK_CHALLENGES_ALARM_NAME) {
      void controller.runKickChallengeClaims();
    } else if (alarm.name === TWITCH_INTEGRITY_ALARM_NAME) {
      void controller.runTwitchIntegrityRefresh();
    }
  };
}

export function createBackgroundController<S extends EngineSettings = EngineSettings>(deps: BackgroundControllerDeps<S>) {
  const reportingSlice = createReportingSlice();
  const commitSlice = createStateCommitSlice();
  const heartbeatSlice = createHeartbeatSlice();
  const integritySlice = createTwitchIntegritySlice();
  const channelPointsSlice = createChannelPointsSlice();
  const kickChallengeSlice = createKickChallengeSlice();
  const authSlice = createAuthHealthSlice();
  const claimSlice = createClaimSlice();
  const signalSlice = createDiscoverySignalSlice();
  const tickSlice = createTickAdmissionSlice();
  const settingsSlice = createSettingsSlice();
  const lifecycleSlice = createLifecycleSlice();
  // Each module takes the slices it uses and the calls it makes into other
  // modules. The calls resolve through `calls` once every module exists.
  const calls = {} as ControllerCalls<S>;
  const { discoverySlice, ...discovery } = createDiscovery(deps, { lifecycleSlice }, calls);
  Object.assign(calls, {
    ...createReporting(deps, { reportingSlice }, calls),
    ...createStateCommit(deps, { commitSlice }, calls),
    ...createHeartbeats(deps, { heartbeatSlice, tickSlice, lifecycleSlice }, calls),
    ...createTwitchIntegrity(deps, { integritySlice, settingsSlice, lifecycleSlice }, calls),
    ...createChannelPoints(deps, { channelPointsSlice, signalSlice, tickSlice, lifecycleSlice }, calls),
    ...createKickChallenges(deps, { kickChallengeSlice, lifecycleSlice }, calls),
    ...createAuthHealth(deps, { authSlice, discoverySlice }, calls),
    ...createManualWatch(deps, calls),
    ...createClaims(deps, { kickChallengeSlice, claimSlice, lifecycleSlice }, calls),
    ...createDiscoverySignals(deps, { signalSlice, tickSlice, lifecycleSlice }, calls),
    ...discovery,
    ...createTickAdmission(deps, { reportingSlice, integritySlice, signalSlice, tickSlice, lifecycleSlice }, calls),
    ...createTickRun(deps, { claimSlice, discoverySlice, tickSlice }, calls),
    ...createSettingsTransitions(deps, { discoverySlice, settingsSlice }, calls),
    ...createLifecycle(deps, { integritySlice, signalSlice, discoverySlice, tickSlice, settingsSlice, lifecycleSlice }, calls),
    ...createMessageHandler(deps, { integritySlice, signalSlice, tickSlice, settingsSlice, lifecycleSlice }, calls),
  } satisfies ControllerCalls<S>);

  // Prime the in-memory integrity token from storage whenever the background
  // script (re)evaluates, so a claim right after a service-worker wake can use
  // the last captured token before any fresh page traffic is observed.
  integritySlice.initialTwitchIntegrityLoad = calls.loadStoredTwitchIntegrity(
    integritySlice.integrityLifecycleGeneration,
    settingsSlice.twitchSettingsTransitionGeneration,
  );

  return {
    ensureAlarm: calls.ensureAlarm,
    ensureInstalledAt: calls.ensureInstalledAt,
    handleStartup: calls.handleStartup,
    handleTabRemoved: calls.handleTabRemoved,
    handleTabUpdated: calls.handleTabUpdated,
    handleMessage: calls.handleMessage,
    resumeAfterManualClose: calls.resumeAfterManualClose,
    captureTwitchIntegrity: calls.captureTwitchIntegrity,
    runTwitchIntegrityRefresh: calls.runTwitchIntegrityRefresh,
    checkAuthHealth: calls.checkAuthHealth,
    invalidateAuthHealth: calls.invalidateAuthHealth,
    tick: calls.tick,
    tickAndHandOff: calls.tickAndHandOff,
    refreshDiscovery: calls.refreshDiscovery,
    discoverySnapshot: calls.discoverySnapshot,
    runWatchHeartbeat: calls.runWatchHeartbeat,
    runTwitchChannelPointsClaim: calls.runTwitchChannelPointsClaim,
    runDropClaims: calls.runDropClaims,
    runKickChallengeClaims: calls.runKickChallengeClaims,
    runClaimHandoff: calls.runClaimHandoff,
    abortClaimHandoffs: calls.abortClaimHandoffs,
    shutdown: calls.shutdown,
    prepareForHostReset: calls.prepareForHostReset,
    settleBackgroundWork: calls.settleBackgroundWork,
  };
}
