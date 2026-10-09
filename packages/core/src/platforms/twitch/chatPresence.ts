import type { DiagnosticEvent } from "@lurkloot/shared/events";
import type { ChatPresenceBlockReason, ChatPresenceState, ChatPresenceStatus } from "@lurkloot/shared/models";
import type { ChatPresenceClient, ChatPresenceTarget } from "../../core/chatPresence";
import { PendingDiscoverySignalDiagnostics } from "../../core/discoverySignals";
import type { WebSocketFactory, WebSocketLike, WebSocketMessageEventLike } from "../../core/webSocket";

// Twitch chat presence over IRC, as the web client connects it
// (docs/superpowers/specs/2026-10-05-chat-presence-design.md). It only joins
// and leaves: no message, whisper or command is ever sent.
export const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv/";
// Chromium suspends an MV3 worker after ~30 s without socket traffic; quiet
// channels would drop presence, so an idle socket pings (a documented
// deviation: pages are never suspended, workers are).
export const TWITCH_IRC_IDLE_PING_MS = 25_000;
// A socket that has not confirmed the room this long after opening or sending
// JOIN (a hung handshake, a suspended channel, a JOIN Twitch ignores) is
// dropped and retried, rather than showing "joining" forever.
export const TWITCH_IRC_JOIN_TIMEOUT_MS = 30_000;
// An idle PING unanswered this long means a half-open socket.
export const TWITCH_IRC_PONG_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const STABLE_CONNECTION_MS = 60_000;
const WEBSOCKET_OPEN = 1;
const AUTH_FAILURE_NOTICES = ["Login authentication failed", "Improperly formatted auth"];
// Trailing text is read for these commands only, so chat content never is.
const TRAILING_COMMANDS = new Set(["NOTICE", "PING"]);

type Timer = ReturnType<typeof setTimeout>;

export interface TwitchChatPresenceDeps {
  createWebSocket: WebSocketFactory;
  getAuthToken: () => Promise<string | undefined>;
  resolveLogin: () => Promise<string | undefined>;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  now?: () => number;
}

export interface IrcLine {
  command: string;
  params: string[];
  prefixNick?: string;
  trailing?: string;
}

export function parseIrcLine(line: string): IrcLine | undefined {
  let rest = line;
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space < 0) return undefined;
    rest = rest.slice(space + 1);
  }
  let prefixNick: string | undefined;
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space < 0) return undefined;
    prefixNick = rest.slice(1, space).split("!")[0];
    rest = rest.slice(space + 1);
  }
  const trailingAt = rest.indexOf(" :");
  const head = trailingAt < 0 ? rest : rest.slice(0, trailingAt);
  const [command, ...params] = head.split(" ").filter(Boolean);
  if (!command) return undefined;
  return {
    command,
    params,
    ...(prefixNick ? { prefixNick } : {}),
    ...(TRAILING_COMMANDS.has(command) && trailingAt >= 0 ? { trailing: rest.slice(trailingAt + 2) } : {}),
  };
}

export class TwitchChatPresenceClient implements ChatPresenceClient {
  private ws?: WebSocketLike;
  private connecting = false;
  private registered = false;
  private stopped = false;
  private login?: string;
  private desired?: string;
  private channelOnServer?: string;
  private joinEchoes = new Set<string>();
  private userStates = new Set<string>();
  private joinedChannel?: string;
  private state: ChatPresenceState = "left";
  private blockReason?: ChatPresenceBlockReason;
  // Warnings already logged since the client last joined or left, so a retry
  // loop logs each distinct failure once.
  private readonly warned = new Set<string>();
  // The last NOTICE Twitch sent for the channel being joined, quoted if the
  // join times out.
  private joinNotice?: string;
  private reconnectAttempt = 0;
  // When the room was last confirmed, until its connection ends. Only a
  // connection that held a room this long resets the reconnect backoff.
  private stableSince?: number;
  private reconnectTimer?: Timer;
  private idleTimer?: Timer;
  private joinTimer?: Timer;
  private pongTimer?: Timer;
  private readonly diagnostics = new PendingDiscoverySignalDiagnostics();
  private readonly intentionallyClosed = new WeakSet<WebSocketLike>();
  private readonly setTimer: NonNullable<TwitchChatPresenceDeps["setTimer"]>;
  private readonly clearTimer: NonNullable<TwitchChatPresenceDeps["clearTimer"]>;
  private readonly now: NonNullable<TwitchChatPresenceDeps["now"]>;

