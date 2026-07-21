function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "unknown Twitch host";
  } catch {
    return "unknown Twitch host";
  }
}

function safeErrorCause(error: unknown): string {
  if (!(error instanceof Error)) return "unknown network error";
  if (error.message === "Failed to fetch" || /^HTTP \d{3}$/.test(error.message)) {
    return error.message;
  }
  return "network request failed";
}

export async function twitchHeartbeatFetchText(url: string, init?: RequestInit): Promise<string> {
  const hostname = safeHostname(url);
  try {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    throw new Error(`Twitch Spade destination fetch failed for ${hostname}: ${safeErrorCause(error)}`);
  }
}

export async function twitchHeartbeatPost(url: string, init: RequestInit): Promise<{ status: number }> {
  const hostname = safeHostname(url);
  try {
    const response = await fetch(url, init);
    return { status: response.status };
  } catch (error) {
    throw new Error(`Twitch Spade heartbeat POST failed for ${hostname}: ${safeErrorCause(error)}`);
  }
}
