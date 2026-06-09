import { createServer } from "node:http";
import { mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

const root = resolve(".output/chrome-mv3");
const outputDir = resolve("artifacts/store-promo");
const candidates = ["popup.html", "popup/index.html"];

// Chrome Web Store promotional tiles. The popup renders these standalone via
// ?screenshot=promo&format=<id>&locale=<code> (see PromoTile in
// entrypoints/popup/main.tsx). Both must be 24-bit, no alpha — Playwright emits
// RGBA PNGs, so each capture is flattened over an opaque background afterwards.
const formats = [
  { id: "small", width: 440, height: 280, file: "promo-small-440x280" },
  { id: "marquee", width: 1400, height: 560, file: "promo-marquee-1400x560" },
];

// One tile set per store locale. The ids match the _locales/<id> folders bundled
// in the build. A subset can be captured by passing locale codes as CLI args,
// e.g. `node scripts/capture-store-promo.mjs es pt_BR`.
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

// Chrome Web Store rejects promo images with an alpha channel. Playwright always
// writes RGBA PNGs, so composite over an opaque background and drop the alpha
// channel to land a 24-bit RGB PNG.
async function flattenToOpaque(path) {
  await execFileAsync("magick", [path, "-background", "#09090b", "-alpha", "remove", "-alpha", "off", "-strip", path]);
}

const popupPath = await findPopupPath();
const { server, origin } = await startServer();

try {
  const browser = await chromium.launch();
  // The popup is the real extension UI, so it expects the WebExtension `browser`
  // global (resolved from `chrome`). Served over plain HTTP that global is
  // absent, so provide the minimal surface PromoTile touches: i18n +
  // runtime.getURL (to fetch the localized message catalogs).
  const page = await browser.newPage({ deviceScaleFactor: 1 });
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
    for (const format of formats) {
      const outputPath = join(localeDir, `stream-autopilot-${format.file}.png`);
      await page.setViewportSize({ width: format.width, height: format.height });
      await page.goto(`${origin}${popupPath}?screenshot=promo&format=${format.id}&locale=${locale}`, { waitUntil: "networkidle" });
      await page.waitForSelector('img[src="/logo-ring.svg"]');
      // Copy starts as raw i18n keys until the locale catalog loads; wait until
      // no raw key is left on screen so the tile never freezes mid-translation.
      await page.waitForFunction(() => {
        const text = document.body.innerText ?? "";
        return text.length > 0 && !/\b(promoTagline|screenshotTwitchHeadline|extensionName|extensionDescription|autoClaimReady)\b/.test(text);
      });
      await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: format.width, height: format.height } });
      await flattenToOpaque(outputPath);
      console.log(`Wrote ${outputPath}`);
    }
  }
  await browser.close();
} finally {
  server.close();
}
