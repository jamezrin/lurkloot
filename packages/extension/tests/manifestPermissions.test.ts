import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KASADA_COOKIE_URL } from "../src/core/cliCredentialExport";
import {
  KICK_HOST_ORIGIN,
  KICK_SOCKET_ORIGIN,
  PLATFORM_IVS_ORIGIN,
  PUSHER_SOCKET_ORIGIN,
  TWITCH_CDN_ORIGIN,
  TWITCH_EXTENSION_HOST_ORIGIN,
  TWITCH_HOST_ORIGIN,
  TWITCH_SOCKET_ORIGIN,
  TWITCH_STATIC_CDN_ORIGIN,
} from "../src/core/platformHosts";
import { TWITCH_HLS_HOST_ORIGIN } from "../src/core/twitchHlsPermission";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../wxt.config.ts"), "utf8");

describe("extension host permissions", () => {
  it("requires Twitch, Kick and platform CDN hosts, with no Kasada-only optional host", () => {
    const required = source.match(/(?<!optional_)host_permissions:\s*\[([\s\S]*?)\]/)?.[1] ?? "";

    expect(required).toContain("TWITCH_HOST_ORIGIN");
    expect(required).toContain("KICK_HOST_ORIGIN");
    expect(required).toContain("TWITCH_HLS_HOST_ORIGIN");
    expect(required).toContain("TWITCH_STATIC_CDN_ORIGIN");
    expect(required).toContain("TWITCH_CDN_ORIGIN");
    expect(required).toContain("PLATFORM_IVS_ORIGIN");
    expect(required).toContain("TWITCH_EXTENSION_HOST_ORIGIN");
    expect(required).toContain("TWITCH_SOCKET_ORIGIN");
    expect(required).toContain("KICK_SOCKET_ORIGIN");
    expect(required).toContain("PUSHER_SOCKET_ORIGIN");
    expect(required).not.toContain('"https://');
    expect(source).not.toMatch(/optional_host_permissions:\s*\[[^\]]*KASADA/);
    expect(source).not.toContain("optional_permissions:");
  });

  it("rewrites request headers only through host-scoped declarativeNetRequest", () => {
    expect(source).toContain('"declarativeNetRequestWithHostAccess"');
    expect(source).not.toMatch(/"declarativeNetRequest"/);
    // Firefox only: its rules skip the background page's sockets (#792).
    expect(source).toContain('...(browser === "firefox" ? ["webRequestBlocking"] : ["offscreen"])');
  });

  it("scopes the in-page panel to the Twitch and Kick host wildcards", () => {
    expect(source).toContain("matches: [TWITCH_HOST_ORIGIN, KICK_HOST_ORIGIN]");
  });

  it("names the Kasada cookie host under the required Twitch CDN wildcard", () => {
    expect(KASADA_COOKIE_URL).toBe("https://k.twitchcdn.net");
    expect(TWITCH_CDN_ORIGIN).toBe("https://*.twitchcdn.net/*");
  });

  it("names the required platform host patterns", () => {
    expect(TWITCH_HOST_ORIGIN).toBe("https://*.twitch.tv/*");
    expect(KICK_HOST_ORIGIN).toBe("https://*.kick.com/*");
    expect(TWITCH_HLS_HOST_ORIGIN).toBe("https://*.ttvnw.net/*");
    expect(TWITCH_STATIC_CDN_ORIGIN).toBe("https://*.jtvnw.net/*");
    expect(TWITCH_CDN_ORIGIN).toBe("https://*.twitchcdn.net/*");
    expect(PLATFORM_IVS_ORIGIN).toBe("https://*.live-video.net/*");
    expect(TWITCH_EXTENSION_HOST_ORIGIN).toBe("https://*.ext-twitch.tv/*");
    expect(TWITCH_SOCKET_ORIGIN).toBe("wss://*.twitch.tv/*");
    expect(KICK_SOCKET_ORIGIN).toBe("wss://*.kick.com/*");
    expect(PUSHER_SOCKET_ORIGIN).toBe("wss://*.pusher.com/*");
  });
});
