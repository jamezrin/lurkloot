// Twitch device-code OAuth: a pure-terminal login that needs no browser. The CLI
// shows a short code, the user enters it at the verification URL, and we poll for
// an access token. The token is issued for DEVICE_FLOW_CLIENT_ID, so GQL calls
// made with it must send that same Client-ID (see TwitchAdapter clientId option).
//
// SPIKE: whether the drop-farming GQL operations (and especially claims) succeed
// with this client id — and whether claims then skip the Client-Integrity
// requirement that gates the web client — is the open question this flow exists
// to answer. The client id and scopes are overridable so the spike can probe.

// TwitchDropsMiner's SmartTV/Android client id, known to work with device-code
// OAuth for drop mining.
export const DEVICE_FLOW_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

const DEVICE_ENDPOINT = "https://id.twitch.tv/oauth2/device";
const TOKEN_ENDPOINT = "https://id.twitch.tv/oauth2/token";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceFlowResult {
  accessToken: string;
  clientId: string;
}

export interface DeviceFlowOptions {
  clientId?: string;
  scopes?: string;
  /** Invoked once with the code/URL the user must visit to authorize. */
  onPrompt: (info: DeviceCodeResponse) => void;
}

async function postForm(url: string, params: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Twitch ${url} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  return body;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runTwitchDeviceFlow(options: DeviceFlowOptions): Promise<DeviceFlowResult> {
  const clientId = options.clientId ?? DEVICE_FLOW_CLIENT_ID;
  const scopes = options.scopes ?? "";

  const device = (await postForm(DEVICE_ENDPOINT, { client_id: clientId, scopes })) as DeviceCodeResponse & { message?: string };
  if (!device.device_code || !device.user_code) {
    throw new Error(`Twitch device-code request failed: ${device.message ?? JSON.stringify(device)}`);
  }
  options.onPrompt(device);

  // Guard against a response that omits/garbles expires_in or interval: a NaN
  // interval would make sleep(NaN) resolve immediately and hammer the token
  // endpoint, and a NaN deadline would make the loop exit before polling. Fall
  // back to the OAuth device-flow defaults (5s poll, 600s lifetime).
  const expiresInSec = Number(device.expires_in);
  const intervalSec = Number(device.interval);
  const deadline = Date.now() + (Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 600) * 1000;
  let intervalMs = Math.max(1, Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const token = (await postForm(TOKEN_ENDPOINT, {
      client_id: clientId,
      device_code: device.device_code,
      grant_type: DEVICE_CODE_GRANT,
      scopes,
    })) as { access_token?: string; message?: string; status?: number };

    if (token.access_token) {
      return { accessToken: token.access_token, clientId };
    }
    const message = (token.message ?? "").toLowerCase();
    if (message.includes("authorization_pending") || message.includes("authorization pending")) continue;
    if (message.includes("slow_down") || message.includes("slow down")) {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`Twitch device-code authorization failed: ${token.message ?? JSON.stringify(token)}`);
  }
  throw new Error("Twitch device-code authorization timed out; run `login --twitch-device` again.");
}
