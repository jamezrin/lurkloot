import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIPv4, isIPv6, type AddressInfo } from "node:net";
import type { CoreRuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type {
  EngineSettings,
  Platform,
  PlatformAuthReasonCode,
  PlatformAuthStatus,
} from "@lurkloot/shared/models";
import { errorMessage } from "@lurkloot/shared/errors";
import type { CredentialSource, LocalCredentialHealth } from "../authStore";
import type { Logger } from "../logger";
import { CliSettingsStoreError } from "../settingsStore";
import { serveAppAsset } from "./appAssets";

// `lurkloot serve`'s local HTTP control plane (#975). It carries the popup's
// own RuntimeMessage contract to the farming controller, behind a loopback
// bind, an optional bearer token and a Host check. It never reads credentials:
// the session view is built from safe health fields only.

export const SERVE_TOKEN_ENV = "LURKLOOT_SERVE_TOKEN";
export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 8420;
// A token guarding a non-loopback bind must not be guessable.
export const MIN_SERVE_TOKEN_LENGTH = 16;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
// One process serves one account; the id lets a later multi-account host add
// sessions without changing the protocol.
export const DEFAULT_SESSION_ID = "default";

const PLATFORMS: readonly Platform[] = ["twitch", "kick"];

// The messages the CLI host supports: whether each names a platform, and
// whether it writes settings. Anything else, extension-only messages included
// (getTabId, playbackTelemetry, getPlaybackControl, exportCliCredentials,
// resumeAfterManualClose), is refused before it reaches the controller.
const SUPPORTED_MESSAGES = {
  getSnapshot: { platform: false, writesSettings: false },
  setPlatformEnabled: { platform: true, writesSettings: true },
  setAutomation: { platform: true, writesSettings: true },
  saveSettings: { platform: false, writesSettings: true },
  updateIdleWatchlist: { platform: true, writesSettings: true },
  claimReward: { platform: true, writesSettings: false },
  selectRewardLane: { platform: true, writesSettings: false },
  searchCategories: { platform: true, writesSettings: false },
  tickNow: { platform: false, writesSettings: false },
  dismissCriticalFailure: { platform: true, writesSettings: false },
} as const satisfies Partial<
  Record<CoreRuntimeMessage["type"], { platform: boolean; writesSettings: boolean }>
>;

export type ControlPlaneMessageType = keyof typeof SUPPORTED_MESSAGES;
export type ControlPlaneMessage = Extract<CoreRuntimeMessage, { type: ControlPlaneMessageType }>;
export const SUPPORTED_MESSAGE_TYPES = Object.keys(
  SUPPORTED_MESSAGES,
) as readonly ControlPlaneMessageType[];

export function isSupportedMessageType(type: string): type is ControlPlaneMessageType {
  return Object.hasOwn(SUPPORTED_MESSAGES, type);
}

export type ControlPlaneErrorCode =
  | "forbidden_host"
  | "forbidden_origin"
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_message"
  | "unsupported_message"
  | "settings_read_only"
  | "settings_unrepresentable"
  | "settings_invalid"
  | "settings_unavailable"
  | "settings_not_saved"
  | "shutting_down"
  | "internal_error"
  // Sign-in routes (controlPlaneAuth.ts).
  | "invalid_request"
  | "invalid_redirect"
  | "login_rejected"
  | "login_cancelled"
  | "upstream_unavailable";

export class ServeConfigError extends Error {}

// True for a name that can only reach this machine: localhost, 127.0.0.0/8 and
// ::1 (bracketed or not, IPv4-mapped included).
export function isLoopbackHost(name: string): boolean {
  const host = name
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host === "localhost.") return true;
  if (isIPv4(host)) return host.startsWith("127.");
  if (isIPv6(host)) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    return mapped ? mapped[1]!.startsWith("127.") : false;
  }
  return false;
}

// The host name of a Host header value, without its port.
export function hostHeaderName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.indexOf(":");
  // More than one colon is a bare IPv6 address, which a Host header may not
  // carry; leave it whole so it fails every comparison.
  if (colon === -1 || trimmed.indexOf(":", colon + 1) !== -1) return trimmed;
  return trimmed.slice(0, colon);
}

export interface ServeBinding {
  host: string;
  port: number;
  token?: string;
}

