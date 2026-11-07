import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_CONTENT_SECURITY_POLICY,
  defaultAppRoot,
  resolveAppAsset,
} from "../src/runtime/appAssets";
import { type ControlPlane, startControlPlane } from "../src/runtime/controlPlane";
import { createLogger } from "../src/logger";

const TOKEN = "serve-token-sentinel-0123456789";
const SECRET = "secret-outside-the-app-root";
const INDEX = '<!doctype html><script type="module" src="./assets/index-abc123.js"></script>';
const quiet = { ...createLogger("error"), log: () => {}, error: () => {} };

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

// node:http with a raw path, so `..` and encoded separators reach the server
// as sent rather than normalised by a URL parser first.
function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolveReply, rejectReply) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path,
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolveReply({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", rejectReply);
    req.end();
  });
}

let base: string;
let root: string;
let plane: ControlPlane | undefined;

beforeAll(async () => {
  // base/secret.txt and base/app.txt sit beside the root, base/app/.
  base = await mkdtemp(join(tmpdir(), "lurkloot-app-"));
  root = join(base, "app");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), INDEX);
  writeFileSync(join(root, "assets", "index-abc123.js"), "export {};");
  writeFileSync(join(root, "assets", "index-abc123.css"), "body{}");
  writeFileSync(join(root, "favicon.svg"), "<svg/>");
  writeFileSync(join(root, "assets", "big-abc123.js"), "x".repeat(32 * 1024 * 1024));
  writeFileSync(join(root, ".env"), SECRET);
  writeFileSync(join(base, "secret.txt"), SECRET);
  writeFileSync(join(base, "app.txt"), SECRET);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

afterEach(async () => {
  await plane?.close();
  plane = undefined;
});

async function start(options: { token?: string; appRoot?: string | undefined } = {}) {
  plane = await startControlPlane({
    host: "127.0.0.1",
    port: 0,
    ...(options.token ? { token: options.token } : {}),
    ...("appRoot" in options
      ? options.appRoot
        ? { appRoot: options.appRoot }
        : {}
      : { appRoot: root }),
    logger: quiet,
    handleMessage: async () => null,
    describeSession: async () => ({
      id: "default",
      version: "test",
      platforms: {} as never,
    }),
  });
  return plane.port;
}

