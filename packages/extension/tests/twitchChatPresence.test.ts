import { afterEach, describe, expect, it } from "vitest";
import {
  parseIrcLine,
  TwitchChatPresenceClient,
  TWITCH_IRC_IDLE_PING_MS,
  TWITCH_IRC_JOIN_TIMEOUT_MS,
  TWITCH_IRC_PONG_TIMEOUT_MS,
  TWITCH_IRC_URL,
} from "@lurkloot/core/twitch/chatPresence";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import { twitchAdapter } from "./helpers/adapters";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketMessageEventLike) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  open(): void { this.readyState = 1; for (const listener of this.listeners.open ?? []) listener({}); }
  serverClose(): void { this.readyState = 3; for (const listener of this.listeners.close ?? []) listener({}); }
  receive(...lines: string[]): void {
    for (const listener of this.listeners.message ?? []) listener({ data: lines.map((line) => `${line}\r\n`).join("") });
  }
}

class FakeClock {
  nowMs = 1_000_000;
  private timers: Array<{ id: number; at: number; callback: () => void }> = [];
  private nextId = 1;
  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.nowMs + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimer = (timer: ReturnType<typeof setTimeout>) => {
    this.timers = this.timers.filter((entry) => entry.id !== (timer as unknown as number));
  };
  now = () => this.nowMs;
  pendingDelays(): number[] { return this.timers.map((entry) => entry.at - this.nowMs); }
  async advance(ms: number): Promise<void> {
    const until = this.nowMs + ms;
    for (;;) {
      const due = this.timers.filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((entry) => entry !== due);
      this.nowMs = due.at;
      due.callback();
      // The callback may start an async reconnect; let it settle. Real
      // setTimeout is untouched: the client only uses the injected timers.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.nowMs = until;
  }
}

const clients: TwitchChatPresenceClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.stop())); });

