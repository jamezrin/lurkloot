import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const root = resolve(".output/chrome-mv3");
const candidates = ["popup.html", "popup/index.html"];

// One capture for the store listing. Screenshots keep the existing filenames and
// show the current artwork, with the popup at its real 720×600 size.
//   node scripts/capture-store.mjs screenshots [locale...]
//   node scripts/capture-store.mjs promos [locale...]
const args = process.argv.slice(2);
const mode = args[0];
if (mode !== "screenshots" && mode !== "promos") {
  throw new Error("Usage: node scripts/capture-store.mjs <screenshots|promos> [locale...]");
}
const outputDir = resolve(mode === "screenshots" ? "artifacts/store-screenshots" : "artifacts/store-promo");
const shots = [
  ["queue", "lurkloot-01-drops-1280x800.png"],
  ["games", "lurkloot-02-extras-1280x800.png"],
  ["kick", "lurkloot-03-easy-1280x800.png"],
  ["watchlist", "lurkloot-04-settings-1280x800.png"],
  ["extensions", "lurkloot-05-updated-1280x800.png"],
];
const promos = [
  { id: "small", width: 440, height: 280 },
  { id: "marquee", width: 1400, height: 560 },
];

const ALL_LOCALES = ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar", "tr"];
const requested = args.slice(1).filter((code) => code !== "--");
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
  ".woff2": "font/woff2",
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
    let requestPath;
    try {
      requestPath = decodeURIComponent(url.pathname === "/" ? "/popup.html" : url.pathname);
    } catch {
      response.writeHead(400);
      response.end("Invalid path");
      return;
    }
    const filePath = resolve(join(root, requestPath));

    if (!filePath.startsWith(`${root}${sep}`)) {
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
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const { server, origin } = await startServer();
let browser;

try {
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript((version) => {
    globalThis.chrome = {
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      runtime: { getURL: (path) => path, getManifest: () => ({ version }) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    };
  }, manifest.version);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  for (const locale of locales) {
    const localeDir = join(outputDir, locale);
    await mkdir(localeDir, { recursive: true });
    if (mode === "screenshots") {
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const [story, filename] of shots) {
        await page.goto(`${origin}${popupPath}?screenshot=store&story=${story}&locale=${locale}`, { waitUntil: "networkidle" });
        await page.waitForSelector(story === "extensions" ? "[data-extension-overview]" : story === "watchlist" ? "#idle-watchlist" : 'main[data-view="queue"] [data-campaign-id]');
        if (story === "games") {
          await page.locator('button[data-view="games"]').click();
          await page.waitForSelector("[data-game]");
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
        });
        await page.waitForTimeout(500);
        const bounds = await page.locator("[data-store-popup]").boundingBox();
        if (!bounds || bounds.width !== 720 || bounds.height !== 600 || bounds.x + bounds.width > 1280 || bounds.y + bounds.height > 800) {
          throw new Error(`Clipped popup: ${JSON.stringify(bounds)}`);
        }
        await page.screenshot({ path: join(localeDir, filename), clip: { x: 0, y: 0, width: 1280, height: 800 } });
        const visibleText = (await page.locator("body").innerText()).replaceAll("Chrome Runner Skin", "");
        if (/NoPixel|Fortnite|Firefox|Chrome/i.test(visibleText)) {
          throw new Error(`Unexpected named provider or browser in ${story}: ${visibleText.match(/.{0,60}(?:NoPixel|Fortnite|Firefox|Chrome).{0,60}/gi)}`);
        }
        console.log(`[${locale}] Captured ${filename}: ${JSON.stringify(bounds)}`);
      }
    } else {
      for (const format of promos) {
        await page.setViewportSize({ width: format.width, height: format.height });
        await page.goto(`${origin}${popupPath}?screenshot=promo&format=${format.id}&locale=${locale}`, { waitUntil: "networkidle" });
        await page.waitForSelector("[data-store-promo]");
        await page.evaluate(() => document.fonts.ready);
        const promoFile = `lurkloot-promo-${format.id}-${format.width}x${format.height}.png`;
        const promoPath = join(localeDir, promoFile);
        await page.screenshot({ path: promoPath, omitBackground: false });
        await execFileAsync("magick", [promoPath, "-alpha", "off", "-define", "png:color-type=2", promoPath]);
        console.log(`[${locale}] Captured ${promoFile}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser?.close();
  server.close();
}
