import type { WebSocketFactory, WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import type { Platform } from "@lurkloot/shared/models";
import { socketProfileFor, type SocketProfileName } from "./socketProfiles";

// A platform socket opens only once its Origin can be rewritten (#792). It
// fails closed: never a handshake with the extension's own origin.
export type SocketRefusal = "unlisted" | "origin-rules" | "permission";

export interface SocketAdmissionDeps {
  // Resolves true once the browser rewrites socket Origins: the DNR rules on
  // Chrome, the webRequest listener on Firefox.
  originReady(): Promise<boolean>;
  hasPermission(origin: string): Promise<boolean>;
  report(refusal: { platform: Platform | undefined; message: string }): void;
}

export type SocketAdmission = (url: string) => Promise<boolean>;

const SOCKET_LABELS: Record<SocketProfileName, string> = {
  "twitch-hermes": "Twitch push",
  "twitch-irc": "Twitch chat",
  "kick-realtime": "Kick realtime",
  "kick-pusher": "Kick realtime (Pusher)",
  "kick-viewer": "Kick viewer",
};

export function createSocketAdmission(deps: SocketAdmissionDeps): SocketAdmission {
  // One diagnostic per socket and reason until it opens again: reconnect
  // backoff retries a refused socket for as long as the cause lasts.
  const reported = new Set<string>();
  const refuse = (key: string, platform: Platform | undefined, message: string) => {
    if (reported.has(key)) return false;
    reported.add(key);
    deps.report({ platform, message });
    return false;
  };
  return async (url) => {
    const profile = socketProfileFor(url);
    if (!profile) return refuse("unlisted", undefined, "Refused to open an unlisted socket.");
    const label = SOCKET_LABELS[profile.name];
    let ready = false;
    try {
      ready = await deps.originReady();
    } catch {
      ready = false;
    }
    if (!ready) {
      return refuse(`${profile.name}:origin-rules`, profile.platform, `${label} socket stays closed: its Origin cannot be set in this browser.`);
    }
    let granted = false;
    try {
      granted = await deps.hasPermission(profile.permission);
    } catch {
      granted = false;
    }
    if (!granted) {
      return refuse(`${profile.name}:permission`, profile.platform, `${label} socket stays closed until the ${profile.permission} host permission is granted.`);
    }
    for (const key of [...reported]) if (key.startsWith(`${profile.name}:`)) reported.delete(key);
    return true;
  };
}

// Firefox: a plain socket, opened once admitted. Its Origin is rewritten by
// the webRequest listener (platformSocketOrigin.ts).
export function createAdmittedWebSocketFactory(admit: SocketAdmission, create: WebSocketFactory): WebSocketFactory {
  return (url) => new AdmittedSocket(url, admit, create);
}

class AdmittedSocket implements WebSocketLike {
  readyState = 0;
  private socket?: WebSocketLike;
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};

  constructor(url: string, admit: SocketAdmission, create: WebSocketFactory) {
    void admit(url).then((admitted) => {
      if (this.readyState !== 0) return;
      if (!admitted) {
        this.fail();
        return;
      }
      let socket: WebSocketLike;
      try {
        socket = create(url);
      } catch {
        this.fail();
        return;
      }
      this.socket = socket;
      socket.addEventListener("open", (event) => {
        if (this.socket !== socket) return;
        this.readyState = 1;
        this.emit("open", event);
      });
      socket.addEventListener("message", (event) => {
        if (this.socket === socket) this.emit("message", event);
      });
      socket.addEventListener("error", (event) => {
        if (this.socket === socket) this.emit("error", event);
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket || this.readyState === 3) return;
        this.readyState = 3;
        this.emit("close", event);
      });
    }, () => this.fail());
  }

  send(data: string): void {
    if (this.readyState === 1) this.socket?.send(data);
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    queueMicrotask(() => this.emit("close", { code: 1000 }));
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketMessageEventLike) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  private fail(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: 1006 });
  }

  private emit(type: string, event: WebSocketMessageEventLike): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}
