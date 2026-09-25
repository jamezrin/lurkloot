// Render the social card with local assets: no external fonts or network.
// From repo root: pnpm --filter @lurkloot/site exec node scripts/make-og.mjs
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Reuse the browser tooling already maintained by the extension's capture scripts.
const { chromium } = createRequire(new URL("../../extension/package.json", import.meta.url))("playwright");
const require = createRequire(import.meta.url);
const fontFile = require.resolve("@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2");
const font = (await readFile(fontFile)).toString("base64");
const logo = await readFile(new URL("../src/assets/logo-mono.svg", import.meta.url), "utf8");
const out = resolve(import.meta.dirname, "../public/og.png");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Archivo; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 900; }
* { margin: 0; box-sizing: border-box; }
body { width: 1200px; height: 630px; padding: 48px 64px; background: #101010; color: #f5f5f5; font-family: Archivo, sans-serif; }
header { display: flex; align-items: center; gap: 12px; font-size: 26px; font-weight: 650; letter-spacing: -1px; padding-bottom: 28px; border-bottom: 1px solid #383838; }
header svg { width: 38px; height: 38px; }
h1 { font-size: 96px; line-height: 1.03; letter-spacing: -6px; font-weight: 650; margin-top: 45px; }
h1 span { color: #a6a6a6; }
p { color: #aaa; font-size: 23px; margin-top: 27px; }
footer { display: flex; justify-content: space-between; border-top: 1px solid #383838; margin-top: 42px; padding-top: 22px; font-size: 16px; }
footer span:last-child { color: #aaa; }
</style></head><body><header>${logo}Lurkloot</header>
<h1>Your drops.<br><span>On autopilot.</span></h1>
<p>Automatic rewards on Twitch + Kick. Supports selected Twitch extensions.</p>
<footer><span>Less watching. More rewards.</span><span>Free &amp; open source.</span></footer>
</body></html>`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
}
