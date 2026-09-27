import type { AdFocusMode, ChannelCandidate, ManagedPageContextTab, ManagedWatchTab, Platform, SchedulerManagedPageContexts, WatchSession } from "@lurkloot/shared/models";
import type { EventEmitter, PageContextCloseReason, PageContextOpenReason } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { TwitchIntegrity } from "./twitchIntegrity";
import type { KickPageContextCycleObservation, PreparedWatchTab, WatchTabOptions } from "../platforms/adapter";
import { SafeFetchError, safeFetchFailure, type SafeFetchFailure } from "./fetchError";
import {
  createTwitchRequestIdentity,
  fetchTwitchInBackgroundWith as fetchTwitchInBackgroundWithIdentity,
  type CookieApi,
  type TwitchRequestIdentity,
} from "./transport";

// Re-exported while callers migrate to @lurkloot/core/transport (#598).
export {
  fetchKickInBackgroundWith,
  KickWafBlockedError,
  needsKickSessionBearer,
  safeKickFailure,
  type CookieApi,
} from "./transport";
import { isTimestampStale, PLAYBACK_TELEMETRY_MAX_AGE_MS } from "./timestamps";

const ignoreEvent: EventEmitter = () => {};

function diagnostic(emit: EventEmitter, level: LogLevel, message: string, platform?: Platform): void {
  emit({ category: "diagnostic", level, message, platform });
}

export interface BrowserTabApi {
  tabs: {
    get(tabId: number): Promise<BrowserTab | undefined>;
    update(tabId: number, properties: Record<string, unknown>): Promise<unknown>;
    remove?(tabId: number): Promise<void>;
    query(queryInfo: Record<string, unknown>): Promise<BrowserTab[]>;
    create(createProperties: Record<string, unknown>): Promise<{ id?: number } | void>;
    executeScript?: (tabId: number, details: { code: string }) => Promise<unknown[] | undefined>;
  };
  scripting?: {
    executeScript?: (details: unknown) => Promise<Array<{ result?: unknown }>>;
  };
  windows?: {
    update(windowId: number, properties: Record<string, unknown>): Promise<unknown>;
  };
}

interface BrowserTab {
  id?: number;
  url?: string;
  pinned?: boolean;
  active?: boolean;
  status?: string;
  windowId?: number;
  mutedInfo?: { muted?: boolean };
}

// Where a page-context tab came from. Only used for diagnostics: a freshly
// created tab boots the SPA and issues authenticated GQL, while an inherited one
// may be idle and issue nothing, which decides whether waiting for a token can
// succeed at all.
type PageContextSource = "created" | "user_tab" | "managed_tab" | "shared_entry";

interface PageContextTab {
  tabId: number;
  createdByExtension: boolean;
  retainedContext?: ManagedPageContextTab;
  openedForRequest?: boolean;
  source?: PageContextSource;
}

interface PageContextEntry {
  promise: Promise<PageContextTab>;
  refs: number;
  abort: AbortController;
}

// Every tab the engine holds, and the state that goes with it, for one
// controller (#598). Nothing here is module-level: two controllers in one
// process each create their own registry and share no tab state. The host that
// runs the tab mechanics and the controller that reads the snapshots must be
// handed the same instance.
export interface TabRegistry {
  pageContextTabs: Map<string, PageContextEntry>;
  retainedPageContextTabs: Map<Platform, ManagedPageContextTab>;
  closingPageContextTabIds: Set<number>;
  retainedPageContextRevision: number;
  // Mirrors SchedulerState.criticalHealth[platform].breakerOpen. The page-context
  // call sites are several layers deep and have no access to scheduler state, so
  // the scheduler (and the controller, whenever it records an open) pushes the
  // flag here instead. Watch tabs are gated directly in the scheduler, which
  // already has the state in scope.
  openManagedTabBreakers: Set<Platform>;
  playbackPrimeStates: Map<Platform, PlaybackPrimeState>;
  adFocusHolds: Map<Platform, number>;
  adFocusExpired: Set<Platform>;
  previousFocus: { tabId?: number; windowId?: number } | undefined;
  twitchIntegrity: TwitchIntegrity | undefined;
  latestTwitchIntegrityCapture: TwitchIntegrityCapture | undefined;
  twitchIntegrityCapturesBySourceTab: Map<number, TwitchIntegrityCapture>;
  twitchIntegrityCaptureGeneration: number;
  integrityWaiters: Array<(capture?: TwitchIntegrityCapture) => void>;
  twitchContextBoot: TwitchContextBootTiming | undefined;
  inFlightIntegrityAcquisition: TwitchIntegrityAcquisition | undefined;
  // Replays the valid captured integrity token on background Twitch GQL.
  twitchRequestIdentity: TwitchRequestIdentity;
}

export function createTabRegistry(): TabRegistry {
  const registry: TabRegistry = {
    pageContextTabs: new Map(),
    retainedPageContextTabs: new Map(),
    closingPageContextTabIds: new Set(),
    retainedPageContextRevision: 0,
    openManagedTabBreakers: new Set(),
    playbackPrimeStates: new Map(),
    adFocusHolds: new Map(),
    adFocusExpired: new Set(),
    previousFocus: undefined,
    twitchIntegrity: undefined,
    latestTwitchIntegrityCapture: undefined,
    twitchIntegrityCapturesBySourceTab: new Map(),
    twitchIntegrityCaptureGeneration: 0,
    integrityWaiters: [],
    twitchContextBoot: undefined,
    inFlightIntegrityAcquisition: undefined,
    twitchRequestIdentity: createTwitchRequestIdentity(() => currentValidTwitchIntegrity(registry)),
  };
  return registry;
}

const ALL_PLATFORMS: readonly Platform[] = ["twitch", "kick"];

export function syncManagedTabBreakers(
  registry: TabRegistry,
  state: { criticalHealth?: Partial<Record<Platform, { breakerOpen?: boolean }>> },
  platforms: readonly Platform[] = ALL_PLATFORMS,
): void {
  for (const platform of platforms) {
    if (state.criticalHealth?.[platform]?.breakerOpen) registry.openManagedTabBreakers.add(platform);
    else registry.openManagedTabBreakers.delete(platform);
  }
}

export function managedTabBreakerOpen(registry: TabRegistry, platform: Platform): boolean {
  return registry.openManagedTabBreakers.has(platform);
}

function platformForOrigin(origin: string): Platform | undefined {
  if (origin === "https://kick.com" || origin === "https://www.kick.com") return "kick";
  if (origin === "https://www.twitch.tv" || origin === "https://twitch.tv") return "twitch";
  return undefined;
}
const DEFAULT_WATCH_TAB_OPTIONS: WatchTabOptions = {
  muted: true,
  closeManagedTabs: true,
  keepVideosUnmuted: true,
};
const PLAYBACK_PRIME_RESTORE_DELAY_MS = 1500;
// Priming foreground-activates the watch tab for a moment, so it must never
// become an open-ended loop: a tab whose player the browser permanently blocks
// keeps reporting playingVideoCount === 0, which would otherwise flicker the tab
// to the foreground on every scheduler tick and make the browser toolbar and the
// extensions menu unusable. Attempts are counted per watch target, spaced by a
// back-off, and give up after the cap with a warning. The counter resets as soon
// as a tick finds playback healthy, so a genuinely deferred player is still
// coaxed along.
const PLAYBACK_PRIME_MAX_ATTEMPTS = 3;
const PLAYBACK_PRIME_BACKOFF_MS = 5 * 60_000;

