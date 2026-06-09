// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Deployed to Cloudflare Pages on a root custom domain. `site` drives canonical
// URLs and the sitemap; the base stays at "/" (root domain, no sub-path).
export default defineConfig({
  site: "https://stream-autopilot.jamezrin.com",
  trailingSlash: "ignore",
  integrations: [sitemap()],
  build: {
    inlineStylesheets: "auto",
  },
});
