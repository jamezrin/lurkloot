import type { EngineEvent } from "@lurkloot/shared/events";
import type { ChatPresenceStatus, EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { twitchExtensionProvider } from "../extensions/registry";
import { pausedForManualWatch } from "./manualWatch";

// Chat presence (docs/superpowers/specs/2026-10-05-chat-presence-design.md).
export interface ChatPresenceTarget {
  username: string;
  channelId?: string;
}

// One platform's chat connection. Shaped as a SlotObserver (stop +
// drainEvents) so the background service can hold it in an ObserverSlot.
export interface ChatPresenceClient {
  // Join `target`, switch to it, or leave when undefined. Resolves once the
  // command is issued; status() reports whether the join was confirmed.
  follow(target: ChatPresenceTarget | undefined): Promise<void>;
  status(): ChatPresenceStatus;
  drainEvents(): readonly EngineEvent[];
  stop(): Promise<void>;
}

export type ChatPresenceTrigger = { kind: "setting" } | { kind: "provider"; providerId: string };

export interface ChatPresenceDecision {
  target: ChatPresenceTarget;
  trigger: ChatPresenceTrigger;
}

// Whether `platform` wants chat presence for the committed `state`, and where.
// Tab watches never do: the page already joins chat.
export function chatPresenceDecision(
  platform: Platform,
  settings: EngineSettings,
  state: SchedulerState,
  options: { capability: boolean; now?: number },
): ChatPresenceDecision | undefined {
  if (!options.capability) return undefined;
  const platformSettings = settings.platform[platform];
  const session = state.sessions[platform];
  const channel = session.channel;
  if (!platformSettings.enabled
    || state.authHealth[platform].status !== "healthy"
    || state.manualClosePause?.[platform]
    || pausedForManualWatch(settings, state, platform, options.now ?? Date.now())
    || session.status !== "watching"
    || session.watchMode !== "tabless"
    || !channel) return undefined;
  const target: ChatPresenceTarget = {
    username: channel.username.toLowerCase(),
    ...(channel.channelId ? { channelId: channel.channelId } : {}),
  };
  const providerId = platform === "twitch" ? session.supplementalWatch?.id : undefined;
  if (providerId && twitchExtensionProvider(providerId)?.needsChatPresence) {
    return { target, trigger: { kind: "provider", providerId } };
  }
  if (platformSettings.alwaysEnterChat === true) return { target, trigger: { kind: "setting" } };
  return undefined;
}