function setup(options: {
  token?: string;
  login?: string;
  getAuthToken?: () => Promise<string | undefined>;
  resolveLogin?: () => Promise<string | undefined>;
} = {}) {
  const sockets: FakeSocket[] = [];
  const clock = new FakeClock();
  const client = new TwitchChatPresenceClient({
    createWebSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    getAuthToken: options.getAuthToken ?? (async () => ("token" in options ? options.token : "secret-token")),
    resolveLogin: options.resolveLogin ?? (async () => ("login" in options ? options.login : "Viewer")),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  clients.push(client);
  return { client, sockets, clock };
}

async function joined(env: ReturnType<typeof setup>, channel = "prod"): Promise<FakeSocket> {
  await env.client.follow({ username: channel });
  const socket = env.sockets.at(-1)!;
  socket.open();
  socket.receive(":tmi.twitch.tv 001 viewer :Welcome, GLHF!");
  socket.receive(`:viewer!viewer@viewer.tmi.twitch.tv JOIN #${channel}`, `@badge-info=;badges= :tmi.twitch.tv USERSTATE #${channel}`);
  return socket;
}

const ALLOWED = /^(CAP REQ|PASS|NICK|USER|JOIN|PART|PING|PONG)( |$)/;

function warnings(env: ReturnType<typeof setup>): string[] {
  return env.client.drainEvents().filter((event) => event.level === "warn").map((event) => event.message);
}

// Opens the latest socket and registers it, so the client sends its JOIN.
function register(env: ReturnType<typeof setup>): FakeSocket {
  const socket = env.sockets.at(-1)!;
  socket.open();
  socket.receive(":tmi.twitch.tv 001 viewer :Welcome, GLHF!");
  return socket;
}

describe("parseIrcLine", () => {
  it("reads tags, prefix nick, command and params, and trailing text only for NOTICE and PING", () => {
    expect(parseIrcLine("@a=b :viewer!viewer@viewer.tmi.twitch.tv JOIN #prod")).toEqual({ command: "JOIN", params: ["#prod"], prefixNick: "viewer" });
    expect(parseIrcLine(":tmi.twitch.tv NOTICE * :Login authentication failed")?.trailing).toBe("Login authentication failed");
    expect(parseIrcLine("PING :tmi.twitch.tv")).toEqual({ command: "PING", params: [], trailing: "tmi.twitch.tv" });
    expect(parseIrcLine("@x=y :someone!someone@someone.tmi.twitch.tv PRIVMSG #prod :hello there")).toEqual({ command: "PRIVMSG", params: ["#prod"], prefixNick: "someone" });
  });
});

describe("TwitchChatPresenceClient", () => {
  it("connects with the web client's handshake and joins the target", async () => {
    const env = setup();
    await env.client.follow({ username: "prod" });
    const socket = env.sockets[0]!;
    expect(socket.url).toBe(TWITCH_IRC_URL);
    socket.open();
    expect(socket.sent).toEqual([
      "CAP REQ :twitch.tv/tags twitch.tv/commands",
      "PASS oauth:secret-token",
      "NICK viewer",
      "USER viewer 8 * :viewer",
    ]);
    socket.receive(":tmi.twitch.tv 001 viewer :Welcome, GLHF!");
    expect(socket.sent.at(-1)).toBe("JOIN #prod");
    expect(env.client.status()).toEqual({ state: "joining", channel: "prod" });
    socket.receive(":viewer!viewer@viewer.tmi.twitch.tv JOIN #prod", "@badges= :tmi.twitch.tv USERSTATE #prod");
    expect(env.client.status()).toEqual({ state: "joined", channel: "prod" });
    expect(env.client.drainEvents().map((event) => event.message)).toContain("Twitch chat presence joined prod");
  });

  it("switches channels on one socket: JOIN the next, then PART the previous", async () => {
    const env = setup();
    const socket = await joined(env, "prod");
    await env.client.follow({ username: "diables" });
    await env.client.follow({ username: "kaaleesi" });
    expect(env.sockets).toHaveLength(1);
    expect(socket.sent.filter((line) => /^(JOIN|PART)/.test(line))).toEqual([
      "JOIN #prod", "JOIN #diables", "PART #prod", "JOIN #kaaleesi", "PART #diables",
    ]);
  });

  it("also accepts end-of-NAMES as the room confirmation", async () => {
    const env = setup();
    await env.client.follow({ username: "prod" });
    const socket = env.sockets[0]!;
    socket.open();
    socket.receive(":tmi.twitch.tv 001 viewer :Welcome, GLHF!");
    socket.receive(":viewer!viewer@viewer.tmi.twitch.tv JOIN #prod", ":viewer.tmi.twitch.tv 366 viewer #prod :End of /NAMES list");
    expect(env.client.status()).toEqual({ state: "joined", channel: "prod" });
  });

  it("does nothing when following the channel it already follows", async () => {
    const env = setup();
    const socket = await joined(env, "prod");
    const before = socket.sent.length;
    await env.client.follow({ username: "PROD" });
    expect(socket.sent).toHaveLength(before);
  });

  it("answers server PING with PONG", async () => {
    const env = setup();
    const socket = await joined(env);
    socket.receive("PING :tmi.twitch.tv");
    expect(socket.sent.at(-1)).toBe("PONG :tmi.twitch.tv");
  });

  it("sends an idle PING after 25 s of silence and none while frames flow", async () => {
    const env = setup();
    const socket = await joined(env);
    await env.clock.advance(TWITCH_IRC_IDLE_PING_MS - 1_000);
    socket.receive("@x=y :a!a@a.tmi.twitch.tv PRIVMSG #prod :hi");
    await env.clock.advance(TWITCH_IRC_IDLE_PING_MS - 1_000);
    expect(socket.sent).not.toContain("PING :tmi.twitch.tv");
    await env.clock.advance(1_001);
    expect(socket.sent.at(-1)).toBe("PING :tmi.twitch.tv");
  });

  it("discards a flood of chat lines without events", async () => {
    const env = setup();
    const socket = await joined(env);
    env.client.drainEvents();
    socket.receive(...Array.from({ length: 500 }, (_, index) => `@id=${index} :u${index}!u@u.tmi.twitch.tv PRIVMSG #prod :message ${index}`));
    expect(env.client.drainEvents()).toEqual([]);
    expect(env.client.status()).toEqual({ state: "joined", channel: "prod" });
  });

  it("blocks on an auth failure notice and does not reconnect", async () => {
    const env = setup();
    await env.client.follow({ username: "prod" });
    const socket = env.sockets[0]!;
    socket.open();
    socket.receive(":tmi.twitch.tv NOTICE * :Login authentication failed");
    expect(env.client.status()).toEqual({ state: "blocked", channel: "prod", reason: "auth" });
    expect(socket.closed).toBe(true);
    await env.clock.advance(120_000);
    expect(env.sockets).toHaveLength(1);
  });

  it("reconnects on RECONNECT and rejoins the target", async () => {
    const env = setup();
    await joined(env);
    env.sockets[0]!.receive(":tmi.twitch.tv RECONNECT");
    await env.clock.advance(1_000);
    expect(env.sockets).toHaveLength(2);
    const next = env.sockets[1]!;
    next.open();
    next.receive(":tmi.twitch.tv 001 viewer :Welcome");
    expect(next.sent.at(-1)).toBe("JOIN #prod");
  });

  it("backs off reconnects up to the cap", async () => {
    const env = setup();
    await env.client.follow({ username: "prod" });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      env.sockets.at(-1)!.serverClose();
      delays.push(Math.min(...env.clock.pendingDelays()));
      await env.clock.advance(delays.at(-1)!);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(env.client.status().state).toBe("error");
  });

  it("keeps backing off across a RECONNECT storm", async () => {
    const env = setup();
    await env.client.follow({ username: "prod" });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const socket = env.sockets.at(-1)!;
      socket.open();
      socket.receive(":tmi.twitch.tv 001 viewer :Welcome, GLHF!");
      socket.receive(":tmi.twitch.tv RECONNECT");
      delays.push(Math.min(...env.clock.pendingDelays()));
      await env.clock.advance(delays.at(-1)!);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("backs off failing reconnects after a long stable session and resolves the login once", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock();
    let token: string | undefined = "secret-token";
    let logins = 0;
    const client = new TwitchChatPresenceClient({
      createWebSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
      getAuthToken: async () => token,
      resolveLogin: async () => { logins += 1; return "Viewer"; },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
    });
    clients.push(client);
    await joined({ client, sockets, clock }, "prod");
    // Ten minutes of a live room: server traffic keeps the PONG timeout away.
    for (let step = 0; step < 30; step += 1) {
      await clock.advance(20_000);
      sockets.at(-1)!.receive("PING :tmi.twitch.tv");
    }
    expect(sockets).toHaveLength(1);
    token = undefined;
    sockets.at(-1)!.serverClose();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      delays.push(Math.min(...clock.pendingDelays()));
      await clock.advance(delays.at(-1)!);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(logins).toBe(1);
  });

  it("drops a join Twitch never confirms and retries, quoting its notice", async () => {
    const env = setup();
    await env.client.follow({ username: "prod" });
    const socket = register(env);
    socket.receive("@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #prod :This channel does not exist or has been suspended.");
    await env.clock.advance(TWITCH_IRC_JOIN_TIMEOUT_MS - 1);
    expect(env.client.status()).toEqual({ state: "joining", channel: "prod" });
    await env.clock.advance(1);
    expect(env.client.status()).toEqual({ state: "error", channel: "prod" });
    expect(socket.closed).toBe(true);
    expect(warnings(env)).toEqual(["Twitch chat presence could not join prod (This channel does not exist or has been suspended.); retrying"]);
    await env.clock.advance(1_000);
    expect(env.sockets).toHaveLength(2);
  });

  it("drops a handshake that never registers", async () => {
    const env = setup();
    await env.client.follow({ username: "prod" });
    env.sockets[0]!.open();
    await env.clock.advance(TWITCH_IRC_JOIN_TIMEOUT_MS);
    expect(env.client.status()).toEqual({ state: "error", channel: "prod" });
    expect(env.sockets[0]!.closed).toBe(true);
  });

  it("times out a switch that is never confirmed and rejoins the new channel", async () => {
    const env = setup();
    await joined(env, "prod");
    await env.client.follow({ username: "diables" });
    await env.clock.advance(TWITCH_IRC_JOIN_TIMEOUT_MS);
    expect(env.client.status()).toEqual({ state: "error", channel: "diables" });
    await env.clock.advance(1_000);
    expect(register(env).sent.at(-1)).toBe("JOIN #diables");
  });

  it("backs off repeated join timeouts up to the cap and warns once", async () => {
    const env = setup();
    await env.client.follow({ username: "prod" });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      register(env);
      await env.clock.advance(TWITCH_IRC_JOIN_TIMEOUT_MS);
      delays.push(Math.min(...env.clock.pendingDelays()));
      await env.clock.advance(delays.at(-1)!);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(warnings(env)).toEqual(["Twitch chat presence could not join prod; retrying"]);
  });

  it("drops a socket whose idle PING goes unanswered", async () => {
    const env = setup();
    const socket = await joined(env);
    env.client.drainEvents();
    await env.clock.advance(TWITCH_IRC_IDLE_PING_MS);
    expect(socket.sent.at(-1)).toBe("PING :tmi.twitch.tv");
    await env.clock.advance(TWITCH_IRC_PONG_TIMEOUT_MS);
    expect(env.client.status()).toEqual({ state: "error", channel: "prod" });
    expect(socket.closed).toBe(true);
    expect(warnings(env)).toEqual(["Twitch chat stopped answering; reconnecting"]);
    await env.clock.advance(1_000);
    expect(env.sockets).toHaveLength(2);
  });

  it("keeps a socket whose idle PING is answered", async () => {
    const env = setup();
    const socket = await joined(env);
    await env.clock.advance(TWITCH_IRC_IDLE_PING_MS);
    socket.receive(":tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv");
    await env.clock.advance(TWITCH_IRC_PONG_TIMEOUT_MS * 2);
    expect(env.client.status()).toEqual({ state: "joined", channel: "prod" });
    expect(env.sockets).toHaveLength(1);
  });

  it("reports a failed login lookup as such, not as a missing identity", async () => {
    const env = setup({ resolveLogin: async () => { throw new Error("GQL request failed: 503"); } });
    await env.client.follow({ username: "prod" });
    expect(env.sockets).toHaveLength(0);
    expect(env.client.status()).toEqual({ state: "error", channel: "prod" });
    expect(warnings(env)).toEqual(["Could not look up the Twitch viewer login for chat presence: GQL request failed: 503"]);
  });

  it("logs each distinct failure once while retrying", async () => {
    let lookups = 0;
    const env = setup({
      resolveLogin: async () => {
        lookups += 1;
        if (lookups === 1) throw new Error("GQL request failed: 503");
        return "Viewer";
      },
    });
    await env.client.follow({ username: "prod" });
    await env.clock.advance(1_000);
    env.sockets[0]!.serverClose();
    await env.clock.advance(2_000);
    env.sockets[1]!.serverClose();
    expect(warnings(env)).toEqual([
      "Could not look up the Twitch viewer login for chat presence: GQL request failed: 503",
      "Twitch chat presence lost the connection to prod; reconnecting",
    ]);
  });

  it("never logs the token lookup's error", async () => {
    const env = setup({ getAuthToken: async () => { throw new Error("cookie secret-token unreadable"); } });
    await env.client.follow({ username: "prod" });
    expect(env.client.status()).toEqual({ state: "error", channel: "prod" });
    expect(JSON.stringify(env.client.drainEvents())).not.toContain("secret-token");
  });

  it("leaves with PART and closes when following nothing", async () => {
    const env = setup();
    const socket = await joined(env);
    await env.client.follow(undefined);
    expect(socket.sent.at(-1)).toBe("PART #prod");
    expect(socket.closed).toBe(true);
    expect(env.client.status()).toEqual({ state: "left" });
  });

  it("reports an error without a signed-in identity", async () => {
    const env = setup({ token: undefined });
    await env.client.follow({ username: "prod" });
    expect(env.sockets).toHaveLength(0);
    expect(env.client.status()).toEqual({ state: "error", channel: "prod" });
  });

  it("never sends anything outside the allowlist and never leaks the token", async () => {
    const env = setup();
    const socket = await joined(env);
    socket.receive("PING :tmi.twitch.tv");
    await env.client.follow({ username: "diables" });
    await env.clock.advance(TWITCH_IRC_IDLE_PING_MS + 1);
    await env.client.stop();
    for (const line of socket.sent) expect(line).toMatch(ALLOWED);
    expect(JSON.stringify(env.client.drainEvents())).not.toContain("secret-token");
  });
});


describe("Twitch chat presence adapter factory", () => {
  it("exposes a chat presence client only when websocket and auth token deps exist", async () => {
    const fetcher = {
      fetchJson: async <T,>(_url: string, init?: RequestInit): Promise<T> => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return (body.operationName === "CurrentUserLogin"
          ? { data: { currentUser: { id: "1", login: "Viewer" } } }
          : {}) as T;
      },
    };
    expect(twitchAdapter(fetcher).createChatPresenceClient).toBeUndefined();
    const sockets: FakeSocket[] = [];
    const client = twitchAdapter(fetcher, undefined, {
      webSocketFactory: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
      getAuthToken: async () => "token",
    }).createChatPresenceClient?.();
    expect(client).toBeInstanceOf(TwitchChatPresenceClient);
    await client!.follow({ username: "prod" });
    sockets[0]!.open();
    expect(sockets[0]!.sent).toContain("NICK viewer");
    await client!.stop();
  });

  it("lets a failed login lookup reach the client's own diagnostics", async () => {
    const fetcher = {
      fetchJson: async <T,>(): Promise<T> => { throw new Error("GQL request failed: 503"); },
    };
    const client = twitchAdapter(fetcher, undefined, {
      webSocketFactory: (url) => new FakeSocket(url),
      getAuthToken: async () => "secret-token",
    }).createChatPresenceClient!();
    await client.follow({ username: "prod" });
    expect(client.status()).toEqual({ state: "error", channel: "prod" });
    const messages = client.drainEvents().map((event) => event.message);
    expect(messages.some((message) => message?.startsWith("Could not look up the Twitch viewer login for chat presence: "))).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("secret-token");
    await client.stop();
  });
});
