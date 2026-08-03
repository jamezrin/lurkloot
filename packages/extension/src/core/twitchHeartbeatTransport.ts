import { isHeartbeatTimeoutError, withHeartbeatTimeout } from "@lurkloot/core/twitch/heartbeat";

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "unknown Twitch host";
  } catch {
    return "unknown Twitch host";
  }
}

function safeErrorCause(error: unknown): string {
  // Reported verbatim: it names no URL, and "we gave up after 15s" is the one
  // cause a user can act on — a DNS filter blackholing the host looks like an
  // ordinary network failure otherwise.
  if (isHeartbeatTimeoutError(error)) return error.message;
  if (!(error instanceof Error)) return "unknown network error";
  if (error.message === "Failed to fetch" || /^HTTP \d{3}$/.test(error.message)) {
    return error.message;
  }
  return "network request failed";
}

export async function twitchHeartbeatFetchText(url: string, init?: RequestInit): Promise<string> {
  const hostname = safeHostname(url);
  try {
    const response = await withHeartbeatTimeout(
      (signal) => fetch(url, { ...init, signal }),
      init?.signal,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    throw new Error(`Twitch Spade destination fetch failed for ${hostname}: ${safeErrorCause(error)}`);
  }
}

export async function twitchHeartbeatPost(url: string, init: RequestInit): Promise<{ status: number }> {
  const hostname = safeHostname(url);
  try {
    const response = await withHeartbeatTimeout(
      (signal) => fetch(url, { ...init, signal }),
      init.signal,
    );
    return { status: response.status };
  } catch (error) {
    throw new Error(`Twitch Spade heartbeat POST failed for ${hostname}: ${safeErrorCause(error)}`);
  }
}
