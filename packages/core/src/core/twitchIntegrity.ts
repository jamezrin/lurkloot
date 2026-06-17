// Twitch's authenticated GQL mutations (notably DropsPage_ClaimDropRewards)
// require a valid `Client-Integrity` token. A token cannot be reliably minted
// from the background — Twitch's /integrity endpoint returns a "bad bot" token
// without the page's Kasada proof-of-work — so instead we capture the token the
// live twitch.tv page already sends on its own GQL requests (via webRequest in
// the background) and replay it. The token is bound to the Client-ID +
// X-Device-Id + Client-Session-Id it was minted with, so the whole trio is
// captured and replayed together.

export interface TwitchIntegrity {
  integrity: string;
  clientSessionId?: string;
  deviceId?: string;
  expiresAt: number; // epoch ms
}

export interface IntegrityHeader {
  name: string;
  value?: string;
}

// Build an integrity bundle from a webRequest `requestHeaders` array, or return
// undefined when the request carries no Client-Integrity header — that filters
// out our own background fetch and anonymous public queries, which never do.
export function integrityFromHeaders(headers: IntegrityHeader[] | undefined): TwitchIntegrity | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined =>
    headers.find((header) => header.name.toLowerCase() === name)?.value;
  const integrity = get("client-integrity");
  if (!integrity) return undefined;
  return {
    integrity,
    clientSessionId: get("client-session-id"),
    deviceId: get("x-device-id"),
    expiresAt: integrityExpiry(integrity),
  };
}

const FALLBACK_TTL_MS = 30 * 60 * 1000;

// The Client-Integrity token is a JWT whose payload carries an `exp` (epoch
// seconds). Decode it for a precise expiry; fall back to a conservative window
// when the token is opaque or unparseable so a malformed token still ages out.
export function integrityExpiry(token: string, now: number = Date.now()): number {
  const exp = decodeJwtExp(token);
  return exp != null ? exp * 1000 : now + FALLBACK_TTL_MS;
}

function decodeJwtExp(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(base64UrlDecode(payload)) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}
