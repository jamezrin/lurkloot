import type { PlaybackControl, RuntimeMessage, RuntimeSnapshot } from "../core/messages";
import type { DropCampaign, DropReward, ExtensionSettings, Platform, SchedulerState } from "../core/models";
import { appendEvent } from "../core/storage";
import { mergeSettings } from "../core/settings";
import { runSchedulerTick } from "../core/scheduler";
import type { PlatformAdapter } from "../platforms/adapter";

export const ALARM_NAME = "stream-maxxing.tick";

export interface BackgroundControllerDeps {
  loadSettings(): Promise<ExtensionSettings>;
  saveSettings(settings: ExtensionSettings): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  createAlarm(name: string, options: { periodInMinutes: number }): Promise<void>;
  createAdapters(): Record<Platform, PlatformAdapter>;
  createNotification?(notification: { title: string; message: string }): Promise<void>;
}

export function createBackgroundController(deps: BackgroundControllerDeps) {
  async function ensureAlarm(): Promise<void> {
    const settings = await deps.loadSettings();
    await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
    if (settings.autoStartDropFarming && settings.running) await tick();
  }

  async function snapshot(): Promise<RuntimeSnapshot> {
    return {
      settings: await deps.loadSettings(),
      state: await deps.loadState(),
    };
  }

  async function tick(platforms?: Platform[]): Promise<void> {
    const settings = await deps.loadSettings();
    const state = await deps.loadState();

    try {
      const result = await runSchedulerTick(state, settings, deps.createAdapters(), platforms ? { platforms } : undefined);
      await emitNotifications(settings, state, result.state);
      await deps.saveState(appendEvent(result.state, {
        level: "info",
        message: "Scheduler tick completed",
      }));
    } catch (error) {
      await deps.saveState(appendEvent(state, {
        level: "error",
        message: error instanceof Error ? error.message : "Scheduler tick failed",
      }));
    }
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
    if (!settings.running) return;

    for (const platform of ["twitch", "kick"] as Platform[]) {
      const session = state.sessions[platform];
      if (
        settings.platform[platform].enabled
        && session.status === "watching"
        && session.tabManagedByExtension
        && session.tabId === tabId
      ) {
        await tick();
        return;
      }
    }
  }

  async function recordPlaybackTelemetry(
    message: Extract<RuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId?: number,
  ): Promise<void> {
    const state = await deps.loadState();
    const session = state.sessions[message.platform];
    if (senderTabId != null && session.tabId != null && senderTabId !== session.tabId) return;

    await deps.saveState({
      ...state,
      sessions: {
        ...state.sessions,
        [message.platform]: {
          ...session,
          playback: {
            ...message.telemetry,
            platform: message.platform,
            checkedAt: new Date().toISOString(),
          },
        },
      },
    });
  }

  async function getPlaybackControl(
    message: Extract<RuntimeMessage, { type: "getPlaybackControl" }>,
    senderTabId?: number,
  ): Promise<PlaybackControl> {
    const state = await deps.loadState();
    const session = state.sessions[message.platform];
    return {
      managed: senderTabId != null
        && session.status === "watching"
        && session.tabId === senderTabId,
    };
  }

  async function claimRewardNow(
    message: Extract<RuntimeMessage, { type: "claimReward" }>,
  ): Promise<RuntimeSnapshot> {
    const state = await deps.loadState();
    const campaigns = state.campaigns[message.platform];
    const campaign = campaigns.find((item) => item.id === message.campaignId);
    const reward = campaign?.rewards.find((item) => item.id === message.rewardId);

    if (!campaign || !reward) {
      await deps.saveState(appendEvent(state, {
        platform: message.platform,
        level: "warn",
        message: "Reward claim skipped because the campaign or reward is no longer available",
      }));
      return snapshot();
    }

    if (!canClaimReward(reward)) {
      await deps.saveState(appendEvent(state, {
        platform: message.platform,
        level: "warn",
        message: `${reward.name} is not ready to claim`,
      }));
      return snapshot();
    }

    try {
      const claimed = await deps.createAdapters()[message.platform].claimReward(campaign, reward);
      const nextCampaigns = campaigns.map((item) => {
        if (item.id !== campaign.id) return item;
        const rewards = item.rewards.map((candidate) => candidate.id === reward.id && claimed
          ? { ...candidate, status: "claimed" as const, watchedMinutes: candidate.requiredMinutes }
          : candidate);
        return {
          ...item,
          rewards,
          status: rewards.every((candidate) => candidate.status === "claimed") ? "completed" as const : item.status,
        };
      });
      const nextState = appendEvent({
        ...state,
        campaigns: {
          ...state.campaigns,
          [message.platform]: nextCampaigns,
        },
      }, {
        platform: message.platform,
        level: claimed ? "info" : "warn",
        message: claimed
          ? `Claimed ${reward.name} from ${campaign.name}`
          : `Could not claim ${reward.name} from ${campaign.name}`,
      });
      const settings = settingsWithDefaults(await deps.loadSettings());
      if (claimed && settings.notifyRewardEarned) {
        await safeNotify(settings, "Reward claimed", `${reward.name} from ${campaign.name}`);
      }
      await deps.saveState(nextState);
      return snapshot();
    } catch (error) {
      await deps.saveState(appendEvent(state, {
        platform: message.platform,
        level: "error",
        message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
      }));
      return snapshot();
    }
  }

  async function handleMessage(
    message: RuntimeMessage,
    sender?: { tab?: { id?: number } },
  ): Promise<RuntimeSnapshot | PlaybackControl | void> {
    if (message.type === "getPlaybackControl") {
      return getPlaybackControl(message, sender?.tab?.id);
    }

    if (message.type === "playbackTelemetry") {
      await recordPlaybackTelemetry(message, sender?.tab?.id);
      return undefined;
    }

    if (message.type === "getSnapshot") {
      return snapshot();
    }

    if (message.type === "setRunning") {
      const settings = mergeSettings({ ...(await deps.loadSettings()), running: message.running });
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      await tick();
      return snapshot();
    }

    if (message.type === "setPlatformEnabled") {
      const current = await deps.loadSettings();
      const settings = mergeSettings({
        ...current,
        platform: {
          ...current.platform,
          [message.platform]: {
            ...current.platform[message.platform],
            enabled: message.enabled,
          },
        },
      });
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      if (settings.running) await tick();
      return snapshot();
    }

    if (message.type === "setAutomation") {
      const current = await deps.loadSettings();
      const settings = mergeSettings({
        ...current,
        running: message.enabled ? true : current.running,
        platform: {
          ...current.platform,
          [message.platform]: {
            ...current.platform[message.platform],
            enabled: message.enabled,
          },
        },
      });
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      if (settings.running) await tick();
      return snapshot();
    }

    if (message.type === "saveSettings") {
      const settings = mergeSettings(message.settings);
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      if (message.tickAfterSave && settings.running && hasEnabledPlatform(settings)) {
        await tick(message.tickAfterSavePlatforms);
      }
      return snapshot();
    }

    if (message.type === "claimReward") {
      return claimRewardNow(message);
    }

    if (message.type === "tickNow") {
      await tick();
      return snapshot();
    }
  }

  async function safeNotify(settings: ExtensionSettings, title: string, message: string): Promise<void> {
    if (!deps.createNotification) return;
    try {
      await deps.createNotification({ title, message });
    } catch {
      // Notification delivery is best-effort and must not fail scheduler ticks.
    }
  }

  async function emitNotifications(
    settings: ExtensionSettings,
    previous: SchedulerState,
    next: SchedulerState,
  ): Promise<void> {
    if (settings.notifyRewardEarned) {
      for (const reward of newlyEarnedRewards(previous, next)) {
        await safeNotify(settings, "Reward earned", `${reward.reward.name} from ${reward.campaign.name}`);
      }
    }

    if (settings.notifyNoDropsLeft) {
      for (const platform of ["twitch", "kick"] as Platform[]) {
        const session = next.sessions[platform];
        if (
          settings.running
          && settings.platform[platform].enabled
          && session.status === "idle"
          && next.campaigns[platform].length > 0
          && next.campaigns[platform].every((campaign) => !hasEarnableReward(campaign))
        ) {
          await safeNotify(settings, "No drops left", `${platformLabel(platform)} has no eligible drops to farm.`);
        }
      }
    }
  }

  return {
    ensureAlarm,
    handleTabRemoved,
    handleMessage,
    tick,
  };

  function settingsWithDefaults(settings: ExtensionSettings): ExtensionSettings {
    return mergeSettings(settings);
  }
}

function hasEnabledPlatform(settings: ExtensionSettings): boolean {
  return (["twitch", "kick"] as Platform[]).some((platform) => settings.platform[platform].enabled);
}

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
        if ((reward.status === "claimable" || reward.status === "claimed") && before !== reward.status) {
          earned.push({ campaign, reward });
        }
      }
    }
  }
  return earned;
}

function hasEarnableReward(campaign: DropCampaign): boolean {
  return campaign.status === "active"
    && campaign.accountLinked !== false
    && (!campaign.eligibility || campaign.eligibility === "eligible")
    && campaign.rewards.some((reward) => reward.status !== "claimed" && reward.status !== "claimable" && reward.preconditionsMet !== false);
}

function canClaimReward(reward: DropReward): boolean {
  if (reward.status !== "claimable") return false;
  if (!reward.claimUntil) return true;
  const claimUntil = Date.parse(reward.claimUntil);
  return Number.isNaN(claimUntil) || Date.now() < claimUntil;
}

function platformLabel(platform: Platform): string {
  return platform === "twitch" ? "Twitch" : "Kick";
}
