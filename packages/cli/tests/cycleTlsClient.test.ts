import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cycleTlsUpstreamName } from "../scripts/executable.mjs";
import { CHROME_HTTP2, CHROME_JA3, CHROME_UA } from "../src/transport/common";
import { createCycleClient } from "../src/transport/cycle";
import { decodeFrame, requestFrameOptions, startCycleTls } from "../src/transport/cycleTlsClient";
import { fakeCycleTls } from "./helpers/fakeCycleTls";

// What cycletls's npm wrapper 2.0.5 sent the binary for the calls the old
// cycle.ts made (captured off the socket), requestId removed.
const wrapperFrames = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "cycletlsWrapperFrames.json"), "utf8"),
) as Array<{ options: Record<string, unknown> }>;

// The wrapper's own bookkeeping, which it added to every frame and the binary
// does not need: connection-reuse hints, and its response-parsing mode.
const WRAPPER_ONLY = ["_connectionReuse", "_hostKey", "responseType"];

function withoutWrapperFields(options: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options).filter(([key]) => !WRAPPER_ONLY.includes(key)));
}

/** Records the frame options our client sends through createCycleClient. */
async function sentFrames(
  calls: Array<[string, Parameters<ReturnType<typeof createCycleClient>["request"]>[1]]>,
): Promise<Record<string, unknown>[]> {
  const sent: Record<string, unknown>[] = [];
  const client = createCycleClient(
    fakeCycleTls((_url, options) => {
      sent.push(options);
      return { status: 200, data: "" };
    }),
  );
  for (const [url, request] of calls) await client.request(url, request);
  return sent;
}

describe("cycletls request frames", () => {
  it("send the binary the same fingerprint and options the npm wrapper sent", async () => {
    const sent = await sentFrames([
      [
        "http://127.0.0.1:1/api/v2/channels/creator",
        {
          method: "get",
          userAgent: CHROME_UA,
          headers: {
            Accept: "application/json",
            Origin: "https://kick.com",
            Authorization: "Bearer t",
          },
        },
      ],
      [
        "http://127.0.0.1:1/api/tv/link/authenticate/UUID",
        {
          method: "post",
          userAgent: CHROME_UA,
          headers: { "Content-Type": "application/json" },
          body: '{"key":"123456"}',
        },
      ],
      [
        "http://127.0.0.1:1/hls",
        {
          method: "get",
          userAgent: "Mozilla/5.0 (Linux; Android 13) Chrome/124.0.0.0 Mobile Safari/537.36",
          headers: {},
          redirect: "manual",
        },
      ],
    ]);
    expect(sent).toEqual(wrapperFrames.map((frame) => withoutWrapperFields(frame.options)));
    expect(sent[0]?.ja3).toBe(CHROME_JA3);
    expect(sent[0]?.http2Fingerprint).toBe(CHROME_HTTP2);
  });

  it("send Chrome 124's user agent, matching the JA3, when the caller names none", async () => {
    const [frame] = await sentFrames([["https://example.test/", { method: "get", headers: {} }]]);
    expect(frame?.userAgent).toBe(CHROME_UA);
  });

  it("only send a timeout the caller asked for", () => {
    const base = {
      url: "u",
      method: "get",
      headers: {},
      body: "",
      ja3: "j",
      http2Fingerprint: "h",
      userAgent: "a",
    };
    expect(requestFrameOptions(base)).not.toHaveProperty("timeout");
    expect(requestFrameOptions({ ...base, timeout: 5 }).timeout).toBe(5);
  });
});

/** Builds a binary frame as the binary does: uint16-prefixed id and type, then the payload. */
function frame(requestId: string, type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([str(requestId), str(type), payload]);
}
function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}
function str(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u16(bytes.length), bytes]);
}

describe("decodeFrame", () => {
  it("reads a response head with repeated headers", () => {
    const payload = Buffer.concat([
      u16(302),
      str("https://kick.com/a"),
      u16(2),
      str("Set-Cookie"),
      u16(2),
      str("a=1"),
      str("b=2"),
      str("Location"),
      u16(1),
      str("/b"),
    ]);
    expect(decodeFrame(frame("r1", "response", payload))).toEqual({
      requestId: "r1",
      type: "response",
      status: 302,
      finalUrl: "https://kick.com/a",
      headers: { "Set-Cookie": ["a=1", "b=2"], Location: ["/b"] },
    });
  });

  it("reads body chunks, the end, and an error", () => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(Buffer.byteLength("héy"));
    const data = decodeFrame(frame("r1", "data", Buffer.concat([length, Buffer.from("héy")])));
    expect(data).toMatchObject({ type: "data" });
    expect(data.type === "data" && data.chunk.toString("utf8")).toBe("héy");
    expect(decodeFrame(frame("r1", "end"))).toEqual({ requestId: "r1", type: "end" });
    expect(decodeFrame(frame("r1", "error", Buffer.concat([u16(408), str("timeout")])))).toEqual({
      requestId: "r1",
      type: "error",
      status: 408,
      message: "timeout",
    });
  });

  it("refuses a truncated frame", () => {
    expect(() => decodeFrame(frame("r1", "response", u16(200)))).toThrow(/truncated/);
  });
});

