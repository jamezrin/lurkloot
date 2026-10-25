import type {
  ExtensionSettings,
  Platform,
  PlatformAuthStatus,
  SchedulerState,
} from "@lurkloot/shared/models";

// The toolbar icon summarises the whole extension in one glance (#900). It is
// derived from committed settings and state only; nothing else writes the icon.
export type ToolbarStatus = "off" | "idle" | "watching" | "paused" | "problem";

export type ToolbarPlatformStatus =
  | "watching"
  | "idle"
  | "paused"
  | "signed_out"
  | "blocked"
  | "stuck";

export interface ToolbarPlatformLine {
  platform: Platform;
  status: ToolbarPlatformStatus;
}

export interface ToolbarView {
  status: ToolbarStatus;
  // One line per enabled platform, in display order. Empty when everything is off.
  platforms: ToolbarPlatformLine[];
}

const PLATFORMS: readonly Platform[] = ["twitch", "kick"];

export const TOOLBAR_PLATFORM_NAMES: Record<Platform, string> = { twitch: "Twitch", kick: "Kick" };

// Auth states that need the user. "checking" and "unavailable" are transient
// (a probe in flight, a network blip) and would make the icon flap.
const SIGNED_OUT: ReadonlySet<PlatformAuthStatus> = new Set([
  "missing_credentials",
  "invalid_credentials",
]);

function platformStatus(state: SchedulerState, platform: Platform): ToolbarPlatformStatus {
  const auth = state.authHealth[platform]?.status;
  if (auth && SIGNED_OUT.has(auth)) return "signed_out";
  if (auth === "blocked") return "blocked";
  if (state.criticalHealth?.[platform]?.status === "flagged") return "stuck";
  // A session "error" is per-channel backoff the scheduler recovers from on its
  // own, so it is not surfaced as a problem.
  const session = state.sessions[platform]?.status;
  if (state.manualClosePause?.[platform] || session === "paused") return "paused";
  if (session === "watching") return "watching";
  return "idle";
}

const PROBLEMS: ReadonlySet<ToolbarPlatformStatus> = new Set(["signed_out", "blocked", "stuck"]);

export function deriveToolbarView(
  settings: Pick<ExtensionSettings, "platform">,
  state: SchedulerState,
): ToolbarView {
  const platforms = PLATFORMS.filter((platform) => settings.platform[platform].enabled).map(
    (platform) => ({ platform, status: platformStatus(state, platform) }),
  );
  const has = (predicate: (status: ToolbarPlatformStatus) => boolean) =>
    platforms.some((line) => predicate(line.status));
  const status: ToolbarStatus =
    platforms.length === 0
      ? "off"
      : has((value) => PROBLEMS.has(value))
        ? "problem"
        : has((value) => value === "paused")
          ? "paused"
          : has((value) => value === "watching")
            ? "watching"
            : "idle";
  return { status, platforms };
}

const PLATFORM_TITLE_KEYS: Record<ToolbarPlatformStatus, string> = {
  watching: "toolbarTitleWatching",
  idle: "toolbarTitleIdle",
  paused: "toolbarTitlePaused",
  signed_out: "toolbarTitleSignedOut",
  blocked: "toolbarTitleBlocked",
  stuck: "toolbarTitleStuck",
};

export type ToolbarTranslate = (key: string, substitutions?: string | string[]) => Promise<string>;

export async function toolbarTitle(
  view: ToolbarView,
  translate: ToolbarTranslate,
): Promise<string> {
  const lines =
    view.platforms.length === 0
      ? [await translate("toolbarTitleOff")]
      : await Promise.all(
          view.platforms.map((line) =>
            translate(PLATFORM_TITLE_KEYS[line.status], TOOLBAR_PLATFORM_NAMES[line.platform]),
          ),
        );
  return [await translate("extensionName"), ...lines].join("\n");
}

export const TOOLBAR_ICON_SIZES = [16, 32] as const;

export function toolbarIconPaths(status: ToolbarStatus): Record<string, string> {
  return Object.fromEntries(
    TOOLBAR_ICON_SIZES.map((size) => [
      String(size),
      // "idle" is the plain brand mark the manifest already declares.
      status === "idle" ? `/icon/${size}.png` : `/icon/status/${status}-${size}.png`,
    ]),
  );
}

// The subset of `action` (MV3) / `browserAction` (Firefox MV2) the toolbar uses.
export interface ToolbarActionApi {
  setIcon(details: { path: Record<string, string> }): Promise<void>;
  setTitle(details: { title: string }): Promise<void>;
}

export interface ToolbarStatusApplier {
  apply(settings: Pick<ExtensionSettings, "platform">, state: SchedulerState): Promise<void>;
  // Forget what was applied, so the next apply writes again (worker wake, reset).
  invalidate(): void;
}

export function createToolbarStatusApplier(
  action: ToolbarActionApi | undefined,
  translate: ToolbarTranslate,
): ToolbarStatusApplier {
  let appliedIcon: ToolbarStatus | undefined;
  let appliedTitle: string | undefined;
  // Applies run in commit order; a slow translate must not let an older view win.
  let queue: Promise<void> = Promise.resolve();
  return {
    apply(settings, state) {
      const view = deriveToolbarView(settings, state);
      queue = queue
        .then(async () => {
          if (!action) return;
          if (appliedIcon !== view.status) {
            await action.setIcon({ path: toolbarIconPaths(view.status) });
            appliedIcon = view.status;
          }
          const title = await toolbarTitle(view, translate);
          if (appliedTitle !== title) {
            await action.setTitle({ title });
            appliedTitle = title;
          }
        })
        .catch(() => undefined);
      return queue;
    },
    invalidate() {
      appliedIcon = undefined;
      appliedTitle = undefined;
    },
  };
}
