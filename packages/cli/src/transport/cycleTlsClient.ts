import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";

// Lurkloot's own client for CycleTLS's Go binary (#1031). The binary is a
// separate GPL-3.0 program; this client only starts it and talks to it over
// its local WebSocket, so no GPL code runs in the CLI's process. It was written
// from the protocol the binary speaks (observed traffic and CycleTLS's
// documented request options), not from the npm wrapper's code:
//
// - The binary listens on the port in its WS_PORT environment variable.
// - A request is one text frame: {"requestId": <id>, "options": {url, method,
//   headers, body, ja3, http2Fingerprint, userAgent, timeout?, disableRedirect?,
//   …}}. Many requests share one socket, told apart by requestId.
// - The answer is a run of binary frames, each led by two length-prefixed
//   (uint16 big-endian) strings: the requestId and a frame type.
//   - "response": uint16 status, string final URL, uint16 header count, then
//     per header a string name, a uint16 value count and that many strings.
//   - "data": a uint32 length and that many body bytes; may repeat.
//   - "end": the request is complete.
//   - "error": uint16 status and a string message; the request is over.
//
// The client starts the binary directly (no shell, so any path works), on a
// port it picked itself, and never joins an instance it did not start. It ends
// the process on close() and, as a backstop, when the CLI's process exits.

export interface CycleTlsRequestOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  ja3: string;
  http2Fingerprint: string;
  userAgent: string;
  // Seconds. Unset leaves the binary's own default.
  timeout?: number;
  disableRedirect?: boolean;
}

export interface CycleTlsResponse {
  status: number;
  finalUrl: string;
  headers: Record<string, string[]>;
  body: Buffer;
}

export interface CycleTlsClient {
  request(options: CycleTlsRequestOptions): Promise<CycleTlsResponse>;
  close(): Promise<void>;
  // The started binary's process id and port, for diagnostics and tests.
  readonly pid: number | undefined;
  readonly port: number;
}

export class CycleTlsStartError extends Error {}

// The fixed fields every request carries besides the caller's: what the binary
// treats as "no proxy, verify TLS, negotiate the protocol", sent explicitly as
// the npm wrapper sent them (tests/fixtures/cycletlsWrapperFrames.json).
const REQUEST_DEFAULTS = {
  proxy: "",
  insecureSkipVerify: false,
  forceHTTP1: false,
  forceHTTP3: false,
  protocol: "",
};

/** Builds the options object of one request frame. */
export function requestFrameOptions(options: CycleTlsRequestOptions): Record<string, unknown> {
  return {
    url: options.url,
    method: options.method,
    headers: options.headers,
    body: options.body,
    ja3: options.ja3,
    http2Fingerprint: options.http2Fingerprint,
    userAgent: options.userAgent,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.disableRedirect ? { disableRedirect: true } : {}),
    ...REQUEST_DEFAULTS,
  };
}

export type CycleTlsFrame =
  | {
      requestId: string;
      type: "response";
      status: number;
      finalUrl: string;
      headers: Record<string, string[]>;
    }
  | { requestId: string; type: "data"; chunk: Buffer }
  | { requestId: string; type: "end" }
  | { requestId: string; type: "error"; status: number; message: string }
  | { requestId: string; type: "unknown"; name: string };

class FrameReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  private need(bytes: number): void {
    if (this.offset + bytes > this.buffer.length) throw new Error("truncated cycletls frame");
  }

  u16(): number {
    this.need(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(length: number): Buffer {
    this.need(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string(): string {
    return this.bytes(this.u16()).toString("utf8");
  }
}

/** Decodes one binary frame from the binary. Throws on a truncated frame. */
export function decodeFrame(buffer: Buffer): CycleTlsFrame {
  const reader = new FrameReader(buffer);
  const requestId = reader.string();
  const type = reader.string();
  switch (type) {
    case "response": {
      const status = reader.u16();
      const finalUrl = reader.string();
      const headers: Record<string, string[]> = {};
      const count = reader.u16();
      for (let i = 0; i < count; i++) {
        const name = reader.string();
        const values: string[] = [];
        const valueCount = reader.u16();
        for (let j = 0; j < valueCount; j++) values.push(reader.string());
        headers[name] = [...(headers[name] ?? []), ...values];
      }
      return { requestId, type, status, finalUrl, headers };
    }
    case "data":
      return { requestId, type, chunk: Buffer.from(reader.bytes(reader.u32())) };
    case "end":
      return { requestId, type };
    case "error":
      return { requestId, type, status: reader.u16(), message: reader.string() };
    default:
      return { requestId, type: "unknown", name: type };
  }
}

interface Pending {
  resolve: (response: CycleTlsResponse) => void;
  reject: (error: Error) => void;
  status?: number;
  finalUrl: string;
  headers: Record<string, string[]>;
  chunks: Buffer[];
}

/** Asks the OS for a free loopback port. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

// Every started binary, so the CLI's exit ends any a close() did not reach.
const running = new Set<ChildProcess>();
let exitHookInstalled = false;

function killRunning(): void {
  for (const child of running) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// Signals that end Node by default. A command that handles one itself (run and
// serve shut down and close the client) keeps doing so; for one that does not,
// Node would die without an "exit" event, so the binaries are ended first and
// the signal raised again with Node's default behavior.
const ENDING_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", killRunning);
  for (const signal of ENDING_SIGNALS) {
    const onSignal = () => {
      if (process.listenerCount(signal) > 1) return;
      killRunning();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    try {
      process.on(signal, onSignal);
    } catch {
      // A signal this platform cannot listen for.
    }
  }
}

/** Tells whether the child process has already exited. */
function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Ends the child: SIGTERM, then SIGKILL if it outlives the grace period. */
async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (exited(child)) return;
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), graceMs);
  });
  if ((await Promise.race([gone, late])) === "late") {
    child.kill("SIGKILL");
    await gone;
  }
  clearTimeout(timer);
}