// The real binary, from the cycletls package the build takes it from.
function upstreamBinary(): string | undefined {
  try {
    const dir = dirname(createRequire(import.meta.url).resolve("cycletls/package.json"));
    const path = join(dir, "dist", cycleTlsUpstreamName(process.platform, process.arch));
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

const binary = upstreamBinary();

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe.skipIf(binary === undefined)("the cycletls binary through our client", () => {
  let server: Server;
  let origin: string;
  let scratch: string;
  const seen: Array<{
    method?: string;
    url?: string;
    headers: Record<string, unknown>;
    body: string;
  }> = [];

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "lurkloot-cycletls-"));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "/final" });
          res.end();
          return;
        }
        res.setHeader("set-cookie", ["a=1", "b=2"]);
        res.writeHead(201, { "content-type": "text/plain; charset=utf-8" });
        res.end(`hello ünï ${req.method} ${req.url}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  it("sends a request and returns status, headers, body and final URL", async () => {
    const client = createCycleClient(await startCycleTls(binary as string));
    try {
      const response = await client.request(`${origin}/hello`, {
        method: "post",
        headers: { "x-lurkloot": "1", "content-type": "application/json" },
        body: '{"a":1}',
        userAgent: "UA-test",
      });
      expect(response.status).toBe(201);
      expect(response.body).toBe("hello ünï POST /hello");
      expect(response.headers["Set-Cookie"]).toEqual(["a=1", "b=2"]);
      expect(response.finalUrl).toBe(`${origin}/hello`);
      const request = seen.at(-1);
      expect(request?.headers["user-agent"]).toBe("UA-test");
      expect(request?.headers["x-lurkloot"]).toBe("1");
      expect(request?.body).toBe('{"a":1}');

      const followed = await client.request(`${origin}/redirect`, { method: "get", headers: {} });
      expect(followed.status).toBe(201);
      expect(followed.finalUrl).toBe(`${origin}/final`);

      const manual = await client.request(`${origin}/redirect`, {
        method: "get",
        headers: {},
        redirect: "manual",
      });
      expect(manual.status).toBe(302);
      expect(manual.headers.Location).toEqual(["/final"]);
    } finally {
      await client.close();
    }
  });

  it("reports a failed request as the binary's status and reason", async () => {
    const client = createCycleClient(await startCycleTls(binary as string));
    try {
      const response = await client.request("http://127.0.0.1:1/", { method: "get", headers: {} });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).toMatch(/refused/);
    } finally {
      await client.close();
    }
  });

  it("gives every client its own binary on its own port, and ends it on close", async () => {
    const first = await startCycleTls(binary as string);
    const second = await startCycleTls(binary as string);
    try {
      expect(first.pid).not.toBe(second.pid);
      expect(first.port).not.toBe(second.port);
      expect(alive(first.pid)).toBe(true);
      expect(alive(second.pid)).toBe(true);
      const [a, b] = await Promise.all(
        [first, second].map((client) =>
          createCycleClient(client).request(`${origin}/both`, { method: "get", headers: {} }),
        ),
      );
      expect([a?.status, b?.status]).toEqual([201, 201]);
    } finally {
      await first.close();
      await second.close();
    }
    expect(await waitUntil(() => !alive(first.pid) && !alive(second.pid))).toBe(true);
  });

  it("starts from a path with spaces and shell characters", async () => {
    const dir = join(scratch, "My Apps $HOME (x)", "cycletls");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, process.platform === "win32" ? "cycletls.exe" : "cycletls");
    copyFileSync(binary as string, path);
    chmodSync(path, 0o755);
    const client = createCycleClient(await startCycleTls(path));
    try {
      expect(
        (await client.request(`${origin}/spaces`, { method: "get", headers: {} })).status,
      ).toBe(201);
    } finally {
      await client.close();
    }
  });

  it("never joins a process already listening on the port it picked", async () => {
    const taken = createServer((_req, res) => res.end("not cycletls"));
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const address = taken.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(
        startCycleTls(binary as string, { pickPort: async () => port, startTimeoutMs: 3_000 }),
      ).rejects.toThrow(/cycletls/);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it("fails clearly when the binary cannot start", async () => {
    await expect(startCycleTls(join(scratch, "missing"))).rejects.toThrow(/could not start/);
  });

  it.skipIf(process.platform === "win32").each([
    ["process.exit()", "exit"],
    ["SIGTERM with no handler of its own", "SIGTERM"],
    ["SIGINT with no handler of its own", "SIGINT"],
  ])("leaves no binary behind when the CLI ends by %s", async (_name, how) => {
    const script = join(scratch, `owner-${how}.ts`);
    const clientModule = join(import.meta.dirname, "..", "src", "transport", "cycleTlsClient.ts");
    writeFileSync(
      script,
      [
        `import { startCycleTls } from ${JSON.stringify(clientModule)};`,
        `const client = await startCycleTls(${JSON.stringify(binary)});`,
        "process.stdout.write(`${client.pid}\\n`);",
        how === "exit" ? "setTimeout(() => process.exit(0), 100);" : "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const pid = await new Promise<number>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const line = out.split("\n")[0];
        if (out.includes("\n") && line) resolve(Number(line));
      });
      child.once("exit", (code) => reject(new Error(`owner exited early (${code})`)));
    });
    expect(alive(pid)).toBe(true);
    if (how !== "exit") child.kill(how as NodeJS.Signals);
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    if (how !== "exit") expect(ended.signal).toBe(how);
    expect(await waitUntil(() => !alive(pid))).toBe(true);
  });
});
