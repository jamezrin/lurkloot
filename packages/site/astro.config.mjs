// @ts-check
import { appendFile, writeFile } from "node:fs/promises";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

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

      await writeFile(new URL("robots.txt", dir), "User-agent: *\nDisallow: /\n");
      await appendFile(
        new URL("_headers", dir),
        "\n/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n",
      );
    },
  },
};

// Names shown in a code block's header, by Markdown fence language.
const codeLanguageLabels = {
  bash: "Terminal",
  sh: "Terminal",
  shell: "Terminal",
  powershell: "PowerShell",
  json: "JSON",
  jsonc: "JSON",
  nginx: "nginx",
};

/**
 * Wraps each highlighted Markdown code block in a frame with its language and
 * a Copy button. The button starts hidden and the guide page's script reveals
 * it, so a page without JavaScript shows no dead button.
 * @type {import("shiki").ShikiTransformer}
 */
const codeFrame = {
  name: "lurkloot-code-frame",
  root(root) {
    const lang = this.options.lang;
    const label = codeLanguageLabels[lang] ?? lang.toUpperCase();
    return {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "div",
          properties: { className: ["code-frame"], "data-language": lang },
          children: [
            {
              type: "element",
              tagName: "div",
              properties: { className: ["code-frame-bar"] },
              children: [
                {
                  type: "element",
                  tagName: "span",
                  properties: { className: ["code-frame-label"] },
                  children: [{ type: "text", value: label }],
                },
                {
                  type: "element",
                  tagName: "button",
                  properties: {
                    type: "button",
                    className: ["code-copy"],
                    hidden: true,
                    "data-code-copy": "",
                    "aria-label": `Copy ${label} code`,
                  },
                  children: [{ type: "text", value: "Copy" }],
                },
              ],
            },
            ...root.children,
          ],
        },
      ],
    };
  },
};

// Deployed to Cloudflare Pages on a root custom domain. `site` drives canonical
// URLs and the sitemap; the base stays at "/" (root domain, no sub-path).
export default defineConfig({
  site: "https://lurkloot.jamezrin.com",
  trailingSlash: "ignore",
  integrations: [
    react(),
    ...(deploymentChannel === "production" ? [sitemap()] : []),
    deploymentFiles,
  ],
  build: {
    inlineStylesheets: "auto",
  },
  markdown: {
    shikiConfig: {
      theme: "github-dark-default",
      transformers: [codeFrame],
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
