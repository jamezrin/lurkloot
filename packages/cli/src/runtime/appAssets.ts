import { createReadStream, existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// The app UI's static bundle (@lurkloot/app-ui, #980), served by `lurkloot
// serve` at `/` beside the control plane's `/v1/*`. The CLI build copies the
// bundle next to dist/index.mjs, so the default root sits beside the bundle
// that runs.

export const APP_INDEX = "index.html";

// The bundle beside the running CLI, when the build put one there. A CLI built
// without it (a bare esbuild run) serves the control plane alone.
export function defaultAppRoot(moduleUrl: string = import.meta.url): string | undefined {
  const root = fileURLToPath(new URL("./app/", moduleUrl));
  try {
    return statSync(resolve(root, APP_INDEX)).isFile() ? root : undefined;
  } catch {
    return undefined;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// The page talks to its own origin only. Drop artwork and avatars come from
// Twitch's and Kick's CDNs, hence https: images. React sets style attributes,
// hence inline styles. No frames, either way.
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const APP_HEADERS = {
  "content-security-policy": APP_CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
} as const;

export type AppAssetResult =
  | { kind: "file"; path: string; contentType: string; immutable: boolean }
  | { kind: "not_found" }
  | { kind: "bad_request" };

// Maps a request path to a file inside `root`, or says why not. Never leaves
// the root: the path is decoded once, any `..`, dot segment, backslash or NUL
// is refused, and the resolved path must still sit under the root. A path
// with no extension that names no file is a page of the app, answered with
// index.html (the SPA fallback); a directory is never listed.
// The app has no URL routes and its asset paths are relative (so it also
// works under a reverse proxy's sub-path), so the fallback serves the paths a
// browser lands on, `/` and one level below it.
export async function resolveAppAsset(root: string, pathname: string): Promise<AppAssetResult> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "bad_request" };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return { kind: "bad_request" };
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  // Dot segments (`.`, `..`) and dotfiles alike: nothing the bundle serves
  // starts with a dot.
  if (segments.some((segment) => segment.startsWith("."))) return { kind: "not_found" };

  const base = resolve(root);
  const index = {
    kind: "file",
    path: resolve(base, APP_INDEX),
    contentType: CONTENT_TYPES[".html"]!,
    immutable: false,
  } as const;
  if (segments.length === 0) return index;
  const candidate = resolve(base, ...segments);
  if (candidate !== base && !candidate.startsWith(base + sep)) return { kind: "not_found" };

  const extension = extname(candidate).toLowerCase();
  try {
    const info = await stat(candidate);
    if (info.isFile()) {
      return {
        kind: "file",
        path: candidate,
        contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        // Vite names everything under assets/ by its content hash.
        immutable: segments[0] === "assets",
      };
    }
  } catch {
    // Missing: handled below.
  }
  // A missing asset is a 404, not the page: a stale chunk must fail loudly.
  return extension ? { kind: "not_found" } : index;
}

function sendText(response: ServerResponse, status: number, text: string, head: boolean): void {
  response.writeHead(status, {
    ...APP_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
  });
  response.end(head ? undefined : text);
}

// Answers a GET or HEAD for the app's files. Other methods get a 405: the
// app's paths take no writes.
export async function serveAppAsset(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) {
    response.writeHead(405, { ...APP_HEADERS, allow: "GET, HEAD", "content-length": "0" });
    response.end();
    return;
  }
  const asset = await resolveAppAsset(root, pathname);
  if (asset.kind === "bad_request") return sendText(response, 400, "Bad request", head);
  if (asset.kind === "not_found" || !existsSync(asset.path))
    return sendText(response, 404, "Not found", head);
  const info = await stat(asset.path);
  response.writeHead(200, {
    ...APP_HEADERS,
    "content-type": asset.contentType,
    "content-length": String(info.size),
    // The page itself always revalidates, so a new CLI's bundle is picked up.
    "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (head) {
    response.end();
    return;
  }
  // pipeline destroys the file stream however the response ends, so a client
  // that goes away mid-download does not leave its descriptor open.
  try {
    await pipeline(createReadStream(asset.path), response);
  } catch (error) {
    // The client went away: nothing to answer, nothing to report.
    if ((error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") return;
    throw error;
  }
}
