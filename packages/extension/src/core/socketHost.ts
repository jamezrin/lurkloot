import { forwardedFrame, socketProfileFor, type SocketProfileName } from "./socketProfiles";

// The offscreen socket host (#792). Chrome applies declarativeNetRequest to a
// WebSocket opened by a document or a worker it spawns, never to one opened
// by the service worker, so every platform socket lives here and presents the
// platform's Origin (platformRequestOrigin.ts). The document only relays
// between the service worker's port and a dedicated Worker, which owns the
// sockets. The host opens allowlisted platform URLs only, reads no cookies or
// credentials, and never sends anything the service worker did not.
export const SOCKET_HOST_PORT = "socket-host";
export const SOCKET_HOST_PATH = "socketHost.html";
// While any socket is open the host messages the service worker this often,
// which keeps it alive as its own socket traffic used to. Chrome suspends an
// idle worker after 30 s; 20 s matches Chrome's keepalive guidance.
export const SOCKET_HOST_KEEPALIVE_MS = 20_000;
export const CLOSE_ABNORMAL = 1006;

export type SocketHostRequest =
  | { type: "open"; id: number; url: string }
  | { type: "send"; id: number; data: string }
  | { type: "close"; id: number };

export type SocketHostEvent =
  | { type: "open"; id: number }
  | { type: "message"; id: number; data: string }
  | { type: "close"; id: number; code?: number }
  | { type: "keepalive" };

// The document tells its Worker to drop every socket when the service worker
// goes away.
export type SocketWorkerControl = SocketHostRequest | { type: "reset" };

interface HostedSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "open" | "message" | "close", listener: (event: { data?: unknown; code?: number }) => void): void;
}

export interface SocketWorkerDeps {
  post(event: SocketHostEvent): void;
  createWebSocket(url: string): HostedSocket;
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

// The Worker end: owns the sockets. Returns the handler for the document's
// messages.
export function startSocketWorker(deps: SocketWorkerDeps): (message: SocketWorkerControl) => void {
  const startInterval = deps.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const stopInterval = deps.clearInterval ?? ((timer) => clearInterval(timer));
  const sockets = new Map<number, { ws: HostedSocket; profile: SocketProfileName }>();
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const syncKeepalive = () => {
    if (sockets.size > 0 && keepalive === undefined) {
      keepalive = startInterval(() => deps.post({ type: "keepalive" }), SOCKET_HOST_KEEPALIVE_MS);
    } else if (sockets.size === 0 && keepalive !== undefined) {
      stopInterval(keepalive);
      keepalive = undefined;
    }
  };

  const open = (id: number, url: string) => {
    if (sockets.has(id)) return;
    const profile = socketProfileFor(url);
    if (!profile) {
      deps.post({ type: "close", id, code: CLOSE_ABNORMAL });
      return;
    }
    let ws: HostedSocket;
    try {
      ws = deps.createWebSocket(url);
    } catch {
      deps.post({ type: "close", id, code: CLOSE_ABNORMAL });
      return;
    }
    sockets.set(id, { ws, profile: profile.name });
    syncKeepalive();
    ws.addEventListener("open", () => {
      if (sockets.get(id)?.ws === ws) deps.post({ type: "open", id });
    });
    ws.addEventListener("message", (event) => {
      if (sockets.get(id)?.ws !== ws || typeof event.data !== "string") return;
      const data = forwardedFrame(profile.name, event.data);
      if (data !== undefined) deps.post({ type: "message", id, data });
    });
    ws.addEventListener("close", (event) => {
      if (sockets.get(id)?.ws !== ws) return;
      sockets.delete(id);
      syncKeepalive();
      deps.post({ type: "close", id, code: event.code });
    });
  };

  return (message) => {
    if (message.type === "open") {
      open(message.id, message.url);
    } else if (message.type === "send") {
      const socket = sockets.get(message.id);
      if (socket?.ws.readyState === 1) socket.ws.send(message.data);
    } else if (message.type === "close") {
      const socket = sockets.get(message.id);
      sockets.delete(message.id);
      syncKeepalive();
      socket?.ws.close(1000);
    } else if (message.type === "reset") {
      const closing = [...sockets.values()];
      sockets.clear();
      syncKeepalive();
      for (const { ws } of closing) ws.close(1000);
    }
  };
}

export interface SocketHostPort {
  readonly name: string;
  readonly sender?: { tab?: unknown; url?: string };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface SocketHostWorker {
  postMessage(message: SocketWorkerControl): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

// The document end: relays between the service worker's port and the Worker.
export function bridgeSocketHost(deps: { connect: (name: string) => SocketHostPort; worker: SocketHostWorker }): void {
  const port = deps.connect(SOCKET_HOST_PORT);
  let connected = true;
  port.onMessage.addListener((message) => deps.worker.postMessage(message as SocketHostRequest));
  deps.worker.addEventListener("message", (event) => {
    if (!connected) return;
    try {
      port.postMessage(event.data);
    } catch {
      // The service worker went away; onDisconnect resets the Worker.
    }
  });
  // A stopped or restarted service worker leaves no socket behind; the next
  // one replaces this document.
  port.onDisconnect.addListener(() => {
    connected = false;
    deps.worker.postMessage({ type: "reset" });
  });
}
