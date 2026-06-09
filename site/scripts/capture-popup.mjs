// Captures clean, retina popup screenshots (just the 400x600 popup shell, no
// store marketing frame) for the landing-page gallery. Reuses the extension's
// screenshot mode (?screenshot=store&variant=<id>) but clips to the popup
// <main> element instead of the 1280x800 store canvas.
//
// Usage: pnpm build (in repo root) first, then:
//   node site/scripts/capture-popup.mjs
// Writes PNGs into site/src/assets/screenshots/.
import { createServer } from "node:http";
import { mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const buildRoot = resolve(repoRoot, ".output/chrome-mv3");
const outputDir = resolve(import.meta.dirname, "..", "src/assets/screenshots");
const candidates = ["popup.html", "popup/index.html"];

// Each variant frames a different view; ids match SCREENSHOT_VARIANTS in
// entrypoints/popup/main.tsx. Switching platform to "kick" is driven by the
// variant, so we get an authentic Kick view too.
const variants = [
  { id: "twitch-drops", file: "drops-twitch" },
  { id: "kick-drops", file: "drops-kick" },
  { id: "watch-queue", file: "watch-queue" },
  { id: "settings", file: "settings" },
  { id: "activity", file: "activity" },
];

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findPopupPath() {
  for (const candidate of candidates) {
    if (await fileExists(join(buildRoot, candidate))) return `/${candidate}`;
  }
  throw new Error(`No built popup HTML in ${buildRoot}. Run \`pnpm build\` in the repo root first.`);
}

function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const filePath = join(buildRoot, decodeURIComponent(url.pathname));
    if (!(await fileExists(filePath))) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" });
    createReadStream(filePath).pipe(response);
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

const popupPath = await findPopupPath();
const { server, origin } = await startServer();

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 480, height: 720 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => {
    globalThis.chrome = {
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      runtime: { getURL: (path) => path, getManifest: () => ({ version: "1.0.0" }) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    };
  });
  await mkdir(outputDir, { recursive: true });
  for (const variant of variants) {
    await page.goto(`${origin}${popupPath}?screenshot=store&variant=${variant.id}&locale=en`, { waitUntil: "networkidle" });
    await page.waitForSelector('header img[alt="Stream Autopilot"]');
    await page.waitForFunction(() => {
      const heading = document.querySelector("h1");
      return Boolean(heading?.textContent) && !heading.textContent.startsWith("screenshot");
    });
    // Clip to the popup shell itself (the 400x600 <main>), skipping the store frame.
    const popup = page.locator('main[data-platform]').first();
    await popup.waitFor({ state: "visible" });
    const outputPath = join(outputDir, `${variant.file}.png`);
    await popup.screenshot({ path: outputPath });
    console.log(`Wrote ${outputPath}`);
  }
  await browser.close();
} finally {
  server.close();
}