export async function openPinnedMutedTabWithBrowser(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  channel: ChannelCandidate,
  session?: WatchSession,
  options?: Partial<WatchTabOptions>,
  emit: EventEmitter = ignoreEvent,
): Promise<PreparedWatchTab> {
  const tabOptions = { ...DEFAULT_WATCH_TAB_OPTIONS, ...options };
  tabOptions.signal?.throwIfAborted();
  const registered = tabOptions.managedTab ?? managedTabFromSession(session, channel.url);

  if (registered) {
    try {
      const tab = await browserApi.tabs.get(registered.tabId);
      if (tab?.id) {
        const updateProperties = watchTabUpdateProperties(tab, channel.url, tabOptions.muted);
        if (Object.keys(updateProperties).length > 0) {
          await browserApi.tabs.update(tab.id, updateProperties);
        }
        if (!shouldPrimePlayback(tab, channel.url, session)) {
          // Playback is healthy, so the budget has served its purpose.
          resetPlaybackPriming(registry, channel.platform);
        } else if (tabOptions.keepVideosUnmuted) {
          await maybePrimeTabPlayback(registry, browserApi, tab.id, channel, emit);
        }
        diagnostic(emit, "debug", `Reusing managed watch tab ${tab.id} for ${channel.username}`, channel.platform);
        tabOptions.signal?.throwIfAborted();
        return {
          tabId: tab.id,
          managedByExtension: true,
          managedTab: managedTab(channel, tab.id),
        };
      }
    } catch {
      // The registered managed tab can go stale after browser restarts or manual tab closure.
      diagnostic(emit, "debug", `Managed watch tab ${registered.tabId} is gone; opening a new one`, channel.platform);
    }
  } else if (session?.tabId && session.tabManagedByExtension === false) {
    try {
      const tab = await browserApi.tabs.get(session.tabId);
      if (tab?.id) {
        const updateProperties = watchTabUpdateProperties(tab, channel.url, tabOptions.muted);
        if (Object.keys(updateProperties).length > 0) {
          await browserApi.tabs.update(tab.id, updateProperties);
        }
        if (!shouldPrimePlayback(tab, channel.url, session)) {
          // Playback is healthy, so the budget has served its purpose.
          resetPlaybackPriming(registry, channel.platform);
        } else if (tabOptions.keepVideosUnmuted) {
          await maybePrimeTabPlayback(registry, browserApi, tab.id, channel, emit);
        }
        diagnostic(emit, "debug", `Reusing your tab ${tab.id} for ${channel.username}`, channel.platform);
        tabOptions.signal?.throwIfAborted();
        return { tabId: tab.id, managedByExtension: false };
      }
    } catch {
      // Reused user tabs are best-effort only; if missing, create a managed tab.
      diagnostic(emit, "debug", `Reused tab ${session.tabId} is gone; opening a managed one`, channel.platform);
    }
  }

  const extraManagedTabIds = new Set<number>();
  if (registered?.tabId != null) extraManagedTabIds.add(registered.tabId);
  if (session?.tabManagedByExtension && session.tabId != null) extraManagedTabIds.add(session.tabId);
  for (const tabId of extraManagedTabIds) {
    if (!browserApi.tabs.remove) continue;
    try {
      await browserApi.tabs.remove(tabId);
      diagnostic(emit, "debug", `Removed stale watch tab ${tabId}`, channel.platform);
    } catch {
      // Stale managed tab ids should not block creating the replacement.
    }
  }

  const tab = await browserApi.tabs.create({
    url: channel.url,
    pinned: true,
    active: false,
  }) as { id?: number };
  if (tab.id == null) {
    diagnostic(emit, "error", `Could not create ${channel.platform} watch tab for ${channel.username}`, channel.platform);
    throw new Error(`Could not create ${channel.platform} watch tab`);
  }
  if (tabOptions.signal?.aborted) {
    if (browserApi.tabs.remove) {
      try {
        await browserApi.tabs.remove(tab.id);
      } catch {
        // The new managed tab may already have been closed independently.
      }
    }
    tabOptions.signal.throwIfAborted();
  }
  await browserApi.tabs.update(tab.id, { pinned: true, muted: tabOptions.muted, active: false });
  if (tabOptions.keepVideosUnmuted) {
    // Deliberately no reset here: a replacement tab for the same failing channel
    // keeps spending the same budget, or the cap never engages under tab churn.
    await maybePrimeTabPlayback(registry, browserApi, tab.id, channel, emit);
  }
  diagnostic(emit, "info", `Opened watch tab ${tab.id} for ${channel.username}`, channel.platform);
  return { tabId: tab.id, managedByExtension: true, managedTab: managedTab(channel, tab.id) };
}

function watchTabUpdateProperties(tab: BrowserTab, url: string, muted: boolean): Record<string, unknown> {
  const updateProperties: Record<string, unknown> = {};
  if (tab.url !== url) updateProperties.url = url;
  if (tab.pinned !== true) updateProperties.pinned = true;
  if (tab.mutedInfo?.muted !== muted) updateProperties.muted = muted;
  if (tab.active !== false) updateProperties.active = false;
  return updateProperties;
}

function shouldPrimePlayback(tab: BrowserTab, url: string, session?: WatchSession): boolean {
  if (tab.url !== url) return true;
  const playback = session?.playback;
  if (!playback) return true;
  if (isTimestampStale(playback.checkedAt, PLAYBACK_TELEMETRY_MAX_AGE_MS, Date.now())) return true;
  // Priming foreground-activates the tab to coax a deferred player into loading
  // and playing — not to unmute. A muted-but-playing video is fine, so do not
  // re-prime just because the browser kept it muted.
  return playback.videoCount === 0
    || playback.playingVideoCount === 0;
}

interface PlaybackPrimeState {
  channelUrl: string;
  attempts: number;
  lastAttemptAt: number;
  exhausted: boolean;
}

// Keyed by platform, not by tab id: when playback never becomes healthy the
// scheduler condemns the watch tab and opens a replacement, so the tab id is
// different on every cycle. A per-tab budget would be reissued in full each time
// and the cap would never engage. The watch target is what we rate-limit, so the
// state carries the channel it was accrued for — a new tab for a *different*
// channel is a legitimate reason to prime again, a new tab for the same channel
// that keeps failing is the loop we must stop.

export { PLAYBACK_PRIME_BACKOFF_MS, PLAYBACK_PRIME_MAX_ATTEMPTS };

// Forgets the priming budget for a platform (or for every platform when none is
// given), so the next request primes again. Called when a tick finds playback
// healthy — genuine recovery, not merely a new tab.
function resetPlaybackPriming(registry: TabRegistry, platform?: Platform): void {
  if (platform == null) registry.playbackPrimeStates.clear();
  else registry.playbackPrimeStates.delete(platform);
}

async function maybePrimeTabPlayback(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  tabId: number,
  channel: ChannelCandidate,
  emit: EventEmitter,
  now: number = Date.now(),
): Promise<void> {
  const platform = channel.platform;
  const tracked = registry.playbackPrimeStates.get(platform);
  const state = tracked?.channelUrl === channel.url
    ? tracked
    : { channelUrl: channel.url, attempts: 0, lastAttemptAt: 0, exhausted: false };
  if (state.exhausted) return;

  if (state.attempts >= PLAYBACK_PRIME_MAX_ATTEMPTS) {
    registry.playbackPrimeStates.set(platform, { ...state, exhausted: true });
    diagnostic(
      emit,
      "warn",
      `Playback for ${channel.username} did not start after ${PLAYBACK_PRIME_MAX_ATTEMPTS} priming attempts; leaving the watch tab in the background`,
      platform,
    );
    return;
  }

  if (state.attempts > 0 && now - state.lastAttemptAt < PLAYBACK_PRIME_BACKOFF_MS) {
    diagnostic(emit, "debug", `Skipping playback priming on watch tab ${tabId} until the back-off elapses`, platform);
    return;
  }

  registry.playbackPrimeStates.set(platform, { ...state, attempts: state.attempts + 1, lastAttemptAt: now });
  await primeTabPlayback(browserApi, tabId, platform, emit);
}

async function primeTabPlayback(browserApi: BrowserTabApi, tabId: number, platform: Platform | undefined, emit: EventEmitter): Promise<void> {
  const [previousActive] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const previousActiveId = previousActive?.id;

  diagnostic(emit, "debug", `Priming playback on watch tab ${tabId}`, platform);
  await browserApi.tabs.update(tabId, { active: true });
  await wait(playbackPrimeRestoreDelayMs());

  if (previousActiveId != null && previousActiveId !== tabId) {
    await browserApi.tabs.update(previousActiveId, { active: true });
  }
}

