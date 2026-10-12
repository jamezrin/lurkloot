// Twitch's video CDN. Playlist and segment hosts are nested ttvnw.net names,
// outside the twitch.tv grant. Required: the HLS watch heartbeat, the default,
// requests playlist and segment headers from it.
export const TWITCH_HLS_HOST_ORIGIN = "https://*.ttvnw.net/*";
