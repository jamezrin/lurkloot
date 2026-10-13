import { describe, expect, it, vi } from "vitest";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import { createAdmittedWebSocketFactory, createSocketAdmission } from "../src/core/socketAdmission";
import { installSocketOriginListener, rewriteSocketOrigin } from "../src/core/platformSocketOrigin";

const IRC_URL = "wss://irc-ws.chat.twitch.tv/";
const VIEWER_URL = "wss://websockets.kick.com/viewer/v1/connect?token=t";
const PUSHER_URL = "wss://ws-us2.pusher.com/app/abc123?protocol=7";

describe("socket admission", () => {
  function admission(options: { ready?: boolean; granted?: string[] } = {}) {
    const report = vi.fn();
    const hasPermission = vi.fn(async (origin: string) => (options.granted ?? ["wss://*.twitch.tv/*", "wss://*.kick.com/*", "wss://*.pusher.com/*"]).includes(origin));
    const admit = createSocketAdmission({ originReady: async () => options.ready ?? true, hasPermission, report });
    return { admit, report, hasPermission };
  }

  it("admits a platform socket once its Origin can be set and its host is granted", async () => {
    const a = admission();
    await expect(a.admit(IRC_URL)).resolves.toBe(true);
    await expect(a.admit(PUSHER_URL)).resolves.toBe(true);
    expect(a.hasPermission).toHaveBeenCalledWith("wss://*.pusher.com/*");
    expect(a.report).not.toHaveBeenCalled();
  });

  it("refuses an unlisted socket", async () => {
    const a = admission();
    await expect(a.admit("wss://evil.example/")).resolves.toBe(false);
    expect(a.report).toHaveBeenCalledWith({ platform: undefined, message: "Refused to open an unlisted socket." });
  });

  it("keeps sockets closed until the Origin rules are in place", async () => {
    const a = admission({ ready: false });
    await expect(a.admit(IRC_URL)).resolves.toBe(false);
    expect(a.report).toHaveBeenCalledWith({ platform: "twitch", message: "Twitch chat socket stays closed: its Origin cannot be set in this browser." });
  });

  it("keeps a socket closed without its wss:// host, saying so once until it opens", async () => {
    const granted = ["wss://*.twitch.tv/*"];
    const a = admission({ granted });
    await expect(a.admit(VIEWER_URL)).resolves.toBe(false);
    await expect(a.admit(VIEWER_URL)).resolves.toBe(false);
    expect(a.report).toHaveBeenCalledOnce();
    expect(a.report).toHaveBeenCalledWith({ platform: "kick", message: "Kick viewer socket stays closed until the wss://*.kick.com/* host permission is granted." });
    granted.push("wss://*.kick.com/*");
    await expect(a.admit(VIEWER_URL)).resolves.toBe(true);
    granted.pop();
    await expect(a.admit(VIEWER_URL)).resolves.toBe(false);
    expect(a.report).toHaveBeenCalledTimes(2);
  });
});

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  addEventListener(type: string, listener: (event: WebSocketMessageEventLike) => void) { (this.listeners[type] ??= []).push(listener); }
  emit(type: string, event: WebSocketMessageEventLike = {}) {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

describe("admitted socket factory (Firefox)", () => {
  const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

  it("opens the browser socket once admitted and passes its events through", async () => {
    const sockets: FakeSocket[] = [];
    const factory = createAdmittedWebSocketFactory(async () => true, () => { const socket = new FakeSocket(); sockets.push(socket); return socket; });
    const socket = factory(IRC_URL);
    const events: string[] = [];
    for (const type of ["open", "message", "close"] as const) socket.addEventListener(type, (event) => events.push(`${type}:${String(event.data ?? event.code ?? "")}`));
    socket.send("early");
    await settle();
    sockets[0]!.emit("open");
    socket.send("hello");
    sockets[0]!.emit("message", { data: "PING" });
    sockets[0]!.emit("close", { code: 1001 });
    expect(sockets[0]!.sent).toEqual(["hello"]);
    expect(events).toEqual(["open:", "message:PING", "close:1001"]);
    expect(socket.readyState).toBe(3);
  });

  it("fails closed when refused, never opening a browser socket", async () => {
    const create = vi.fn();
    const socket = createAdmittedWebSocketFactory(async () => false, create)(IRC_URL);
    const closed = vi.fn();
    socket.addEventListener("close", closed);
    await settle();
    expect(create).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledWith({ code: 1006 });
  });

  it("never opens a socket closed before admission", async () => {
    const create = vi.fn();
    const socket = createAdmittedWebSocketFactory(async () => true, create)(IRC_URL);
    socket.close();
    await settle();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("Firefox socket origin listener", () => {
  const EXTENSION = "moz-extension://1b2c3d4e-0000-4000-8000-000000000000";
  const headers = [{ name: "Host", value: "irc-ws.chat.twitch.tv" }, { name: "Origin", value: EXTENSION }];

  it("sets the platform's Origin on the extension's own platform sockets", () => {
    expect(rewriteSocketOrigin({ url: IRC_URL, originUrl: `${EXTENSION}/_generated_background_page.html`, requestHeaders: headers }, EXTENSION)).toEqual({
      requestHeaders: [{ name: "Host", value: "irc-ws.chat.twitch.tv" }, { name: "Origin", value: "https://www.twitch.tv" }],
    });
    expect(rewriteSocketOrigin({ url: PUSHER_URL, originUrl: `${EXTENSION}/background.html`, requestHeaders: headers }, EXTENSION)?.requestHeaders.at(-1)).toEqual({ name: "Origin", value: "https://kick.com" });
  });

  it("leaves a platform tab's sockets and other hosts alone", () => {
    expect(rewriteSocketOrigin({ url: IRC_URL, originUrl: "https://www.twitch.tv/somechannel", requestHeaders: headers }, EXTENSION)).toBeUndefined();
    expect(rewriteSocketOrigin({ url: IRC_URL, originUrl: "moz-extension://another-extension/page.html", requestHeaders: headers }, EXTENSION)).toBeUndefined();
    expect(rewriteSocketOrigin({ url: "wss://backend.p-n6412w7dsu.exmggames.com/handler", originUrl: `${EXTENSION}/x.html`, requestHeaders: headers }, EXTENSION)).toBeUndefined();
  });

  it("registers a blocking listener on the platform socket hosts", () => {
    const addListener = vi.fn();
    expect(installSocketOriginListener({ onBeforeSendHeaders: { addListener } }, EXTENSION)).toBe(true);
    expect(addListener).toHaveBeenCalledWith(expect.any(Function), {
      urls: ["wss://*.twitch.tv/*", "wss://*.kick.com/*", "wss://*.pusher.com/*"],
      types: ["websocket"],
    }, ["blocking", "requestHeaders"]);
    expect(installSocketOriginListener(undefined, EXTENSION)).toBe(false);
  });
});
