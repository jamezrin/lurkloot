import { describe, expect, it, vi } from "vitest";
import { createSocketHostFactory } from "../src/core/socketHostFactory";
import { SOCKET_HOST_PORT, type SocketHostEvent, type SocketHostRequest } from "../src/core/socketHost";

const CENTRIFUGO_URL = "wss://realtime.us-west-2.platform.kick.com/connection/websocket";
const DOCUMENT_URL = "chrome-extension://abcdefghijklmnop/socketHost.html";

// Two Port ends wired to each other, as runtime.connect gives the document and
// the worker's onConnect.
interface TestPort {
  name: string;
  sender?: { tab?: unknown; url?: string };
  peer: TestPort;
  disconnected: boolean;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  messages: Array<(message: unknown) => void>;
  disconnects: Array<() => void>;
}

function portPair(sender: { tab?: unknown; url?: string } = { url: DOCUMENT_URL }, name = SOCKET_HOST_PORT) {
  const make = (portSender?: typeof sender): TestPort => {
    const messages: Array<(message: unknown) => void> = [];
    const disconnects: Array<() => void> = [];
    return {
      name,
      sender: portSender,
      peer: undefined as unknown as TestPort,
      disconnected: false,
      postMessage(message: unknown) { if (!this.disconnected) for (const listener of this.peer.messages) listener(structuredClone(message)); },
      disconnect() { if (this.disconnected) return; this.disconnected = true; this.peer.disconnected = true; for (const listener of this.peer.disconnects) listener(); },
      onMessage: { addListener: (listener: (message: unknown) => void) => { messages.push(listener); } },
      onDisconnect: { addListener: (listener: () => void) => { disconnects.push(listener); } },
      messages,
      disconnects,
    };
  };
  const document = make();
  const worker = make(sender);
  document.peer = worker;
  worker.peer = document;
  return { document, worker };
}

describe("socket host factory", () => {
  function host(admit: (url: string) => Promise<boolean> = async () => true, createFails = false) {
    let onConnect!: (port: unknown) => void;
    const documents = { open: false, created: 0, closed: 0 };
    const timers: Array<{ callback: () => void; delayMs: number; cleared?: boolean }> = [];
    const factory = createSocketHostFactory({
      onConnect: { addListener: (listener) => { onConnect = listener as never; } },
      documentUrl: DOCUMENT_URL,
      hasDocument: async () => documents.open,
      createDocument: async () => {
        if (createFails) throw new Error("Only a single offscreen document may be created.");
        documents.open = true; documents.created += 1;
      },
      closeDocument: async () => { documents.open = false; documents.closed += 1; },
      admit,
      setTimer: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length as never; },
      clearTimer: (timer) => { timers[(timer as unknown as number) - 1]!.cleared = true; },
    });
    // Connects a host document, returning the requests it receives.
    const connectDocument = (sender?: { tab?: unknown; url?: string }, name?: string) => {
      const { document, worker } = portPair(sender, name);
      const requests: SocketHostRequest[] = [];
      document.onMessage.addListener((message) => requests.push(message as SocketHostRequest));
      onConnect(worker);
      return { document, requests };
    };
    return { factory, documents, timers, connectDocument };
  }
  const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

  it("creates the offscreen document and opens the socket through it", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    const listener = vi.fn();
    socket.addEventListener("open", listener);
    await settle();
    expect(h.documents.created).toBe(1);
    const relay = h.connectDocument();
    await settle();
    expect(relay.requests).toEqual([{ type: "open", id: 1, url: CENTRIFUGO_URL }]);
    relay.document.postMessage({ type: "open", id: 1 } satisfies SocketHostEvent);
    expect(socket.readyState).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    socket.send("{}");
    expect(relay.requests.at(-1)).toEqual({ type: "send", id: 1, data: "{}" });
  });

  // #792: never a handshake whose Origin cannot be set.
  it("fails a refused socket closed, without creating the document", async () => {
    const h = host(async () => false);
    const socket = h.factory(CENTRIFUGO_URL);
    const closed = vi.fn();
    socket.addEventListener("close", closed);
    await settle();
    expect(closed).toHaveBeenCalledWith({ code: 1006 });
    expect(h.documents.created).toBe(0);
  });

  it("ignores a port from a tab, another page or another name", async () => {
    const h = host();
    h.factory(CENTRIFUGO_URL);
    await settle();
    const fromTab = h.connectDocument({ tab: { id: 3 }, url: DOCUMENT_URL });
    const fromPage = h.connectDocument({ url: "https://kick.com/xqc" });
    const otherName = h.connectDocument({ url: DOCUMENT_URL }, "something-else");
    await settle();
    expect(fromTab.requests).toEqual([]);
    expect(fromPage.requests).toEqual([]);
    expect(otherName.requests).toEqual([]);
  });

  it("treats a keepalive as nothing more than traffic", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    const message = vi.fn();
    socket.addEventListener("message", message);
    await settle();
    const relay = h.connectDocument();
    await settle();
    relay.document.postMessage({ type: "keepalive" } satisfies SocketHostEvent);
    expect(message).not.toHaveBeenCalled();
  });

  it("replaces a document an earlier worker left behind", async () => {
    const h = host();
    h.documents.open = true;
    h.factory(CENTRIFUGO_URL);
    await settle();
    expect(h.documents.closed).toBe(1);
    expect(h.documents.created).toBe(1);
  });

  it("closes every socket when the document goes away", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    const closed = vi.fn();
    socket.addEventListener("close", closed);
    await settle();
    const relay = h.connectDocument();
    await settle();
    relay.document.postMessage({ type: "open", id: 1 } satisfies SocketHostEvent);
    relay.document.disconnect();
    expect(closed).toHaveBeenCalledWith({ code: 1006 });
    expect(socket.readyState).toBe(3);
  });

  it("tells the document to close a socket the worker closes, and closes the document once idle", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    await settle();
    const relay = h.connectDocument();
    await settle();
    relay.document.postMessage({ type: "open", id: 1 } satisfies SocketHostEvent);
    socket.close();
    expect(relay.requests.at(-1)).toEqual({ type: "close", id: 1 });
    h.timers.find((timer) => timer.delayMs === 10_000)!.callback();
    await settle();
    expect(h.documents.closed).toBe(1);
  });

  it("clears the connect timeout once the document connects", async () => {
    const h = host();
    h.factory(CENTRIFUGO_URL);
    await settle();
    h.connectDocument();
    await settle();
    expect(h.timers.find((timer) => timer.delayMs === 15_000)!.cleared).toBe(true);
  });

  it("fails the socket, with no stray rejection, when the document cannot be created", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const h = host(async () => true, true);
      const socket = h.factory(CENTRIFUGO_URL);
      const closed = vi.fn();
      socket.addEventListener("close", closed);
      await settle();
      expect(closed).toHaveBeenCalledWith({ code: 1006 });
      const timeout = h.timers.find((timer) => timer.delayMs === 15_000)!;
      expect(timeout.cleared).toBe(true);
      timeout.callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("fails the socket when the document never connects", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    const closed = vi.fn();
    socket.addEventListener("close", closed);
    await settle();
    h.timers.find((timer) => timer.delayMs === 15_000)!.callback();
    await settle();
    expect(closed).toHaveBeenCalledWith({ code: 1006 });
  });
});
