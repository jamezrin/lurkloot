import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { constants } from "node:os";
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
  // False once the binary exited or its socket closed; it then takes no
  // requests (restartingCycleTls starts a new one).
  readonly running: boolean;
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

/** Reads only a frame's request id, for a frame that does not decode. */
export function frameRequestId(buffer: Buffer): string | undefined {
  try {
    return new FrameReader(buffer).string();
  } catch {
    return undefined;
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
      // ws hands each message its own buffer, so the slice is the chunk's own.
      return { requestId, type, chunk: reader.bytes(reader.u32()) };
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
  timer: NodeJS.Timeout;
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
// the process ends as the signal would have ended it.
const ENDING_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Tells whether anything but the backstop listens for the signal right now. */
export function othersHandle(signal: NodeJS.Signals, self: (...args: unknown[]) => void): boolean {
  return process.listeners(signal).some((listener) => listener !== self);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", killRunning);
  for (const signal of ENDING_SIGNALS) {
    const onSignal = () => {
      // Prepended, so this runs before a command's own process.once() handler
      // removes itself, and sees it.
      if (othersHandle(signal, onSignal)) return;
      killRunning();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
      // A signal the process ignores even without a handler (SIGTERM to PID 1
      // in a container) would leave it running: end it as the signal would.
      setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 100).unref();
    };
    try {
      process.prependListener(signal, onSignal);
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
  // How long a request may go unanswered before the client gives up on it.
  // Default: the request's own timeout plus 30 s, or 60 s.
  requestDeadlineMs?: (options: CycleTlsRequestOptions) => number;
  // Injectable for tests.
  pickPort?: () => Promise<number>;
}

function defaultDeadline(options: CycleTlsRequestOptions): number {
  return options.timeout === undefined ? 60_000 : options.timeout * 1_000 + 30_000;
}

// How long the binary must stay up after the socket opens: a binary that could
// not bind its port exits at once, and the socket then reached another program.
const SETTLE_MS = 150;

// The tail of the binary's own output, kept for a start failure's message.
const OUTPUT_TAIL = 2_000;

/** Connects to the binary's socket, retrying until it listens or the deadline passes. */
async function connect(
  child: ChildProcess,
  port: number,
  deadline: number,
  output: () => string,
  abandoned: () => boolean,
): Promise<WebSocket> {
  for (;;) {
    if (abandoned()) throw new CycleTlsStartError("cycletls start abandoned");
    if (exited(child)) {
      throw new CycleTlsStartError(
        `cycletls exited before it listened (code ${child.exitCode ?? child.signalCode})${tail(output())}`,
      );
    }
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 2_000 });
    const opened = await new Promise<boolean>((resolve) => {
      socket.once("open", () => resolve(true));
      socket.once("error", () => resolve(false));
    });
    if (opened) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      if (!exited(child) && socket.readyState === WebSocket.OPEN) return socket;
      socket.terminate();
      throw new CycleTlsStartError(
        `cycletls did not start on port ${port}; another program answered there${tail(output())}`,
      );
    }
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
  // own stdout, which a launcher reads. Kept only until it is up.
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let startFailed = false;
  const spawnError = new Promise<Error>((resolve) =>
    child.once("error", (error) => {
      startFailed = true;
      resolve(error);
    }),
  );
  // A failed spawn fires "error" and "close" but never "exit".
  child.once("close", () => running.delete(child));
  child.once("exit", () => running.delete(child));

  let socket: WebSocket;
  try {
    socket = await Promise.race([
      connect(
        child,
        port,
        Date.now() + (options.startTimeoutMs ?? 15_000),
        () => output,
        () => startFailed,
      ),
      spawnError.then((error) => {
        throw new CycleTlsStartError(
          `cycletls could not start from ${executablePath}: ${error.message}`,
        );
      }),
    ]);
  } catch (error) {
    startFailed = true;
    running.delete(child);
    if (child.pid !== undefined) await stopChild(child, 0);
    throw error;
  }
  for (const stream of [child.stdout, child.stderr]) {
    stream?.off("data", keep);
    stream?.resume();
  }

  const pending = new Map<string, Pending>();
  let closed = false;
  let sequence = 0;
  let socketOpen = true;
  const settle = (requestId: string): Pending | undefined => {
    const request = pending.get(requestId);
    if (!request) return undefined;
    pending.delete(requestId);
    clearTimeout(request.timer);
    return request;
  };
  const failAll = (error: Error) => {
    for (const requestId of [...pending.keys()]) settle(requestId)?.reject(error);
  };

  socket.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
    let frame: CycleTlsFrame;
    try {
      frame = decodeFrame(buffer);
    } catch {
      const requestId = frameRequestId(buffer);
      if (requestId !== undefined) {
        settle(requestId)?.reject(new Error("cycletls sent a frame that does not decode"));
      }
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
        settle(frame.requestId);
        request.resolve({
          status: request.status ?? 0,
          finalUrl: request.finalUrl,
          headers: request.headers,
          body: Buffer.concat(request.chunks),
        });
        break;
      case "error":
        settle(frame.requestId);
        // As the binary reports it: a failed request is a status (408 for a
        // timeout, 5xx otherwise) with the reason as its body.
        request.resolve({
          status: frame.status,
          finalUrl: "",
          headers: {},
          body: Buffer.from(frame.message, "utf8"),
        });
        break;
      case "unknown":
        settle(frame.requestId);
        request.reject(new Error(`cycletls sent an unknown frame type ${frame.name}`));
        break;
    }
  });
  socket.on("close", () => {
    socketOpen = false;
    failAll(new Error("cycletls connection closed"));
  });
  socket.on("error", () => {});
  child.once("exit", (code, signal) => {
    if (!closed) failAll(new Error(`cycletls exited (${code ?? signal})`));
  });

  const deadlineOf = options.requestDeadlineMs ?? defaultDeadline;
  return {
    pid: child.pid,
    port,
    get running() {
      return !closed && socketOpen && !exited(child);
    },
    request(requestOptions) {
      if (closed) return Promise.reject(new Error("cycletls client is closed"));
      if (!socketOpen || socket.readyState !== WebSocket.OPEN || exited(child)) {
        return Promise.reject(new Error("cycletls is not running"));
      }
      sequence += 1;
      const requestId = `lurkloot-${child.pid}-${sequence}`;
      return new Promise<CycleTlsResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(requestId)?.reject(new Error("cycletls did not answer the request in time"));
        }, deadlineOf(requestOptions));
        timer.unref();
        pending.set(requestId, { resolve, reject, timer, finalUrl: "", headers: {}, chunks: [] });
        socket.send(
          JSON.stringify({ requestId, options: requestFrameOptions(requestOptions) }),
          (error) => {
            if (error) settle(requestId)?.reject(error);
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

/**
 * A client that starts the binary on first use (or adopts `initial`, which it
 * then owns and closes) and starts a new one when the
 * last exited or lost its socket (a crash, say), so a long `run` recovers on
 * its next request instead of failing every one until restarted. The dead
 * binary is ended before its replacement starts.
 */
export function restartingCycleTls(
  start: () => Promise<CycleTlsClient>,
  initial?: CycleTlsClient,
): CycleTlsClient {
  let current: CycleTlsClient | undefined = initial;
  let starting: Promise<CycleTlsClient> | undefined;
  let closed = false;
  const live = async (): Promise<CycleTlsClient> => {
    if (closed) throw new Error("cycletls client is closed");
    if (current?.running) return current;
    if (!starting) {
      starting = (async () => {
        const dead = current;
        current = undefined;
        await dead?.close();
        const next = await start();
        if (closed) {
          await next.close();
          throw new Error("cycletls client is closed");
        }
        current = next;
        return next;
      })().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  };
  return {
    get pid() {
      return current?.pid;
    },
    get port() {
      return current?.port ?? 0;
    },
    get running() {
      return !closed && (current?.running ?? false);
    },
    async request(options) {
      return (await live()).request(options);
    },
    async close() {
      closed = true;
      await starting?.catch(() => undefined);
      await current?.close();
      current = undefined;
    },
  };
}