describe("serve's app UI", () => {
  it("serves the page at / with its content type, security headers and no caching", async () => {
    const port = await start();
    const reply = await send(port, "/");
    expect(reply.status).toBe(200);
    expect(reply.text).toBe(INDEX);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.headers["content-security-policy"]).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(reply.headers["x-frame-options"]).toBe("DENY");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["cache-control"]).toBe("no-cache");
  });

  it("serves hashed assets with their types, cached for good", async () => {
    const port = await start();
    const script = await send(port, "/assets/index-abc123.js");
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const style = await send(port, "/assets/index-abc123.css");
    expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");
    const icon = await send(port, "/favicon.svg");
    expect(icon.headers["content-type"]).toBe("image/svg+xml");
    expect(icon.headers["cache-control"]).toBe("no-cache");
  });

  it("answers the app's own paths with the page (SPA fallback)", async () => {
    const port = await start();
    for (const path of ["/accounts", "/drops/queue", "/settings?tab=general"]) {
      const reply = await send(port, path);
      expect(reply.status, path).toBe(200);
      expect(reply.text, path).toBe(INDEX);
    }
  });

  it("answers a missing file with a 404, not the page", async () => {
    const port = await start();
    const reply = await send(port, "/assets/index-gone.js");
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain("<!doctype");
  });

  it("never lists a directory", async () => {
    const port = await start();
    for (const path of ["/assets", "/assets/"]) {
      const reply = await send(port, path);
      expect(reply.status, path).toBe(200);
      expect(reply.text, path).toBe(INDEX);
      expect(reply.text, path).not.toContain("index-abc123.css");
    }
  });

  it("refuses every path out of the app's root", async () => {
    const port = await start();
    const attempts = [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/..%5csecret.txt",
      "/%2e%2e%5csecret.txt",
      "/..%00/secret.txt",
      "/../app.txt",
      "/.env",
      "/assets/%2e/../.env",
      `/${encodeURIComponent(join(base, "secret.txt"))}`,
      "//etc/passwd",
      "/%ff",
    ];
    for (const path of attempts) {
      const reply = await send(port, path);
      expect(reply.text, path).not.toContain(SECRET);
      expect(reply.text, path).not.toContain("root:");
      expect([200, 400, 404], path).toContain(reply.status);
    }
  });

  it("maps paths inside the root only, whatever the encoding", async () => {
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/a/%2e%2e/%2e%2e/secret.txt"]) {
      const result = await resolveAppAsset(root, path);
      expect(result.kind, path).toBe("not_found");
    }
    expect((await resolveAppAsset(root, "/..%5csecret.txt")).kind).toBe("bad_request");
    expect((await resolveAppAsset(root, "/%E0%A4%A")).kind).toBe("bad_request");
  });

  // Counts open descriptors through /proc, so Linux only.
  it.skipIf(process.platform !== "linux")(
    "closes the file when a client goes away mid-download",
    async () => {
      const port = await start();
      const openFiles = () =>
        readdirSync("/proc/self/fd").filter((fd) => {
          try {
            return readlinkSync(`/proc/self/fd/${fd}`).endsWith("big-abc123.js");
          } catch {
            return false;
          }
        }).length;
      await new Promise<void>((resolveRead) => {
        const socket = connect(port, "127.0.0.1", () =>
          socket.write("GET /assets/big-abc123.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
        );
        // Read the first bytes, then stop reading and hang up.
        socket.once("data", () => {
          socket.destroy();
          resolveRead();
        });
      });
      await expect.poll(openFiles, { timeout: 2000 }).toBe(0);
    },
  );

  it("answers HEAD without a body, and refuses writes to the app's paths", async () => {
    const port = await start();
    const head = await send(port, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(Number(head.headers["content-length"])).toBe(INDEX.length);
    const post = await send(port, "/", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  it("serves the page without the token, and still guards the API with it", async () => {
    const port = await start({ token: TOKEN });
    expect((await send(port, "/")).status).toBe(200);
    expect((await send(port, "/assets/index-abc123.js")).status).toBe(200);
    expect((await send(port, "/v1/session")).status).toBe(401);
    expect(
      (await send(port, "/v1/session", { headers: { authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(200);
  });

  it("refuses a foreign Host for the page too (DNS rebinding)", async () => {
    const port = await start();
    const reply = await send(port, "/", { headers: { host: "attacker.example:8420" } });
    expect(reply.status).toBe(403);
    expect(reply.text).not.toContain("<!doctype");
  });

  // A reverse proxy in front of a non-loopback bind (compose's 0.0.0.0): the
  // app's writes carry the proxy's Origin, which must match the Host it sends.
  it("accepts the app's writes through a proxy that passes the original Host, not one that rewrites it", async () => {
    plane = await startControlPlane({
      host: "0.0.0.0",
      port: 0,
      token: TOKEN,
      appRoot: root,
      logger: quiet,
      handleMessage: async () => null,
      describeSession: async () => ({ id: "default", version: "test", platforms: {} as never }),
    });
    const post = (host: string) =>
      new Promise<number>((resolveStatus, rejectStatus) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: plane!.port,
            method: "POST",
            path: "/v1/session/messages",
            headers: {
              host,
              origin: "https://lurkloot.example",
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
            },
            agent: false,
          },
          (res) => {
            res.resume();
            res.on("end", () => resolveStatus(res.statusCode ?? 0));
          },
        );
        req.on("error", rejectStatus);
        req.end(JSON.stringify({ type: "getSnapshot" }));
      });
    expect(await post("lurkloot.example")).toBe(200);
    expect(await post(`127.0.0.1:${plane.port}`)).toBe(403);
    expect((await send(plane.port, "/", { headers: { host: "lurkloot.example" } })).status).toBe(
      200,
    );
  });

  it("keeps /v1 the API's: an unknown endpoint is a JSON 404, never the page", async () => {
    const port = await start();
    for (const path of ["/v1", "/v1/", "/v1/nope"]) {
      const reply = await send(port, path);
      expect(reply.status, path).toBe(404);
      expect(JSON.parse(reply.text), path).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("serves the control plane alone without a bundle", async () => {
    const port = await start({ appRoot: undefined });
    const reply = await send(port, "/");
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.text)).toMatchObject({ error: { code: "not_found" } });
  });

  it("finds the bundle beside the CLI that runs, and none where there is none", () => {
    // dist/index.mjs beside dist/app/index.html, as the CLI build lays them out.
    expect(defaultAppRoot(pathToFileURL(join(base, "index.mjs")).href)).toBe(`${root}/`);
    expect(defaultAppRoot(pathToFileURL(join(root, "assets", "index.mjs")).href)).toBeUndefined();
  });
});