// Validates the bind before anything starts: a non-loopback host needs an
// access token, and a token must be long enough to be one.
export function resolveServeBinding(input: {
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
}): ServeBinding {
  const host = (input.host ?? DEFAULT_SERVE_HOST).trim();
  if (!host) throw new ServeConfigError("--host must not be empty");
  const port = input.port ?? DEFAULT_SERVE_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ServeConfigError(`--port must be an integer from 0 to 65535, got ${port}`);
  const rawToken = (input.env ?? process.env)[SERVE_TOKEN_ENV]?.trim();
  const token = rawToken ? rawToken : undefined;
  if (token && token.length < MIN_SERVE_TOKEN_LENGTH)
    throw new ServeConfigError(
      `${SERVE_TOKEN_ENV} must be at least ${MIN_SERVE_TOKEN_LENGTH} characters long`,
    );
  if (!isLoopbackHost(host) && !token)
    throw new ServeConfigError(
      `Refusing to bind ${host} without an access token: set ${SERVE_TOKEN_ENV}, or bind a loopback address`,
    );
  return token ? { host, port, token } : { host, port };
}

export interface SessionPlatformView {
  enabled: boolean;
  auth: {
    // The engine's last live probe.
    status: PlatformAuthStatus;
    reasonCode?: PlatformAuthReasonCode;
    checkedAt?: string;
    // What the local credential store holds: presence and origin only.
    credential: {
      present: boolean;
      source: CredentialSource;
      status: LocalCredentialHealth["status"];
    };
  };
}

export interface SessionView {
  id: string;
  version: string;
  platforms: Record<Platform, SessionPlatformView>;
}

// Picks named safe fields only, so nothing added to the snapshot or the
// credential reading later can leak through the session view.
export function buildSessionView(input: {
  id?: string;
  version: string;
  snapshot: RuntimeSnapshot<EngineSettings>;
  credentials: Record<Platform, LocalCredentialHealth>;
}): SessionView {
  const view = (platform: Platform): SessionPlatformView => {
    const live = input.snapshot.state.authHealth[platform];
    const local = input.credentials[platform];
    return {
      enabled: input.snapshot.settings.platform[platform].enabled,
      auth: {
        status: live.status,
        ...(live.reasonCode ? { reasonCode: live.reasonCode } : {}),
        ...(live.checkedAt ? { checkedAt: live.checkedAt } : {}),
        credential: { present: local.present, source: local.source, status: local.status },
      },
    };
  };
  return {
    id: input.id ?? DEFAULT_SESSION_ID,
    version: input.version,
    platforms: { twitch: view("twitch"), kick: view("kick") },
  };
}

// A route a feature module adds beside the built-in ones, such as the sign-in
// routes. It runs behind the same Host, Origin and token guard; a POST body is
// read with the same content-type requirement and size limit before the
// handler runs (an empty body reads as {}).
export interface ControlPlaneRoute {
  method: "GET" | "POST" | "DELETE";
  path: string;
  handle(body: unknown): Promise<{ status?: number; body: unknown }>;
}

export interface ControlPlaneOptions extends ServeBinding {
  // True when the settings store applies and saves a patch (serve's config-file
  // store, #1000). A host without one refuses the settings messages with
  // settings_read_only.
  settingsWritable?: boolean;
  handleMessage(message: ControlPlaneMessage): Promise<unknown>;
  describeSession(): Promise<SessionView>;
  logger: Logger;
  maxBodyBytes?: number;
  routes?: readonly ControlPlaneRoute[];
  // The app UI's built bundle (appAssets.ts), served at every path outside
  // /v1. Without one, those paths are 404s, as before.
  appRoot?: string;
}

export interface ControlPlane {
  host: string;
  port: number;
  close(): Promise<void>;
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ControlPlaneErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
    // The settings paths a rejected change is about.
    readonly paths?: string[],
  ) {
    super(message);
  }
}

// A settings change the config-file store refused. A change it cannot hold or
// accept is the caller's (400, with the offending paths); a config file it
// cannot read or would not write back is the host's (5xx). Either way nothing
// was saved, and the controller kept its settings.
function settingsStoreRequestError(error: CliSettingsStoreError): RequestError {
  switch (error.code) {
    case "unrepresentable":
      return new RequestError(400, "settings_unrepresentable", error.message, {}, error.paths);
    case "invalid":
      return new RequestError(400, "settings_invalid", error.message, {}, error.paths);
    case "config_unreadable":
      return new RequestError(
        503,
        "settings_unavailable",
        "The config file could not be read; settings were not changed",
        {},
        error.paths,
      );
    case "verification_failed":
      return new RequestError(
        500,
        "settings_not_saved",
        "The config file could not be updated; settings were not changed",
        {},
        error.paths,
      );
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// Constant-time: both sides are hashed to equal-length digests first.
function tokenMatches(header: string | undefined, expected: Buffer): boolean {
  const match = header ? /^Bearer[ \t]+(\S+)\s*$/i.exec(header) : null;
  const matches = timingSafeEqual(digest(match?.[1] ?? ""), expected);
  return matches && match !== null;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(text);
}

function sendError(response: ServerResponse, error: RequestError): void {
  sendJson(
    response,
    error.status,
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.paths ? { paths: error.paths } : {}),
      },
    },
    error.headers,
  );
}

