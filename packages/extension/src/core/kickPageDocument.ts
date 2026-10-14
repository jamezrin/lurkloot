import type { ChannelCandidate } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { SafeFetchFailure } from "@lurkloot/core/fetchError";
import { KickWafBlockedError } from "@lurkloot/core/transport";
import {
  forgetOpeningWatchTab,
  forgetTabClosure,
  noteTabClosure,
  type TabRegistry,
} from "@lurkloot/core/tabRegistry";
import type { BrowserTabApi } from "./browserTabs";

const KICK_ORIGIN = "https://kick.com";
const ignoreEvent: EventEmitter = () => {};

function diagnostic(emit: EventEmitter, level: LogLevel, message: string): void {
  emit({ category: "diagnostic", level, message, platform: "kick" });
}

// Injected into a Kick page's MAIN world. Must stay self-contained: executeScript
// only serializes this function's own source.
export function validateKickPageContext(): { usable: boolean; failure?: SafeFetchFailure } {
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

export async function inspectKickDocument(
  browserApi: BrowserTabApi,
  tabId: number,
  signal?: AbortSignal,
): Promise<{ usable: true } | { usable: false; failure?: SafeFetchFailure }> {
  signal?.throwIfAborted();
  try {
    if (browserApi.scripting?.executeScript) {
      const [result] = await withAbortSignal(browserApi.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: validateKickPageContext,
      }), signal);
      return normalizeKickDocumentInspection(result?.result);
    }
    if (browserApi.tabs.executeScript) {
      const results = await withAbortSignal(
        browserApi.tabs.executeScript(tabId, { code: `(${validateKickPageContext.toString()})()` }),
        signal,
      );
      return normalizeKickDocumentInspection(results?.[0]);
    }
  } catch (error) {
    signal?.throwIfAborted();
    return { usable: false, failure: { kind: "invalid_response" } };
  }
  return { usable: false, failure: { kind: "invalid_response" } };
}

export async function isKickPageContextUsable(
  browserApi: BrowserTabApi,
  tabId: number,
  _origin: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await inspectKickDocument(browserApi, tabId, signal)).usable;
}

// Kick sometimes serves a security-policy JSON body instead of the channel SPA.
// Refuse to farm on that document and surface KickWafBlockedError so the
// scheduler marks auth blocked (#794).
export async function assertKickWatchTabUsable(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  tabId: number,
  channel: ChannelCandidate,
  emit: EventEmitter = ignoreEvent,
  signal?: AbortSignal,
  options: { closeOnFailure: boolean } = { closeOnFailure: false },
): Promise<void> {
  if (channel.platform !== "kick") return;
  signal?.throwIfAborted();
  await waitForKickOriginReady(browserApi, tabId, signal);
  const inspection = await inspectKickDocument(browserApi, tabId, signal);
  if (inspection.usable) return;

  const failure = kickWatchTabBlockFailure(inspection.failure);
  diagnostic(
    emit,
    "warn",
    failure.reason
      ? `Kick watch tab ${tabId} is unusable: ${failure.reason}`
      : `Kick watch tab ${tabId} is blocked or unusable`,
  );
  if (options.closeOnFailure && browserApi.tabs.remove) {
    try {
      await closeKickTab(registry, browserApi, tabId);
      diagnostic(emit, "debug", `Closed blocked Kick watch tab ${tabId}`);
    } catch {
      // The tab may already have been closed independently.
    }
  }
  throw new KickWafBlockedError(failure);
}

function kickWatchTabBlockFailure(failure: SafeFetchFailure | undefined): SafeFetchFailure {
  if (failure?.kind === "security_policy_blocked") return failure;
  return {
    kind: "security_policy_blocked",
    reason: failure?.reason ?? "Kick watch tab returned a non-HTML document",
    ...(failure?.reference !== undefined ? { reference: failure.reference } : {}),
    ...(failure?.status !== undefined ? { status: failure.status } : {}),
  };
}

function normalizeKickDocumentInspection(
  value: unknown,
): { usable: true } | { usable: false; failure?: SafeFetchFailure } {
  const record = value && typeof value === "object" ? value as {
    usable?: unknown;
    ok?: unknown;
    failure?: SafeFetchFailure;
  } : undefined;
  if (record?.usable === true || record?.ok === true) return { usable: true };
  return {
    usable: false,
    ...(record?.failure ? { failure: record.failure } : {}),
  };
}

async function closeKickTab(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  tabId: number,
): Promise<void> {
  const remove = browserApi.tabs.remove;
  if (!remove) throw new Error("Tab removal is unavailable");
  noteTabClosure(registry, tabId, "extension-cleanup");
  try {
    await remove(tabId);
  } catch (error) {
    forgetTabClosure(registry, tabId);
    throw error;
  }
  forgetOpeningWatchTab(registry, tabId);
}

async function waitForKickOriginReady(
  browserApi: BrowserTabApi,
  tabId: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (typeof process !== "undefined" && process.env.NODE_ENV === "test") return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const tab = await withAbortSignal(browserApi.tabs.get(tabId), signal);
      const url = tab?.url;
      if (tab && url?.startsWith(KICK_ORIGIN) && (tab.status == null || tab.status === "complete")) return;
    } catch (error) {
      signal?.throwIfAborted();
    }
    await withAbortSignal(wait(100), signal);
  }
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

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