export interface StartCycleTlsOptions {
  // How long the binary gets to accept the socket. Default 15 s.
  startTimeoutMs?: number;
  // How long close() waits after SIGTERM before SIGKILL. Default 2 s.
  stopGraceMs?: number;
  // Injectable for tests.
  pickPort?: () => Promise<number>;
}

// The tail of the binary's own output, kept for a start failure's message.
const OUTPUT_TAIL = 2_000;

/** Connects to the binary's socket, retrying until it listens or the deadline passes. */
async function connect(
  child: ChildProcess,
  port: number,
  deadline: number,
  output: () => string,
): Promise<WebSocket> {
  for (;;) {
    if (exited(child)) {
      throw new CycleTlsStartError(
        `cycletls exited before it listened (code ${child.exitCode ?? child.signalCode})${tail(output())}`,
      );
    }
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const opened = await new Promise<boolean>((resolve) => {
      socket.once("open", () => resolve(true));
      socket.once("error", () => resolve(false));
    });
    if (opened) return socket;
    socket.terminate();
    if (Date.now() >= deadline) {
      throw new CycleTlsStartError(
        `cycletls did not listen on port ${port} in time${tail(output())}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed ? `: ${trimmed.slice(-500)}` : "";
}

/** Starts the CycleTLS binary at the given path and connects a client to it. */
export async function startCycleTls(
  executablePath: string,
  options: StartCycleTlsOptions = {},
): Promise<CycleTlsClient> {
  const port = await (options.pickPort ?? freePort)();
  const child = spawn(executablePath, [], {
    env: { ...process.env, WS_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  running.add(child);
  installExitHook();
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
  };
  // Drained so the binary never blocks on a full pipe; never sent to the CLI's
  // own stdout, which a launcher reads.
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
  child.once("exit", () => running.delete(child));

  let socket: WebSocket;
  try {
    socket = await Promise.race([
      connect(child, port, Date.now() + (options.startTimeoutMs ?? 15_000), () => output),
      spawnError.then((error) => {
        throw new CycleTlsStartError(
          `cycletls could not start from ${executablePath}: ${error.message}`,
        );
      }),
    ]);
  } catch (error) {
    await stopChild(child, 0);
    throw error;
  }

  const pending = new Map<string, Pending>();
  let closed = false;
  let sequence = 0;
  const failAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  socket.on("message", (data, isBinary) => {
    if (!isBinary) return;
    let frame: CycleTlsFrame;
    try {
      frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
    } catch {
      return;
    }
    const request = pending.get(frame.requestId);
    if (!request) return;
    switch (frame.type) {
      case "response":
        request.status = frame.status;
        request.finalUrl = frame.finalUrl;
        request.headers = frame.headers;
        break;
      case "data":
        request.chunks.push(frame.chunk);
        break;
      case "end":
        pending.delete(frame.requestId);
        request.resolve({
          status: request.status ?? 0,
          finalUrl: request.finalUrl,
          headers: request.headers,
          body: Buffer.concat(request.chunks),
        });
        break;
      case "error":
        pending.delete(frame.requestId);
        // As the binary reports it: a failed request is a status (408 for a
        // timeout, 5xx otherwise) with the reason as its body.
        request.resolve({
          status: frame.status,
          finalUrl: "",
          headers: {},
          body: Buffer.from(frame.message, "utf8"),
        });
        break;
    }
  });
  socket.on("close", () => failAll(new Error("cycletls connection closed")));
  socket.on("error", () => {});
  child.once("exit", (code, signal) => {
    if (!closed) failAll(new Error(`cycletls exited (${code ?? signal})`));
  });

  return {
    pid: child.pid,
    port,
    request(requestOptions) {
      if (closed) return Promise.reject(new Error("cycletls client is closed"));
      if (socket.readyState !== WebSocket.OPEN || exited(child)) {
        return Promise.reject(new Error("cycletls is not running"));
      }
      sequence += 1;
      const requestId = `lurkloot-${child.pid}-${sequence}`;
      return new Promise<CycleTlsResponse>((resolve, reject) => {
        pending.set(requestId, { resolve, reject, finalUrl: "", headers: {}, chunks: [] });
        socket.send(
          JSON.stringify({ requestId, options: requestFrameOptions(requestOptions) }),
          (error) => {
            if (!error) return;
            pending.delete(requestId);
            reject(error);
          },
        );
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      failAll(new Error("cycletls client is closed"));
      socket.terminate();
      await stopChild(child, options.stopGraceMs ?? 2_000);
    },
  };
}
