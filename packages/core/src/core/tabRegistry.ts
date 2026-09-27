import type { ManagedPageContextTab, Platform, SchedulerManagedPageContexts, TabClosureOrigin } from "@lurkloot/shared/models";
import type { EventEmitter, PageContextCloseReason } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { TwitchIntegrity } from "./twitchIntegrity";
import type { KickPageContextCycleObservation } from "../platforms/adapter";
import { createTwitchRequestIdentity, type TwitchRequestIdentity } from "./transport";

// The engine's side of browser tabs (#598): which tabs it holds and why, and the
// rules for them — the managed-tab breaker, page-context snapshots and
// recovery, and Twitch integrity captures and waits. There is no browser code
// here. The extension runs the tab mechanics (packages/extension/src/core/
// browserTabs.ts) against the same registry the controller reads.

const ignoreEvent: EventEmitter = () => {};

function diagnostic(emit: EventEmitter, level: LogLevel, message: string, platform?: Platform): void {
  emit({ category: "diagnostic", level, message, platform });
}

// Where a page-context tab came from. Only used for diagnostics: a freshly
// created tab boots the SPA and issues authenticated GQL, while an inherited one
// may be idle and issue nothing, which decides whether waiting for a token can
// succeed at all.
export type PageContextSource = "created" | "user_tab" | "managed_tab" | "shared_entry";

export interface PageContextTab {
  tabId: number;
  createdByExtension: boolean;
  retainedContext?: ManagedPageContextTab;
  openedForRequest?: boolean;
  source?: PageContextSource;
}

