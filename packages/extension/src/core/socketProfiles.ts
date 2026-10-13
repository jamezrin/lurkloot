import { TWITCH_IRC_CLIENT_COMMANDS } from "@lurkloot/core/twitch/chatPresence";
import { twitchExtensionProvider } from "@lurkloot/core/extensions/registry";
import type { Platform } from "@lurkloot/shared/models";
import { KICK_SOCKET_ORIGIN, PUSHER_SOCKET_ORIGIN, TWITCH_SOCKET_ORIGIN } from "./platformHosts";

// The platform sockets the extension may open, each with the host permission
// its Origin rewrite needs and the frames it forwards (#792). The socket host
// opens these URLs and nothing else.
export type SocketProfileName = "twitch-hermes" | "twitch-irc" | "kick-realtime" | "kick-pusher" | "kick-viewer" | "fortnite";

export interface SocketProfile {
  name: SocketProfileName;
  platform: Platform;
  // The wss:// host permission the Origin rewrite needs.
  permission: string;
}

const PROFILES: Array<SocketProfile & { url: RegExp }> = [
  { name: "twitch-hermes", platform: "twitch", permission: TWITCH_SOCKET_ORIGIN, url: /^wss:\/\/hermes\.twitch\.tv\/v1\?clientId=[a-z0-9]+$/i },
  { name: "twitch-irc", platform: "twitch", permission: TWITCH_SOCKET_ORIGIN, url: /^wss:\/\/irc-ws\.chat\.twitch\.tv\/$/i },
  { name: "kick-realtime", platform: "kick", permission: KICK_SOCKET_ORIGIN, url: /^wss:\/\/realtime\.[a-z0-9-]+\.platform\.kick\.com\/connection\/websocket$/i },
  { name: "kick-pusher", platform: "kick", permission: PUSHER_SOCKET_ORIGIN, url: /^wss:\/\/ws-[a-z0-9-]+\.pusher\.com\/app\/[a-z0-9]+\?[^#\s]*$/i },
  { name: "kick-viewer", platform: "kick", permission: KICK_SOCKET_ORIGIN, url: /^wss:\/\/websockets\.kick\.com\/viewer\/v1\/connect\?token=[^#\s&]+$/i },
  // The Fortnite Twitch Extension's backend (#798). Its driver reads every
  // frame (replies to its own commands, state pushes), so nothing is dropped.
  { name: "fortnite", platform: "twitch", permission: twitchExtensionProvider("fortnite")!.backendSocketOrigin!, url: /^wss:\/\/backend\.p-n6412w7dsu\.exmggames\.com\/handler$/i },
];

export function socketProfileFor(url: string): SocketProfile | undefined {
  const match = PROFILES.find((profile) => profile.url.test(url));
  return match ? { name: match.name, platform: match.platform, permission: match.permission } : undefined;
}

// What the host forwards of a socket frame, decided by prefix and unparsed,
// or undefined to forward nothing. Chat is dropped here, so busy chats never
// wake the worker.
export function forwardedFrame(profile: SocketProfileName, data: string): string | undefined {
  if (profile === "twitch-irc") return forwardedIrc(data);
  if (profile === "kick-realtime") return forwardedCentrifugo(data);
  if (profile === "kick-pusher") return PUSHER_FORWARDED_EVENT.test(data) ? data : undefined;
  return data;
}

// IRC: only the commands chat presence reads; never PRIVMSG and the rest of
// the chat traffic.
function forwardedIrc(data: string): string | undefined {
  const kept = data.split("\r\n").filter((line) => {
    const command = ircCommand(line);
    return command !== undefined && TWITCH_IRC_CLIENT_COMMANDS.has(command);
  });
  return kept.length > 0 ? kept.map((line) => `${line}\r\n`).join("") : undefined;
}

function ircCommand(line: string): string | undefined {
  let rest = line;
  for (const marker of ["@", ":"]) {
    if (!rest.startsWith(marker)) continue;
    const space = rest.indexOf(" ");
    if (space < 0) return undefined;
    rest = rest.slice(space + 1);
  }
  return rest.split(" ", 1)[0] || undefined;
}

// Centrifugo: every line but a "push" on a channel other than drops_*.
// Drop channels are forwarded for discovery signals (#755).
function forwardedCentrifugo(data: string): string | undefined {
  const kept = data.split("\n").filter((line) => line.length > 0
    && (!line.startsWith("{\"push\"") || line.startsWith(CENTRIFUGO_FORWARDED_PUSH)));
  return kept.length > 0 ? kept.join("\n") : undefined;
}
const CENTRIFUGO_FORWARDED_PUSH = "{\"push\":{\"channel\":\"drops_";
// Pusher: its own protocol frames and Kick's plain snake_case events
// (drops_campaign_started); chat events are named App\Events\…
const PUSHER_FORWARDED_EVENT = /^\{"event":"(?:pusher[a-z_]*:[a-z_]+|[a-z0-9_]+)"/;
