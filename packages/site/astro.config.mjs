// @ts-check
import { appendFile, writeFile } from "node:fs/promises";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { GUIDE_SECTIONS } from "./src/guide.ts";
import tailwindcss from "@tailwindcss/vite";

const deploymentChannel = process.env.SITE_DEPLOYMENT_CHANNEL ?? "production";

if (!new Set(["prerelease", "production"]).has(deploymentChannel)) {
  throw new Error(`Unsupported site deployment channel: ${deploymentChannel}`);
}

// Starlight adds its own sitemap unless one is already configured. Prerelease
// builds have none (they are not indexed), so this stands in for it there.
/** @type {import("astro").AstroIntegration} */
const noSitemap = { name: "@astrojs/sitemap", hooks: {} };

// The user guide at /guide. Starlight renders it inside the site's own header,
// colours and type (src/components/guide/, src/styles/guide.css), and gives it
// search, collapsible sections, "On this page" lists and copyable code blocks.
const guide = starlight({
  title: "Lurkloot Guide",
  titleDelimiter: "—",
  description: "How to set up and use Lurkloot, the Twitch and Kick drops farmer.",
  favicon: "/favicon.svg",
  disable404Route: true,
  credits: false,
  editLink: {
    baseUrl: "https://github.com/jamezrin/lurkloot/edit/develop/packages/site/",
  },
  customCss: ["./src/styles/guide.css"],
  routeMiddleware: "./src/guideRouteData.ts",
  components: {
    Header: "./src/components/guide/Header.astro",
    PageTitle: "./src/components/guide/PageTitle.astro",
    Footer: "./src/components/guide/Footer.astro",
    MobileMenuFooter: "./src/components/guide/MobileMenuFooter.astro",
    ThemeProvider: "./src/components/guide/ThemeProvider.astro",
    ThemeSelect: "./src/components/guide/Empty.astro",
  },
  sidebar: [
    { label: "Guide home", link: "/guide/" },
    ...GUIDE_SECTIONS.map((section) => ({
      label: section.title,
      collapsed: true,
      items: [{ autogenerate: { directory: `guide/${section.id}` } }],
    })),
  ],
  expressiveCode: {
    themes: ["github-dark-default"],
    styleOverrides: {
      borderRadius: "10px",
      borderColor: "rgb(255 255 255 / 15%)",
      codeBackground: "#0d0d0d",
      codeFontFamily: '"Geist Mono Variable", ui-monospace, monospace',
      codeFontSize: "13.5px",
      codeLineHeight: "1.7",
      uiFontFamily: '"Geist Variable", system-ui, sans-serif',
      frames: {
        frameBoxShadowCssValue: "none",
        editorBackground: "#0d0d0d",
        editorTabBarBackground: "#111",
        editorActiveTabBackground: "#0d0d0d",
        editorActiveTabIndicatorTopColor: "transparent",
        terminalBackground: "#0d0d0d",
        terminalTitlebarBackground: "#111",
        terminalTitlebarBorderBottomColor: "rgb(255 255 255 / 9%)",
        terminalTitlebarDotsOpacity: "0.35",
        inlineButtonBorder: "rgb(255 255 255 / 15%)",
        inlineButtonForeground: "#a1a1a1",
        tooltipSuccessBackground: "#ededed",
        tooltipSuccessForeground: "#000",
      },
    },
  },
});

/** @type {import("astro").AstroIntegration} */
const deploymentFiles = {
  name: "lurkloot-deployment-files",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      if (deploymentChannel !== "prerelease") return;

      await writeFile(new URL("robots.txt", dir), "User-agent: *\nDisallow: /\n");
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
    deploymentChannel === "production" ? sitemap() : noSitemap,
    guide,
    deploymentFiles,
  ],
  build: {
    inlineStylesheets: "auto",
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