function playbackPrimeRestoreDelayMs(): number {
  return typeof process !== "undefined" && process.env.NODE_ENV === "test"
    ? 0
    : PLAYBACK_PRIME_RESTORE_DELAY_MS;
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function managedTabFromSession(session: WatchSession | undefined, channelUrl: string): ManagedWatchTab | undefined {
  if (!session?.tabId || !session.tabManagedByExtension) return undefined;
  return {
    platform: session.platform,
    tabId: session.tabId,
    channelUrl,
    ownedByExtension: true,
  };
}

function managedTab(channel: ChannelCandidate, tabId: number): ManagedWatchTab {
  return {
    platform: channel.platform,
    tabId,
    channelUrl: channel.url,
    ownedByExtension: true,
  };
}

export async function stopWatchTabWithBrowser(browserApi: BrowserTabApi, session: WatchSession, options?: Partial<WatchTabOptions>, emit: EventEmitter = ignoreEvent): Promise<void> {
  const tabOptions = { ...DEFAULT_WATCH_TAB_OPTIONS, ...options };
  tabOptions.signal?.throwIfAborted();
  if (!session.tabId) return;
  try {
    if (session.tabManagedByExtension && tabOptions.closeManagedTabs && browserApi.tabs.remove) {
      await browserApi.tabs.remove(session.tabId);
      diagnostic(emit, "debug", `Closed managed watch tab ${session.tabId}`, session.platform);
      tabOptions.signal?.throwIfAborted();
      return;
    }
    await browserApi.tabs.update(session.tabId, {
      muted: false,
      pinned: false,
      active: false,
    });
    diagnostic(emit, "debug", `Released your tab ${session.tabId} (unmuted, unpinned)`, session.platform);
  } catch {
    // The user may have closed the tab already.
    diagnostic(emit, "debug", `Watch tab ${session.tabId} was already closed`, session.platform);
  }
  tabOptions.signal?.throwIfAborted();
}

// While an ad is rolling, the managed watch tab must be the active tab in a
// focused window or the browser throttles the ad countdown's requestAnimationFrame
// loop (the visibility keep-alive only fools page JS, not the rAF engine). We
// bring the tab to focus for the duration of the ad and restore the user's
// previous tab/window once every platform's ad has finished. Holds are tracked
// per platform so two simultaneous ads don't restore focus prematurely.
// Ad focus is re-evaluated on every playback telemetry report (several times a
// second on a busy page), so the hold must be idempotent: we only issue browser
// calls when the tab is not already where we want it. A hold is also capped —
// a detector stuck reporting an ad must never pin the user's focus forever.
const AD_FOCUS_MAX_HOLD_MS = 3 * 60 * 1000;

export { AD_FOCUS_MAX_HOLD_MS };

export async function applyAdFocusWithBrowser(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  platform: Platform,
  tabId: number | undefined,
  adActive: boolean,
  mode: AdFocusMode,
  emit: EventEmitter = ignoreEvent,
): Promise<void> {
  if (mode === "none" || !adActive || tabId == null) {
    registry.adFocusExpired.delete(platform);
    await releaseAdFocus(registry, browserApi, platform, tabId, emit);
    return;
  }

  // This ad episode already exhausted its cap; stay out of the user's way until
  // the platform stops reporting an ad.
  if (registry.adFocusExpired.has(platform)) return;

  const heldSince = registry.adFocusHolds.get(platform);
  if (heldSince != null && Date.now() - heldSince >= AD_FOCUS_MAX_HOLD_MS) {
    registry.adFocusExpired.add(platform);
    diagnostic(emit, "warn", `Ad focus held for over ${Math.round(AD_FOCUS_MAX_HOLD_MS / 1000)}s; releasing it`, platform);
    await releaseAdFocus(registry, browserApi, platform, tabId, emit);
    return;
  }

  if (registry.adFocusHolds.size === 0) {
    const [active] = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== tabId) {
      registry.previousFocus = { tabId: active?.id, windowId: active?.windowId };
    }
  }
  const alreadyHeld = heldSince != null;
  if (!alreadyHeld) registry.adFocusHolds.set(platform, Date.now());

  const tab = await browserApi.tabs.get(tabId).catch(() => undefined);
  const needsWindowFocus = mode === "window" && tab?.windowId != null && !(await isWindowFocused(browserApi, tab.windowId));
  if (tab?.active === true && !needsWindowFocus) return;

  if (tab?.active !== true) {
    await browserApi.tabs.update(tabId, { active: true });
  }
  if (needsWindowFocus && tab?.windowId != null) {
    await browserApi.windows?.update(tab.windowId, { focused: true });
  }
  if (!alreadyHeld) {
    diagnostic(emit, "debug", `Focusing watch tab ${tabId} for an ad`, platform);
  }
}

// The tabs API has no "is this window focused" call, but the active tab of the
// last focused window answers the same question without a windows.get binding.
async function isWindowFocused(browserApi: BrowserTabApi, windowId: number): Promise<boolean> {
  const [active] = await browserApi.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return active?.windowId === windowId;
}

async function releaseAdFocus(registry: TabRegistry, browserApi: BrowserTabApi, platform: Platform, watchTabId: number | undefined, emit: EventEmitter): Promise<void> {
  if (!registry.adFocusHolds.delete(platform) || registry.adFocusHolds.size > 0) return;

  const restore = registry.previousFocus;
  registry.previousFocus = undefined;
  if (!restore?.tabId) return;

  // Only restore if the watch tab is still the active tab; otherwise the user
  // has already moved on and we should not yank focus back.
  if (watchTabId != null) {
    const [active] = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== watchTabId) return;
  }

  diagnostic(emit, "debug", `Restoring previous tab ${restore.tabId} after the ad`, platform);
  await browserApi.tabs.update(restore.tabId, { active: true }).catch(() => undefined);
  if (restore.windowId != null) {
    await browserApi.windows?.update(restore.windowId, { focused: true }).catch(() => undefined);
  }
}

export interface PageFetchOptions {
  retainPageContext?: {
    platform: Platform;
    managedContext?: ManagedPageContextTab;
    retainCreatedPageContext?: boolean;
  };
  emit?: EventEmitter;
  openReason?: PageContextOpenReason;
  // Integrity preparation must not create a user-facing activity entry, but the
  // controller still needs to account for every extension-owned context it
  // opens in the managed-tab churn breaker.
  emitPageContextActivity?: boolean;
  onManagedPageContextOpen?: () => void | Promise<void>;
  // Demands a context that is about to boot the SPA from scratch, because the
  // caller is waiting for the page to issue something (see ensureTwitchIntegrity-
  // WithBrowser). An already-loaded user tab is idle and would only time out, and
  // reloading it to force activity is not ours to do — so user tabs are skipped
  // and an extension-owned context is created or explicitly navigated instead.
  requireFreshPageContext?: boolean;
}


// The most recently captured Client-Integrity bundle from the live twitch.tv
// page (see src/core/twitchIntegrity.ts). The background registers a webRequest
// listener that feeds this via setTwitchIntegrity so authenticated GQL mutations
// (e.g. drop claims) carry a valid integrity token. Defaults to undefined so
// queries keep working anonymously / without integrity until one is captured.

interface TwitchIntegrityCapture {
  value: TwitchIntegrity;
  sourceTabId?: number;
  generation: number;
}

// Keep the latest capture from each attributed tab long enough for a managed
// helper wait to identify its own replacement even if a user tab immediately
// replays the previous token into the ordinary global slot.
const MAX_TWITCH_INTEGRITY_SOURCE_CAPTURES = 32;

// Treat a token expiring within this window as already stale, so a claim never
// ships with one that expires mid-flight (the captured token is replayed and
// the round-trip plus Twitch-side clock skew can otherwise straddle expiry).
export const INTEGRITY_EXPIRY_SKEW_MS = 30_000;

// Page context to open when no token has been captured: a logged-in twitch.tv
// SPA route that immediately issues authenticated GQL carrying Client-Integrity,
// which the background webRequest listener captures (see entrypoints/background.ts).
export const TWITCH_PAGE_CONTEXT_URL = "https://www.twitch.tv/drops/inventory";

// How long to wait for the live page to mint and send a token after we open it.
//
// This budgets for a cold twitch.tv boot, which is dominated by Kasada's
// proof-of-work rather than by the page load: an observed boot reached
// `status === "complete"` in 1.4s and only produced a token at 22s. The previous
// 12s could not cover that, so the wait timed out, the operation degraded to
// stale data, and the token landed anyway once nobody was waiting for it.
//
// Note that "the token landed once nobody was waiting" also had a second, then
// unknown cause: the capture path installed tokens under the same platform lock
// the waiting tick held, so a rejection-recovery wait could never be satisfied
// no matter how long this budget was. That deadlock is fixed in the controller's
// captureTwitchIntegrity. This budget still covers genuine cold-boot latency on
// the readiness path, which has always run outside that lock.
//
// Raising it is only affordable because a forced refresh is now bounded by
// rejectedToken (see below): a tick pays this once, not once per rejected
// operation. Provisional — it covers a single observed sample with margin, and
// the boot-phase diagnostics exist to replace it with a measured distribution.
export const INTEGRITY_REFRESH_TIMEOUT_MS = 30_000;

// Resolvers waiting for the next captured token (see waitForIntegrityCapture).

// Test seam for proving terminal paths release their registered callbacks.
export function currentTwitchIntegrityWaiterCount(registry: TabRegistry): number {
  return registry.integrityWaiters.length;
}

// Phase timings for the twitch.tv page context currently being booted to mint an
// integrity token. A cold boot costs far more than the document load: the tab
// reports `status === "complete"` as soon as the HTML shell lands, but the token
// only appears once the SPA has hydrated, authenticated, and completed Kasada's
// proof-of-work (see src/core/twitchIntegrity.ts). Those phases are billed to
// very different causes — a slow network, a slow SPA boot, or an expensive
// challenge in a deprioritized background tab — and the aggregate wait duration
// cannot tell them apart, so each boundary is stamped as it is crossed.
interface TwitchContextBootTiming {
  tabId: number;
  createdAt: number;
  readyAt?: number;
  firstGqlAt?: number;
}

// Called for every gql.twitch.tv request the background sees, including the
// anonymous ones that carry no Client-Integrity header. Those are exactly what
// distinguishes "the SPA has not booted yet" from "the SPA is running but is
// still solving the proof-of-work", which is the split the aggregate timeout
// hides.
export function noteTwitchGqlRequest(registry: TabRegistry, tabId: number | undefined, now: number = Date.now()): void {
  if (tabId == null || registry.twitchContextBoot?.tabId !== tabId) return;
  registry.twitchContextBoot.firstGqlAt ??= now;
}

