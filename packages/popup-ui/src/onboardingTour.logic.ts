import type { Platform } from "@lurkloot/shared/models";
import type { PopupView } from "./shell";

export interface TourStep {
  id: string;
  platform: Platform;
  view: PopupView;
  settingsFocus?: string;
  targets: readonly string[];
  titleKey: string;
  bodyKey: string;
}

function step(
  id: string,
  platform: Platform,
  view: PopupView,
  targets: readonly string[],
  titleKey: string,
  settingsFocus?: string,
): TourStep {
  return {
    id,
    platform,
    view,
    ...(settingsFocus ? { settingsFocus } : {}),
    targets,
    titleKey,
    bodyKey: titleKey.replace("Title", "Body"),
  };
}

export const TOUR_STEPS: readonly TourStep[] = [
  step("statusStrip", "twitch", "queue", ['[data-tour="status-strip"]'], "tourStatusStripTitle"),
  step("platformSwitch", "twitch", "queue", ['[data-tour="platform-switch"]'], "tourPlatformTitle"),
  step("queueOrder", "twitch", "queue", ['[data-tour="queue-list"]'], "tourQueueOrderTitle"),
  step(
    "queueControls",
    "twitch",
    "queue",
    ['[data-tour="queue-strategy"]'],
    "tourQueueControlsTitle",
  ),
  step("completed", "twitch", "completed", ['[data-tour="completed-list"]'], "tourCompletedTitle"),
  step("games", "twitch", "games", ['[data-tour="games-mode"]'], "tourGamesTitle"),
  step("watchlist", "twitch", "watchlist", ['[data-tour="watchlist"]'], "tourWatchlistTitle"),
  step("extensions", "twitch", "nopixel", ['[data-tour="rail-extensions"]'], "tourExtensionsTitle"),
  step(
    "kickProgress",
    "kick",
    "queue",
    ['[data-account-progress="kick"]'],
    "tourKickProgressTitle",
  ),
  step(
    "kickChallenges",
    "kick",
    "settings",
    ['[data-tour="kick-challenges"]'],
    "tourKickChallengesTitle",
    "kick",
  ),
  step("activity", "kick", "activity", ['[data-tour="activity-list"]'], "tourActivityTitle"),
  step(
    "settings",
    "kick",
    "settings",
    ['[id="settings-section-general.drops"]'],
    "tourSettingsTitle",
    "general.drops",
  ),
];

export type TourPhase =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "welcome" }
  | { kind: "step"; index: number }
  | { kind: "done" };

export type TourAction = "arm" | "disarm" | "start" | "next" | "back" | "skip" | "finish";

export function tourReducer(phase: TourPhase, action: TourAction): TourPhase {
  switch (phase.kind) {
    case "loading":
      if (action === "arm") return { kind: "welcome" };
      if (action === "disarm") return { kind: "hidden" };
      return phase;
    case "hidden":
      return action === "arm" ? { kind: "welcome" } : phase;
    case "welcome":
      if (action === "start") return { kind: "step", index: 0 };
      if (dismissesForGood(action)) return { kind: "hidden" };
      return phase;
    case "step":
      if (action === "next") {
        return phase.index + 1 >= TOUR_STEPS.length
          ? { kind: "done" }
          : { kind: "step", index: phase.index + 1 };
      }
      if (action === "back") return { kind: "step", index: Math.max(0, phase.index - 1) };
      if (dismissesForGood(action)) return { kind: "hidden" };
      return phase;
    case "done":
      return dismissesForGood(action) ? { kind: "hidden" } : phase;
  }
}

export function dismissesForGood(action: TourAction): boolean {
  return action === "skip" || action === "finish";
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const top = Math.min(...rects.map((r) => r.top));
  const left = Math.min(...rects.map((r) => r.left));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  return { top, left, width: right - left, height: bottom - top };
}

// Keeps the top part of a tall target and clips it to the frame.
export function clampTarget(
  target: Rect,
  frame: { width: number; height: number },
  maxHeightRatio = 0.55,
): Rect {
  const top = Math.max(0, Math.min(target.top, frame.height));
  const left = Math.max(0, Math.min(target.left, frame.width));
  const width = Math.max(0, Math.min(target.left + target.width, frame.width) - left);
  const bottom = Math.min(target.top + target.height, frame.height);
  const height = Math.max(0, Math.min(bottom - top, frame.height * maxHeightRatio));
  return { top, left, width, height };
}

const CARD_GAP = 12;
const FRAME_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

export function placeCard(
  target: Rect | null,
  card: { width: number; height: number },
  frame: { width: number; height: number },
): { top: number; left: number; side: "below" | "above" | "right" | "left" | "center" } {
  const minTop = FRAME_MARGIN;
  const maxTop = frame.height - FRAME_MARGIN - card.height;
  const minLeft = FRAME_MARGIN;
  const maxLeft = frame.width - FRAME_MARGIN - card.width;
  if (!target) {
    return {
      top: clamp((frame.height - card.height) / 2, minTop, maxTop),
      left: clamp((frame.width - card.width) / 2, minLeft, maxLeft),
      side: "center",
    };
  }
  const centredLeft = clamp(target.left + (target.width - card.width) / 2, minLeft, maxLeft);
  const centredTop = clamp(target.top + (target.height - card.height) / 2, minTop, maxTop);
  const below = target.top + target.height + CARD_GAP;
  if (below <= maxTop) return { top: below, left: centredLeft, side: "below" };
  const above = target.top - CARD_GAP - card.height;
  if (above >= minTop) return { top: above, left: centredLeft, side: "above" };
  const right = target.left + target.width + CARD_GAP;
  if (right <= maxLeft) return { top: centredTop, left: right, side: "right" };
  const left = target.left - CARD_GAP - card.width;
  if (left >= minLeft) return { top: centredTop, left, side: "left" };
  return { top: clamp(below, minTop, maxTop), left: centredLeft, side: "below" };
}
