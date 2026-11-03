import { randomUUID } from "node:crypto";
import { saveCredentials } from "../authStore";
import { initCycle, createTvLinkAuthenticator } from "../transport/cycle";
import type { Logger } from "../logger";
import { waitForDeviceApproval, type DeviceLoginFlow } from "./deviceLogin";

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

// The authenticate call and what it holds (a cycletls subprocess), so the flow
// can release it however it ends.
export interface TvLinkClient {
  authenticate: TvLinkAuthenticator;
  dispose(): Promise<void>;
}

async function createCycleTvLinkClient(): Promise<TvLinkClient> {
  const cycleTLS = await initCycle();
  return {
    authenticate: createTvLinkAuthenticator(cycleTLS),
    dispose: async () => {
      await cycleTLS.exit();
    },
  };
}

// Starts a TV link and returns the flow. Kick does not document a "pending"
// body, so any response without a token is treated as still-waiting; the only
// terminal outcomes are a token or the deadline. The uuid and code together
// let anyone collect the token once the user approves, so the link is shown to
// the user and never logged by `serve`.
export async function startKickDeviceLogin(
  options: { createClient?: () => Promise<TvLinkClient>; link?: TvLink } = {},
): Promise<DeviceLoginFlow> {
  const link = options.link ?? requestTvLink();
  const client = await (options.createClient ?? createCycleTvLinkClient)();
  return {
    platform: "kick",
    verificationUrl: link.verificationUrl,
    userCode: link.code,
    intervalMs: POLL_INTERVAL_SECONDS * 1000,
    expiresInMs: EXPIRES_IN_SECONDS * 1000,
    expiredMessage: "TV link code expired before approval",
    poll: async () => {
      const { token } = await client.authenticate(link.uuid, link.code);
      return token ? { status: "approved", token } : { status: "pending" };
    },
    credentials: (sessionToken) => ({ kick: { sessionToken } }),
    dispose: () => client.dispose(),
  };
}

export async function kickDeviceLogin(authDir: string, logger: Logger): Promise<void> {
  const flow = await startKickDeviceLogin();
  try {
    logger.info(
      `Open ${flow.verificationUrl} (signed in to Kick) and confirm code: ${flow.userCode}`,
      "login",
    );
    logger.info(
      `Waiting for approval (expires in ${Math.round(flow.expiresInMs / 60_000)} min)…`,
      "login",
    );
    const sessionToken = await waitForDeviceApproval(flow);
    saveCredentials(authDir, flow.credentials(sessionToken));
    logger.info("Kick device login complete; token saved", "login");
  } finally {
    await flow.dispose();
  }
}
