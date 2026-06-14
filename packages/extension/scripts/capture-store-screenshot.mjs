import { createServer } from "node:http";
import { mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(".output/chrome-mv3");
const outputDir = resolve("artifacts/store-screenshots");
const candidates = ["popup.html", "popup/index.html"];

// Each variant is rendered via ?screenshot=store&variant=<id>&locale=<code>
// (see SCREENSHOT_VARIANTS / SCREENSHOT_LOCALE in entrypoints/popup/main.tsx).
// Numeric file prefixes preserve the upload order in the store listing.
const variants = [
  { id: "twitch-drops", file: "01-twitch-drops" },
  { id: "kick-drops", file: "02-kick-drops" },
  { id: "watch-queue", file: "03-watch-queue" },
  { id: "settings", file: "04-settings" },
  { id: "activity", file: "05-activity" },
];

// One screenshot set per store locale. The ids match the _locales/<id> folders
// bundled in the build. A subset can be captured by passing locale codes as CLI
// args, e.g. `node scripts/capture-store-screenshot.mjs es pt_BR`.
const ALL_LOCALES = ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar"];
const requested = process.argv.slice(2);
const locales = requested.length > 0 ? requested.filter((code) => ALL_LOCALES.includes(code)) : ALL_LOCALES;
if (locales.length === 0) {
  throw new Error(`No known locales in: ${requested.join(", ")}. Known: ${ALL_LOCALES.join(", ")}`);
}

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
    const details = await stat(path);
    return details.isFile();
  } catch {
    return false;
  }
}

async function findPopupPath() {
  for (const candidate of candidates) {
    const path = join(root, candidate);
    if (await fileExists(path)) return `/${candidate}`;
  }
  throw new Error(`Could not find a built popup HTML file in ${root}. Run pnpm build first.`);
}

function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestPath = decodeURIComponent(url.pathname === "/" ? "/popup.html" : url.pathname);
    const filePath = resolve(join(root, requestPath));

    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    if (!(await fileExists(filePath))) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine screenshot server port."));
        return;
      }
      resolveServer({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

const popupPath = await findPopupPath();
const { server, origin } = await startServer();

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  // The popup is the real extension UI, so it expects the WebExtension `browser`
  // global (resolved from `chrome`). Served over plain HTTP that global is
  // absent, so provide the minimal surface the popup touches at load/render:
  // i18n + runtime.getURL (used to fetch the localized message catalogs). The
  // mock data and locale come from screenshot mode + the ?locale= param, so
  // getMessage can return "" and let the catalog drive the copy.
  await page.addInitScript(() => {
    globalThis.chrome = {
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      runtime: { getURL: (path) => path, getManifest: () => ({ version: "1.0.0" }) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    };
  });
  for (const locale of locales) {
    const localeDir = join(outputDir, locale);
    await mkdir(localeDir, { recursive: true });
    for (const variant of variants) {
      const outputPath = join(localeDir, `lurkloot-${variant.file}-1280x800.png`);
      await page.goto(`${origin}${popupPath}?screenshot=store&variant=${variant.id}&locale=${locale}`, { waitUntil: "networkidle" });
      // The header logo only renders after the snapshot loads (the loading
      // placeholder shows just "Loading"), and is present in every view/platform —
      // wait on it so Kick and non-Drops variants capture fully-rendered content.
      await page.waitForSelector('header img[alt="Lurkloot"]');
      // The marketing headline starts as the raw i18n key until the locale
      // catalog loads; wait until it has been replaced with real copy so the
      // capture never freezes a half-translated overlay.
      await page.waitForFunction(() => {
        const heading = document.querySelector("h1");
        return Boolean(heading?.textContent) && !heading.textContent.startsWith("screenshot");
      });
      await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: 1280, height: 800 } });
      console.log(`Wrote ${outputPath}`);
    }
  }
  await browser.close();
} finally {
  server.close();
}
