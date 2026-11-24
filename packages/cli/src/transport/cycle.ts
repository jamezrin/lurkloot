import type { CycleTLSClient } from "cycletls";
import { assertCycleTlsPathStartable, standaloneCycleTlsPath } from "../runtime/standalone";
import { CHROME_HTTP2, CHROME_JA3 } from "./common";
import type { ImpersonatedResponse, ImpersonatingClient } from "./impersonation";

export type { CycleTLSClient } from "cycletls";

/** Starts CycleTLS using the shipped helper in a standalone install or the package default. */
export async function initCycle(
  executablePath = standaloneCycleTlsPath(),
): Promise<CycleTLSClient> {
  // Imported here, not at the top, so a CLI on another backend never loads
  // cycletls's (GPL-3.0) JavaScript.
  const { default: initCycleTLS } = await import("cycletls");
  if (executablePath === undefined) return initCycleTLS();
  assertCycleTlsPathStartable(executablePath, process.platform);
  return initCycleTLS({ executablePath });
}

function bodyText(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (typeof data === "string") return data;
  return JSON.stringify(data ?? "");
}

function headerRecord(headers: unknown): Record<string, string | string[]> {
  if (!headers || typeof headers !== "object") return {};
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" || Array.isArray(value)) out[key] = value;
  }
  return out;
}

// The cycletls backend: sends the pinned Chrome 124 JA3/HTTP-2 fingerprint
// (common.ts) with every request. CycleTLS 2.x has no per-request cancellation
// (its only interruption is a process-wide exit(), which would end sibling
// requests), so a request's signal is not passed on.
export function createCycleClient(cycleTLS: CycleTLSClient): ImpersonatingClient {
  return {
    backend: "cycletls",
    async request(url, request): Promise<ImpersonatedResponse> {
      const response = await cycleTLS(
        url,
        {
          ja3: CHROME_JA3,
          http2Fingerprint: CHROME_HTTP2,
          userAgent: request.userAgent,
          headers: request.headers,
          body: request.body,
          ...(request.redirect === "manual" ? { disableRedirect: true } : {}),
        },
        request.method,
      );
      const finalUrl = typeof response.finalUrl === "string" ? response.finalUrl.trim() : "";
      return {
        status: response.status,
        headers: headerRecord(response.headers),
        body: bodyText(response.data),
        ...(finalUrl ? { finalUrl } : {}),
      };
    },
    close: async () => {
      await cycleTLS.exit();
    },
  };
}
