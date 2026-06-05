import { createServer } from "node:http";
import { mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(".output/chrome-mv3");
const outputDir = resolve("artifacts/store-screenshots");
const candidates = ["popup.html", "popup/index.html"];

// Each variant is rendered via ?screenshot=store&variant=<id> (see
// SCREENSHOT_VARIANTS in entrypoints/popup/main.tsx). Numeric file prefixes
// preserve the upload order in the store listing.
const variants = [
  { id: "twitch-drops", file: "01-twitch-drops" },
  { id: "kick-drops", file: "02-kick-drops" },
  { id: "watch-queue", file: "03-watch-queue" },
  { id: "settings", file: "04-settings" },
  { id: "activity", file: "05-activity" },
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
await mkdir(outputDir, { recursive: true });
const { server, origin } = await startServer();

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  for (const variant of variants) {
    const outputPath = join(outputDir, `stream-autopilot-${variant.file}-1280x800.png`);
    await page.goto(`${origin}${popupPath}?screenshot=store&variant=${variant.id}`, { waitUntil: "networkidle" });
    // The header logo only renders after the snapshot loads (the loading
    // placeholder shows just "Loading"), and is present in every view/platform —
    // wait on it so Kick and non-Drops variants capture fully-rendered content.
    await page.waitForSelector('header img[alt="Stream Autopilot"]');
    await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: 1280, height: 800 } });
    console.log(`Wrote ${outputPath}`);
  }
  await browser.close();
} finally {
  server.close();
}
