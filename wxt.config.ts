import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    build: {
      sourcemap: false,
    },
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: "Stream Autopilot",
    description:
      "Farm Twitch and Kick drops through normal browser sessions, visible muted tabs, and optional low-resource mode.",
    permissions: ["alarms", "storage", "tabs", "scripting", "notifications", "cookies", "webRequest"],
    host_permissions: [
      "https://www.twitch.tv/*",
      "https://gql.twitch.tv/*",
      "https://kick.com/*",
      "https://web.kick.com/*",
      "https://websockets.kick.com/*"
    ],
    icons: {
      "16": "icon/16.png",
      "32": "icon/32.png",
      "48": "icon/48.png",
      "128": "icon/128.png"
    },
    action: {
      default_title: "Stream Autopilot",
      default_icon: {
        "16": "icon/16.png",
        "32": "icon/32.png"
      }
    },
    browser_specific_settings: {
      gecko: {
        id: "stream-autopilot@jamezrin.name",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["none"]
        }
      }
    }
  },
  zip: {
    sourcesRoot: ".",
    artifactTemplate: "{{name}}-{{version}}-{{browser}}.zip",
    sourcesTemplate: "{{name}}-{{version}}-sources.zip",
  }
});
