import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { forgetCredentials, saveCredentials } from "../authStore";
import type { Logger } from "../logger";
import { TWITCH_ANDROID_CLIENT_ID } from "../twitch";

// Twitch no longer issues device codes to its Android client, but it still
// completes a normal browser sign-in for it when the redirect is twitch.tv's
// home page: Twitch's OAuth implicit grant puts the token in the redirect's
// URL fragment. An Android token sees the whole drops dashboard without a
// Client-Integrity token, which a Smart TV device-login token does not.
//
// Twitch accepts only `https://www.twitch.tv/` as the redirect for this
// client, so the CLI cannot receive the redirect itself. The user signs in,
// copies the address Twitch sends them to, and pastes it back. The token is
// read from that address, checked with Twitch, and saved; it is never logged.
const AUTHORIZE_ENDPOINT = "https://id.twitch.tv/oauth2/authorize";
const VALIDATE_ENDPOINT = "https://id.twitch.tv/oauth2/validate";
const REDIRECT_URI = "https://www.twitch.tv/";

export function twitchAndroidAuthorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: TWITCH_ANDROID_CLIENT_ID,
    response_type: "token",
    redirect_uri: REDIRECT_URI,
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

// Reads the access token from the pasted redirect address. Accepts the whole
// address (`https://www.twitch.tv/#access_token=…&scope=…`) or just its
// fragment. Twitch reports a refused sign-in as `error` in the fragment.
export function parseTwitchRedirect(input: string): string {
  const text = input.trim();
  if (!text) throw new Error("Nothing was pasted; paste the address Twitch sent you to");
  const hashIndex = text.indexOf("#");
  const fragment = hashIndex >= 0 ? text.slice(hashIndex + 1) : text;
  const params = new URLSearchParams(fragment);
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    throw new Error(`Twitch refused the sign-in: ${description ?? error}`);
  }
  const token = params.get("access_token");
  if (!token || !/^[a-z0-9]+$/i.test(token)) {
    throw new Error(
      "The pasted address has no access_token; copy the full https://www.twitch.tv/#access_token=… address",
    );
  }
  return token;
}

export interface ValidatedTwitchToken {
  clientId: string;
  userId?: string;
  login?: string;
}

interface ValidateResponse {
  client_id?: string;
  user_id?: string;
  login?: string;
  status?: number;
  message?: string;
}

// Confirms the token is live and was issued to the Android client: the GQL
// Client-ID must match the token's client, or Twitch counts no watch time.
export async function validateTwitchAndroidToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidatedTwitchToken> {
  const response = await fetchImpl(VALIDATE_ENDPOINT, {
    headers: { authorization: `OAuth ${token}` },
  });
  const data = (await response.json().catch(() => ({}))) as ValidateResponse;
  if (!response.ok) {
    throw new Error(
      `Twitch rejected the token: HTTP ${response.status}${data.message ? ` ${data.message}` : ""}`,
    );
  }
  if (data.client_id !== TWITCH_ANDROID_CLIENT_ID) {
    throw new Error(
      "That token was not issued by the sign-in link this command printed; open that link and paste the address it ends on",
    );
  }
  return { clientId: data.client_id, userId: data.user_id, login: data.login };
}

// Reads one line from an interactive terminal, or everything piped in.
async function readRedirectInput(): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, "utf8");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question("Paste the address here: ");
  } finally {
    prompt.close();
  }
}

export async function twitchBrowserLogin(
  authDir: string,
  logger: Logger,
  readInput: () => Promise<string> = readRedirectInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  logger.info(
    `Open this link in a browser and sign in to Twitch: ${twitchAndroidAuthorizeUrl()}`,
    "login",
  );
  logger.info(
    "Twitch then sends you to https://www.twitch.tv/#access_token=…. Copy that whole address. If twitch.tv removes the #access_token part before you can copy it, open the browser's developer tools on the Network tab with Preserve log on before signing in, and copy the location header of the id.twitch.tv redirect.",
    "login",
  );
  const token = parseTwitchRedirect(await readInput());
  const validated = await validateTwitchAndroidToken(token, fetchImpl);
  // Replace the stored Twitch login whole: fields left over from a web import
  // (device ID, Kasada cookie) belong to another session and must not linger.
  forgetCredentials(authDir, "twitch");
  saveCredentials(authDir, { twitch: { authToken: token, clientId: validated.clientId } });
  logger.info(
    `Twitch browser login complete${validated.login ? ` for ${validated.login}` : ""}; token saved`,
    "login",
  );
}
