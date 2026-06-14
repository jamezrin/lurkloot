// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Deployed to Cloudflare Pages on a root custom domain. `site` drives canonical
// URLs and the sitemap; the base stays at "/" (root domain, no sub-path).
export default defineConfig({
  site: "https://lurkloot.jamezrin.com",
  trailingSlash: "ignore",
  integrations: [react(), sitemap()],
  build: {
    inlineStylesheets: "auto",
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