const ROUTES: Record<string, "GET" | "POST"> = {
  "/v1/health": "GET",
  "/v1/session": "GET",
  "/v1/session/messages": "POST",
};

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://control-plane").pathname;
  } catch {
    return "/";
  }
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit)
    return Promise.reject(
      new RequestError(413, "payload_too_large", "Request body too large", {
        connection: "close",
      }),
    );
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    request.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        request.pause();
        rejectBody(
          new RequestError(413, "payload_too_large", "Request body too large", {
            connection: "close",
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (done) return;
      done = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (done) return;
      done = true;
      rejectBody(error);
    });
  });
}

// A JSON content type forces a CORS preflight, which fails with no CORS
// headers, so a cross-site form or text/plain POST never gets here.
async function readJsonBody(
  request: IncomingMessage,
  limit: number,
  allowEmpty = false,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType))
    throw new RequestError(415, "unsupported_media_type", "Send application/json");
  const text = await readBody(request, limit);
  if (allowEmpty && !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "invalid_json", "The body is not valid JSON");
  }
}

// Shape checks before the controller sees a message: a supported type, and a
// known platform on the messages that name one. Field-level validation of a
// settings patch is the settings store's job (#976); only the fields the
// controller reads before the store sees the change are checked here.
function settingsMessageFieldError(
  type: ControlPlaneMessageType,
  value: Record<string, unknown>,
): string | undefined {
  switch (type) {
    case "saveSettings": {
      const patch = value.settingsPatch;
      return patch === null || typeof patch !== "object" || Array.isArray(patch)
        ? "saveSettings needs a settingsPatch object"
        : undefined;
    }
    case "setPlatformEnabled":
    case "setAutomation":
      return typeof value.enabled === "boolean" ? undefined : `${type} needs a boolean enabled`;
    case "updateIdleWatchlist":
      return typeof value.channel === "string"
        && (value.action === "add" || value.action === "remove")
        ? undefined
        : "updateIdleWatchlist needs a string channel and action add or remove";
    default:
      return undefined;
  }
}

export function parseControlPlaneMessage(
  value: unknown,
  settingsWritable = false,
): ControlPlaneMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RequestError(400, "invalid_message", "The body must be a JSON object");
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string")
    throw new RequestError(400, "invalid_message", "The message needs a string type");
  if (!isSupportedMessageType(type))
    throw new RequestError(
      422,
      "unsupported_message",
      `Message type ${JSON.stringify(type.slice(0, 64))} is not supported by the CLI host`,
    );
  if (SUPPORTED_MESSAGES[type].platform) {
    const platform = (value as { platform?: unknown }).platform;
    if (typeof platform !== "string" || !PLATFORMS.includes(platform as Platform))
      throw new RequestError(400, "invalid_message", `${type} needs platform twitch or kick`);
  }
  const fieldError = settingsMessageFieldError(type, value as Record<string, unknown>);
  if (fieldError) throw new RequestError(400, "invalid_message", fieldError);
  if (SUPPORTED_MESSAGES[type].writesSettings && !settingsWritable)
    throw new RequestError(
      409,
      "settings_read_only",
      `${type} changes settings, which this host reads from its config file only`,
    );
  return value as ControlPlaneMessage;
}

