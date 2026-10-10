function isHttpsHost(rawUrl: string, allowed: (hostname: string) => boolean): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && allowed(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedTwitchUrl(rawUrl: string): boolean {
  return isHttpsHost(rawUrl, (hostname) => hostname === "twitch.tv" || hostname.endsWith(".twitch.tv"));
}

// Playlist and segment URLs come from Twitch's video CDN, not twitch.tv.
// Signed query strings authorize the request; the host check stops a playlist
// from sending them anywhere else.
export function isAllowedHlsUrl(rawUrl: string): boolean {
  return isHttpsHost(rawUrl, (hostname) => hostname === "ttvnw.net" || hostname.endsWith(".ttvnw.net"));
}
