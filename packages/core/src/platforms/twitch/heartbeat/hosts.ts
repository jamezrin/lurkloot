export function isAllowedTwitchUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && (hostname === "twitch.tv" || hostname.endsWith(".twitch.tv"));
  } catch {
    return false;
  }
}
