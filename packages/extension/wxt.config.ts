import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
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
} from "./src/core/platformHosts";
import { TWITCH_HLS_HOST_ORIGIN } from "./src/core/twitchHlsPermission";
import { applyProviderOptionalPermissions } from "./src/extensions/manifest";

// Native `_locales` are required by the manifest's localized store listing
// (default_locale + __MSG__). They are not committed; we materialize them from
// the single source of truth, the @lurkloot/locales package, at build time.
const messagesDir = dirname(
  createRequire(import.meta.url).resolve("@lurkloot/locales/messages/en.json"),
);

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  hooks: {
    "build:manifestGenerated"(_wxt, manifest) {
      applyProviderOptionalPermissions(manifest);
    },
    "build:publicAssets"(_wxt, files) {
      for (const file of readdirSync(messagesDir)) {
        if (!file.endsWith(".json")) continue;
        files.push({
          absoluteSrc: join(messagesDir, file),
          relativeDest: `_locales/${basename(file, ".json")}/messages.json`,
        });
      }
    },
  },
  vite: () => ({
    build: {
      sourcemap: false,
    },
    plugins: [tailwindcss()],
  }),
  manifest: ({ browser }) => ({
    default_locale: "en",
    name: "__MSG_extensionStoreName__",
    description: "__MSG_extensionDescription__",
    // declarativeNetRequestWithHostAccess (no install warning; acts only on
    // granted hosts): presents the platform's site Origin on the extension's
    // own platform requests and sockets (platformRequestOrigin.ts).
    // offscreen (Chrome only, no install warning): the socket host, whose
    // worker opens the platform sockets where those rules reach them (#792).
    // webRequestBlocking (Firefox only): Firefox's rules skip the background
    // page's sockets, so a listener sets their Origin (platformSocketOrigin.ts).
    permissions: [
      "alarms",
      "storage",
      "tabs",
      "scripting",
      "notifications",
      "cookies",
      "webRequest",
      "declarativeNetRequestWithHostAccess",
      ...(browser === "firefox" ? ["webRequestBlocking"] : ["offscreen"]),
    ],
    // Optional hosts come only from opted-in Twitch Extension providers
    // (applyProviderOptionalPermissions). Twitch CDN / Kasada is required.
    // Twitch's video CDN carries the HLS watch heartbeat, the default.
    // The static CDN, Twitch CDN (Kasada), Amazon IVS, and Twitch Extensions
    // hosts sit outside *.twitch.tv / *.kick.com and are granted now so a
    // later farming path does not need another privilege escalation.
    host_permissions: [
      TWITCH_HOST_ORIGIN,
      KICK_HOST_ORIGIN,
      TWITCH_HLS_HOST_ORIGIN,
      TWITCH_STATIC_CDN_ORIGIN,
      TWITCH_CDN_ORIGIN,
      PLATFORM_IVS_ORIGIN,
      TWITCH_EXTENSION_HOST_ORIGIN,
      // A socket's Origin can be set only with its wss:// host (#792).
      TWITCH_SOCKET_ORIGIN,
      KICK_SOCKET_ORIGIN,
      PUSHER_SOCKET_ORIGIN,
    ],
    // The in-page panel is an extension page the twitch/kick content scripts
    // embed in an iframe, so its document must be web-accessible. Scoped to the
    // two origins that inject it — never <all_urls>: a listed resource is
    // fetchable, and so fingerprintable, by every origin it is exposed to.
    // Note MV2 (Firefox) has no `matches` field and downlevels this to a flat
    // string array, exposing the page to all origins there.
    web_accessible_resources: [
      {
        resources: ["inpagePanel.html"],
        matches: [TWITCH_HOST_ORIGIN, KICK_HOST_ORIGIN],
      },
    ],
    icons: {
      "16": "icon/16.png",
      "32": "icon/32.png",
      "48": "icon/48.png",
      "128": "icon/128.png",
    },
    action: {
      default_title: "__MSG_extensionName__",
      default_icon: {
        "16": "icon/16.png",
        "32": "icon/32.png",
      },
    },
    browser_specific_settings: {
      gecko: {
        id: "lurkloot@jamezrin.name",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
  }),
  zip: {
    sourcesRoot: ".",
    // WXT 0.21's {{version}} is manifest.version. Release artifact names follow
    // package.json, which is {{packageVersion}}.
    artifactTemplate: "{{name}}-{{packageVersion}}-{{browser}}.zip",
    sourcesTemplate: "{{name}}-{{packageVersion}}-sources.zip",
    // Generated, gitignored outputs (store screenshots/promo tiles) live here;
    // keep them out of the AMO sources zip.
    excludeSources: ["artifacts/**"],
  },
});
