import { isAllowedHlsUrl } from "./hosts";

export type PlaylistKind = "master" | "media";

// Twitch's master playlist lists variants after #EXT-X-STREAM-INF. A media
// playlist lists segments after #EXTINF. Anything else (keys, maps, comments)
// stays on a tag line and is never requested. A URI that shows up without its
// tag, or a tag left hanging at the end, rejects the whole body so a malformed
// master cannot be treated as a list of media files.
export function playlistUrls(body: string, base: string, kind: PlaylistKind): string[] {
  if (!body.trim().startsWith("#EXTM3U")) return [];
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return [];
  }
  if (!isAllowedHlsUrl(baseUrl.href)) return [];

  const tag = kind === "master" ? "#EXT-X-STREAM-INF:" : "#EXTINF:";
  const urls: string[] = [];
  let pending = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (line.startsWith(tag)) pending = true;
      continue;
    }
    if (!pending) return [];
    let resolved: URL;
    try {
      resolved = new URL(line, baseUrl);
    } catch {
      return [];
    }
    if (!isAllowedHlsUrl(resolved.href)) return [];
    if (kind === "master" && !resolved.pathname.endsWith(".m3u8")) return [];
    urls.push(resolved.href);
    pending = false;
  }
  return pending ? [] : urls;
}