function describeContextBoot(boot: TwitchContextBootTiming, now: number): string {
  const since = (at: number | undefined): string => (at == null ? "never" : `${at - boot.createdAt}ms`);
  return `tab ready at ${since(boot.readyAt)}, first GQL at ${since(boot.firstGqlAt)}, ${now - boot.createdAt}ms since the tab was created`;
}

export function isValidTwitchIntegrity(
  value: TwitchIntegrity | undefined,
  now: number = Date.now(),
): value is TwitchIntegrity {
  return value != null && value.expiresAt > now + INTEGRITY_EXPIRY_SKEW_MS;
}

export function hasValidTwitchIntegrity(registry: TabRegistry, now: number = Date.now()): boolean {
  return isValidTwitchIntegrity(registry.twitchIntegrity, now);
}

export interface TwitchIntegrityCaptureOptions {
  isNew?: boolean;
  sourceTabId?: number;
}

export function setTwitchIntegrity(
  registry: TabRegistry,
  value: TwitchIntegrity | undefined,
  options?: TwitchIntegrityCaptureOptions,
  emit: EventEmitter = ignoreEvent,
): void {
  registry.twitchIntegrity = value;
  const generation = ++registry.twitchIntegrityCaptureGeneration;
  if (value == null) {
    registry.latestTwitchIntegrityCapture = undefined;
    registry.twitchIntegrityCapturesBySourceTab.clear();
  } else {
    const capture: TwitchIntegrityCapture = {
      value,
      generation,
      ...(options?.sourceTabId != null ? { sourceTabId: options.sourceTabId } : {}),
    };
    registry.latestTwitchIntegrityCapture = capture;
    if (capture.sourceTabId != null) {
      // Delete first so the insertion order reflects capture recency; stale
      // source entries must not grow without bound in a long-lived background.
      registry.twitchIntegrityCapturesBySourceTab.delete(capture.sourceTabId);
      registry.twitchIntegrityCapturesBySourceTab.set(capture.sourceTabId, capture);
      while (registry.twitchIntegrityCapturesBySourceTab.size > MAX_TWITCH_INTEGRITY_SOURCE_CAPTURES) {
        const oldestSourceTabId = registry.twitchIntegrityCapturesBySourceTab.keys().next().value;
        if (oldestSourceTabId == null) break;
        registry.twitchIntegrityCapturesBySourceTab.delete(oldestSourceTabId);
      }
    }
  }
  if (value && options?.isNew) {
    const ttlSeconds = Math.max(0, Math.round((value.expiresAt - Date.now()) / 1000));
    diagnostic(emit, "info", `Captured a fresh Twitch integrity token (expires ${new Date(value.expiresAt).toISOString()}, in ${ttlSeconds}s)`, "twitch");
  }
  if (value != null && registry.integrityWaiters.length > 0) {
    const waiters = registry.integrityWaiters;
    registry.integrityWaiters = [];
    for (const resolve of waiters) resolve(registry.latestTwitchIntegrityCapture);
  }
}

// A forced refresh runs after Twitch rejected a token the extension still
// considers unexpired, so local expiry alone cannot decide success: the captured
// token must also differ from the one that was rejected.
export interface TwitchIntegrityRequest {
  forceRefresh?: boolean;
  signal?: AbortSignal;
  reason?: "readiness" | "proactive_refresh" | "rejection_recovery";
  onManagedPageContextOpen?: () => void | Promise<void>;
  // Receives the exact bundle captured by the managed context. A forced GQL
  // retry uses this callback to pin the trio it sends instead of reading the
  // last-writer-wins global after a concurrent page capture.
  onIntegrityCaptured?: (value: TwitchIntegrity) => void;
  // The token the rejected request actually sent, captured before it was issued.
  // Without it a forced refresh cannot tell "this caller was rejected on a token
  // someone has already replaced" from "this caller was rejected on the token we
  // currently hold" — only the second needs a new one minted. Omitted means
  // unknown, which always mints.
  rejectedToken?: string;
}

// The integrity bundle outgoing requests should carry, or undefined when there
// is none to replay. Returned whole because the token is bound to the device id
// and session id it was minted with — replaying the trio apart from each other
// is rejected.
//
// Callers that assemble their own headers use this so the token they sent is
// known exactly, rather than re-read later from a global that a concurrent
// capture may have replaced in between. See TwitchIntegrityRequest.rejectedToken.
export function currentValidTwitchIntegrity(registry: TabRegistry): TwitchIntegrity | undefined {
  return hasValidTwitchIntegrity(registry) ? registry.twitchIntegrity : undefined;
}

interface TwitchIntegrityAcquisitionResult {
  value: TwitchIntegrity;
  managedContext: boolean;
}

// Minting boots a twitch.tv context and may wait ~22s for Kasada's proof-of-work,
// so every caller shares one owned acquisition. The owned abort cancels the
// underlying page context; only the creator's signal owns that lifecycle, while
// later joiners race their own signal without disturbing everyone else.
interface TwitchIntegrityAcquisition {
  promise: Promise<TwitchIntegrityAcquisitionResult | undefined>;
  abort: AbortController;
}


export function cancelTwitchIntegrityAcquisition(registry: TabRegistry, reason?: unknown): void {
  registry.inFlightIntegrityAcquisition?.abort.abort(reason);
}

function hasReplacementTwitchIntegrity(registry: TabRegistry, rejectedToken?: string): boolean {
  if (!hasValidTwitchIntegrity(registry)) return false;
  return rejectedToken == null || registry.twitchIntegrity?.integrity !== rejectedToken;
}

function isReplacementCapture(capture: TwitchIntegrityCapture | undefined, rejectedToken?: string): boolean {
  if (!capture || !isValidTwitchIntegrity(capture.value)) return false;
  return rejectedToken == null || capture.value.integrity !== rejectedToken;
}

function captureForIntegrityWait(
  registry: TabRegistry,
  rejectedToken: string | undefined,
  sourceTabId: number | undefined,
  latestCapture?: TwitchIntegrityCapture,
  minimumGeneration = 0,
): TwitchIntegrityCapture | undefined {
  if (sourceTabId != null) {
    const sourceCapture = registry.twitchIntegrityCapturesBySourceTab.get(sourceTabId);
    if (sourceCapture != null && sourceCapture.generation > minimumGeneration && isReplacementCapture(sourceCapture, rejectedToken)) return sourceCapture;
    // Unattributed captures retain the historic global behavior. Once a
    // capture has an explicit source, however, a different tab cannot satisfy
    // this managed-context wait.
    if (latestCapture != null && latestCapture.generation > minimumGeneration && isReplacementCapture(latestCapture, rejectedToken) && latestCapture.sourceTabId == null) return latestCapture;
    return undefined;
  }
  const capture = latestCapture ?? registry.latestTwitchIntegrityCapture;
  return capture != null && capture.generation > minimumGeneration && isReplacementCapture(capture, rejectedToken) ? capture : undefined;
}

// Resolves with the exact usable capture, or undefined after timeoutMs. A
// captured token can be near-expiry — captureTwitchIntegrity does not gate on
// expiry — so resolvers re-check validity. When rejectedToken is set,
// re-capturing that same token does not settle the wait; the page may replay it
// before minting a replacement.
function waitForIntegrityCapture(
  registry: TabRegistry,
  timeoutMs: number,
  rejectedToken?: string,
  signal?: AbortSignal,
  sourceTabId?: number,
  minimumGeneration = 0,
): Promise<TwitchIntegrityCapture | undefined> {
  signal?.throwIfAborted();
  const alreadyCaptured = captureForIntegrityWait(registry, rejectedToken, sourceTabId, undefined, minimumGeneration);
  if (alreadyCaptured) return Promise.resolve(alreadyCaptured);
  return new Promise((resolve, reject) => {
    let settled = false;
    const removeWaiter = () => {
      registry.integrityWaiters = registry.integrityWaiters.filter((waiter) => waiter !== onCapture);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      removeWaiter();
    };
    const finish = (capture?: TwitchIntegrityCapture) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(capture);
    };
    const onCapture = (capture?: TwitchIntegrityCapture) => {
      if (settled) return;
      // Not a replacement yet — keep waiting until the deadline instead of
      // reporting the rejected token back as a successful refresh.
      const replacement = captureForIntegrityWait(registry, rejectedToken, sourceTabId, capture, minimumGeneration);
      if (!replacement) {
        registry.integrityWaiters.push(onCapture);
        return;
      }
      finish(replacement);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    registry.integrityWaiters.push(onCapture);
  });
}

