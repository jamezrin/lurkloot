function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "unknown Twitch host";
  } catch {
    return "unknown Twitch host";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown network error";
}

export async function twitchHeartbeatFetchText(url: string, init?: RequestInit): Promise<string> {
  const hostname = safeHostname(url);
  try {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    throw new Error(`Twitch Spade destination fetch failed for ${hostname}: ${errorMessage(error)}`);
  }
}

export async function twitchHeartbeatPost(url: string, init: RequestInit): Promise<{ status: number }> {
  const hostname = safeHostname(url);
  try {
    const response = await fetch(url, init);
    return { status: response.status };
  } catch (error) {
    throw new Error(`Twitch Spade heartbeat POST failed for ${hostname}: ${errorMessage(error)}`);
  }
}
