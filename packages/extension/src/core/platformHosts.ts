// Required first-party platform hosts. Declared as host_permissions so farming
// paths that need them do not force later install-time privilege escalations
// (#786 for HLS; the CDN/IVS/extension hosts follow the same rule).

/** Twitch site, GQL, Spade, Hermes, and other first-party `*.twitch.tv` services. */
export const TWITCH_HOST_ORIGIN = "https://*.twitch.tv/*";

/** Kick site, `web.kick.com`, `websockets.kick.com`, and other first-party services. */
export const KICK_HOST_ORIGIN = "https://*.kick.com/*";

/** Twitch static CDN (campaign art, emotes, box art, thumbnails). */
export const TWITCH_STATIC_CDN_ORIGIN = "https://*.jtvnw.net/*";

/**
 * Twitch CDN used by Kasada (`k.twitchcdn.net`) and related first-party
 * services. Covers the CLI credential export's `KP_UIDz-ssn` cookie read.
 */
export const TWITCH_CDN_ORIGIN = "https://*.twitchcdn.net/*";

/**
 * Amazon IVS. Kick delivers livestream playlists on nested
 * `*.playback.live-video.net` hosts; Twitch's web player also contacts
 * `*.live-video.net` for IVS device configuration.
 */
export const PLATFORM_IVS_ORIGIN = "https://*.live-video.net/*";

/** Twitch Extensions CDN and supervisor (`*.ext-twitch.tv`). */
export const TWITCH_EXTENSION_HOST_ORIGIN = "https://*.ext-twitch.tv/*";

/**
 * WebSocket hosts. A socket's Origin can be rewritten only where the
 * extension holds its `wss://` host, on Chrome and Firefox alike (#792).
 */
export const TWITCH_SOCKET_ORIGIN = "wss://*.twitch.tv/*";
export const KICK_SOCKET_ORIGIN = "wss://*.kick.com/*";

/** Kick's realtime fallback provider, which kick.com opens with its own origin. */
export const PUSHER_SOCKET_ORIGIN = "wss://*.pusher.com/*";
