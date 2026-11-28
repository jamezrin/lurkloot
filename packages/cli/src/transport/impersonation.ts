// The browser-impersonating HTTP client the CLI reaches Kick (and Twitch's
// heartbeat) through. Kick's Cloudflare WAF fingerprints the TLS and HTTP/2
// stack, not headers, so a plain Node fetch can be refused where a browser is
// not. Two libraries can send a browser's fingerprint, and the transport,
// the Kick TV-link sign-in and the heartbeat all talk to them through this one
// interface:
//
// - impit (Apache-2.0): a Rust library loaded into Node, with browser profiles
//   it keeps current. The default.
// - cycletls: CycleTLS's Go binary (GPL-3.0), a separate program the CLI starts
//   and talks to over a local socket through its own client
//   (cycleTlsClient.ts), sent a JA3/HTTP-2 fingerprint string. Kept as an
//   opt-in fallback. No CycleTLS code runs in the CLI's process.
//
// Each backend is loaded only when it is created, so a CLI on cycletls never
// loads impit's native add-on, and one on impit never starts the binary.

export type ImpersonationBackend = "impit" | "cycletls";

export interface ImpersonatedRequest {
  method: "get" | "post" | "head";
  headers: Record<string, string>;
  body?: string;
  // Overrides the backend's browser user agent. Leave unset to send the one
  // the backend's browser fingerprint belongs to.
  userAgent?: string;
  // "manual" returns a 3xx as-is; the default follows redirects.
  redirect?: "follow" | "manual";
  // impit cancels the request; the cycletls binary cannot cancel one request,
  // so callers still race their own deadline.
  signal?: AbortSignal;
}

export interface ImpersonatedResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  // The address the response came from after redirects, when the backend
  // reports one.
  finalUrl?: string;
}

export interface ImpersonatingClient {
  readonly backend: ImpersonationBackend;
  request(url: string, request: ImpersonatedRequest): Promise<ImpersonatedResponse>;
  close(): Promise<void>;
}

export async function createImpersonatingClient(
  backend: ImpersonationBackend,
): Promise<ImpersonatingClient> {
  if (backend === "cycletls") {
    const { initCycle, createCycleClient } = await import("./cycle");
    return createCycleClient(await initCycle());
  }
  const { initImpit, createImpitClient } = await import("./impit");
  return createImpitClient(await initImpit());
}
