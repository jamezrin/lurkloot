import type { TwitchExtensionProviderDescriptor } from "@lurkloot/core/extensions/types";

// Reduced from Twitch's shipped CoordinatorExtensionsForChannel query. This is
// a selected-channel session read, not the public/batched discovery primitive.
export const TWITCH_EXTENSION_SESSION_QUERY = `
query CoordinatorExtensionsForChannel($channelID: ID!) {
  user(id: $channelID) {
    channel {
      selfInstalledExtensions {
        installation {
          extension { id version }
          activationConfig { state }
        }
        token { jwt }
      }
    }
  }
}`;

export type TwitchExtensionSessionOutcome = "ready" | "unavailable" | "auth-required"
  | "expired" | "compatibility-error" | "transport-error" | "provider-error" | "cancelled";

export interface SessionSource {
  query(query: string, variables: Record<string, string>, signal?: AbortSignal): Promise<unknown>;
  hasSession(): Promise<boolean>;
  now(): number;
}
export interface DriverSession {
  readonly jwt: string;
  readonly expiresAt: number;
  readonly signal?: AbortSignal;
  readonly channelId: string;
  readonly version: string;
  readonly identityLinked: boolean;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function claimsFor(jwt: string): Record<string, unknown> | undefined {
  if (jwt.length > 16_384) return;
  const segments = jwt.split(".");
  if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return;
  try {
    const payload = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    return object(JSON.parse(atob(payload)));
  } catch { return; }
}

// Credentials stay within the privileged transport/driver call. Only the
// outcome class is returned to the host; no raw GQL result, token, JWT claims,
// driver result or vendor exception may enter snapshots, reports or history.
// Claims are a consistency check, not signature verification: Twitch issues
// the token and the provider backend remains responsible for verifying it.
export async function withTwitchExtensionSession(
  source: SessionSource,
  provider: TwitchExtensionProviderDescriptor,
  channelId: string,
  run: (session: DriverSession) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<TwitchExtensionSessionOutcome> {
  if (signal?.aborted) return "cancelled";
  let response: unknown;
  try {
    if (!await source.hasSession()) return "auth-required";
    if (signal?.aborted) return "cancelled";
    response = await source.query(TWITCH_EXTENSION_SESSION_QUERY, { channelID: channelId }, signal);
  } catch { return signal?.aborted ? "cancelled" : "transport-error"; }
  if (signal?.aborted) return "cancelled";
  const envelope = object(response);
  if (!envelope || envelope.errors !== undefined) return "transport-error";
  const channel = object(object(object(envelope.data)?.user)?.channel);
  const rows = channel?.selfInstalledExtensions;
  if (rows === null || !channel) return "unavailable";
  if (!Array.isArray(rows)) return "compatibility-error";
  for (const value of rows) {
    const row = object(value);
    const installation = object(row?.installation);
    const extension = object(installation?.extension);
    if (typeof extension?.id !== "string" || extension.id.split(":")[0] !== provider.extensionId
      || object(installation?.activationConfig)?.state !== "ACTIVE") continue;
    const jwt = object(row?.token)?.jwt;
    if (typeof jwt !== "string") return "compatibility-error";
    const claims = claimsFor(jwt);
    if (!claims || claims.channel_id !== channelId || typeof claims.exp !== "number"
      || !Number.isFinite(claims.exp) || !["viewer", "moderator", "broadcaster"].includes(String(claims.role))
      || typeof extension.version !== "string" || !extension.version) return "compatibility-error";
    if (claims.exp * 1000 <= source.now() + 30_000) return "expired";
    if (typeof claims.opaque_user_id !== "string" || !claims.opaque_user_id.startsWith("U")) return "auth-required";
    try {
      await run({ jwt, expiresAt: claims.exp * 1000, signal, channelId, version: extension.version, identityLinked: typeof claims.user_id === "string" && Boolean(claims.user_id) });
      return signal?.aborted ? "cancelled" : "ready";
    } catch { return signal?.aborted ? "cancelled" : "provider-error"; }
  }
  return "unavailable";
}