// Ensures a valid Client-Integrity token exists before an authenticated mutation
// (drop claims). When none is captured — e.g. tabless farming with no twitch.tv
// tab open — opens or reuses a logged-in twitch.tv page-context tab so the SPA
// mints one the webRequest listener captures, waits for it, then releases the tab.
// A forced refresh additionally covers the case where Twitch rejected a token
// that has not locally expired: it skips the fast path, demands a token
// different from the rejected one, and only ever boots an extension-owned
// context so a user's own twitch.tv tab is never navigated or closed.
export async function ensureTwitchIntegrityWithBrowser(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  originUrl: string,
  timeoutMs: number = INTEGRITY_REFRESH_TIMEOUT_MS,
  emit: EventEmitter = ignoreEvent,
  request?: TwitchIntegrityRequest,
): Promise<boolean> {
  request?.signal?.throwIfAborted();
  const forceRefresh = request?.forceRefresh === true;
  const reason = request?.reason
    ?? (forceRefresh ? "rejection_recovery" : "readiness");
  if (!forceRefresh) {
    if (hasValidTwitchIntegrity(registry)) return true;
    const captured = await startTwitchIntegrityAcquisition(registry, 
      browserApi,
      originUrl,
      timeoutMs,
      emit,
      undefined,
      false,
      reason,
      request?.onManagedPageContextOpen,
      request?.signal,
    );
    if (captured) request?.onIntegrityCaptured?.(captured.value);
    return captured != null;
  }

  // Another operation's refresh already replaced the token this caller was
  // rejected on. It has not tried the current one yet, so minting again cannot
  // help it — and would cost another cold boot.
  if (request?.rejectedToken != null && hasReplacementTwitchIntegrity(registry, request.rejectedToken)) {
    diagnostic(emit, "debug", "Reusing the Twitch integrity token another operation just minted instead of booting another page context", "twitch");
    request.onIntegrityCaptured?.(registry.latestTwitchIntegrityCapture?.value ?? registry.twitchIntegrity!);
    return true;
  }

  const rejectedToken = request?.rejectedToken ?? registry.twitchIntegrity?.integrity;
  const captured = await startTwitchIntegrityAcquisition(registry, 
    browserApi,
    originUrl,
    timeoutMs,
    emit,
    rejectedToken,
    true,
    reason,
    request?.onManagedPageContextOpen,
    request?.signal,
  );
  if (captured) request?.onIntegrityCaptured?.(captured.value);
  return captured != null;
}

function startTwitchIntegrityAcquisition(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  originUrl: string,
  timeoutMs: number,
  emit: EventEmitter,
  rejectedToken: string | undefined,
  forceRefresh: boolean,
  reason: NonNullable<TwitchIntegrityRequest["reason"]>,
  onManagedPageContextOpen?: () => void | Promise<void>,
  ownerSignal?: AbortSignal,
): Promise<TwitchIntegrityAcquisitionResult | undefined> {
  if (registry.inFlightIntegrityAcquisition) {
    diagnostic(emit, "debug", "Joining the Twitch integrity acquisition already in flight", "twitch");
    const joined = withAbortSignal(registry.inFlightIntegrityAcquisition.promise, ownerSignal);
    if (!forceRefresh) return joined;
    return joined.then((captured) => {
      ownerSignal?.throwIfAborted();
      if (captured && captured.managedContext && captured.value.integrity !== rejectedToken && isValidTwitchIntegrity(captured.value)) return captured;
      return startTwitchIntegrityAcquisition(registry, 
        browserApi,
        originUrl,
        timeoutMs,
        emit,
        rejectedToken,
        true,
        reason,
        onManagedPageContextOpen,
        ownerSignal,
      );
    });
  }

  const abort = new AbortController();
  const abortFromOwner = () => abort.abort(ownerSignal?.reason);
  ownerSignal?.addEventListener("abort", abortFromOwner, { once: true });

  const promise = mintTwitchIntegrity(registry, 
    browserApi,
    originUrl,
    timeoutMs,
    emit,
    rejectedToken,
    forceRefresh,
    reason,
    onManagedPageContextOpen,
    abort.signal,
  ).finally(() => {
    ownerSignal?.removeEventListener("abort", abortFromOwner);
    registry.twitchIntegrityCapturesBySourceTab.clear();
    if (registry.inFlightIntegrityAcquisition?.promise === promise) {
      registry.inFlightIntegrityAcquisition = undefined;
    }
  });
  registry.inFlightIntegrityAcquisition = { promise, abort };
  return promise;
}

// The page-context boot itself, with no bounding logic: callers reach it through
// ensureTwitchIntegrityWithBrowser, which decides whether a boot is warranted.
async function mintTwitchIntegrity(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  originUrl: string,
  timeoutMs: number,
  emit: EventEmitter,
  rejectedToken: string | undefined,
  // Carried explicitly rather than derived from `rejectedToken != null`: a forced
  // refresh can legitimately have no token to compare against (nothing captured
  // yet, or a host that cannot report what it sent), and it must still demand a
  // freshly created context. Inferring it would silently downgrade those cases to
  // a plain mint, which may inherit an idle tab that issues no request and can
  // only ever time out.
  forceRefresh: boolean,
  reason: NonNullable<TwitchIntegrityRequest["reason"]>,
  onManagedPageContextOpen?: () => void | Promise<void>,
  signal?: AbortSignal,
): Promise<TwitchIntegrityAcquisitionResult | undefined> {
  diagnostic(
    emit,
    "info",
    reason === "proactive_refresh"
      ? "Proactively refreshing Twitch integrity through a twitch.tv page context"
      : forceRefresh
      ? "Twitch rejected the current integrity token; using a twitch.tv page context to mint a replacement"
      : "No valid Twitch integrity token; using a twitch.tv page context to capture one",
    "twitch",
  );
  const origin = new URL(originUrl).origin;
  const minimumCaptureGeneration = registry.twitchIntegrityCaptureGeneration;
  let pageContext: PageContextTab | undefined;
  try {
    pageContext = await acquirePageContextTab(registry, browserApi, originUrl, origin, {
      retainPageContext: {
        platform: "twitch",
        retainCreatedPageContext: false,
      },
      emit,
      requireFreshPageContext: forceRefresh,
      emitPageContextActivity: reason === "rejection_recovery",
      onManagedPageContextOpen,
    }, signal);
    if (reason !== "rejection_recovery" && pageContext.source === "created") {
      diagnostic(
        emit,
        "debug",
        reason === "proactive_refresh"
          ? "Opened a managed twitch.tv page context for proactive integrity refresh"
          : "Opened a managed twitch.tv page context for Twitch integrity readiness",
        "twitch",
      );
    }
    // Which context we got decides whether waiting can work at all: only a
    // freshly created tab is guaranteed to boot the SPA and issue authenticated
    // GQL for the listener to read a token from. An inherited or already-idle tab
    // may issue nothing, and the wait can only ever time out.
    const source = pageContext.source ?? "unknown";
    diagnostic(emit, "debug", `Waiting up to ${timeoutMs}ms for a Twitch integrity token from a ${source} page context (tab ${pageContext.tabId})`, "twitch");
    // On success the capture itself is logged once by setTwitchIntegrity (info);
    // here we only surface the failure case so the log isn't doubled up.
    const startedAt = Date.now();
    const captured = await waitForIntegrityCapture(registry, 
      timeoutMs,
      rejectedToken,
      signal,
      forceRefresh ? pageContext.tabId : undefined,
      forceRefresh ? minimumCaptureGeneration : 0,
    );
    const settledAt = Date.now();
    // Logged on both outcomes, not just the failure: a success that took 20s is
    // the same latency problem as a timeout, and only the phase split says which
    // part of the cold boot to attack.
    const boot = registry.twitchContextBoot?.tabId === pageContext.tabId ? registry.twitchContextBoot : undefined;
    const phases = boot ? ` (${describeContextBoot(boot, settledAt)})` : "";
    if (!captured) {
      diagnostic(emit, reason === "proactive_refresh" ? "debug" : "warn", `Timed out waiting for a Twitch integrity token after ${settledAt - startedAt}ms from a ${source} page context${phases} (is twitch.tv logged in?)`, "twitch");
    } else {
      diagnostic(emit, "debug", `Waited ${settledAt - startedAt}ms for a Twitch integrity token from a ${source} page context${phases}`, "twitch");
    }
    return captured
      ? {
          value: captured.value,
          managedContext: pageContext.createdByExtension,
        }
      : undefined;
  } catch (error) {
    signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    diagnostic(emit, reason === "proactive_refresh" ? "debug" : "warn", `Could not open a twitch.tv tab to capture an integrity token: ${message}`, "twitch");
    return undefined;
  } finally {
    if (pageContext) {
      await releasePageContextTab(registry, browserApi, origin, pageContext, emit, signal?.aborted === true);
    }
  }
}