export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlane> {
  const { logger } = options;
  const loopbackBind = isLoopbackHost(options.host);
  const expectedToken = options.token ? digest(options.token) : undefined;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES;
  let closing = false;

  // The app's files are what a browser loads before it can ask for the
  // token, so they need no token; the Host check still applies.
  const guardHost = (request: IncomingMessage): void => {
    const hostHeader = request.headers.host;
    // DNS rebinding: a page on a hostile name that resolves to 127.0.0.1
    // still sends its own name as Host.
    if (loopbackBind && (!hostHeader || !isLoopbackHost(hostHeaderName(hostHeader))))
      throw new RequestError(403, "forbidden_host", "Host header is not a loopback name");
  };

  const guard = (request: IncomingMessage): void => {
    const hostHeader = request.headers.host;
    guardHost(request);
    // Cross-site requests from a browser: only a same-origin page may call.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      let originHost: string | undefined;
      try {
        const parsed = new URL(origin);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") originHost = parsed.host;
      } catch {
        originHost = undefined;
      }
      if (!originHost || !hostHeader || originHost.toLowerCase() !== hostHeader.toLowerCase())
        throw new RequestError(403, "forbidden_origin", "Cross-origin requests are not allowed");
    }
    if (expectedToken && !tokenMatches(request.headers.authorization, expectedToken))
      throw new RequestError(401, "unauthorized", "A valid bearer token is required", {
        "www-authenticate": "Bearer",
      });
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closing) throw new RequestError(503, "shutting_down", "The server is shutting down");
    const path = requestPath(request);
    if (options.appRoot && path !== "/v1" && !path.startsWith("/v1/")) {
      guardHost(request);
      await serveAppAsset(options.appRoot, request, response, path);
      return;
    }
    guard(request);
    const extra = options.routes?.filter((candidate) => candidate.path === path) ?? [];
    if (extra.length > 0) {
      const match = extra.find((candidate) => candidate.method === request.method);
      if (!match) {
        const allowed = extra.map((candidate) => candidate.method).join(", ");
        throw new RequestError(405, "method_not_allowed", `This endpoint allows ${allowed}`, {
          allow: allowed,
        });
      }
      const body =
        match.method === "POST" ? await readJsonBody(request, maxBodyBytes, true) : undefined;
      const result = await match.handle(body);
      sendJson(response, result.status ?? 200, result.body);
      return;
    }
    const method = ROUTES[path];
    if (!method) throw new RequestError(404, "not_found", "No such endpoint");
    if (request.method !== method)
      throw new RequestError(405, "method_not_allowed", `This endpoint requires ${method}`, {
        allow: method,
      });
    if (path === "/v1/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (path === "/v1/session") {
      sendJson(response, 200, await options.describeSession());
      return;
    }
    const body = await readJsonBody(request, maxBodyBytes);
    const message = parseControlPlaneMessage(body, options.settingsWritable ?? false);
    const result = await options.handleMessage(message);
    sendJson(response, 200, { result: result ?? null });
  };

  const server = createServer((request, response) => {
    route(request, response)
      .catch((error: unknown) => {
        // A file that failed mid-stream: its status is already out.
        if (response.headersSent) {
          logger.error(errorMessage(error), "serve");
          response.destroy();
          return;
        }
        if (error instanceof RequestError) {
          sendError(response, error);
          return;
        }
        if (error instanceof CliSettingsStoreError) {
          const mapped = settingsStoreRequestError(error);
          if (mapped.status >= 500) logger.error(errorMessage(error), "serve");
          sendError(response, mapped);
          return;
        }
        // Engine errors are English diagnostics with no credential values,
        // but the body still carries only a generic message.
        logger.error(errorMessage(error), "serve");
        sendError(response, new RequestError(500, "internal_error", "The request failed"));
      })
      .finally(() => {
        // The path only: a query string is the client's and could carry anything.
        logger.debug(`${request.method} ${requestPath(request)} ${response.statusCode}`, "serve");
        // An unread body (refused or over the limit) must not keep the socket.
        if (!request.complete) response.once("finish", () => request.destroy());
      });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  server.on("error", (error) => logger.error(errorMessage(error), "serve"));
  const address = server.address() as AddressInfo;
  const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${shownHost}:${address.port}/`;
  // A wildcard bind is no address to open: name the one that works here.
  const wildcard = address.address === "0.0.0.0" || address.address === "::";
  const localNote = wildcard ? `, on this machine http://127.0.0.1:${address.port}/` : "";
  const tokenNote = expectedToken ? " (bearer token required)" : "";
  logger.info(
    options.appRoot
      ? `App and control plane at ${url}${tokenNote}${localNote}`
      : `Control plane listening on ${url.slice(0, -1)}${tokenNote}`,
    "serve",
  );

  return {
    host: address.address,
    port: address.port,
    close: () =>
      new Promise<void>((resolveClose) => {
        if (closing) {
          resolveClose();
          return;
        }
        closing = true;
        server.close(() => resolveClose());
        // Keep-alive sockets would hold close() open indefinitely.
        server.closeAllConnections();
      }),
  };
}