export interface PageContextEntry {
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
  // Tabs the engine is closing or has closed, and why (#598). Recorded before
  // the browser call, so the removal event that follows it finds the entry.
  tabClosures: Map<number, Exclude<TabClosureOrigin, "user">>;
  retainedPageContextRevision: number;
  // Mirrors SchedulerState.criticalHealth[platform].breakerOpen. The page-context
  // call sites are several layers deep and have no access to scheduler state, so
  // the scheduler (and the controller, whenever it records an open) pushes the
  // flag here instead. Watch tabs are gated directly in the scheduler, which
  // already has the state in scope.
  openManagedTabBreakers: Set<Platform>;
  // Keyed by platform, not by tab id: when playback never becomes healthy the
  // scheduler condemns the watch tab and opens a replacement, so the tab id is
  // different on every cycle. A per-tab budget would be reissued in full each time
  // and the cap would never engage. The watch target is what we rate-limit, so the
  // state carries the channel it was accrued for — a new tab for a *different*
  // channel is a legitimate reason to prime again, a new tab for the same channel
  // that keeps failing is the loop we must stop.
  playbackPrimeStates: Map<Platform, PlaybackPrimeState>;
  adFocusHolds: Map<Platform, number>;
  adFocusExpired: Set<Platform>;
  previousFocus: { tabId?: number; windowId?: number } | undefined;
  // The most recently captured Client-Integrity bundle from the live twitch.tv
  // page (see twitchIntegrity.ts). The host feeds it through setTwitchIntegrity
  // so authenticated GQL mutations (e.g. drop claims) carry a valid integrity
  // token. Undefined until one is captured, so queries keep working without it.
  twitchIntegrity: TwitchIntegrity | undefined;
  latestTwitchIntegrityCapture: TwitchIntegrityCapture | undefined;
  twitchIntegrityCapturesBySourceTab: Map<number, TwitchIntegrityCapture>;
  twitchIntegrityCaptureGeneration: number;
  // Resolvers waiting for the next captured token (see waitForIntegrityCapture).
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
    tabClosures: new Map(),
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

export interface PlaybackPrimeState {
  channelUrl: string;
  attempts: number;
  lastAttemptAt: number;
  exhausted: boolean;
}

// Forgets the priming budget for a platform (or for every platform when none is
// given), so the next request primes again. Called when a tick finds playback
// healthy — genuine recovery, not merely a new tab.
export function resetPlaybackPriming(registry: TabRegistry, platform?: Platform): void {
  if (platform == null) registry.playbackPrimeStates.clear();
  else registry.playbackPrimeStates.delete(platform);
}

export interface TwitchIntegrityCapture {
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
export interface TwitchContextBootTiming {
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

export function describeContextBoot(boot: TwitchContextBootTiming, now: number): string {
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

export interface TwitchIntegrityAcquisitionResult {
  value: TwitchIntegrity;
  managedContext: boolean;
}

// Minting boots a twitch.tv context and may wait ~22s for Kasada's proof-of-work,
// so every caller shares one owned acquisition. The owned abort cancels the
// underlying page context; only the creator's signal owns that lifecycle, while
// later joiners race their own signal without disturbing everyone else.
export interface TwitchIntegrityAcquisition {
  promise: Promise<TwitchIntegrityAcquisitionResult | undefined>;
  abort: AbortController;
}

export function cancelTwitchIntegrityAcquisition(registry: TabRegistry, reason?: unknown): void {
  registry.inFlightIntegrityAcquisition?.abort.abort(reason);
}

export function hasReplacementTwitchIntegrity(registry: TabRegistry, rejectedToken?: string): boolean {
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
export function waitForIntegrityCapture(
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

// Enough for every tab one cycle can close; an entry whose removal event never
// arrives (the host was restarting) must not linger for a reused tab id.
const MAX_TAB_CLOSURES = 64;

// Records that the engine is about to close `tabId`. Call it before the browser
// call: the removal event can arrive before that call resolves.
export function noteTabClosure(
  registry: TabRegistry,
  tabId: number,
  origin: Exclude<TabClosureOrigin, "user">,
): void {
  registry.tabClosures.delete(tabId);
  registry.tabClosures.set(tabId, origin);
  while (registry.tabClosures.size > MAX_TAB_CLOSURES) {
    const oldest = registry.tabClosures.keys().next().value;
    if (oldest == null) break;
    registry.tabClosures.delete(oldest);
  }
}

// For a close that did not happen, so a later user close of the same tab is
// still the user's.
export function forgetTabClosure(registry: TabRegistry, tabId: number): void {
  registry.tabClosures.delete(tabId);
}

export function isTabClosing(registry: TabRegistry, tabId: number): boolean {
  return registry.tabClosures.has(tabId);
}

// Why a removed tab was closed: the engine's recorded reason, or the user.
export function takeTabClosureOrigin(registry: TabRegistry, tabId: number): TabClosureOrigin {
  const origin = registry.tabClosures.get(tabId);
  registry.tabClosures.delete(tabId);
  return origin ?? "user";
}

// What one scheduler cycle's page-context evidence means for the retained
// context (#598: this is policy, so it stays in core; the extension only
// verifies and closes the tab):
// - "none": nothing retained, or no evidence about its fallback host;
// - "retained": the cycle still needed the page, or background access is not
//   yet confirmed often enough, so the context stays;
// - "recovered": background access worked `requiredSuccesses` times in a row
//   (clamped to 1–10) and no request is using the context, so it may close.
export type PageContextRecoveryStep =
  | { readonly kind: "none" }
  | { readonly kind: "retained" }
  | { readonly kind: "recovered"; readonly context: ManagedPageContextTab; readonly updated: ManagedPageContextTab };

export function observePageContextRecovery(
  registry: TabRegistry,
  platform: Platform,
  observation: KickPageContextCycleObservation,
  requiredSuccesses: number,
  emit: EventEmitter = ignoreEvent,
): PageContextRecoveryStep {
  const context = registry.retainedPageContextTabs.get(platform);
  if (!context) return { kind: "none" };

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
    return { kind: "retained" };
  }

  if (!context.fallbackHost || !observation.backgroundHosts.includes(context.fallbackHost)) return { kind: "none" };

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
    return { kind: "retained" };
  }
  return { kind: "recovered", context, updated };
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