// The extension's Twitch identity replays the page-captured integrity token.
export function fetchTwitchInBackgroundWith<T>(registry: TabRegistry, api: CookieApi, url: string, init?: RequestInit): Promise<T> {
  return fetchTwitchInBackgroundWithIdentity<T>(api, url, init, registry.twitchRequestIdentity);
}

export async function fetchJsonInPageWithBrowser<T>(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  originUrl: string,
  url: string,
  init?: RequestInit,
  options?: PageFetchOptions,
): Promise<T> {
  const signal = init?.signal;
  signal?.throwIfAborted();
  const origin = new URL(originUrl).origin;
  const pageContext = await acquirePageContextTab(registry, browserApi, originUrl, origin, options, signal);

  try {
    signal?.throwIfAborted();
    const initJson = pageFetchInitJson(init);
    const runtimeBrowser = browserApi;

    if (runtimeBrowser.scripting?.executeScript) {
      const execution = runtimeBrowser.scripting.executeScript({
        target: { tabId: pageContext.tabId },
        // args must be JSON-serializable; `undefined` is rejected ("unserializable"),
        // so pass `null` when there is no init (e.g. Kick GET requests).
        args: [url, initJson],
        // Kick needs the page MAIN world for Cloudflare/session context.
        // Twitch GQL also runs in MAIN, but uses XHR below to avoid Twitch's
        // page fetch wrappers.
        world: "MAIN",
        func: pageFetchJson,
      });
      const [result] = await withAbortSignal(execution, signal);
      // executeScript resolves one entry per injected frame; an empty array
      // means the context tab was closed or navigated away before injection.
      // Surface that clearly instead of dereferencing undefined.
      if (!result) throw new Error(`Page context for ${origin} returned no script result`);
      return unwrapPageFetchResult<T>(result.result);
    }

    if (runtimeBrowser.tabs.executeScript) {
      const code = `(${pageFetchJson.toString()})(${JSON.stringify(url)}, ${JSON.stringify(initJson ?? undefined)})`;
      const execution = runtimeBrowser.tabs.executeScript(pageContext.tabId, { code });
      const results = await withAbortSignal(execution, signal);
      const result = results?.[0];
      return unwrapPageFetchResult<T>(result);
    }

    throw new Error("No supported page script execution API is available");
  } finally {
    await releasePageContextTab(registry, 
      browserApi,
      origin,
      pageContext,
      options?.emit,
      signal?.aborted === true && pageContext.openedForRequest === true,
    );
  }
}

function pageFetchInitJson(init?: RequestInit): string | null {
  if (!init) return null;
  const { signal: _signal, ...serializableInit } = init;
  return JSON.stringify(serializableInit);
}

async function withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function unwrapPageFetchResult<T>(candidate: unknown): T {
  if (!candidate || typeof candidate !== "object") return candidate as T;
  const envelope = candidate as Record<string, unknown>;
  if (envelope.__lurklootPageFetch !== true) return candidate as T;
  if (envelope.ok === true) return envelope.data as T;
  throw new SafeFetchError(safeFetchFailure(envelope.error));
}

async function acquirePageContextTab(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  originUrl: string,
  origin: string,
  options?: PageFetchOptions,
  signal?: AbortSignal | null,
): Promise<PageContextTab> {
  signal?.throwIfAborted();
  let entry = registry.pageContextTabs.get(origin);
  let promise: Promise<PageContextTab>;
  if (entry) {
    // Inherited from a concurrent caller: this tab has already served its own
    // request and may now be idle, which matters to anyone waiting for the page
    // to issue a fresh request (see ensureTwitchIntegrityWithBrowser). It is not
    // owned by this request, so aborting this caller must not discard it.
    promise = entry.promise.then((tab) => ({
      ...tab,
      openedForRequest: false,
      source: "shared_entry" as const,
    }));
  } else {
    const abort = new AbortController();
    entry = {
      promise: findOrCreatePageContextTab(registry, browserApi, originUrl, origin, options, abort.signal),
      refs: 0,
      abort,
    };
    registry.pageContextTabs.set(origin, entry);
    promise = entry.promise;
  }
  entry.refs += 1;
  try {
    return await withAbortSignal(promise, signal);
  } catch (error) {
    entry.refs -= 1;
    if (entry.refs === 0 && registry.pageContextTabs.get(origin) === entry) {
      registry.pageContextTabs.delete(origin);
      entry.abort.abort(signal?.aborted ? signal.reason : error);
    }
    throw error;
  }
}

