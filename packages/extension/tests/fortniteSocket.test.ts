import { afterEach, describe, expect, it, vi } from "vitest";
import { connectFortniteSocket } from "../src/extensions/fortnite/socket";
import type { WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
class Socket {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  listeners = new Map<string, Set<(event: WebSocketMessageEventLike) => void>>();
  reply?: (message: Record<string, unknown>) => void;
  addEventListener(type: string, listener: (event: WebSocketMessageEventLike) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: string, listener: (event: WebSocketMessageEventLike) => void) { this.listeners.get(type)?.delete(listener); }
  send(data: string) { const message = JSON.parse(data); this.sent.push(message); this.reply?.(message); }
  close() { this.readyState = 3; this.event("close", {}); }
  event(type: string, event: WebSocketMessageEventLike) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  message(message: unknown) { this.event("message", { data: JSON.stringify(message) }); }
}
afterEach(() => vi.useRealTimers());
describe("Fortnite privileged socket transport", () => {
  it("correlates immediate responses, sends normal empty-property hello and adopts connection ID", async () => {
    const socket = new Socket();
    socket.reply = (message) => socket.message({ commandId: message.commandId, connectionId: "connection", serverTime: Date.now(), payload: { ok: true }, properties: { epicDeviceId: "private" } });
    const connection = await connectFortniteSocket({ createSocket: (url) => { expect(url).toBe("wss://backend.p-n6412w7dsu.exmggames.com/handler"); return socket; }, signal: new AbortController().signal, onPush: vi.fn() });
    expect(await connection.command("service.hello")).toEqual({ ok: true });
    expect(socket.sent[0].payload).toEqual({ properties: {} });
    await connection.command("campaign.get"); expect(socket.sent[1].connectionId).toBe("connection");
    expect(socket.sent[0].time).toBe(1); expect(socket.sent[1].time).toBe(2);
    connection.close();
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
  it("delivers unsolicited state pushes separately and never returns server properties", async () => {
    const socket = new Socket(); const push = vi.fn();
    const connection = await connectFortniteSocket({ createSocket: () => socket, signal: new AbortController().signal, onPush: push });
    socket.message({ type: "states.change", payload: { states: [] }, properties: { epicSessionToken: "private" } });
    expect(push).toHaveBeenCalledExactlyOnceWith({ type: "states.change", payload: { states: [] } });
    connection.close();
  });
  it("bounds unanswered commands and closes their connection", async () => {
    vi.useFakeTimers(); const socket = new Socket();
    const connection = await connectFortniteSocket({ createSocket: () => socket, signal: new AbortController().signal, onPush: vi.fn() });
    const pending = connection.command("campaign.get"); const assertion = expect(pending).rejects.toThrow("Fortnite command timed out.");
    await vi.advanceTimersByTimeAsync(30_000); await assertion;
    expect(socket.readyState).toBe(3); await connection.closed;
  });
  it("uses vendor ping cadence and stops all work on abort", async () => {
    vi.useFakeTimers(); const socket = new Socket();
    socket.reply = (message) => socket.message({ commandId: message.commandId, payload: {} });
    const abort = new AbortController();
    const connection = await connectFortniteSocket({ createSocket: () => socket, signal: abort.signal, onPush: vi.fn() });
    connection.startPing(); await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.sent.map((message) => message.type)).toEqual(["service.ping"]);
    abort.abort(); await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sent).toHaveLength(1); expect(socket.readyState).toBe(3);
    await expect(connection.command("campaign.get")).rejects.toThrow("Fortnite connection closed.");
  });
  it("suppresses raw vendor error messages and rejects malformed input", async () => {
    const socket = new Socket();
    socket.reply = (message) => socket.message({ commandId: message.commandId, error: true, payload: { message: "private", errorKey: "private" } });
    const connection = await connectFortniteSocket({ createSocket: () => socket, signal: new AbortController().signal, onPush: vi.fn() });
    await expect(connection.command("campaign.get")).rejects.toThrow("Fortnite provider rejected command.");
    socket.event("message", { data: "not-json-private" }); expect(socket.readyState).toBe(3);
  });
});
