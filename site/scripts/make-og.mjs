// Renders the Open Graph / Twitter social card to site/public/og.png (1200x630).
// Run after assets exist: node site/scripts/make-og.mjs
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const here = import.meta.dirname;
const logo = await readFile(resolve(here, "..", "src/assets/logo-ring.svg"), "utf8");
const out = resolve(here, "..", "public/og.png");

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin:0; box-sizing:border-box; }
  body { width:1200px; height:630px; overflow:hidden; font-family:'Bricolage Grotesque',sans-serif;
    background:#060609; color:#ecedf5; position:relative; }
  .bg { position:absolute; inset:0;
    background-image:
      radial-gradient(700px 460px at 8% -10%, rgba(145,71,255,0.4), transparent 60%),
      radial-gradient(620px 420px at 100% 8%, rgba(83,252,24,0.22), transparent 55%),
      linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
    background-size:100% 100%,100% 100%,48px 48px,48px 48px; }
  .pad { position:relative; padding:74px 80px; height:100%; display:flex; flex-direction:column; justify-content:space-between; }
  .top { display:flex; align-items:center; gap:20px; }
  .logo { width:74px; height:74px; border-radius:18px; overflow:hidden; box-shadow:0 12px 40px -8px rgba(145,71,255,0.6); }
  .logo svg { width:100%; height:100%; display:block; }
  .brand { font-size:34px; font-weight:700; letter-spacing:-0.02em; }
  h1 { font-size:92px; line-height:0.98; letter-spacing:-0.04em; max-width:18ch; }
  .grad { background:linear-gradient(100deg,#c4a7ff,#b7ff6a); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .row { display:flex; align-items:center; justify-content:space-between; }
  .pills { display:flex; gap:14px; font-family:'Geist Mono',monospace; font-size:21px; color:#9c9db4; }
  .pill { display:flex; align-items:center; gap:9px; }
  .dot { width:11px; height:11px; border-radius:50%; background:#53fc18; box-shadow:0 0 12px rgba(83,252,24,0.7); }
  .url { font-family:'Geist Mono',monospace; font-size:22px; color:#6b6c84; letter-spacing:0.04em; }
</style></head>
<body><div class="bg"></div><div class="pad">
  <div class="top"><span class="logo">${logo}</span><span class="brand">Stream Autopilot</span></div>
  <h1>Farm Twitch &amp; Kick drops on <span class="grad">autopilot</span>.</h1>
  <div class="row">
    <div class="pills">
      <span class="pill"><span class="dot"></span>No password</span>
      <span class="pill"><span class="dot"></span>Auto-claim</span>
      <span class="pill"><span class="dot"></span>Open source</span>
    </div>
    <span class="url">chrome &middot; firefox</span>
  </div>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
console.log(`Wrote ${out}`);
