import { randomUUID } from "node:crypto";
import { saveCredentials } from "../authStore";
import { initCycle, createTvLinkAuthenticator } from "../transport/cycle";
import type { Logger } from "../logger";

// Kick's smart-TV link flow, so a headless host can get a Kick session token
// with no browser: generate a uuid + short code, show the user the activation
// URL, then poll until they approve it from a device where they're already
// signed in. This is exactly how Kick's own TV app (com.kick.tv) and the
// open-source KCIKTV client authenticate — the token it returns is the same
// session Bearer the cookie export yields, so farming uses it unchanged.
//
// The authenticate endpoint sits behind Kick's Cloudflare WAF (a plain fetch
// gets HTTP 403 "Request blocked by security policy."), so the request rides the
// same cycletls Chrome fingerprint the impersonate transport uses for Kick.
const LOGIN_URL = "https://kick.com/tv/login";
// The flow is push-driven in the apps (a Pusher `tv-setup-<uuid>` event), but
// polling the authenticate endpoint until it returns a token works headlessly.
const POLL_INTERVAL_SECONDS = 5;
const EXPIRES_IN_SECONDS = 300;

export interface TvLink {
  uuid: string;
  code: string;
  verificationUrl: string;
}

export function requestTvLink(): TvLink {
  const uuid = randomUUID().toUpperCase();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  return { uuid, code, verificationUrl: `${LOGIN_URL}?uuid=${uuid}&code=${code}` };
}

// Resolves the link once the user approves it (the response carries a token).
export type TvLinkAuthenticator = (uuid: string, code: string) => Promise<{ token?: string }>;

// Polls the authenticate endpoint until the user approves the link (returning a
// token) or the code expires. Kick does not document a "pending" body, so any
// response without a token is treated as still-waiting; the only terminal
// outcomes are a token or the deadline. `authenticate` and `sleep` are
// injectable for tests.
export async function pollForToken(
  uuid: string,
  code: string,
  authenticate: TvLinkAuthenticator,
  intervalSeconds = POLL_INTERVAL_SECONDS,
  expiresInSeconds = EXPIRES_IN_SECONDS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const { token } = await authenticate(uuid, code);
    if (token) return token;
  }
  throw new Error("TV link code expired before approval");
}

export async function kickDeviceLogin(authDir: string, logger: Logger): Promise<void> {
  const link = requestTvLink();
  logger.info(`Open ${link.verificationUrl} (signed in to Kick) and confirm code: ${link.code}`, "login");
  logger.info(`Waiting for approval (expires in ${Math.round(EXPIRES_IN_SECONDS / 60)} min)…`, "login");
  const cycleTLS = await initCycle();
  try {
    const sessionToken = await pollForToken(link.uuid, link.code, createTvLinkAuthenticator(cycleTLS));
    saveCredentials(authDir, { kick: { sessionToken } });
    logger.info("Kick device login complete; token saved", "login");
  } finally {
    await cycleTLS.exit();
  }
}