async function releasePageContextTab(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  origin: string,
  pageContext: PageContextTab,
  emit: EventEmitter = ignoreEvent,
  discardRetainedContext = false,
): Promise<void> {
  const entry = registry.pageContextTabs.get(origin);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;

  registry.pageContextTabs.delete(origin);
  if (!pageContext.createdByExtension) return;
  if (pageContext.retainedContext && !discardRetainedContext) {
    registry.retainedPageContextTabs.set(pageContext.retainedContext.platform, pageContext.retainedContext);
    registry.retainedPageContextRevision += 1;
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(pageContext.retainedContext.origin).host} because it may still be required`, pageContext.retainedContext.platform);
    return;
  }
  if (pageContext.retainedContext) {
    const retained = registry.retainedPageContextTabs.get(pageContext.retainedContext.platform);
    if (retained?.tabId === pageContext.tabId) {
      registry.retainedPageContextTabs.delete(pageContext.retainedContext.platform);
      registry.retainedPageContextRevision += 1;
    }
  }
  if (!browserApi.tabs.remove) return;

  try {
    await browserApi.tabs.remove(pageContext.tabId);
  } catch {
    // The temporary context tab may have been closed manually before cleanup.
  }
}

async function findOrCreatePageContextTab(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  originUrl: string,
  origin: string,
  options?: PageFetchOptions,
  signal?: AbortSignal,
): Promise<PageContextTab> {
  signal?.throwIfAborted();
  const retain = options?.retainPageContext;
  let openReason = options?.openReason ?? "background_rejected";
  const retained = retain?.managedContext ?? (retain ? registry.retainedPageContextTabs.get(retain.platform) : undefined);
  const tabs = await withAbortSignal(browserApi.tabs.query({ url: `${origin}/*` }), signal);
  const retainedIds = new Set(
    [...registry.retainedPageContextTabs.values(), retained]
      .filter((tab): tab is ManagedPageContextTab => tab != null && tab.origin === origin)
      .map((tab) => tab.tabId),
  );
  for (const tabId of registry.closingPageContextTabIds) retainedIds.add(tabId);
  const requireFresh = options?.requireFreshPageContext === true;
  let tabId: number | undefined;
  for (const tab of tabs) {
    if (requireFresh) break;
    if (tab.id == null || retainedIds.has(tab.id)) continue;
    if (await isUsablePageContext(browserApi, tab.id, origin, signal)) {
      tabId = tab.id;
      break;
    }
  }
  if (tabId != null) {
    if (retained?.origin === origin) {
      registry.retainedPageContextTabs.delete(retained.platform);
      registry.retainedPageContextRevision += 1;
      const remove = browserApi.tabs.remove;
      if (!remove) {
        diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(retained.origin).host} because tab removal is unavailable`, retained.platform);
      } else {
        try {
          await withAbortSignal(remove(retained.tabId), signal);
          options?.emit?.({
            category: "activity",
            code: "page_context_closed",
            level: "info",
            platform: retained.platform,
            data: { host: new URL(retained.origin).host, reason: "user_tab_available" },
          });
        } catch {
          // The retained page context may already be gone.
          diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(retained.origin).host} because the tab was already gone`, retained.platform);
        }
      }
    }
    signal?.throwIfAborted();
    diagnostic(options?.emit ?? ignoreEvent, "debug", `Reused user page context on ${new URL(origin).host}`, retain?.platform);
    return { tabId, createdByExtension: false, source: "user_tab" };
  }

  if (retained?.origin === origin) {
    try {
      const tab = await withAbortSignal(browserApi.tabs.get(retained.tabId), signal);
      if (tab?.id && tab.url?.startsWith(origin) && await isUsablePageContext(browserApi, tab.id, origin, signal)) {
        registry.retainedPageContextTabs.set(retained.platform, retained);
        registry.retainedPageContextRevision += 1;
        // We own this tab, so re-navigating it to boot the SPA again is safe —
        // it is the only way a retained (and by now idle) context issues the
        // authenticated request the caller is waiting on.
        if (requireFresh) {
          signal?.throwIfAborted();
          await withAbortSignal(browserApi.tabs.update(tab.id, { url: originUrl }), signal);
          await waitForPageContextReady(browserApi, tab.id, origin, signal);
          diagnostic(options?.emit ?? ignoreEvent, "debug", `Reloaded managed page context on ${new URL(origin).host} to force a fresh page request`, retained.platform);
          return { tabId: tab.id, createdByExtension: true, retainedContext: retained, openedForRequest: true, source: "managed_tab" };
        }
        diagnostic(options?.emit ?? ignoreEvent, "debug", `Reused managed page context on ${new URL(origin).host}`, retained.platform);
        return { tabId: tab.id, createdByExtension: true, retainedContext: retained, source: "managed_tab" };
      }
      registry.retainedPageContextTabs.delete(retained.platform);
      registry.retainedPageContextRevision += 1;
      openReason = "managed_context_unusable";
      if (tab?.id) {
        const remove = browserApi.tabs.remove;
        if (!remove) {
          diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(origin).host} because tab removal is unavailable`, retained.platform);
        } else {
          try {
            await withAbortSignal(remove(retained.tabId), signal);
            options?.emit?.({
              category: "activity",
              code: "page_context_closed",
              level: "info",
              platform: retained.platform,
              data: { host: new URL(origin).host, reason: "managed_context_unusable" },
            });
          } catch {
            diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(origin).host} because it was already gone`, retained.platform);
          }
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      registry.retainedPageContextTabs.delete(retained.platform);
      registry.retainedPageContextRevision += 1;
      openReason = "managed_context_unusable";
      diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(origin).host} because it is unusable`, retained.platform);
    }
  }

  // The breaker is open: this platform kept reopening a managed tab. Opening
  // another one is exactly the user-hostile behaviour we detected, so the fetch
  // fails instead. It closes on its own once the churn evidence ages out.
  const contextPlatform = retain?.platform ?? platformForOrigin(origin);
  if (contextPlatform && registry.openManagedTabBreakers.has(contextPlatform)) {
    throw new SafeFetchError({
      kind: "security_policy_blocked",
      reason: "Managed tab creation is suspended after repeated reopening",
    });
  }

  signal?.throwIfAborted();
  const createdAt = Date.now();
  const tab = await browserApi.tabs.create({ url: originUrl, pinned: false, active: false }) as { id?: number };
  if (tab.id == null) {
    signal?.throwIfAborted();
    throw new Error(`Could not open page context for ${originUrl}`);
  }
  if (contextPlatform === "twitch") registry.twitchContextBoot = { tabId: tab.id, createdAt };
  try {
    signal?.throwIfAborted();
    await withAbortSignal(browserApi.tabs.update(tab.id, { muted: true, active: false }), signal);
    await waitForPageContextReady(browserApi, tab.id, origin, signal);
    if (registry.twitchContextBoot?.tabId === tab.id) registry.twitchContextBoot.readyAt = Date.now();
    if (!await isUsablePageContext(browserApi, tab.id, origin, signal)) {
      throw new SafeFetchError({
        kind: "security_policy_blocked",
        reason: "Kick page context is blocked or unusable",
      });
    }
    signal?.throwIfAborted();
  } catch (error) {
    try {
      await browserApi.tabs.remove?.(tab.id);
    } catch {
      // The unusable page may already have been closed.
    }
    throw error;
  }
  try {
    await options?.onManagedPageContextOpen?.();
  } catch {
    if (contextPlatform) {
      diagnostic(options?.emit ?? ignoreEvent, "warn", `Could not account for a managed page context opened on ${new URL(origin).host}`, contextPlatform);
    }
  }
  if (retain && retain.retainCreatedPageContext !== false) {
    const retainedContext: ManagedPageContextTab = {
      platform: retain.platform,
      tabId: tab.id,
      originUrl,
      origin,
      ownedByExtension: true,
    };
    registry.retainedPageContextTabs.set(retain.platform, retainedContext);
    registry.retainedPageContextRevision += 1;
    if (options?.emitPageContextActivity !== false) {
      options?.emit?.({
        category: "activity",
        code: "page_context_opened",
        level: "info",
        platform: retain.platform,
        data: { host: new URL(origin).host, reason: openReason },
      });
    }
    return {
      tabId: tab.id,
      createdByExtension: true,
      retainedContext,
      openedForRequest: true,
      source: "created",
    };
  }
  return {
    tabId: tab.id,
    createdByExtension: true,
    openedForRequest: true,
    source: "created",
  };
}

async function isUsablePageContext(
  browserApi: BrowserTabApi,
  tabId: number,
  origin: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (origin !== "https://kick.com") return true;
  try {
    if (browserApi.scripting?.executeScript) {
      const [result] = await withAbortSignal(browserApi.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: validateKickPageContext,
      }), signal);
      const value = result?.result as { usable?: unknown } | undefined;
      return value?.usable === true || (value as { ok?: unknown } | undefined)?.ok === true;
    }
    if (browserApi.tabs.executeScript) {
      const results = await withAbortSignal(
        browserApi.tabs.executeScript(tabId, { code: `(${validateKickPageContext.toString()})()` }),
        signal,
      );
      const value = results?.[0] as { usable?: unknown; ok?: unknown } | undefined;
      return value?.usable === true || value?.ok === true;
    }
  } catch (error) {
    signal?.throwIfAborted();
    return false;
  }
  return false;
}

function validateKickPageContext(): { usable: boolean; failure?: SafeFetchFailure } {
  const contentType = document.contentType?.toLowerCase() ?? "";
  const text = document.body?.textContent?.trim().slice(0, 512) ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.includes("json") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      return { usable: false, failure: { kind: "invalid_response" } };
    }
  }
  const rawReason = typeof body.error === "string"
    ? body.error
    : typeof body.message === "string"
      ? body.message
      : undefined;
  const reason = rawReason && rawReason.length <= 256 ? rawReason : undefined;
  const blocked = /security policy|request blocked/i.test(reason ?? text);
  if (contentType.includes("json") || blocked) {
    const rawReference = body.reference;
    const reference = (typeof rawReference === "string" && rawReference.length > 0 && rawReference.length <= 128)
      || (typeof rawReference === "number" && Number.isFinite(rawReference))
      ? rawReference
      : undefined;
    return {
      usable: false,
      failure: {
        kind: blocked ? "security_policy_blocked" : "invalid_response",
        ...(reason ? { reason } : {}),
        ...(reference !== undefined ? { reference } : {}),
      },
    };
  }
  return { usable: contentType.includes("html") || document.documentElement?.tagName === "HTML" };
}

async function waitForPageContextReady(
  browserApi: BrowserTabApi,
  tabId: number,
  origin: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (typeof process !== "undefined" && process.env.NODE_ENV === "test") return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const tab = await withAbortSignal(browserApi.tabs.get(tabId), signal);
      const url = tab?.url;
      if (tab && url?.startsWith(origin) && (tab.status == null || tab.status === "complete")) return;
    } catch (error) {
      signal?.throwIfAborted();
      // Keep polling until the page either becomes ready or times out.
    }
    await withAbortSignal(wait(100), signal);
  }
}

export function registerManagedPageContextTabs(
  registry: TabRegistry,
  contexts: SchedulerManagedPageContexts,
  platforms: readonly Platform[] = ALL_PLATFORMS,
): void {
  for (const platform of platforms) {
    registry.retainedPageContextTabs.delete(platform);
    const context = contexts[platform];
    if (context) registry.retainedPageContextTabs.set(platform, context);
    registry.retainedPageContextRevision += 1;
  }
}

// Hydrates storage-owned metadata only when this platform has no live registry
// entry. A provider request may update the registry while its storage read is
// pending; an old read must never put that newer page context back. Callers can
// pass the revision observed before the read to make that race explicit.
export function hydrateManagedPageContextTabs(
  registry: TabRegistry,
  contexts: SchedulerManagedPageContexts,
  platforms: readonly Platform[] = ALL_PLATFORMS,
  expectedRevision?: number,
): boolean {
  if (expectedRevision !== undefined && expectedRevision !== registry.retainedPageContextRevision) return false;
  for (const platform of platforms) {
    if (registry.retainedPageContextTabs.has(platform)) continue;
    const context = contexts[platform];
    if (!context) continue;
    registry.retainedPageContextTabs.set(platform, context);
    registry.retainedPageContextRevision += 1;
  }
  return true;
}

export function currentManagedPageContextTabsRevision(registry: TabRegistry): number {
  return registry.retainedPageContextRevision;
}

export function currentManagedPageContextTabs(registry: TabRegistry): SchedulerManagedPageContexts {
  return Object.fromEntries(registry.retainedPageContextTabs) as SchedulerManagedPageContexts;
}

export function recordManagedPageContextFallback(
  registry: TabRegistry,
  platform: Platform,
  host: string,
  emit: EventEmitter = ignoreEvent,
  now: number = Date.now(),
): void {
  const context = registry.retainedPageContextTabs.get(platform);
  if (!context) return;
  const updated: ManagedPageContextTab = {
    ...context,
    lastFallbackAt: new Date(now).toISOString(),
    fallbackHost: host,
    backgroundSuccesses: 0,
  };
  registry.retainedPageContextTabs.set(platform, updated);
  registry.retainedPageContextRevision += 1;
  diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} because background access is still rejected`, platform);
}

export async function reconcileManagedPageContextRecoveryWithBrowser(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  platform: Platform,
  observation: KickPageContextCycleObservation,
  requiredSuccesses: number,
  emit: EventEmitter = ignoreEvent,
): Promise<boolean> {
  const context = registry.retainedPageContextTabs.get(platform);
  if (!context) return false;

  if (observation.fallbackHosts.length > 0) {
    const fallbackHost = observation.fallbackHosts.at(-1)!;
    registry.retainedPageContextTabs.set(platform, {
      ...context,
      lastFallbackAt: new Date().toISOString(),
      fallbackHost,
      backgroundSuccesses: 0,
    });
    registry.retainedPageContextRevision += 1;
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} because this scheduler cycle still required page fallback`, platform);
    return true;
  }

  if (!context.fallbackHost || !observation.backgroundHosts.includes(context.fallbackHost)) return false;

  const updated: ManagedPageContextTab = {
    ...context,
    backgroundSuccesses: (context.backgroundSuccesses ?? 0) + 1,
  };
  registry.retainedPageContextTabs.set(platform, updated);
  registry.retainedPageContextRevision += 1;
  const threshold = Math.min(10, Math.max(1, Math.round(requiredSuccesses)));
  const recovered = updated.backgroundSuccesses! >= threshold
    && !registry.pageContextTabs.has(context.origin);
  if (!recovered) {
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} while background recovery is being confirmed`, platform);
    return true;
  }

  const verificationRevision = registry.retainedPageContextRevision;
  let retainedTab: Awaited<ReturnType<BrowserTabApi["tabs"]["get"]>>;
  try {
    retainedTab = await browserApi.tabs.get(context.tabId);
  } catch {
    registry.retainedPageContextTabs.delete(platform);
    registry.retainedPageContextRevision += 1;
    diagnostic(emit, "debug", `Forgot managed page context on ${new URL(context.origin).host} because the retained tab was already gone`, platform);
    return true;
  }
  if (registry.retainedPageContextRevision !== verificationRevision || registry.pageContextTabs.has(context.origin)) {
    return true;
  }
  if (retainedTab?.id !== context.tabId) {
    registry.retainedPageContextTabs.delete(platform);
    registry.retainedPageContextRevision += 1;
    diagnostic(emit, "debug", `Forgot managed page context on ${new URL(context.origin).host} because the retained tab was already gone or changed`, platform);
    return true;
  }
  if (typeof retainedTab.url !== "string") {
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} because the tab URL is temporarily unavailable`, platform);
    return true;
  }
  let retainedOrigin: string;
  try {
    retainedOrigin = new URL(retainedTab.url).origin;
  } catch {
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} because the tab URL is temporarily unreadable`, platform);
    return true;
  }
  if (retainedOrigin !== context.origin) {
    registry.retainedPageContextTabs.delete(platform);
    registry.retainedPageContextRevision += 1;
    diagnostic(emit, "debug", `Forgot managed page context on ${new URL(context.origin).host} because the retained tab changed`, platform);
    return true;
  }
  const remove = browserApi.tabs.remove;
  if (!remove) {
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} because tab removal is unavailable`, platform);
    return true;
  }
  // Release ownership synchronously before the asynchronous close. A fallback
  // that starts from this point onward must acquire a fresh managed context,
  // so this recovery attempt cannot delete or close its replacement.
  registry.retainedPageContextTabs.delete(platform);
  registry.retainedPageContextRevision += 1;
  registry.closingPageContextTabIds.add(context.tabId);
  try {
    await remove(context.tabId);
    emit({
      category: "activity",
      code: "page_context_closed",
      level: "info",
      platform,
      data: { host: new URL(context.origin).host, reason: "background_recovered" },
    });
  } catch {
    if (!registry.retainedPageContextTabs.has(platform)) {
      registry.retainedPageContextTabs.set(platform, updated);
      registry.retainedPageContextRevision += 1;
    }
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} because the tab could not be closed`, platform);
  } finally {
    registry.closingPageContextTabIds.delete(context.tabId);
  }
  return true;
}

// Pure state cleanup: drop the given platforms from the contexts map and the
// retained-tab registry, returning the next contexts. No browser access, so a
// headless runtime — and the scheduler's default — can forget page contexts
// without a tab API; the browser-backed variant below layers real tab removal
// on top.
export function forgetManagedPageContextTabs(
  registry: TabRegistry,
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter } = {},
): SchedulerManagedPageContexts {
  const platforms = options.platforms ?? ["twitch", "kick"];
  const next = { ...contexts };
  for (const platform of platforms) {
    if (!next[platform]) continue;
    delete next[platform];
    registry.retainedPageContextTabs.delete(platform);
    registry.retainedPageContextRevision += 1;
  }
  return next;
}

export async function stopManagedPageContextTabsWithBrowser(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter } = {},
): Promise<SchedulerManagedPageContexts> {
  const platforms = options.platforms ?? ["twitch", "kick"];
  for (const platform of platforms) {
    const context = contexts[platform];
    if (!context) continue;
    const remove = browserApi.tabs.remove;
    if (!remove) {
      diagnostic(options.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(context.origin).host} because tab removal is unavailable`, platform);
      continue;
    }
    try {
      await remove(context.tabId);
      options.emit?.({
        category: "activity",
        code: "page_context_closed",
        level: "info",
        platform,
        data: { host: new URL(context.origin).host, reason: options.reason ?? "automation_disabled" },
      });
    } catch {
      // The retained page context may have been closed manually.
      diagnostic(options.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(context.origin).host} because the tab was already gone`, platform);
    }
  }
  return forgetManagedPageContextTabs(registry, contexts, options);
}

export type { SchedulerManagedPageContexts };

// Injected into a page's MAIN world via executeScript to fetch with the page's
// cookies/session — used for Kick, which needs Cloudflare/session context. All
// Twitch requests go through fetchTwitchInBackground instead, because Twitch GQL
// cannot be reached from the twitch.tv page (CORS / anti-tampering). Must be
// self-contained: executeScript only serializes this function's own source, so
// module-scope helpers are unavailable in the page.
//
// Test seam: exported so tests can call it directly with a stubbed fetch/document
// instead of only through the mocked executeScript path (see fetchJsonInPageWithBrowser's
// tests). Exporting does not affect executeScript injection, which serializes only
// this function's own toString() output, not how it was imported.
export async function pageFetchJson(targetUrl: string, initJson?: string): Promise<unknown> {
  const parsedInit = initJson ? JSON.parse(initJson) : undefined;
  const headers = new Headers(parsedInit?.headers ?? {});
  // Mirrors needsKickSessionBearer (KICK_BEARER_PATHS); inlined because
  // executeScript only serializes this function's own source, so module-scope
  // helpers are unavailable in the page. Matches on parsed host/pathname so the
  // session token is never attached to a look-alike host or to an unintended
  // subpath of /api/v1/user.
  let needsKickBearer = false;
  try {
    const parsedTarget = new URL(targetUrl);
    needsKickBearer = parsedTarget.protocol === "https:"
      && (parsedTarget.host === "web.kick.com"
        || parsedTarget.host === "websockets.kick.com"
        || (parsedTarget.host === "kick.com"
          && (parsedTarget.pathname === "/api/v1/user" || parsedTarget.pathname === "/api/v1/user/livestreams")));
  } catch {
    needsKickBearer = false;
  }
  if (needsKickBearer && !headers.has("authorization")) {
    const sessionToken = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("session_token="))
      ?.slice("session_token=".length);
    if (sessionToken) headers.set("authorization", `Bearer ${decodeURIComponent(sessionToken)}`);
  }
  try {
    const response = await fetch(targetUrl, {
      ...parsedInit,
      headers,
      credentials: parsedInit?.credentials ?? "include",
    });
    const text = await response.text();
    if (!response.ok) {
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        // Never retain non-JSON response bodies.
      }
      const rawReason = typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : undefined;
      const reason = rawReason && rawReason.length <= 256 ? rawReason : undefined;
      const rawReference = body.reference;
      const reference = (typeof rawReference === "string" && rawReference.length > 0 && rawReference.length <= 128)
        || (typeof rawReference === "number" && Number.isFinite(rawReference))
        ? rawReference
        : undefined;
      const blocked = /security policy|request blocked/i.test(reason ?? "");
      return {
        __lurklootPageFetch: true,
        ok: false,
        error: {
          kind: blocked
            ? "security_policy_blocked"
            : response.status === 401 || response.status === 403
              ? "authentication_rejected"
              : "http_error",
          status: response.status,
          ...(reason ? { reason } : {}),
          ...(reference !== undefined ? { reference } : {}),
        },
      };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? JSON.parse(text) : { html: text };
    return { __lurklootPageFetch: true, ok: true, data };
  } catch {
    return {
      __lurklootPageFetch: true,
      ok: false,
      error: { kind: "network_error" },
    };
  }
}
