// @ts-check
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Deployed to Cloudflare Pages on a root custom domain. `site` drives canonical
// URLs and the sitemap; the base stays at "/" (root domain, no sub-path).
export default defineConfig({
  site: "https://stream-autopilot.jamezrin.com",
  trailingSlash: "ignore",
  integrations: [react(), sitemap()],
  build: {
    inlineStylesheets: "auto",
  },
  vite: {
    resolve: {
      alias: {
        // The interactive demo imports the real popup, which imports `wxt/browser`.
        // Outside the extension, resolve it to a mock + demo-mode bootstrap.
        "wxt/browser": fileURLToPath(new URL("./src/popup-ui/browser-mock.ts", import.meta.url)),
        // Import extension source (the popup component tree) by repo-root path.
        "@ext": repoRoot.replace(/\/$/, ""),
      },
    },
  },
});
