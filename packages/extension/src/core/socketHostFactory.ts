import type {
  WebSocketFactory,
  WebSocketLike,
  WebSocketMessageEventLike,
} from "@lurkloot/core/webSocket";
import type { SocketAdmission } from "./socketAdmission";
import {
  CLOSE_ABNORMAL,
  SOCKET_HOST_PORT,
  type SocketHostEvent,
  type SocketHostPort,
  type SocketHostRequest,
} from "./socketHost";

// How long the factory waits for the host document to connect after creating
// it.
const HOST_CONNECT_TIMEOUT_MS = 15_000;
// The offscreen document closes once no socket has needed it this long.
const HOST_IDLE_CLOSE_MS = 10_000;

export interface SocketHostDocument {
  onConnect: { addListener(listener: (port: SocketHostPort) => void): void };
  // The host document's own URL: only its port is accepted.
  documentUrl: string;
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  admit: SocketAdmission;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

// The service worker end: a WebSocketFactory whose sockets live in the
// offscreen socket host (socketHost.ts). Create it once, synchronously when
// the worker starts, so onConnect is registered before the document connects.
export function createSocketHostFactory(host: SocketHostDocument): WebSocketFactory {
  const setTimer = host.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = host.clearTimer ?? ((timer) => clearTimeout(timer));
  const sockets = new Map<number, HostSocket>();
  let nextId = 1;
  let port: SocketHostPort | undefined;
  let connecting: Promise<SocketHostPort> | undefined;
  let waiting: ((port: SocketHostPort) => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  host.onConnect.addListener((candidate) => {
    // Only our own offscreen document: never a tab or a content script.
    if (
      candidate.name !== SOCKET_HOST_PORT
      || candidate.sender?.tab
      || candidate.sender?.url !== host.documentUrl
    )
      return;
    port?.disconnect();
    port = candidate;
    candidate.onMessage.addListener((message) => {
      if (port !== candidate) return;
      const event = message as SocketHostEvent;
      // A keepalive only has to arrive: it keeps this worker running.
      if (event.type === "keepalive") return;
      sockets.get(event.id)?.receive(event);
    });
    candidate.onDisconnect.addListener(() => {
      if (port !== candidate) return;
      port = undefined;
      for (const socket of [...sockets.values()])
        socket.receive({ type: "close", id: socket.id, code: CLOSE_ABNORMAL });
    });
    waiting?.(candidate);
    waiting = undefined;
  });

  async function hostPort(): Promise<SocketHostPort> {
    if (port) return port;
    connecting ??= (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // A document from an earlier worker has no live port; start afresh.
        try {
          if (await host.hasDocument()) await host.closeDocument();
        } catch {
          // Already gone; createDocument below decides.
        }
        const connected = new Promise<SocketHostPort>((resolve, reject) => {
          waiting = resolve;
          timeout = setTimer(
            () => reject(new Error("The socket host did not connect")),
            HOST_CONNECT_TIMEOUT_MS,
          );
        });
        // A failed createDocument skips the await below; the timeout must not
        // then reject an unobserved promise.
        connected.catch(() => undefined);
        await host.createDocument();
        return await connected;
      } finally {
        if (timeout !== undefined) clearTimer(timeout);
        timeout = undefined;
        connecting = undefined;
        waiting = undefined;
      }
    })();
    return await connecting;
  }

  function released(id: number): void {
    sockets.delete(id);
    if (sockets.size > 0 || idleTimer !== undefined) return;
    idleTimer = setTimer(() => {
      idleTimer = undefined;
      if (sockets.size > 0) return;
      port?.disconnect();
      port = undefined;
      void host
        .hasDocument()
        .then((open) => (open ? host.closeDocument() : undefined))
        .catch(() => undefined);
    }, HOST_IDLE_CLOSE_MS);
  }

  class HostSocket implements WebSocketLike {
    readyState = 0;
    private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> =
      {};
    private relay?: SocketHostPort;

    constructor(
      readonly id: number,
      url: string,
    ) {
      host
        .admit(url)
        .then(async (admitted) => {
          if (!admitted) throw new Error("Socket refused");
          const connected = await hostPort();
          if (this.readyState !== 0) return;
          this.relay = connected;
          connected.postMessage({ type: "open", id, url } satisfies SocketHostRequest);
        })
        .catch(() => this.receive({ type: "close", id, code: CLOSE_ABNORMAL }));
    }

    send(data: string): void {
      if (this.readyState !== 1) return;
      this.relay?.postMessage({ type: "send", id: this.id, data } satisfies SocketHostRequest);
    }

    close(): void {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      try {
        this.relay?.postMessage({ type: "close", id: this.id } satisfies SocketHostRequest);
      } catch {
        // The host is gone; its socket closed with it.
      }
      released(this.id);
      queueMicrotask(() => this.emit("close", { code: 1000 }));
    }

    addEventListener(
      type: "open" | "message" | "close" | "error",
      listener: (event: WebSocketMessageEventLike) => void,
    ): void {
      (this.listeners[type] ??= []).push(listener);
    }

    receive(event: Exclude<SocketHostEvent, { type: "keepalive" }>): void {
      if (this.readyState === 3) return;
      if (event.type === "open") {
        this.readyState = 1;
        this.emit("open", {});
      } else if (event.type === "message") {
        this.emit("message", { data: event.data });
      } else {
        this.readyState = 3;
        released(this.id);
        this.emit("close", { code: event.code });
      }
    }

    private emit(type: string, event: WebSocketMessageEventLike): void {
      for (const listener of this.listeners[type] ?? []) listener(event);
    }
  }

  return (url) => {
    if (idleTimer !== undefined) clearTimer(idleTimer);
    idleTimer = undefined;
    const socket = new HostSocket(nextId++, url);
    sockets.set(socket.id, socket);
    return socket;
  };
}
