import { assertCycleTlsBinary, cycleTlsBinaryPath } from "../runtime/standalone";
import { CHROME_HTTP2, CHROME_JA3, CHROME_UA } from "./common";
import { type CycleTlsClient, startCycleTls } from "./cycleTlsClient";
import type { ImpersonatedResponse, ImpersonatingClient } from "./impersonation";

export type { CycleTlsClient } from "./cycleTlsClient";

/** Starts the shipped CycleTLS binary as a separate process the CLI owns. */
export async function initCycle(executablePath = cycleTlsBinaryPath()): Promise<CycleTlsClient> {
  assertCycleTlsBinary(executablePath);
  return startCycleTls(executablePath);
}

// The cycletls backend: sends the pinned Chrome 124 JA3/HTTP-2 fingerprint
// (common.ts) with every request, and Chrome 124's user agent unless the caller
// names another. The binary has no per-request cancellation, so a request's
// signal is not passed on; callers race their own deadline.
export function createCycleClient(cycleTls: CycleTlsClient): ImpersonatingClient {
  return {
    backend: "cycletls",
    async request(url, request): Promise<ImpersonatedResponse> {
      const response = await cycleTls.request({
        url,
        method: request.method,
        headers: request.headers,
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
