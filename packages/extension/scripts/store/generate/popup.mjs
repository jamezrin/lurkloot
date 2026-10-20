import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const POPUP_CANDIDATES = ["popup.html", "popup/index.html"];

// What each popup story must have rendered before it is photographed.
export const STORY_READINESS = Object.freeze({
  queue: Object.freeze({ selector: 'main[data-view="queue"] [data-campaign-id]' }),
  games: Object.freeze({
    selector: 'main[data-view="games"] [data-game]',
  }),
  kick: Object.freeze({ selector: "[data-platform-features]" }),
  watchlist: Object.freeze({ selector: "#idle-watchlist" }),
  free: Object.freeze({ selector: '[data-store-artwork="free"]' }),
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

// Serves the built popup and hands `work` a page that renders it. The extension
// version comes from the build that is served, not from the checkout, because
// that is what the artwork shows.
export async function withPopup(buildDirectory, work) {
  const root = resolve(buildDirectory);
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
    const result = await work({ page, origin, popupPath, version: manifest.version });
    if (errors.length) throw new Error(errors.join("\n"));
    return result;
  } finally {
    await browser?.close();
    server.close();
  }
}
