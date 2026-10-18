import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { parseLocaleArguments } from "./core/listing.mjs";
import { gitProvenance, recordCapture } from "./core/provenance.mjs";
import { LISTING, STORE_PATHS } from "./lurkloot.mjs";

const execFileAsync = promisify(execFile);

const POPUP_CANDIDATES = ["popup.html", "popup/index.html"];

// One capture for the store listing. Screenshots show the current artwork, with
// the popup at its real 720×600 size, in the files the listing profile names.
//   node scripts/store-listing/capture.mjs screenshots [--locales a b]
//   node scripts/store-listing/capture.mjs promos [--locales a b]
export const CAPTURE_MODES = Object.freeze(["screenshots", "promos"]);

export const PROMO_FORMATS = Object.freeze([
  Object.freeze({ id: "small", width: 440, height: 280 }),
  Object.freeze({ id: "marquee", width: 1400, height: 560 }),
]);

// What each popup story must have rendered before it is photographed.
export const STORY_READINESS = Object.freeze({
  queue: Object.freeze({ selector: 'main[data-view="queue"] [data-campaign-id]' }),
  games: Object.freeze({
    selector: 'main[data-view="queue"] [data-campaign-id]',
    open: 'button[data-view="games"]',
    then: "[data-game]",
  }),
  kick: Object.freeze({ selector: 'main[data-view="queue"] [data-campaign-id]' }),
  watchlist: Object.freeze({ selector: "#idle-watchlist" }),
  extensions: Object.freeze({ selector: "[data-extension-overview]" }),
});

const CONTENT_TYPES = {
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
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findPopupPath(root) {
  for (const candidate of POPUP_CANDIDATES) {
    if (await fileExists(join(root, candidate))) return `/${candidate}`;
  }
  throw new Error(`Could not find a built popup HTML file in ${root}. Run pnpm build first.`);
}

function startServer(root) {
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
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
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

async function captureScreenshot({ page, origin, popupPath, locale, variant, file, output }) {
  const story = variant.story;
  const readiness = STORY_READINESS[story];
  await page.goto(`${origin}${popupPath}?screenshot=store&story=${story}&locale=${locale}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector(readiness.selector);
  if (readiness.open) {
    await page.locator(readiness.open).click();
    await page.waitForSelector(readiness.then);
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
  });
  await page.waitForTimeout(500);
  const bounds = await page.locator("[data-store-popup]").boundingBox();
  if (
    !bounds
    || bounds.width !== 720
    || bounds.height !== 600
    || bounds.x + bounds.width > LISTING.screenshotSize.width
    || bounds.y + bounds.height > LISTING.screenshotSize.height
  ) {
    throw new Error(`Clipped popup: ${JSON.stringify(bounds)}`);
  }
  await page.screenshot({
    path: file,
    clip: { x: 0, y: 0, ...LISTING.screenshotSize },
  });
  const visibleText = (await page.locator("body").innerText()).replaceAll("Chrome Runner Skin", "");
  if (/NoPixel|Fortnite|Firefox|Chrome/i.test(visibleText)) {
    throw new Error(
      `Unexpected named provider or browser in ${story}: ${visibleText.match(/.{0,60}(?:NoPixel|Fortnite|Firefox|Chrome).{0,60}/gi)}`,
    );
  }
  output(`[${locale}] Captured ${LISTING.screenshotFilename(variant)}: ${JSON.stringify(bounds)}`);
}

async function capturePromo({ page, origin, popupPath, locale, format, localeDir, output }) {
  await page.setViewportSize({ width: format.width, height: format.height });
  await page.goto(`${origin}${popupPath}?screenshot=promo&format=${format.id}&locale=${locale}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("[data-store-promo]");
  await page.evaluate(() => document.fonts.ready);
  const promoFile = `lurkloot-promo-${format.id}-${format.width}x${format.height}.png`;
  const promoPath = join(localeDir, promoFile);
  await page.screenshot({ path: promoPath, omitBackground: false });
  await execFileAsync("magick", [
    promoPath,
    "-alpha",
    "off",
    "-define",
    "png:color-type=2",
    promoPath,
  ]);
  output(`[${locale}] Captured ${promoFile}`);
}

export async function captureStore({
  mode,
  locales,
  listing = LISTING,
  paths = STORE_PATHS,
  output = console.log,
}) {
  if (!CAPTURE_MODES.includes(mode)) {
    throw new Error(`Capture mode must be one of ${CAPTURE_MODES.join(", ")}`);
  }
  listing.validateLocaleCodes(locales);
  const root = resolve(paths.build);
  const outputDir = resolve(mode === "screenshots" ? paths.screenshots : paths.promos);
  const popupPath = await findPopupPath(root);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const { server, origin } = await startServer(root);
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
        await page.setViewportSize({ ...listing.screenshotSize });
        for (const variant of listing.screenshots) {
          await captureScreenshot({
            page,
            origin,
            popupPath,
            locale,
            variant,
            file: join(localeDir, listing.screenshotFilename(variant)),
            output,
          });
        }
      } else {
        for (const format of PROMO_FORMATS) {
          await capturePromo({ page, origin, popupPath, locale, format, localeDir, output });
        }
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
    if (mode === "screenshots") {
      await recordCapture({
        dir: outputDir,
        listing,
        locales,
        version: manifest.version,
        git: await gitProvenance({ cwd: paths.packageRoot }),
      });
      output(`Recorded capture provenance for ${manifest.version}.`);
    }
  } finally {
    await browser?.close();
    server.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  if (!CAPTURE_MODES.includes(mode)) {
    throw new Error(
      `Usage: node scripts/store-listing/capture.mjs <${CAPTURE_MODES.join("|")}> [--locales a b]`,
    );
  }
  await captureStore({ mode, locales: parseLocaleArguments(LISTING, rest) });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`store capture: ${error.message}`);
    process.exitCode = 1;
  });
}