  constructor(private readonly deps: TwitchChatPresenceDeps) {
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    this.now = deps.now ?? Date.now;
  }

  async follow(target: ChatPresenceTarget | undefined): Promise<void> {
    if (this.stopped) return;
    const next = target?.username.toLowerCase();
    if (next === this.desired) return;
    this.desired = next;
    if (!next) {
      this.leave();
      return;
    }
    if (this.state === "blocked") return;
    this.setState("joining");
    if (!this.ws) {
      await this.connect();
      return;
    }
    this.joinDesired();
  }

  status(): ChatPresenceStatus {
    if (this.state === "left") return { state: "left" };
    return {
      state: this.state,
      ...(this.desired ? { channel: this.desired } : {}),
      ...(this.state === "blocked" && this.blockReason ? { reason: this.blockReason } : {}),
    };
  }

  drainEvents(): DiagnosticEvent[] {
    return this.diagnostics.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.desired = undefined;
    this.leave();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ws || this.connecting || !this.desired) return;
    this.connecting = true;
    try {
      // A client lives for one identity (an auth change stops it), so the
      // login is resolved once rather than on every reconnect.
      // Called inside then() so a lookup that throws, rather than rejects,
      // still settles here and the retry below is scheduled.
      const [tokenResult, loginResult] = await Promise.allSettled([
        Promise.resolve().then(() => this.deps.getAuthToken()),
        this.login ?? Promise.resolve().then(() => this.deps.resolveLogin()),
      ]);
      if (this.stopped || !this.desired || this.ws) return;
      if (loginResult.status === "rejected") {
        this.fail(`Could not look up the Twitch viewer login for chat presence: ${errorMessage(loginResult.reason)}`);
        return;
      }
      // The token lookup's error is never logged: it may quote the credential.
      const token = tokenResult.status === "fulfilled" ? tokenResult.value : undefined;
      const login = loginResult.value;
      if (!token || !login) {
        this.fail("Twitch chat presence has no signed-in Twitch identity");
        return;
      }
      const nick = login.toLowerCase();
      this.login = nick;
      let ws: WebSocketLike;
      try {
        ws = this.deps.createWebSocket(TWITCH_IRC_URL);
      } catch (error) {
        this.fail(`Could not open the Twitch chat connection: ${errorMessage(error)}`);
        return;
      }
      this.ws = ws;
      this.registered = false;
      this.channelOnServer = undefined;
      this.armJoinTimeout(ws);
      this.log("debug", "Opening Twitch chat presence connection");
      ws.addEventListener("open", () => {
        if (this.ws !== ws) return;
        this.sendRaw(ws, "CAP REQ :twitch.tv/tags twitch.tv/commands");
        this.sendRaw(ws, `PASS oauth:${token}`);
        this.sendRaw(ws, `NICK ${nick}`);
        this.sendRaw(ws, `USER ${nick} 8 * :${nick}`);
      });
      ws.addEventListener("message", (event) => this.onMessage(ws, event));
      ws.addEventListener("close", () => this.onClose(ws));
      ws.addEventListener("error", () => this.onClose(ws));
    } finally {
      this.connecting = false;
    }
  }

  private onMessage(ws: WebSocketLike, event: WebSocketMessageEventLike): void {
    if (this.ws !== ws) return;
    this.resetIdle();
    this.clearPong();
    if (typeof event.data !== "string") return;
    for (const raw of event.data.split("\r\n")) {
      if (!raw) continue;
      const line = parseIrcLine(raw);
      if (!line) continue;
      switch (line.command) {
        case "PING":
          this.sendRaw(ws, `PONG :${line.trailing ?? "tmi.twitch.tv"}`);
          break;
        case "001":
          this.registered = true;
          this.joinDesired();
          break;
        case "NOTICE":
          if (line.trailing && AUTH_FAILURE_NOTICES.some((notice) => line.trailing!.includes(notice))) {
            this.block("auth");
            return;
          }
          // Twitch's reason for refusing the room (a suspended channel, say),
          // kept for the join timeout's warning.
          if (line.trailing && this.channelOnServer && line.params[0]?.toLowerCase() === `#${this.channelOnServer}`
            && this.joinedChannel !== this.channelOnServer) this.joinNotice = line.trailing.slice(0, 200);
          break;
        case "RECONNECT":
          // Twitch's maintenance notice: reconnect and rejoin, backing off
          // like any other drop so a server that repeats it is not hammered.
          this.dropConnection("joining");
          return;
        case "JOIN":
          if (line.prefixNick?.toLowerCase() === this.login) this.confirm(this.joinEchoes, line.params[0]);
          break;
        // Either confirms the room: USERSTATE follows a logged-in JOIN, and
        // 366 (end of NAMES) is what the 2026-10-04 capture observed.
        case "USERSTATE":
          this.confirm(this.userStates, line.params[0]);
          break;
        case "366":
          this.confirm(this.userStates, line.params[1]);
          break;
        default:
          break;
      }
    }
  }

  private confirm(set: Set<string>, param: string | undefined): void {
    const channel = param?.replace(/^#/, "").toLowerCase();
    if (!channel) return;
    set.add(channel);
    if (channel !== this.desired || !this.joinEchoes.has(channel) || !this.userStates.has(channel)) return;
    if (this.state === "joined" && this.joinedChannel === channel) return;
    const previous = this.joinedChannel;
    this.joinedChannel = channel;
    this.stableSince ??= this.now();
    this.clearJoinTimeout();
    this.joinNotice = undefined;
    this.setState("joined");
    this.log("debug", previous && previous !== channel
      ? `Twitch chat presence switched ${previous} → ${channel}`
      : `Twitch chat presence joined ${channel}`);
  }

  private joinDesired(): void {
    const next = this.desired;
    const ws = this.ws;
    if (!next || !ws || !this.registered || this.channelOnServer === next) return;
    const previous = this.channelOnServer;
    this.joinEchoes.delete(next);
    this.userStates.delete(next);
    this.sendRaw(ws, `JOIN #${next}`);
    this.channelOnServer = next;
    this.joinNotice = undefined;
    this.armJoinTimeout(ws);
    if (previous) {
      this.sendRaw(ws, `PART #${previous}`);
      this.joinEchoes.delete(previous);
      this.userStates.delete(previous);
    }
  }

  private leave(): void {
    const channel = this.channelOnServer;
    if (channel && this.ws && this.registered) this.sendRaw(this.ws, `PART #${channel}`);
    this.closeSocket();
    this.clearReconnect();
    if (this.joinedChannel) this.log("debug", `Twitch chat presence left ${this.joinedChannel}`);
    this.joinedChannel = undefined;
    this.joinEchoes.clear();
    this.userStates.clear();
    this.blockReason = undefined;
    this.state = "left";
    this.warned.clear();
    this.joinNotice = undefined;
    this.reconnectAttempt = 0;
    this.stableSince = undefined;
  }

  private onClose(ws: WebSocketLike): void {
    if (this.intentionallyClosed.has(ws) || this.ws !== ws) return;
    this.dropConnection("error");
  }

  // Every unplanned end of a connection: a server close or error, RECONNECT,
  // and the join and PONG timeouts. It backs off; only a connection that held
  // its room long enough (connectionEnded) earns a fresh backoff.
  private dropConnection(state: "error" | "joining", warning?: string): void {
    this.connectionEnded();
    this.closeSocket();
    this.joinedChannel = undefined;
    this.joinNotice = undefined;
    if (this.stopped || this.state === "blocked" || !this.desired) return;
    this.setState(state, warning);
    this.scheduleReconnect();
  }

  private fail(message: string): void {
    this.setState("error", message);
    this.scheduleReconnect();
  }

  private block(reason: ChatPresenceBlockReason): void {
    this.blockReason = reason;
    this.setState("blocked", "Twitch chat presence stopped: Twitch rejected the chat login");
    this.clearReconnect();
    this.closeSocket();
  }

  private setState(state: ChatPresenceState, warning?: string): void {
    this.state = state;
    if (state === "joined" || state === "joining") {
      if (state === "joined") this.warned.clear();
      return;
    }
    const message = warning ?? `Twitch chat presence lost the connection to ${this.desired ?? "chat"}; reconnecting`;
    const key = `${state}:${this.blockReason ?? ""}:${this.desired ?? ""}:${message}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log("warn", message);
  }

  // A connection that held its room for STABLE_CONNECTION_MS earns a fresh
  // backoff; anything shorter keeps doubling it.
  private connectionEnded(): void {
    if (this.stableSince !== undefined && this.now() - this.stableSince >= STABLE_CONNECTION_MS) this.reconnectAttempt = 0;
    this.stableSince = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined || !this.desired) return;
    const delayMs = Math.min(RECONNECT_BASE_MS * (2 ** this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    const timer = this.setTimer(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = undefined;
      void this.connect();
    }, delayMs);
    this.reconnectTimer = timer;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private resetIdle(): void {
    this.clearIdle();
    const ws = this.ws;
    if (!ws) return;
    const timer = this.setTimer(() => {
      if (this.idleTimer !== timer) return;
      this.idleTimer = undefined;
      if (this.ws !== ws || !this.registered) return;
      this.sendRaw(ws, "PING :tmi.twitch.tv");
      // Only a received line clears it: sending resets the idle timer, not this.
      this.armPong(ws);
    }, TWITCH_IRC_IDLE_PING_MS);
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    if (this.idleTimer === undefined) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armPong(ws: WebSocketLike): void {
    if (this.pongTimer !== undefined) return;
    const timer = this.setTimer(() => {
      if (this.pongTimer !== timer) return;
      this.pongTimer = undefined;
      if (this.ws === ws) this.dropConnection("error", "Twitch chat stopped answering; reconnecting");
    }, TWITCH_IRC_PONG_TIMEOUT_MS);
    this.pongTimer = timer;
  }

  private clearPong(): void {
    if (this.pongTimer === undefined) return;
    this.clearTimer(this.pongTimer);
    this.pongTimer = undefined;
  }

  // Armed when a socket opens and on every JOIN, so a switch is covered too;
  // cleared once the room is confirmed.
  private armJoinTimeout(ws: WebSocketLike): void {
    this.clearJoinTimeout();
    const timer = this.setTimer(() => {
      if (this.joinTimer !== timer) return;
      this.joinTimer = undefined;
      if (this.ws !== ws || !this.desired) return;
      const notice = this.joinNotice ? ` (${this.joinNotice})` : "";
      this.dropConnection("error", `Twitch chat presence could not join ${this.desired}${notice}; retrying`);
    }, TWITCH_IRC_JOIN_TIMEOUT_MS);
    this.joinTimer = timer;
  }

  private clearJoinTimeout(): void {
    if (this.joinTimer === undefined) return;
    this.clearTimer(this.joinTimer);
    this.joinTimer = undefined;
  }

  private closeSocket(): void {
    this.clearIdle();
    this.clearPong();
    this.clearJoinTimeout();
    const ws = this.ws;
    this.ws = undefined;
    this.registered = false;
    this.channelOnServer = undefined;
    if (!ws) return;
    this.intentionallyClosed.add(ws);
    try {
      ws.close();
    } catch {
      // Best-effort: callbacks of a cleared socket are inert.
    }
  }

  // Lines are never logged: PASS carries the token.
  private sendRaw(ws: WebSocketLike, line: string): void {
    if (ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      ws.send(line);
    } catch (error) {
      this.log("warn", `Could not send to Twitch chat: ${errorMessage(error)}`);
    }
    if (this.ws === ws) this.resetIdle();
  }

  private log(level: "debug" | "warn", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "twitch", level, message });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
