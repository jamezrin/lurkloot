import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const root = resolve(".output/chrome-mv3");
const outputDir = resolve(process.env.STORE_DRAFT_OUTPUT ?? "/tmp/lurkloot-store-draft");
const candidates = ["popup.html", "popup/index.html"];

// English-only art direction draft; does not upload anything.
// From the repository root:
//   pnpm build
//   pnpm --filter @lurkloot/extension exec node scripts/capture-store-draft.mjs
// Optional: STORE_DRAFT_OUTPUT=/path/to/drafts

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
  // The popup is the real extension UI, so it expects the WebExtension `browser`
  // global (resolved from `chrome`). Served over plain HTTP that global is
  // absent, so provide the minimal surface the popup touches at load/render:
  // i18n + runtime.getURL (used to fetch the localized message catalogs). The
  // mock data and locale come from screenshot mode + the ?locale= param, so
  // getMessage can return "" and let the catalog drive the copy.
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
  await mkdir(outputDir, { recursive: true });
  for (const story of ["queue", "games", "kick", "watchlist", "extensions"]) {
    await page.goto(`${origin}${popupPath}?screenshot=store&draft=${story}&locale=en`, { waitUntil: "networkidle" });
    await page.waitForSelector(story === "extensions" ? '[data-extension-overview]' : story === "watchlist" ? '#idle-watchlist' : 'main[data-view="queue"] [data-campaign-id]');
    if (story === "games") {
      await page.locator('button[data-view="games"]').click();
      await page.waitForSelector('[data-game]');
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode().catch(() => undefined)));
    });
    await page.waitForTimeout(500);
    const bounds = await page.locator('[data-draft-popup]').boundingBox();
    if (!bounds || bounds.width !== 720 || bounds.height !== 600 || bounds.x + bounds.width > 1280 || bounds.y + bounds.height > 800) throw new Error(`Clipped popup: ${JSON.stringify(bounds)}`);
    await page.screenshot({ path: join(outputDir, `${story}-1280x800.png`), clip: { x: 0, y: 0, width: 1280, height: 800 } });
    const visibleText = (await page.locator('body').innerText()).replaceAll('Chrome Runner Skin', '');
    if (/NoPixel|Fortnite|Firefox|Chrome/i.test(visibleText)) throw new Error(`Unexpected named provider or browser in ${story}: ${visibleText.match(/.{0,60}(?:NoPixel|Fortnite|Firefox|Chrome).{0,60}/gi)}`);
    console.log(`Captured ${story}: ${JSON.stringify(bounds)}`);
  }
  for (const format of [{ id: "small", width: 440, height: 280 }, { id: "marquee", width: 1400, height: 560 }]) {
    await page.setViewportSize({ width: format.width, height: format.height });
    await page.goto(`${origin}${popupPath}?screenshot=promo&draft=1&format=${format.id}&locale=en`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-promo-draft]');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(outputDir, `promo-${format.id}-${format.width}x${format.height}.png`), omitBackground: false });
    await execFileAsync("magick", [join(outputDir, `promo-${format.id}-${format.width}x${format.height}.png`), "-alpha", "off", "-define", "png:color-type=2", join(outputDir, `promo-${format.id}-${format.width}x${format.height}.png`)]);
    console.log(`Captured promo ${format.id}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser?.close();
  server.close();
}
