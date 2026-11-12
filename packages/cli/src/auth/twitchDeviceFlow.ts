import { saveCredentials } from "../authStore";
import { TWITCH_SMARTBOX_CLIENT_ID } from "../twitch";
import type { Logger } from "../logger";
import { waitForDeviceApproval, type DeviceLoginFlow, type DevicePoll } from "./deviceLogin";

// Twitch's device-code OAuth, so a headless host can get a Twitch token with no
// browser: request a code, show the user the activation URL, then poll until they
// authorize. Uses the Smart TV client, which Twitch currently accepts for the
// device flow. The transport sends the same Client-ID as the issued token.
const DEVICE_ENDPOINT = "https://id.twitch.tv/oauth2/device";
const TOKEN_ENDPOINT = "https://id.twitch.tv/oauth2/token";
// No scopes are needed for the drops GQL.
const SCOPES = "";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function requestDeviceCode(
  clientId = TWITCH_SMARTBOX_CLIENT_ID,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCode> {
  const response = await fetchImpl(DEVICE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scopes: SCOPES }),
  });
  if (!response.ok) {
    throw new Error(`Device-code request failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<DeviceCode>;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  message?: string;
}

// One poll of the token endpoint. `authorization_pending` is the normal wait
// state; `slow_down` asks for a longer interval; anything else is a hard failure.
export async function pollDeviceToken(
  deviceCode: string,
  clientId = TWITCH_SMARTBOX_CLIENT_ID,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<DevicePoll> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    ...(signal ? { signal } : {}),
  });
  const data = (await response.json()) as TokenResponse;
  if (data.access_token) return { status: "approved", token: data.access_token };
  if (data.message === "authorization_pending" || data.error === "authorization_pending")
    return { status: "pending" };
  if (data.message === "slow_down" || data.error === "slow_down") return { status: "slow_down" };
  throw new Error(`Device authorization failed: ${data.message ?? data.error ?? "unknown error"}`);
}

// Requests a device code and returns the started flow. The device code itself
// stays inside the flow: only the activation URL and user code leave it.
export async function startTwitchDeviceLogin(
  options: { clientId?: string; fetchImpl?: typeof fetch } = {},
): Promise<DeviceLoginFlow> {
  const clientId = options.clientId ?? TWITCH_SMARTBOX_CLIENT_ID;
  const fetchImpl = options.fetchImpl ?? fetch;
  const code = await requestDeviceCode(clientId, fetchImpl);
  return {
    platform: "twitch",
    verificationUrl: code.verification_uri,
    userCode: code.user_code,
    intervalMs: code.interval * 1000,
    expiresInMs: code.expires_in * 1000,
    expiredMessage: "Device code expired before authorization",
    poll: (signal) => pollDeviceToken(code.device_code, clientId, fetchImpl, signal),
    credentials: (token) => ({ twitch: { authToken: token, clientId } }),
    dispose: async () => {},
  };
}

export async function twitchDeviceLogin(
  authDir: string,
  logger: Logger,
  clientId = TWITCH_SMARTBOX_CLIENT_ID,
): Promise<void> {
  const flow = await startTwitchDeviceLogin({ clientId });
  try {
    logger.info(`Open ${flow.verificationUrl} and enter code: ${flow.userCode}`, "login");
    logger.info(
      `Waiting for authorization (expires in ${Math.round(flow.expiresInMs / 60_000)} min)…`,
      "login",
    );
    const accessToken = await waitForDeviceApproval(flow);
    saveCredentials(authDir, flow.credentials(accessToken));
    logger.info("Twitch device login complete; token saved", "login");
  } finally {
    await flow.dispose();
  }
}
