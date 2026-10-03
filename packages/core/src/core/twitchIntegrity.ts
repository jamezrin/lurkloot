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
  // Set when expiresAt is OPAQUE_INTEGRITY_CEILING_MS after capture rather
  // than an expiry the token declared.
  expiryUnknown?: true;
}

// A host refresh request. The extension may satisfy this through a managed
// page context; the CLI satisfies it through Node's web-integrity minter.
export interface TwitchIntegrityRequest {
  forceRefresh?: boolean;
  // Stops this caller waiting. An acquisition it started is shared and keeps
  // running; only cancelAcquisition stops that.
  signal?: AbortSignal;
  reason?: "readiness" | "proactive_refresh" | "rejection_recovery";
  onManagedPageContextOpen?: () => void | Promise<void>;
  onIntegrityCaptured?: (value: TwitchIntegrity) => void;
  rejectedToken?: string;
}

export interface IntegrityHeader {
  name: string;
  value?: string;
}

// Build an integrity bundle from a webRequest `requestHeaders` array, or return
// undefined when the request carries no Client-Integrity header, as anonymous
// public queries never do. The background's own requests replay the captured
// token, so the caller filters those out by their source.
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
    ...integrityExpiryFields(integrity),
  };
}

// Twitch's web Client-Integrity token is PASETO v4.local: its claims are
// encrypted with a key only Twitch holds, so the token cannot tell us when it
// expires. Twitch's /integrity response says, and the CLI's mint reads it, but
// webRequest cannot read response bodies. So a token whose expiry cannot be
// read is kept until Twitch rejects it, when rejection recovery mints a
// replacement, or at most for this long, so one nothing rejects still ages
// out (#720). It is a ceiling, not an estimate. Readiness mints whenever the
// local token has lapsed, so a value near the 2–3 hours after which Twitch has
// been seen to reject tokens would open a twitch.tv tab on a timer.
export const OPAQUE_INTEGRITY_CEILING_MS = 12 * 60 * 60 * 1000;

// A token that is a JWT carries an `exp` (epoch seconds) to decode.
export function integrityExpiry(token: string, now: number = Date.now()): number {
  return integrityExpiryFields(token, now).expiresAt;
}

function integrityExpiryFields(token: string, now: number = Date.now()): Pick<TwitchIntegrity, "expiresAt" | "expiryUnknown"> {
  const exp = decodeJwtExp(token);
  return exp != null
    ? { expiresAt: exp * 1000 }
    : { expiresAt: now + OPAQUE_INTEGRITY_CEILING_MS, expiryUnknown: true };
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
