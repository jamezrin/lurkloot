import { assertCycleTlsBinary, cycleTlsBinaryPath } from "../runtime/standalone";
import { CHROME_HTTP2, CHROME_JA3, CHROME_UA } from "./common";
import { type CycleTlsClient, restartingCycleTls, startCycleTls } from "./cycleTlsClient";
import type { ImpersonatedResponse, ImpersonatingClient } from "./impersonation";

export type { CycleTlsClient } from "./cycleTlsClient";

/**
 * Starts the shipped CycleTLS binary as a separate process the CLI owns, and
 * again if it dies (restartingCycleTls).
 */
export async function initCycle(executablePath = cycleTlsBinaryPath()): Promise<CycleTlsClient> {
  assertCycleTlsBinary(executablePath);
  const first = await startCycleTls(executablePath);
  return restartingCycleTls(() => {
    assertCycleTlsBinary(executablePath);
    return startCycleTls(executablePath);
  }, first);
}

// The cycletls backend: sends the pinned Chrome 124 JA3/HTTP-2 fingerprint
// (common.ts) with every request, and Chrome 124's user agent unless the caller
// names another. The binary has no per-request cancellation, so a request's
// signal is not passed on; callers race their own deadline.
//
// The binary builds a new HTTP client for every request and never closes its
// connection, which stays open until the server drops it (minutes for Kick):
// a farming CLI ends up holding a couple of hundred idle connections. Asking
// it to close each one after the response fixes that. Over HTTP/2 the header
// is not sent, so Kick sees the same request. The binary's own
// enableConnectionReuse option is no way out: it answers parallel requests to
// several Kick hosts with HTTP 421.
export function createCycleClient(cycleTls: CycleTlsClient): ImpersonatingClient {
  return {
    backend: "cycletls",
    async request(url, request): Promise<ImpersonatedResponse> {
      const response = await cycleTls.request({
        url,
        method: request.method,
        headers: { ...request.headers, Connection: "close" },
        body: request.body ?? "",
        ja3: CHROME_JA3,
        http2Fingerprint: CHROME_HTTP2,
        userAgent: request.userAgent ?? CHROME_UA,
        ...(request.redirect === "manual" ? { disableRedirect: true } : {}),
      });
      const finalUrl = response.finalUrl.trim();
      return {
        status: response.status,
        headers: response.headers,
        body: response.body.toString("utf8"),
        ...(finalUrl ? { finalUrl } : {}),
      };
    },
    close: () => cycleTls.close(),
  };
}
