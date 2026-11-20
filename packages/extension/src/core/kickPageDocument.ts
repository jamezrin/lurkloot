import type { SafeFetchFailure } from "@lurkloot/core/fetchError";
import { isKickHttpChallenge, kickHttpChallenge } from "@lurkloot/core/transport";
import type { PageFetchOptions } from "./browserTabs";

// Kick's page-context fallback policy for the background fetcher.
//
// A challenge seen only by the service worker takes the normal fallback: a
// real kick.com tab runs Cloudflare's challenge, so the fallback may open one
// retained context, which later fallbacks reuse and the churn breaker bounds.
// Once the page context itself answers a host with the challenge marker, a new
// tab would repeat the blocked request. Challenged fallbacks for that host
// then only reuse a usable context (a user's kick.com tab or the retained one)
// until a request to the host succeeds from either side. With none open, Kick
// stays unavailable and no tab opens.
export class KickPageContextFallback {
  private readonly challengedHosts = new Set<string>();

  options(url: string, backgroundError: unknown): PageFetchOptions {
    const reuseOnly = isKickHttpChallenge(backgroundError) && this.challengedHosts.has(hostOf(url));
    return {
      retainPageContext: { platform: "kick" },
      inspectDocument: inspectKickDocument,
      openReason: "background_rejected",
      challengeError: kickHttpChallenge,
      ...(reuseOnly ? { reusePageContextOrThrow: backgroundError } : {}),
    };
  }

  async fetch<T>(
    url: string,
    backgroundError: unknown,
    fetchInPage: (options: PageFetchOptions) => Promise<T>,
  ): Promise<T> {
    const options = this.options(url, backgroundError);
    let result: T;
    try {
      result = await fetchInPage(options);
    } catch (error) {
      // A normal fallback only throws a challenge when the page answered with
      // the marker. A reuse-only refusal rethrows the background challenge for
      // a host that is already latched. Other failures leave the latch as is.
      if (isKickHttpChallenge(error)) this.challengedHosts.add(hostOf(url));
      throw error;
    }
    this.challengedHosts.delete(hostOf(url));
    return result;
  }

  recordBackgroundSuccess(host: string): void {
    this.challengedHosts.delete(host);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// Kick's PageDocumentInspector: Kick can answer a page request with its
// security-policy JSON instead of the page (#794). browserTabs injects it into
// the tab's MAIN world, so it must stay self-contained: executeScript only
// serializes this function's own source.
export function inspectKickDocument(): { usable: boolean; failure?: SafeFetchFailure } {
  const contentType = document.contentType?.toLowerCase() ?? "";
  const text = document.body?.textContent?.trim().slice(0, 512) ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.includes("json") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as Record<string, unknown>;
    } catch {
      return { usable: false, failure: { kind: "invalid_response" } };
    }
  }
  const rawReason =
    typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
        ? body.message
        : undefined;
  const reason = rawReason && rawReason.length <= 256 ? rawReason : undefined;
  const blocked = /security policy|request blocked/i.test(reason ?? text);
  if (contentType.includes("json") || blocked) {
    const rawReference = body.reference;
    const reference =
      (typeof rawReference === "string" && rawReference.length > 0 && rawReference.length <= 128)
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
  if (contentType.includes("html") || document.documentElement?.tagName === "HTML")
    return { usable: true };
  return {
    usable: false,
    failure: { kind: "invalid_response", reason: "Kick served a non-HTML document" },
  };
}
