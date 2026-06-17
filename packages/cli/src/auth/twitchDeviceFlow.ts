import { saveCredentials } from "../authStore";
import type { Logger } from "../logger";

// Twitch's device-code OAuth, so a headless host can get a Twitch token with no
// browser: request a code, show the user the activation URL, then poll until
// they authorize. Uses the SmartTV/console public client id (the same family of
// client used by device-flow drop tools). Whether this token is accepted for the
// drops GQL + claims is the maintainer spike called out in the epic.
const DEVICE_ENDPOINT = "https://id.twitch.tv/oauth2/device";
const TOKEN_ENDPOINT = "https://id.twitch.tv/oauth2/token";
export const SMARTTV_CLIENT_ID = "ue6666qo983tsx6so1t0vnawi233wa";
const SCOPES = "user:read:follows channel:read:subscriptions";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function requestDeviceCode(clientId = SMARTTV_CLIENT_ID): Promise<DeviceCode> {
  const response = await fetch(DEVICE_ENDPOINT, {
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

// Polls the token endpoint until the user authorizes (or the code expires).
// `authorization_pending` is the normal wait state; back off on `slow_down`.
export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  clientId = SMARTTV_CLIENT_ID,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let intervalMs = intervalSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = (await response.json()) as TokenResponse;
    if (data.access_token) return data.access_token;
    if (data.message === "authorization_pending" || data.error === "authorization_pending") continue;
    if (data.message === "slow_down" || data.error === "slow_down") { intervalMs += 5000; continue; }
    throw new Error(`Device authorization failed: ${data.message ?? data.error ?? "unknown error"}`);
  }
  throw new Error("Device code expired before authorization");
}

export async function twitchDeviceLogin(authDir: string, logger: Logger, clientId = SMARTTV_CLIENT_ID): Promise<void> {
  const code = await requestDeviceCode(clientId);
  logger.info(`Open ${code.verification_uri} and enter code: ${code.user_code}`, "login");
  logger.info(`Waiting for authorization (expires in ${Math.round(code.expires_in / 60)} min)…`, "login");
  const accessToken = await pollForToken(code.device_code, code.interval, code.expires_in, clientId);
  saveCredentials(authDir, { twitch: { authToken: accessToken, clientId } });
  logger.info("Twitch device login complete; token saved", "login");
}
