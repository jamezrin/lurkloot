// @ts-check
import { appendFile, writeFile } from "node:fs/promises";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { localeToPrefix, prefixedLocales } from "./src/i18n/locale.ts";

const deploymentChannel = process.env.SITE_DEPLOYMENT_CHANNEL ?? "production";

if (!new Set(["prerelease", "production"]).has(deploymentChannel)) {
  throw new Error(`Unsupported site deployment channel: ${deploymentChannel}`);
}

/** @type {import("astro").AstroIntegration} */
const deploymentFiles = {
  name: "lurkloot-deployment-files",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      if (deploymentChannel !== "prerelease") return;

      await writeFile(
        new URL("robots.txt", dir),
        "User-agent: *\nDisallow: /\n",
      );
      await appendFile(
        new URL("_headers", dir),
        "\n/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n",
      );
    },
  },
};

// Deployed to Cloudflare Pages on a root custom domain. `site` drives canonical
// URLs and the sitemap; the base stays at "/" (root domain, no sub-path).
export default defineConfig({
  site: "https://lurkloot.jamezrin.com",
  trailingSlash: "ignore",
  integrations: [
    react(),
    ...(deploymentChannel === "production"
      ? [
        sitemap({
          filter(page) {
            const path = new URL(page).pathname;
            return !prefixedLocales().some((locale) => {
              const prefix = localeToPrefix(locale);
              return path === `/${prefix}` || path.startsWith(`/${prefix}/`);
            });
          },
        }),
      ]
      : []),
    deploymentFiles,
  ],
  build: {
    inlineStylesheets: "auto",
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
