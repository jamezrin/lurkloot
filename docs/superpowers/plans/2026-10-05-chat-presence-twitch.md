# Chat presence (plan 1 of 2: foundations, Twitch, service, popup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join the watched Twitch channel's chat while a tabless watch needs it (NoPixelV, or the new "Always enter channel chat" setting), so NoPixelV's daily watch time accrues (#683).

**Architecture:**
- The status types and settings live in `@lurkloot/shared`.
- `@lurkloot/core` holds the client contract and a pure "is presence wanted" rule.
- A Twitch IRC client implements that contract and is created by `TwitchAdapter`.
- A per-platform `ObserverSlot` service follows the committed watch, the same way the discovery-signal observers do.
- The popup shows the presence state. Only the extension host declares the new `chatPresence` capability.
- Kick follows in plan 2: `docs/superpowers/plans/2026-10-05-chat-presence-kick.md`, written after its origin spike.

**Tech Stack:** TypeScript (strict, ES modules), pnpm workspace, Vitest (Node; happy-dom for popup tests), React popup UI, WXT extension.

**Spec:** `docs/superpowers/specs/2026-10-05-chat-presence-design.md`

## Global Constraints

- Work in `.worktrees/chat-presence` on `feat/chat-presence`. Run `pnpm install --frozen-lockfile` there first if `node_modules` is missing.
- Two-space indentation, double quotes, semicolons, `type` imports for types, camelCase functions.
- Diagnostic messages are English literals and never become locale keys. User copy is localized in **all 11 catalogs** (`ar de en es fr hi it pt_BR ru tr zh_CN`), and `pnpm locales:check` must pass.
- Never put the Twitch `auth-token`, a `PASS` line or chat content into a diagnostic, an event, the state or a snapshot.
- The IRC client may send only `CAP REQ`, `PASS`, `NICK`, `USER`, `JOIN`, `PART`, `PING` and `PONG`.
- IRC handshake, verbatim: `CAP REQ :twitch.tv/tags twitch.tv/commands`, `PASS oauth:<token>`, `NICK <login>`, `USER <login> 8 * :<login>`, then `JOIN #<channel>`. Switching sends `JOIN #<next>` and then `PART #<prev>`.
- Idle keepalive: `PING :tmi.twitch.tv` after 25 000 ms with no frame in either direction. Reconnect backoff: 1 000 ms doubling to a 60 000 ms cap, reset after 60 000 ms of stable connection.
- `alwaysEnterChat` defaults to `false` on both platforms. `EXTENSION_CAPABILITIES.chatPresence = true` and `CLI_CAPABILITIES.chatPresence = false`.
- Provider declaration: NoPixelV `needsChatPresence: true`, Fortnite `false`.
- Core must stay browser-free (`packages/extension/tests/coreBoundary.test.ts`).
- Commits follow Conventional Commits. Git identity comes from git config, so never pass `--author`.

## Review Focus

1. **Account switch while in chat:** the user signs into another Twitch account. Presence must leave and rejoin as the new identity, never stay joined as the old one. Task 6 adds "stops the client when auth leaves healthy".
2. **Busy-channel floods:** a frame with hundreds of chat lines must produce no diagnostics and retain no content. Task 3 adds "discards a flood of chat lines without events".
3. **Rapid target changes** (the NoPixelV lane rotating every minute): presence switches on one socket and never reconnects per switch. Task 3 adds "switches channels on one socket".
4. **Server maintenance loops:** repeated closes and `RECONNECT` must back off with a capped delay, not reconnect in a tight loop. Task 3 adds "backs off reconnects up to the cap".
5. **Tab fallback during a provider watch:** a watch that moved to a tab must not keep a second chat connection. Task 2's rule table adds "tab watch never wants presence".

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/models.ts` (modify) | `ChatPresenceState`, `ChatPresenceBlockReason`, `ChatPresenceStatus`; `PlatformSettings.alwaysEnterChat?`; `SchedulerState.chatPresence?` |
| `packages/shared/src/settings.ts` (modify) | Default and normalization of `alwaysEnterChat` |
| `packages/core/src/background/platformState.ts` (modify) | Merge kind for the new `SchedulerState.chatPresence` key |
| `packages/cli/src/settings.ts`, `packages/cli/src/config.ts` (modify) | Accept and template `alwaysEnterChat` |
| `packages/core/src/core/chatPresence.ts` (create) | `ChatPresenceTarget`, the `ChatPresenceClient` contract, the pure `chatPresenceDecision()` rule |
| `packages/core/src/extensions/types.ts`, `registry.ts` (modify) | `needsChatPresence` on provider descriptors |
| `packages/core/src/platforms/adapter.ts` (modify) | `createChatPresenceClient?()` |
| `packages/core/src/platforms/twitch/chatPresence.ts` (create) | Twitch IRC presence client and `parseIrcLine` |
| `packages/core/src/platforms/twitch/index.ts` (modify) | Factory wiring and `resolveViewerLogin()` |
| `packages/core/package.json` (modify) | Exports `./chatPresence` and `./twitch/chatPresence` |
| `packages/core/src/background/hostPorts.ts` (modify) | `HostCapabilities.chatPresence` |
| `packages/core/src/background/reporting.ts` (modify) | One-time "unsupported on this host" diagnostic for `alwaysEnterChat` |
| `packages/core/src/background/chatPresence.ts` (create) | The per-platform observer service |
| `packages/core/src/background/{types,stateTransaction,tickRun,lifecycle,controller}.ts` (modify) | Wiring: calls, epochs, shutdown/reset, snapshot |
| `packages/popup-ui/src/{statusStrip,twitchExtensions,settingsRegistry,Popup}.tsx` (modify) | Strip badge, NoPixelV badge, the Twitch settings row |
| `packages/locales/messages/*.json` (modify) | 7 new keys and an updated `extensionNoPixelHint` |
| `packages/extension/tests/...` (create/modify) | Tests per task |
| `docs/architecture.md`, `docs/twitch-extensions/foundation.md` (modify) | Docs |

---

### Task 1: Shared contracts and settings

**Files:**
- Modify: `packages/shared/src/models.ts` (near `PlatformSettings` around line 337, and `SchedulerState` around line 514)
- Modify: `packages/shared/src/settings.ts` (`DEFAULT_ENGINE_SETTINGS` around line 44, `mergeEngineSettings` around line 150)
- Modify: `packages/core/src/background/platformState.ts` (`SCHEDULER_STATE_MERGE` around line 52)
- Modify: `packages/cli/src/settings.ts` (`CLI_PLATFORM_KEYS` line 138, `normalizePlatform` `common()` around line 405)
- Modify: `packages/cli/src/config.ts` (template, around lines 141 and 167)
- Test: `packages/extension/tests/settings.test.ts`, `packages/cli/tests/settings.test.ts`

**Interfaces:**
- Produces:
  - `ChatPresenceState = "left" | "joining" | "joined" | "error" | "blocked"`
  - `ChatPresenceBlockReason = "auth" | "origin-rejected" | "unsupported-provider" | "capability-absent"`
  - `interface ChatPresenceStatus { state: ChatPresenceState; channel?: string; reason?: ChatPresenceBlockReason }`
  - `PlatformSettings.alwaysEnterChat?: boolean`
  - `SchedulerState.chatPresence?: Partial<Record<Platform, ChatPresenceStatus>>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/extension/tests/settings.test.ts`, inside `describe("settings", …)`:

```ts
  it("defaults alwaysEnterChat to off on both platforms and keeps explicit values", () => {
    expect(DEFAULT_ENGINE_SETTINGS.platform.twitch.alwaysEnterChat).toBe(false);
    expect(DEFAULT_ENGINE_SETTINGS.platform.kick.alwaysEnterChat).toBe(false);
    const merged = mergeEngineSettings({
      platform: {
        twitch: { alwaysEnterChat: true },
        kick: { alwaysEnterChat: "yes" },
      },
    } as never);
    expect(merged.platform.twitch.alwaysEnterChat).toBe(true);
    expect(merged.platform.kick.alwaysEnterChat).toBe(false);
  });
```

Append to `packages/cli/tests/settings.test.ts`, inside `describe("parseCliSettings", …)`:

```ts
  it("accepts alwaysEnterChat on both platforms", () => {
    const settings = parseCliSettings({ platform: { twitch: { alwaysEnterChat: true }, kick: {} } });
    expect(settings.platform.twitch.alwaysEnterChat).toBe(true);
    expect(settings.platform.kick.alwaysEnterChat).toBe(false);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settings.test.ts -t alwaysEnterChat && pnpm --filter @lurkloot/cli exec vitest run tests/settings.test.ts -t alwaysEnterChat`
Expected: both FAIL. The extension test gets `undefined`, not `false`. The CLI test throws on the unknown key `alwaysEnterChat`.

- [ ] **Step 3: Add the shared types**

In `packages/shared/src/models.ts`, add above `export interface PlatformSettings`:

```ts
// Chat presence (docs/superpowers/specs/2026-10-05-chat-presence-design.md):
// whether LurkLoot is in the watched channel's chat. Runtime only; attached to
// snapshots, never persisted.
export type ChatPresenceState = "left" | "joining" | "joined" | "error" | "blocked";
export type ChatPresenceBlockReason = "auth" | "origin-rejected" | "unsupported-provider" | "capability-absent";
export interface ChatPresenceStatus {
  state: ChatPresenceState;
  channel?: string;
  reason?: ChatPresenceBlockReason;
}
```

In `PlatformSettings`, after `subscribedRewardMarks?: string[];`:

```ts
  // Join the chat of every channel watched tablessly on this platform, so the
  // account appears in its chatter list. Off by default. Providers that need
  // chat presence (NoPixelV) join it regardless.
  alwaysEnterChat?: boolean;
```

In `SchedulerState`, directly after the `twitchExtensions?` line:

```ts
  // Live chat presence per platform, attached to snapshots like the
  // twitchExtensions summaries. Never persisted or restored.
  chatPresence?: Partial<Record<Platform, ChatPresenceStatus>>;
```

- [ ] **Step 4: Add defaults and normalization**

In `packages/shared/src/settings.ts`, `DEFAULT_ENGINE_SETTINGS.platform.twitch`: add `alwaysEnterChat: false,` after `channelPointsPushClaim: true,`. In `.kick`, add `alwaysEnterChat: false,` after `autoClaimChallenges: true,`.

In `mergeEngineSettings`, twitch block, after the `subscribedRewardMarks` line:

```ts
        alwaysEnterChat: booleanOr(platform?.twitch?.alwaysEnterChat, false),
```

In the kick block, after its `subscribedRewardMarks` line:

```ts
        alwaysEnterChat: booleanOr(platform?.kick?.alwaysEnterChat, false),
```

In `packages/core/src/background/platformState.ts`, `SCHEDULER_STATE_MERGE`, after `twitchExtensions: "global",`:

```ts
  chatPresence: "global",
```

- [ ] **Step 5: Accept the key in the CLI**

In `packages/cli/src/settings.ts`, `CLI_PLATFORM_KEYS`: append `"alwaysEnterChat"` to both the `twitch` and the `kick` sets. In `normalizePlatform`'s `common()` `base` object, after `subscribedRewardMarks: …,`:

```ts
        alwaysEnterChat: booleanOr(ps.alwaysEnterChat, false),
```

In `packages/cli/src/config.ts`, in the twitch block of the template, insert before the `// Claim channel-point bonuses while farming this platform.` comment:

```ts
        // Join each watched channel's chat. Not supported by the CLI yet: it
        // logs a warning once and ignores this.
        "alwaysEnterChat": ${json(twitch.alwaysEnterChat ?? false)},
```

In the kick block, insert before `// Claim Kick's daily gamification challenges automatically.`:

```ts
        // Join each watched channel's chat. Not supported by the CLI yet: it
        // logs a warning once and ignores this.
        "alwaysEnterChat": ${json(kick.alwaysEnterChat ?? false)},
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settings.test.ts && pnpm --filter @lurkloot/cli exec vitest run tests/settings.test.ts tests/config.test.ts && pnpm typecheck`
Expected: PASS. If `config.test.ts` round-trips the template, it passes once both templates carry the key.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/core/src/background/platformState.ts packages/cli/src/settings.ts packages/cli/src/config.ts packages/extension/tests/settings.test.ts packages/cli/tests/settings.test.ts
git commit -m "feat(settings): add chat presence status types and alwaysEnterChat"
```

---

### Task 2: Core contract, provider declaration and the presence rule

**Files:**
- Create: `packages/core/src/core/chatPresence.ts`
- Modify: `packages/core/src/extensions/types.ts`, `packages/core/src/extensions/registry.ts`
- Modify: `packages/core/src/platforms/adapter.ts` (`PlatformAdapter`, next to `createChannelPointsPushController` at line 115)
- Modify: `packages/core/package.json` (`exports`)
- Test: `packages/extension/tests/chatPresenceRule.test.ts` (create)

**Interfaces:**
- Consumes: `ChatPresenceStatus` (Task 1).
- Produces, in `@lurkloot/core/chatPresence`:
  - `interface ChatPresenceTarget { username: string; channelId?: string }`
  - `interface ChatPresenceClient { follow(target: ChatPresenceTarget | undefined): Promise<void>; status(): ChatPresenceStatus; drainEvents(): readonly EngineEvent[]; stop(): Promise<void> }`
  - `type ChatPresenceTrigger = { kind: "setting" } | { kind: "provider"; providerId: string }`
  - `interface ChatPresenceDecision { target: ChatPresenceTarget; trigger: ChatPresenceTrigger }`
  - `function chatPresenceDecision(platform: Platform, settings: EngineSettings, state: SchedulerState, options: { capability: boolean; now?: number }): ChatPresenceDecision | undefined`
- Also produces `TwitchExtensionProviderDescriptor.needsChatPresence: boolean` and `PlatformAdapter.createChatPresenceClient?(): ChatPresenceClient`.

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/chatPresenceRule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chatPresenceDecision } from "@lurkloot/core/chatPresence";
import { twitchExtensionProvider } from "@lurkloot/core/extensions/registry";
import type { EngineSettings, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../src/core/storage";

function settingsWith(patch: { enabled?: boolean; alwaysEnterChat?: boolean; pauseOnManualWatch?: boolean } = {}): EngineSettings {
  return {
    ...DEFAULT_ENGINE_SETTINGS,
    pauseOnManualWatch: patch.pauseOnManualWatch ?? DEFAULT_ENGINE_SETTINGS.pauseOnManualWatch,
    platform: {
      ...DEFAULT_ENGINE_SETTINGS.platform,
      twitch: {
        ...DEFAULT_ENGINE_SETTINGS.platform.twitch,
        enabled: patch.enabled ?? true,
        alwaysEnterChat: patch.alwaysEnterChat ?? false,
      },
    },
  };
}

function stateWith(session: Partial<WatchSession> = {}, auth: "healthy" | "checking" = "healthy"): SchedulerState {
  return {
    ...DEFAULT_STATE,
    authHealth: { ...DEFAULT_STATE.authHealth, twitch: { status: auth } },
    sessions: {
      ...DEFAULT_STATE.sessions,
      twitch: {
        platform: "twitch",
        status: "watching",
        watchMode: "tabless",
        offlineChecks: 0,
        channel: { platform: "twitch", username: "Prod", url: "https://www.twitch.tv/prod", channelId: "174754672" },
        ...session,
      },
    },
  } as SchedulerState;
}

const nopixel = { supplementalWatch: { id: "nopixel", tablessOnly: true as const } };
const fortnite = { supplementalWatch: { id: "fortnite", tablessOnly: true as const } };

describe("chat presence rule", () => {
  it("declares chat presence for NoPixelV only", () => {
    expect(twitchExtensionProvider("nopixel")?.needsChatPresence).toBe(true);
    expect(twitchExtensionProvider("fortnite")?.needsChatPresence).toBe(false);
  });

  it("wants presence for a NoPixelV watch, with the provider as trigger", () => {
    expect(chatPresenceDecision("twitch", settingsWith(), stateWith(nopixel), { capability: true })).toEqual({
      target: { username: "prod", channelId: "174754672" },
      trigger: { kind: "provider", providerId: "nopixel" },
    });
  });

  it("wants presence for any tabless watch when alwaysEnterChat is on", () => {
    expect(chatPresenceDecision("twitch", settingsWith({ alwaysEnterChat: true }), stateWith(), { capability: true })?.trigger)
      .toEqual({ kind: "setting" });
  });

  it.each([
    ["no trigger", settingsWith(), stateWith()],
    ["Fortnite watch", settingsWith(), stateWith(fortnite)],
    ["platform disabled", settingsWith({ enabled: false, alwaysEnterChat: true }), stateWith()],
    ["auth not healthy", settingsWith({ alwaysEnterChat: true }), stateWith({}, "checking")],
    ["tab watch never wants presence", settingsWith({ alwaysEnterChat: true }), stateWith({ ...nopixel, watchMode: "tab" })],
    ["not watching", settingsWith({ alwaysEnterChat: true }), stateWith({ status: "paused" })],
    ["no channel", settingsWith({ alwaysEnterChat: true }), stateWith({ channel: undefined })],
  ])("does not want presence: %s", (_label, settings, state) => {
    expect(chatPresenceDecision("twitch", settings, state, { capability: true })).toBeUndefined();
  });

  it("does not want presence without the host capability", () => {
    expect(chatPresenceDecision("twitch", settingsWith({ alwaysEnterChat: true }), stateWith(nopixel), { capability: false })).toBeUndefined();
  });

  it("does not want presence during a manual-close pause or a recent manual watch", () => {
    const paused: SchedulerState = { ...stateWith(nopixel), manualClosePause: { twitch: { platform: "twitch", closedAt: new Date(0).toISOString() } } };
    expect(chatPresenceDecision("twitch", settingsWith(), paused, { capability: true })).toBeUndefined();
    const now = Date.parse("2026-10-05T12:00:00Z");
    const watching: SchedulerState = {
      ...stateWith(nopixel),
      manualWatch: { twitch: { platform: "twitch", tabId: 7, checkedAt: new Date(now).toISOString(), active: true } },
    };
    expect(chatPresenceDecision("twitch", settingsWith({ pauseOnManualWatch: true }), watching, { capability: true, now })).toBeUndefined();
    expect(chatPresenceDecision("twitch", settingsWith({ pauseOnManualWatch: false }), watching, { capability: true, now })).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/chatPresenceRule.test.ts`
Expected: FAIL. `@lurkloot/core/chatPresence` cannot be resolved.

- [ ] **Step 3: Declare the provider flag**

In `packages/core/src/extensions/types.ts`, add to `TwitchExtensionProviderDescriptor`:

```ts
  // The provider credits rewards only while the viewer is in the channel's
  // chat (NoPixelV reads the chatter list, #683), so chat presence follows it.
  readonly needsChatPresence: boolean;
```

In `packages/core/src/extensions/registry.ts`, add `needsChatPresence: true,` to the nopixel descriptor and `needsChatPresence: false,` to the fortnite one, each after `minRefreshIntervalMs`.

- [ ] **Step 4: Write the contract and the rule**

Create `packages/core/src/core/chatPresence.ts`:

```ts
import type { EngineEvent } from "@lurkloot/shared/events";
import type { ChatPresenceStatus, EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { twitchExtensionProvider } from "../extensions/registry";
import { pausedForManualWatch } from "./manualWatch";

// Chat presence (docs/superpowers/specs/2026-10-05-chat-presence-design.md).
export interface ChatPresenceTarget {
  username: string;
  channelId?: string;
}

// One platform's chat connection. Shaped as a SlotObserver (stop +
// drainEvents) so the background service can hold it in an ObserverSlot.
export interface ChatPresenceClient {
  // Join `target`, switch to it, or leave when undefined. Resolves once the
  // command is issued; status() reports whether the join was confirmed.
  follow(target: ChatPresenceTarget | undefined): Promise<void>;
  status(): ChatPresenceStatus;
  drainEvents(): readonly EngineEvent[];
  stop(): Promise<void>;
}

export type ChatPresenceTrigger = { kind: "setting" } | { kind: "provider"; providerId: string };

export interface ChatPresenceDecision {
  target: ChatPresenceTarget;
  trigger: ChatPresenceTrigger;
}

// Whether `platform` wants chat presence for the committed `state`, and where.
// Tab watches never do: the page already joins chat.
export function chatPresenceDecision(
  platform: Platform,
  settings: EngineSettings,
  state: SchedulerState,
  options: { capability: boolean; now?: number },
): ChatPresenceDecision | undefined {
  if (!options.capability) return undefined;
  const platformSettings = settings.platform[platform];
  const session = state.sessions[platform];
  const channel = session.channel;
  if (!platformSettings.enabled
    || state.authHealth[platform].status !== "healthy"
    || state.manualClosePause?.[platform]
    || pausedForManualWatch(settings, state, platform, options.now ?? Date.now())
    || session.status !== "watching"
    || session.watchMode !== "tabless"
    || !channel) return undefined;
  const target: ChatPresenceTarget = {
    username: channel.username.toLowerCase(),
    ...(channel.channelId ? { channelId: channel.channelId } : {}),
  };
  const providerId = platform === "twitch" ? session.supplementalWatch?.id : undefined;
  if (providerId && twitchExtensionProvider(providerId)?.needsChatPresence) {
    return { target, trigger: { kind: "provider", providerId } };
  }
  if (platformSettings.alwaysEnterChat === true) return { target, trigger: { kind: "setting" } };
  return undefined;
}
```

- [ ] **Step 5: Add the adapter factory slot and the package exports**

In `packages/core/src/platforms/adapter.ts`, add `import type { ChatPresenceClient } from "../core/chatPresence";` with the other type imports. In `PlatformAdapter`, after `createChannelPointsPushController?…`:

```ts
  // Joins the watched channel's chat while presence is wanted (chatPresence.ts).
  createChatPresenceClient?(): ChatPresenceClient;
```

In `packages/core/package.json` `exports`, after `"./discoverySignals": …`:

```json
    "./chatPresence": "./src/core/chatPresence.ts",
```

After `"./twitch/channelPointsPush": …`:

```json
    "./twitch/chatPresence": "./src/platforms/twitch/chatPresence.ts",
```

Check `exports` for an `./extensions/registry` entry, since the test imports it. If it is missing, add `"./extensions/registry": "./src/extensions/registry.ts",`.

- [ ] **Step 6: Run the test, the typecheck and the boundary test**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/chatPresenceRule.test.ts tests/coreBoundary.test.ts && pnpm typecheck`
Expected: PASS. The `./twitch/chatPresence` export points at a file Task 3 creates, so if typecheck resolves exports strictly, add that line in Task 3 instead.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/core/chatPresence.ts packages/core/src/extensions packages/core/src/platforms/adapter.ts packages/core/package.json packages/extension/tests/chatPresenceRule.test.ts
git commit -m "feat(core): add the chat presence contract and rule"
```

---

### Task 3: Twitch IRC presence client

**Files:**
- Create: `packages/core/src/platforms/twitch/chatPresence.ts`
- Test: `packages/extension/tests/twitchChatPresence.test.ts` (create)

**Interfaces:**
- Consumes: `ChatPresenceClient` and `ChatPresenceTarget` (Task 2), `WebSocketFactory` and `WebSocketLike` (`@lurkloot/core/webSocket`), `PendingDiscoverySignalDiagnostics` (`../../core/discoverySignals`).
- Produces:
  - `TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv/"`
  - `TWITCH_IRC_IDLE_PING_MS = 25_000`
  - `interface TwitchChatPresenceDeps { createWebSocket; getAuthToken(): Promise<string | undefined>; resolveLogin(): Promise<string | undefined>; setTimer?(cb, ms); clearTimer?(t); now?(): number }`
  - `class TwitchChatPresenceClient implements ChatPresenceClient`
  - `function parseIrcLine(line: string): { command: string; params: string[]; prefixNick?: string; trailing?: string } | undefined`

- [ ] **Step 1: Write the failing tests**

Create `packages/extension/tests/twitchChatPresence.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { parseIrcLine, TwitchChatPresenceClient, TWITCH_IRC_IDLE_PING_MS, TWITCH_IRC_URL } from "@lurkloot/core/twitch/chatPresence";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";

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

function setup(options: { token?: string; login?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const clock = new FakeClock();
  const client = new TwitchChatPresenceClient({
    createWebSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    getAuthToken: async () => ("token" in options ? options.token : "secret-token"),
    resolveLogin: async () => ("login" in options ? options.login : "Viewer"),
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/twitchChatPresence.test.ts`
Expected: FAIL. `@lurkloot/core/twitch/chatPresence` cannot be resolved.

- [ ] **Step 3: Implement the client**

Create `packages/core/src/platforms/twitch/chatPresence.ts`:

```ts
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
  private lastWarnKey?: string;
  private reconnectAttempt = 0;
  private connectedAt = 0;
  private reconnectTimer?: Timer;
  private idleTimer?: Timer;
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
      let token: string | undefined;
      let login: string | undefined;
      try {
        [token, login] = await Promise.all([this.deps.getAuthToken(), this.deps.resolveLogin()]);
      } catch {
        token = undefined;
      }
      if (this.stopped || !this.desired || this.ws) return;
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
        this.fail(`Could not open the Twitch chat connection: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      this.ws = ws;
      this.registered = false;
      this.channelOnServer = undefined;
      this.connectedAt = this.now();
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
          if (line.trailing && AUTH_FAILURE_NOTICES.some((notice) => line.trailing!.includes(notice))) this.block("auth");
          break;
        case "RECONNECT":
          // Twitch's maintenance notice: reconnect promptly and rejoin.
          this.reconnectAttempt = 0;
          this.closeSocket();
          this.joinedChannel = undefined;
          this.setState("joining");
          this.scheduleReconnect();
          break;
        case "JOIN":
          if (line.prefixNick?.toLowerCase() === this.login) this.confirm(this.joinEchoes, line.params[0]);
          break;
        case "USERSTATE":
          this.confirm(this.userStates, line.params[0]);
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
    this.lastWarnKey = undefined;
  }

  private onClose(ws: WebSocketLike): void {
    if (this.intentionallyClosed.has(ws) || this.ws !== ws) return;
    this.ws = undefined;
    this.registered = false;
    this.channelOnServer = undefined;
    this.joinedChannel = undefined;
    this.clearIdle();
    if (this.stopped || this.state === "blocked" || !this.desired) return;
    this.setState("error");
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
      if (state === "joined") this.lastWarnKey = undefined;
      return;
    }
    const key = `${state}:${this.blockReason ?? ""}:${this.desired ?? ""}`;
    if (key === this.lastWarnKey) return;
    this.lastWarnKey = key;
    this.log("warn", warning ?? `Twitch chat presence lost the connection to ${this.desired ?? "chat"}; reconnecting`);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined || !this.desired) return;
    if (this.connectedAt && this.now() - this.connectedAt >= STABLE_CONNECTION_MS) this.reconnectAttempt = 0;
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
      if (this.ws === ws && this.registered) this.sendRaw(ws, "PING :tmi.twitch.tv");
    }, TWITCH_IRC_IDLE_PING_MS);
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    if (this.idleTimer === undefined) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = undefined;
  }

  private closeSocket(): void {
    this.clearIdle();
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
      this.log("warn", `Could not send to Twitch chat: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.ws === ws) this.resetIdle();
  }

  private log(level: "debug" | "warn", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "twitch", level, message });
  }
}
```

`FakeSocket.readyState` stays `0` until `open()`, so the handshake lines go out from the `open` listener once `readyState === 1`. That is why `sendRaw` checks `WEBSOCKET_OPEN`.

- [ ] **Step 4: Run the tests until they pass**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/twitchChatPresence.test.ts`
Expected: PASS, all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/twitch/chatPresence.ts packages/extension/tests/twitchChatPresence.test.ts packages/core/package.json
git commit -m "feat(twitch): join chat over IRC for chat presence"
```

---

### Task 4: Twitch adapter factory and viewer login

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts`. Add a query constant next to `CURRENT_USER_QUERY` (line 23), the factory next to `createChannelPointsPushController` (lines 983 and 1058–1067), and `resolveViewerLogin()` after `resolveViewerUserId()` (line 2567).
- Test: `packages/extension/tests/twitchChatPresence.test.ts` (append)

**Interfaces:**
- Consumes: `TwitchChatPresenceClient` (Task 3), `ChatPresenceClient` (Task 2).
- Produces: `TwitchAdapter.createChatPresenceClient?: () => ChatPresenceClient`. It is defined only when both `webSocketFactory` and `getAuthToken` are set.

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/twitchChatPresence.test.ts`:

```ts
import { twitchAdapter } from "./helpers/adapters";

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
});
```

Move the `twitchAdapter` import to the top of the file with the other imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/twitchChatPresence.test.ts -t "adapter factory"`
Expected: FAIL. `createChatPresenceClient` is `undefined` in the second case.

- [ ] **Step 3: Implement the factory and login resolution**

In `packages/core/src/platforms/twitch/index.ts`:

```ts
// after CURRENT_USER_QUERY
const CURRENT_USER_LOGIN_QUERY = "query CurrentUserLogin { currentUser { id login } }";
```

Add the import:

```ts
import type { ChatPresenceClient } from "../../core/chatPresence";
import { TwitchChatPresenceClient } from "./chatPresence";
```

In the class fields, next to `readonly createChannelPointsPushController?`:

```ts
  readonly createChatPresenceClient?: () => ChatPresenceClient;
```

In the constructor's `if (createWebSocket && getAuthToken) { … }` block, after the channel-points assignment:

```ts
      this.createChatPresenceClient = () => new TwitchChatPresenceClient({
        createWebSocket,
        getAuthToken,
        resolveLogin: () => this.resolveViewerLogin(),
      });
```

After `resolveViewerUserId()`:

```ts
  private async resolveViewerLogin(): Promise<string | undefined> {
    try {
      const response = await this.gqlWithIntegrityRetry<{ currentUser?: { login?: string } }>(
        "CurrentUserLogin",
        "",
        {},
        CURRENT_USER_LOGIN_QUERY,
      );
      return response.data?.currentUser?.login;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(this.emit, "warn", `Could not resolve the Twitch viewer login for chat presence: ${message}`, "twitch");
      return undefined;
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/twitchChatPresence.test.ts tests/twitchChannelPointsPush.test.ts`
Expected: PASS. If the fake fetcher's request shape differs (for example `operationName` lives elsewhere in `init.body`), log `init?.body` once and match the field the GQL transport actually sends. Do not change the transport.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/twitch/index.ts packages/extension/tests/twitchChatPresence.test.ts
git commit -m "feat(twitch): create chat presence clients from the adapter"
```

---

### Task 5: Host capability and the unsupported-setting diagnostic

**Files:**
- Modify: `packages/core/src/background/hostPorts.ts` (`HostCapabilities` lines 31–51)
- Modify: `packages/core/src/background/reporting.ts` (`reportUnsupportedSettings` lines 361–380)
- Modify: `packages/extension/tests/helpers/hostPorts.ts` (`mockedCapabilities` lines 97–104)
- Modify: `packages/extension/tests/hostPorts.test.ts` (lines 99–108)
- Test: `packages/extension/tests/backgroundController/reporting.test.ts` (append)

**Interfaces:**
- Produces: `HostCapabilities.chatPresence: boolean`. It has no port: clients come from the adapters.

- [ ] **Step 1: Write the failing tests**

In `packages/extension/tests/hostPorts.test.ts`, add `chatPresence: true,` to the expected `EXTENSION_CAPABILITIES` object and `chatPresence: false,` to `CLI_CAPABILITIES`.

Append to `packages/extension/tests/backgroundController/reporting.test.ts`, using its imports. Add `hostPortsFromMocks`, `CLI_CAPABILITIES`, `createBackgroundController` and `farming` imports if they are not there:

```ts
describe("chat presence host capability", () => {
  it("reports alwaysEnterChat once as unsupported on a host without chat presence", async () => {
    const settings = farming(DEFAULT_SETTINGS);
    settings.platform.twitch.alwaysEnterChat = true;
    const env = harness(settings);
    const controller = createBackgroundController(hostPortsFromMocks(env.deps, { ...EXTENSION_CAPABILITIES, chatPresence: false }));
    await controller.tick(["twitch"], "manual_tick");
    await controller.tick(["twitch"], "manual_tick");
    const messages = env.reportEvents.mock.calls.flatMap(([events]) => events).map((event) => event.message);
    expect(messages.filter((message) => message === "This host cannot join channel chat, so platform.twitch.alwaysEnterChat has no effect")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/hostPorts.test.ts tests/backgroundController/reporting.test.ts`
Expected: FAIL. The capability objects lack `chatPresence` and the message is never reported.

- [ ] **Step 3: Implement**

In `packages/core/src/background/hostPorts.ts`, add to `HostCapabilities`:

```ts
  // Joining the watched channel's chat (chatPresence.ts). It has no port: the
  // adapters create the clients. Off on the CLI until it is enabled there.
  readonly chatPresence: boolean;
```

Add `chatPresence: true,` to `EXTENSION_CAPABILITIES` and `chatPresence: false,` to `CLI_CAPABILITIES`. `assertHostCapabilities` stays unchanged, because no port has to match.

In `packages/core/src/background/reporting.ts`, replace the body of `reportUnsupportedSettings` up to `const events = unsupported`:

```ts
  async function reportUnsupportedSettings(settings: EngineSettings, tickContext?: TickDiagnosticContext): Promise<void> {
    const unsupported: Array<readonly [string, string]> = [];
    if (!ports.capabilities.browserTabs) {
      if (!settings.tablessMode) {
        unsupported.push(["tablessMode", "This host has no browser tabs, so tablessMode=false has no effect: every watch is tabless"]);
      }
      if (settings.pauseOnManualWatch) {
        unsupported.push(["pauseOnManualWatch", "This host has no browser tabs, so pauseOnManualWatch has no effect"]);
      }
    }
    if (!ports.capabilities.chatPresence) {
      for (const platform of PLATFORMS) {
        if (settings.platform[platform].alwaysEnterChat !== true) continue;
        const key = `platform.${platform}.alwaysEnterChat`;
        unsupported.push([key, `This host cannot join channel chat, so ${key} has no effect`]);
      }
    }
```

Leave the rest of the function as it is, and import `PLATFORMS` from `./constants` if `reporting.ts` does not already.

In `packages/extension/tests/helpers/hostPorts.ts`, `mockedCapabilities`:

```ts
    supplementalSources: mocks.selectSupplementalWatchTarget !== undefined,
    // Extension-shaped mocks (with tabs) join chat like the extension does.
    chatPresence: browserTabs,
```

Any test that builds a `HostCapabilities` literal by hand will fail typecheck; add `chatPresence` to each one. Find them with `grep -rn "supplementalSources:" packages/extension/tests packages/cli/tests`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/hostPorts.test.ts tests/backgroundController/reporting.test.ts tests/controllerContract.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/background/hostPorts.ts packages/core/src/background/reporting.ts packages/extension/tests
git commit -m "feat(core): declare the chat presence host capability"
```

---

### Task 6: The chat presence service

**Files:**
- Create: `packages/core/src/background/chatPresence.ts`
- Modify: `packages/core/src/background/types.ts`. Add a `// chatPresence.ts` block next to `// channelPoints.ts` (line 360).
- Modify: `packages/core/src/background/stateTransaction.ts` (`TickConclusion.observerEpochs`, lines 141–144)
- Modify: `packages/core/src/background/tickRun.ts`. Add the `Pick` entry near line 45, the destructure near line 91, and `observerEpochs` at line 612.
- Modify: `packages/core/src/background/lifecycle.ts`. Add the `Pick` entries near lines 93–95, `snapshot()` at line 270, `shutdown()` at line 299 and `prepareForHostReset()` at line 318.
- Modify: `packages/core/src/background/controller.ts` (module list at line 113)
- Modify: `packages/extension/tests/helpers/backgroundController.ts` (a fake client and the `harness()` return)
- Test: `packages/extension/tests/backgroundController/chatPresence.test.ts` (create)

**Interfaces:**
- Consumes: `chatPresenceDecision`, `ChatPresenceClient` (Task 2); `PlatformAdapter.createChatPresenceClient` (Task 2); `ports.capabilities.chatPresence` (Task 5); `ObserverSlot` (`./observerSlot`).
- Produces these `ControllerCalls` members:
  - `chatPresenceEpochs(platforms: readonly Platform[]): Partial<Record<Platform, number>>`
  - `chatPresenceStatuses(): Partial<Record<Platform, ChatPresenceStatus>>`
  - `stopChatPresenceAndReport(platforms: readonly Platform[]): Promise<void>`
  - `stopChatPresenceInBackground(platforms: readonly Platform[]): void`
  - `TickConclusion.observerEpochs.chatPresence: Partial<Record<Platform, number>>`

- [ ] **Step 1: Add the fake client to the harness**

In `packages/extension/tests/helpers/backgroundController.ts`, add these imports:

```ts
import type { ChatPresenceClient, ChatPresenceTarget } from "@lurkloot/core/chatPresence";
import type { ChatPresenceStatus } from "@lurkloot/shared/models";
```

Add the class after `FakeChannelPointsPushController`:

```ts
export class FakeChatPresenceClient implements ChatPresenceClient {
  follows: Array<ChatPresenceTarget | undefined> = [];
  stops = 0;
  followBarrier?: Promise<void>;
  current: ChatPresenceStatus = { state: "left" };
  private readonly events: DiagnosticEvent[] = [];

  async follow(target: ChatPresenceTarget | undefined): Promise<void> {
    this.follows.push(target);
    if (this.followBarrier) await this.followBarrier;
    this.current = target ? { state: "joined", channel: target.username } : { state: "left" };
  }

  status(): ChatPresenceStatus {
    return this.current;
  }

  drainEvents(): DiagnosticEvent[] {
    return this.events.splice(0);
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.current = { state: "left" };
  }
}
```

In `harness()`, after the channel-points factory lines:

```ts
  const chatPresenceClient = new FakeChatPresenceClient();
  const chatPresenceFactory = vi.fn(() => chatPresenceClient);
  twitch.createChatPresenceClient = chatPresenceFactory;
```

Add `chatPresenceClient,` and `chatPresenceFactory,` to the returned object.

- [ ] **Step 2: Write the failing service tests**

Create `packages/extension/tests/backgroundController/chatPresence.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ChannelCandidate, ExtensionSettings } from "@lurkloot/shared/models";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { allDiagnostics, deferred, farming, harness } from "../helpers/backgroundController";

function chatSettings(alwaysEnterChat: boolean): ExtensionSettings {
  const settings = farming({ ...DEFAULT_SETTINGS, tablessMode: true });
  return {
    ...settings,
    platform: {
      ...settings.platform,
      kick: { ...settings.platform.kick, enabled: false },
      twitch: { ...settings.platform.twitch, alwaysEnterChat },
    },
  };
}

function tablessTwitch(env: ReturnType<typeof harness>): void {
  const watcher = {
    platform: "twitch" as const,
    async start(_candidate: ChannelCandidate) {},
    async tick() { return { ok: true, live: true }; },
    drainEvents() { return []; },
    async stop() {},
  } satisfies TablessWatchController;
  env.twitch.supportsTabless = true;
  env.twitch.createTablessWatcher = () => watcher;
}

describe("chat presence service", () => {
  it("joins the watched channel's chat for a tabless watch when alwaysEnterChat is on", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    expect(env.state.sessions.twitch).toMatchObject({ status: "watching", watchMode: "tabless" });
    expect(env.chatPresenceFactory).toHaveBeenCalledOnce();
    expect(env.chatPresenceClient.follows).toEqual([{ username: "twitch-creator" }]);
  });

  it("does not create a client when nothing wants presence", async () => {
    const env = harness(chatSettings(false));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    expect(env.chatPresenceFactory).not.toHaveBeenCalled();
  });

  it("does not create a client for a tab watch", async () => {
    const env = harness({ ...chatSettings(true), tablessMode: false });
    await env.controller.tick(["twitch"], "manual_tick");
    expect(env.state.sessions.twitch.watchMode).not.toBe("tabless");
    expect(env.chatPresenceFactory).not.toHaveBeenCalled();
  });

  it("stops the client when auth leaves healthy", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    await env.controller.invalidateAuthHealth("twitch");
    expect(env.chatPresenceClient.stops).toBe(1);
  });

  it("stops the client when the setting is switched off", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { alwaysEnterChat: false } } } });
    expect(env.chatPresenceClient.stops).toBe(1);
  });

  it("does not keep a client whose start finished after auth was invalidated", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    const blocked = deferred<void>();
    env.chatPresenceClient.followBarrier = blocked.promise;
    const tick = env.controller.tick(["twitch"], "manual_tick");
    await vi.waitFor(() => expect(env.chatPresenceClient.follows).toHaveLength(1));
    await env.controller.invalidateAuthHealth("twitch");
    blocked.resolve();
    await tick;
    await env.controller.settleBackgroundWork();
    expect(env.chatPresenceClient.stops).toBeGreaterThanOrEqual(1);
  });

  it("attaches each platform's presence status to snapshots", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    const snapshot = await env.controller.handleMessage({ type: "getSnapshot" }) as { state: { chatPresence?: unknown } };
    expect(snapshot.state.chatPresence).toEqual({ twitch: { state: "joined", channel: "twitch-creator" } });
    expect(env.state).not.toHaveProperty("chatPresence");
  });

  it("joins for a committed NoPixelV watch and announces it once", async () => {
    const providerChannel = { platform: "twitch" as const, username: "prod", url: "https://www.twitch.tv/prod", channelId: "174754672" };
    const env = harness(chatSettings(false), {
      initialState: {
        ...DEFAULT_STATE,
        authHealth: { ...DEFAULT_STATE.authHealth, twitch: { status: "healthy" } },
        sessions: {
          ...DEFAULT_STATE.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            watchMode: "tabless",
            offlineChecks: 0,
            channel: providerChannel,
            supplementalWatch: { id: "nopixel", tablessOnly: true },
          },
        },
      },
    });
    // A settings save reconciles presence against the stored state.
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { alwaysEnterChat: false } } } });
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { alwaysEnterChat: false } } } });
    expect(env.chatPresenceClient.follows).toEqual([{ username: "prod", channelId: "174754672" }, { username: "prod", channelId: "174754672" }]);
    const announcements = allDiagnostics(env).filter((event) => event.message === "Joined prod's chat because nopixel needs chat presence to earn watch time");
    expect(announcements).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController/chatPresence.test.ts`
Expected: FAIL. The factory is never called and the snapshot has no `chatPresence`.

- [ ] **Step 4: Implement the service**

Create `packages/core/src/background/chatPresence.ts`:

```ts
import type { EventEmitter } from "@lurkloot/shared/events";
import type { ChatPresenceStatus, EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { chatPresenceDecision, type ChatPresenceClient } from "../core/chatPresence";
import type { PlatformAdapter } from "../platforms/adapter";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { emitHostCallbackError } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import { ObserverSlot } from "./observerSlot";
import type { StateTransaction } from "./stateTransaction";
import type { ControllerCalls } from "./types";

// Chat presence (docs/superpowers/specs/2026-10-05-chat-presence-design.md):
// one client per platform following the committed watch, reconciled like the
// discovery-signal observers. Presence never affects heartbeats.
export function createChatPresence<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  transaction: Pick<StateTransaction<S>, "onCommit" | "onTickConcluded">,
  { lifecycleSlice }: Pick<ControllerSlices<S>, "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "createAdapter"
    | "diagnosticEvent"
    | "reportBestEffort"
    | "withEventCollector"
    | "trackBackgroundWork"
  >,
): Pick<ControllerCalls<S>,
  | "chatPresenceEpochs"
  | "chatPresenceStatuses"
  | "stopChatPresenceAndReport"
  | "stopChatPresenceInBackground"
> {
  const { createAdapter, diagnosticEvent, reportBestEffort, withEventCollector, trackBackgroundWork } = lateBound(calls);
  const slots: Record<Platform, ObserverSlot<ChatPresenceClient>> = {
    twitch: new ObserverSlot<ChatPresenceClient>("twitch", "chat presence", "discard"),
    kick: new ObserverSlot<ChatPresenceClient>("kick", "chat presence", "discard"),
  };
  // "<provider>:<channel>" last announced per platform, so the provider
  // announcement is made once per presence session.
  const announced: Partial<Record<Platform, string>> = {};

  function observersOpen(): boolean {
    return lifecycleSlice.observersOpen && !lifecycleSlice.controllerShutdown;
  }

  async function reconcile(
    platform: Platform,
    settings: EngineSettings,
    state: SchedulerState,
    adapter: PlatformAdapter,
    emit: EventEmitter,
    since: number,
  ): Promise<void> {
    const decision = chatPresenceDecision(platform, settings, state, { capability: ports.capabilities.chatPresence });
    if (decision?.trigger.kind === "provider") {
      const key = `${decision.trigger.providerId}:${decision.target.username}`;
      if (announced[platform] !== key) {
        announced[platform] = key;
        emit({
          category: "diagnostic",
          platform,
          level: "info",
          message: `Joined ${decision.target.username}'s chat because ${decision.trigger.providerId} needs chat presence to earn watch time`,
        });
      }
    } else {
      announced[platform] = undefined;
    }
    await slots[platform].reconcile({
      wanted: decision !== undefined,
      factory: adapter.createChatPresenceClient,
      open: observersOpen,
      since,
      emit,
      start: (client) => client.follow(decision?.target),
    });
  }

  async function stopChatPresence(platforms: readonly Platform[], emit: EventEmitter): Promise<void> {
    for (const platform of platforms) announced[platform] = undefined;
    await Promise.all(platforms.map((platform) => slots[platform].stop(emit)));
  }

  async function stopChatPresenceAndReport(platforms: readonly Platform[]): Promise<void> {
    await withEventCollector(async (emit, events) => {
      await stopChatPresence(platforms, emit);
      await reportBestEffort(events);
    });
  }

  function stopChatPresenceInBackground(platforms: readonly Platform[]): void {
    const run = stopChatPresenceAndReport(platforms).catch((error) => {
      diagnosticEvent("warn", `Chat presence cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        platforms.length === 1 ? platforms[0] : undefined);
    });
    trackBackgroundWork(run);
  }

  function chatPresenceEpochs(platforms: readonly Platform[]): Partial<Record<Platform, number>> {
    return Object.fromEntries(platforms.map((platform) => [platform, slots[platform].epoch]));
  }

  function chatPresenceStatuses(): Partial<Record<Platform, ChatPresenceStatus>> {
    const statuses: Partial<Record<Platform, ChatPresenceStatus>> = {};
    for (const platform of PLATFORMS) {
      const client = slots[platform].current;
      if (client) statuses[platform] = client.status();
    }
    return statuses;
  }

  // A commit that leaves auth unhealthy (logout, rejected probe, an account
  // change being checked, #595) or ends the watch stops presence before any
  // await, so the old identity never stays in chat.
  transaction.onCommit(async (change) => {
    if (change.kind !== "state") return;
    const { previous, state } = change;
    const platforms = change.platforms.filter((platform) =>
      slots[platform].current !== undefined
      && (state.authHealth[platform].status !== "healthy"
        || (previous.sessions[platform].status === "watching" && state.sessions[platform].status !== "watching")));
    if (platforms.length > 0) await stopChatPresenceAndReport(platforms);
  });

  // A settings save can switch a trigger on or off; follow it at once.
  transaction.onCommit((change) => {
    if (change.kind !== "settings" || change.startup) return;
    const run = reconcileFromSettings(change.settings).catch((error) => {
      diagnosticEvent("warn", `Chat presence reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    trackBackgroundWork(run);
  });

  async function reconcileFromSettings(settings: S): Promise<void> {
    await withEventCollector(async (emit, events) => {
      try {
        for (const platform of PLATFORMS) {
          if (!observersOpen()) {
            await slots[platform].stop(emit);
            continue;
          }
          // Read before the state: a stop after this point makes it stale.
          const since = slots[platform].epoch;
          const state = await ports.storage.loadState();
          if (!chatPresenceDecision(platform, settings, state, { capability: ports.capabilities.chatPresence })) {
            if (slots[platform].current) await slots[platform].stop(emit);
            continue;
          }
          const adapter = createAdapter(platform, settings, emit);
          await reconcile(platform, settings, state, adapter, emit, since);
        }
      } catch (error) {
        emitHostCallbackError(emit, undefined, error, "Could not reconcile chat presence");
      } finally {
        await reportBestEffort(events);
      }
    });
  }

  // After a tick commits, with no lock held: presence follows the committed
  // watch. A stop since the commit bumps the epoch, so it backs off.
  transaction.onTickConcluded((tick) => {
    if (tick.signal.aborted) return;
    tick.follow(withEventCollector(async (emit, events) => {
      for (const platform of tick.platforms) {
        try {
          await reconcile(platform, tick.settings, tick.state, tick.adapters[platform], emit,
            tick.observerEpochs.chatPresence[platform] ?? slots[platform].epoch);
        } catch (error) {
          diagnosticEvent("warn", `Chat presence reconcile failed: ${error instanceof Error ? error.message : String(error)}`, platform);
        }
      }
      await reportBestEffort(tick.correlate(events));
    }));
  });

  return { chatPresenceEpochs, chatPresenceStatuses, stopChatPresenceAndReport, stopChatPresenceInBackground };
}
```

Check two signatures before writing the calls:
- `emitHostCallbackError` in `./helpers`: if it requires a `Platform`, pass `"twitch"` there, as `channelPoints.ts` does.
- `createAdapter`: `channelPoints.ts` calls `createAdapter("twitch", settings, emit)`. If it returns `{ adapter }` rather than the adapter, destructure it accordingly.

- [ ] **Step 5: Wire it in**

`packages/core/src/background/types.ts`, inside `ControllerCalls`, after the `// channelPoints.ts` block:

```ts
  // chatPresence.ts
  chatPresenceEpochs(platforms: readonly Platform[]): Partial<Record<Platform, number>>;
  chatPresenceStatuses(): Partial<Record<Platform, ChatPresenceStatus>>;
  stopChatPresenceAndReport(platforms: readonly Platform[]): Promise<void>;
  stopChatPresenceInBackground(platforms: readonly Platform[]): void;
```

Add `ChatPresenceStatus` to that file's `@lurkloot/shared/models` type import.

`packages/core/src/background/stateTransaction.ts`, in `observerEpochs`:

```ts
    readonly chatPresence: Partial<Record<Platform, number>>;
```

`packages/core/src/background/tickRun.ts`: add `| "chatPresenceEpochs"` to the `Pick` list, `chatPresenceEpochs,` to the destructure, and in `observerEpochs`:

```ts
                chatPresence: chatPresenceEpochs(schedulerPlatforms),
```

`packages/core/src/background/lifecycle.ts`: add `| "chatPresenceStatuses" | "stopChatPresenceAndReport" | "stopChatPresenceInBackground"` to its `Pick` list and the destructure. Then:

```ts
  async function snapshot(): Promise<RuntimeSnapshot<S>> {
    const state = await ports.storage.loadState();
    const chatPresence = chatPresenceStatuses();
    return {
      settings: await ports.storage.loadSettings(),
      state: Object.keys(chatPresence).length > 0 ? { ...state, chatPresence } : state,
    };
  }
```

In `shutdown()`, after `stopTwitchChannelPointsPushInBackground();`:

```ts
    stopChatPresenceInBackground(PLATFORMS);
```

In `prepareForHostReset()`, after `await stopTwitchChannelPointsPushAndReport();`:

```ts
      await stopChatPresenceAndReport(PLATFORMS);
```

`packages/core/src/background/controller.ts`: add `import { createChatPresence } from "./chatPresence";`, and add to the module list after `createChannelPoints`:

```ts
    ...createChatPresence(ports, transaction, { lifecycleSlice }, calls),
```

- [ ] **Step 6: Run the service tests, then the whole suite**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController/chatPresence.test.ts`
Expected: PASS.

Then: `pnpm test && pnpm typecheck`
Expected: PASS. The `observerEpochs` literal change can break hand-built `TickConclusion` fixtures in `tickRun.test.ts` or the controller contract tests. Add `chatPresence: {}` there.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/background packages/extension/tests/helpers/backgroundController.ts packages/extension/tests/backgroundController/chatPresence.test.ts
git commit -m "feat(core): follow the committed watch with chat presence"
```

---

### Task 7: Popup: setting, strip badge, NoPixelV badge, locales

**Files:**
- Modify: `packages/popup-ui/src/settingsRegistry.tsx` (`platformSection`, after `claimEntry` at line 366)
- Modify: `packages/popup-ui/src/statusStrip.tsx` (`StatusStrip` props and `WatchingLines`)
- Modify: `packages/popup-ui/src/twitchExtensions.tsx` (`providerDetails` and `TwitchExtensionView`)
- Modify: `packages/popup-ui/src/Popup.tsx` (`<StatusStrip` at line 903, `<TwitchExtensionView` at line 1048)
- Modify: `packages/locales/messages/*.json` (all 11)
- Test: `packages/extension/tests/chatPresencePopup.test.tsx` (create)

**Interfaces:**
- Consumes: `ChatPresenceStatus`, `SchedulerState.chatPresence` (Task 1); `settings.platform.twitch.alwaysEnterChat`.
- Produces:
  - Settings entry id `twitch.alwaysEnterChat`.
  - `StatusStrip` prop `chatPresence?: ChatPresenceStatus`.
  - `TwitchExtensionView` prop `chatPresence?: ChatPresenceStatus`.
  - `providerDetails(provider, summary, t, chatPresenceBlocked = false)`.
  - Locale keys: `alwaysEnterChatTitle`, `alwaysEnterChatDescription`, `chatPresenceJoined`, `chatPresenceJoining`, `chatPresenceUnavailable`, `chatPresenceBlockedAuth`, `extensionChatPresenceBlocked`.

- [ ] **Step 1: Write the failing tests**

Create `packages/extension/tests/chatPresencePopup.test.tsx`:

```tsx
// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPresenceStatus } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { StatusStrip } from "../../popup-ui/src/statusStrip";
import { TwitchExtensionView } from "../../popup-ui/src/twitchExtensions";
import { I18nContext } from "../../popup-ui/src/context";

const messages: Record<string, string> = {
  watchingLabel: "Watching",
  chatPresenceJoined: "In chat",
  chatPresenceJoining: "Joining chat…",
  chatPresenceUnavailable: "Chat unavailable",
  chatPresenceBlockedAuth: "Chat unavailable: sign in to Twitch again",
  extensionChatPresenceBlocked: "Not in chat: NoPixel watch time isn't earned until chat presence recovers",
};
const t = (key: string) => messages[key] ?? key;

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function render(node: React.ReactNode): HTMLElement {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = "<div id=app></div>";
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(<I18nContext.Provider value={{ t: t as never, dir: "ltr", locale: "en" }}>{node}</I18nContext.Provider>);
  });
  return container;
}

function strip(chatPresence?: ChatPresenceStatus): HTMLElement {
  return render(
    <StatusStrip
      platform="twitch"
      presentation={{ state: "running", operational: true } as never}
      farmingChannel={{ name: "prod", url: "https://www.twitch.tv/prod" } as never}
      chatPresence={chatPresence}
      enabled
      pending={false}
      onToggle={() => undefined}
    />,
  );
}

describe("chat presence in the popup", () => {
  it.each([
    [{ state: "joined", channel: "prod" }, "In chat"],
    [{ state: "joining", channel: "prod" }, "Joining chat…"],
    [{ state: "error", channel: "prod" }, "Chat unavailable"],
    [{ state: "blocked", channel: "prod", reason: "auth" }, "Chat unavailable: sign in to Twitch again"],
  ] as const)("labels the strip badge for %o", (status, label) => {
    expect(strip(status).querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  });

  it("shows no badge when presence is not wanted", () => {
    expect(strip(undefined).querySelector('[data-chat-presence]')).toBeNull();
    expect(strip({ state: "left" }).querySelector('[data-chat-presence]')).toBeNull();
  });

  it("warns on the active NoPixelV view while it is not in chat", () => {
    const settings = { ...DEFAULT_SETTINGS, twitchExtensions: { ...DEFAULT_SETTINGS.twitchExtensions, nopixel: { ...DEFAULT_SETTINGS.twitchExtensions.nopixel, enabled: true } } };
    const summary = { status: "farming", reasonCode: "watchtime", progress: [{ key: "daily-pack", earned: 3, required: 60 }], pending: [], updatedAt: new Date(0).toISOString() } as never;
    const view = (chatPresence: ChatPresenceStatus) => render(
      <TwitchExtensionView providerId="nopixel" settings={settings} summary={summary} active pending={false}
        chatPresence={chatPresence} onEnabledChange={async () => true} onOptionChange={() => undefined} />,
    );
    expect(view({ state: "error", channel: "prod" }).querySelector(`[aria-label="${messages.extensionChatPresenceBlocked}"]`)).not.toBeNull();
    expect(view({ state: "joined", channel: "prod" }).querySelector(`[aria-label="${messages.extensionChatPresenceBlocked}"]`)).toBeNull();
  });
});
```

In `packages/extension/tests/settingsRegistry.test.ts`, in the `keeps the full settings tree stable` inline snapshot, insert `"twitch.alwaysEnterChat",` on the line after `"twitch.autoClaimChannelPoints",`. Kick gets no entry yet.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/chatPresencePopup.test.tsx tests/settingsRegistry.test.ts`
Expected: FAIL. The props and the entry do not exist.

- [ ] **Step 3: Add the strip badge**

In `packages/popup-ui/src/statusStrip.tsx`:
- Import `MessageSquare` from `lucide-react` and `type ChatPresenceStatus` from `@lurkloot/shared/models`.
- Add `chatPresence?: ChatPresenceStatus;` to the `StatusStrip` props, with the comment `// Set while chat presence is wanted for this platform's watch.`.
- Pass it through as `<WatchingLines … chatPresence={chatPresence} />`.
- Add `chatPresence?: ChatPresenceStatus` to `WatchingLines`' props.
- Inside the second row, immediately after the viewers `Tip`, add:

```tsx
        {chatPresence && chatPresence.state !== "left" ? <ChatPresenceBadge status={chatPresence} /> : null}
```

Add at the end of the file:

```tsx
function chatPresenceLabelKey(status: ChatPresenceStatus): string {
  if (status.state === "joined") return "chatPresenceJoined";
  if (status.state === "joining") return "chatPresenceJoining";
  if (status.state === "blocked" && status.reason === "auth") return "chatPresenceBlockedAuth";
  return "chatPresenceUnavailable";
}

// Icon-only so the strip keeps its fixed height; the label is the tooltip and
// the accessible name.
function ChatPresenceBadge({ status }: { status: ChatPresenceStatus }): React.ReactElement {
  const t = useT();
  const label = t(chatPresenceLabelKey(status));
  const tone = status.state === "joined"
    ? "text-[var(--accent-text)]"
    : status.state === "joining" ? "text-zinc-400 dark:text-zinc-500" : "text-amber-600 dark:text-amber-400";
  return (
    <Tip label={label}>
      <span role="img" aria-label={label} data-chat-presence={status.state} className={cn("inline-flex shrink-0", tone)}>
        <MessageSquare size={10} aria-hidden />
      </span>
    </Tip>
  );
}
```

- [ ] **Step 4: Add the NoPixelV badge**

In `packages/popup-ui/src/twitchExtensions.tsx`:
- Import `MessageSquareOff` from `lucide-react` and `type ChatPresenceStatus`.
- Change the signature to `function providerDetails(provider: TwitchExtensionProviderId, summary: TwitchExtensionSummary | undefined, t: ReturnType<typeof useT>, chatPresenceBlocked = false)`.
- Inside the `provider === "nopixel"` branch, before the giveaway badges, add:

```ts
    if (chatPresenceBlocked) badges.push({ key: "chat-presence", icon: MessageSquareOff, tone: "warning", label: t("extensionChatPresenceBlocked") });
```

In `TwitchExtensionView`, add `chatPresence?: ChatPresenceStatus;` to its props, with the comment `// The Twitch chat presence status; NoPixelV earns watch time only while joined.`. Then change its `providerDetails` call to:

```ts
  const chatPresenceBlocked = providerId === "nopixel" && active && chatPresence !== undefined && chatPresence.state !== "joined";
  const { progress, badges } = providerDetails(providerId, summary, t, chatPresenceBlocked);
```

Then find where `TwitchExtensionView` renders badges (it already maps `badges`). If it does not, render them the same way `ProviderCard` does: `{badges.map((badge) => <StatusBadge key={badge.key} badge={badge} />)}` next to the status line.

- [ ] **Step 5: Wire the popup**

In `packages/popup-ui/src/Popup.tsx`, add `chatPresence={snapshot.state.chatPresence?.[platform]}` to `<StatusStrip` and `chatPresence={snapshot.state.chatPresence?.twitch}` to `<TwitchExtensionView`.

In `packages/popup-ui/src/settingsRegistry.tsx`, `platformSection`: after the `claimEntry` constant, define:

```tsx
    // Kick gets its row with its client (plan 2); until then the setting
    // would have no effect there.
    const chatEntry: SettingsEntryDef | undefined = platform === "twitch"
      ? {
        id: "twitch.alwaysEnterChat",
        titleKey: "alwaysEnterChatTitle",
        descriptionKey: "alwaysEnterChatDescription",
        render: () => <SettingRow title={t("alwaysEnterChatTitle")} description={t("alwaysEnterChatDescription")} checked={settings.platform.twitch.alwaysEnterChat === true} onChange={(value) => void onSettingsChange({ platform: { twitch: { alwaysEnterChat: value } } }, { tickAfterSave: true, tickAfterSavePlatforms: ["twitch"] })} />,
      }
      : undefined;
```

At line 507, the section's rows: change `rows: [claimEntry],` to `rows: chatEntry ? [claimEntry, chatEntry] : [claimEntry],`.

- [ ] **Step 6: Add the locale keys**

Add these keys to every catalog in `packages/locales/messages/`, keeping each file's existing key order and formatting (`{"message": "…"}`). Also replace `extensionNoPixelHint`.

| key | en |
| --- | --- |
| `alwaysEnterChatTitle` | Always enter channel chat |
| `alwaysEnterChatDescription` | Join the chat of each channel being watched. Streamers and moderators can see you in the chat's viewer list. Messages are never sent. |
| `chatPresenceJoined` | In chat |
| `chatPresenceJoining` | Joining chat… |
| `chatPresenceUnavailable` | Chat unavailable |
| `chatPresenceBlockedAuth` | Chat unavailable: sign in to Twitch again |
| `extensionChatPresenceBlocked` | Not in chat: NoPixel watch time isn't earned until chat presence recovers |
| `extensionNoPixelHint` | Earn daily packs and join giveaways. Earning watch time joins the watched channel's chat, so you appear in its viewer list. |

Translations, in the same key order:

- **ar**: "الدخول دائمًا إلى دردشة القناة" · "انضم إلى دردشة كل قناة تتم مشاهدتها. يمكن لصانعي المحتوى والمشرفين رؤيتك في قائمة مشاهدي الدردشة. لا تُرسل أي رسائل أبدًا." · "في الدردشة" · "جارٍ الانضمام إلى الدردشة…" · "الدردشة غير متاحة" · "الدردشة غير متاحة: سجّل الدخول إلى Twitch مجددًا" · "لست في الدردشة: لا يُحتسب وقت مشاهدة NoPixel حتى يعود الحضور في الدردشة" · "احصل على الحزم اليومية وشارك في السحوبات. يتطلب احتساب وقت المشاهدة الانضمام إلى دردشة القناة التي تتم مشاهدتها، لذا ستظهر في قائمة مشاهديها."
- **de**: "Immer dem Kanal-Chat beitreten" · "Tritt dem Chat jedes angesehenen Kanals bei. Streamer und Moderatoren sehen dich in der Zuschauerliste des Chats. Es werden nie Nachrichten gesendet." · "Im Chat" · "Chat wird betreten…" · "Chat nicht verfügbar" · "Chat nicht verfügbar: Melde dich erneut bei Twitch an" · "Nicht im Chat: NoPixel-Wiedergabezeit wird erst wieder gezählt, wenn die Chat-Präsenz zurück ist" · "Erhalte tägliche Pakete und nimm an Verlosungen teil. Um Wiedergabezeit zu sammeln, tritt Lurkloot dem Chat des angesehenen Kanals bei, daher erscheinst du in dessen Zuschauerliste."
- **es**: "Entrar siempre al chat del canal" · "Únete al chat de cada canal que se esté viendo. Los streamers y moderadores pueden verte en la lista de espectadores del chat. Nunca se envían mensajes." · "En el chat" · "Entrando al chat…" · "Chat no disponible" · "Chat no disponible: vuelve a iniciar sesión en Twitch" · "Fuera del chat: el tiempo de visualización de NoPixel no cuenta hasta que se recupere la presencia en el chat" · "Obtén paquetes diarios y participa en sorteos. Para acumular tiempo de visualización se entra al chat del canal que se está viendo, así que aparecerás en su lista de espectadores."
- **fr**: "Toujours rejoindre le chat de la chaîne" · "Rejoindre le chat de chaque chaîne regardée. Les streamers et modérateurs peuvent vous voir dans la liste des spectateurs du chat. Aucun message n'est jamais envoyé." · "Dans le chat" · "Connexion au chat…" · "Chat indisponible" · "Chat indisponible : reconnectez-vous à Twitch" · "Hors du chat : le temps de visionnage NoPixel n'est pas comptabilisé tant que la présence dans le chat n'est pas rétablie" · "Obtenez des packs quotidiens et participez aux tirages. Pour cumuler du temps de visionnage, Lurkloot rejoint le chat de la chaîne regardée : vous apparaissez donc dans sa liste de spectateurs."
- **hi**: "हमेशा चैनल चैट में शामिल हों" · "देखे जा रहे हर चैनल की चैट में शामिल हों। स्ट्रीमर और मॉडरेटर आपको चैट की दर्शक सूची में देख सकते हैं। कोई संदेश कभी नहीं भेजा जाता।" · "चैट में" · "चैट में शामिल हो रहे हैं…" · "चैट उपलब्ध नहीं" · "चैट उपलब्ध नहीं: Twitch में फिर से साइन इन करें" · "चैट में नहीं: चैट उपस्थिति लौटने तक NoPixel का वॉच टाइम नहीं गिना जाता" · "दैनिक पैक पाएँ और उपहार प्रतियोगिताओं में शामिल हों। वॉच टाइम कमाने के लिए देखे जा रहे चैनल की चैट में शामिल होना पड़ता है, इसलिए आप उसकी दर्शक सूची में दिखेंगे।"
- **it**: "Entra sempre nella chat del canale" · "Entra nella chat di ogni canale guardato. Streamer e moderatori possono vederti nell'elenco spettatori della chat. Non viene mai inviato alcun messaggio." · "In chat" · "Ingresso in chat…" · "Chat non disponibile" · "Chat non disponibile: accedi di nuovo a Twitch" · "Non sei in chat: il tempo di visione di NoPixel non viene conteggiato finché la presenza in chat non torna" · "Ottieni pacchetti giornalieri e partecipa alle estrazioni. Per accumulare tempo di visione si entra nella chat del canale guardato, quindi comparirai nel suo elenco spettatori."
- **pt_BR**: "Sempre entrar no chat do canal" · "Entre no chat de cada canal assistido. Streamers e moderadores podem ver você na lista de espectadores do chat. Nenhuma mensagem é enviada." · "No chat" · "Entrando no chat…" · "Chat indisponível" · "Chat indisponível: entre na Twitch novamente" · "Fora do chat: o tempo assistido do NoPixel não conta até a presença no chat voltar" · "Ganhe pacotes diários e participe de sorteios. Para acumular tempo assistido, o Lurkloot entra no chat do canal assistido, então você aparece na lista de espectadores dele."
- **ru**: "Всегда заходить в чат канала" · "Заходить в чат каждого просматриваемого канала. Стримеры и модераторы видят вас в списке зрителей чата. Сообщения никогда не отправляются." · "В чате" · "Вход в чат…" · "Чат недоступен" · "Чат недоступен: войдите в Twitch снова" · "Не в чате: время просмотра NoPixel не засчитывается, пока присутствие в чате не восстановится" · "Получайте ежедневные наборы и участвуйте в розыгрышах. Чтобы засчитывалось время просмотра, Lurkloot заходит в чат просматриваемого канала, поэтому вы появляетесь в списке его зрителей."
- **tr**: "Kanal sohbetine her zaman katıl" · "İzlenen her kanalın sohbetine katıl. Yayıncılar ve moderatörler seni sohbetin izleyici listesinde görebilir. Asla mesaj gönderilmez." · "Sohbette" · "Sohbete katılınıyor…" · "Sohbet kullanılamıyor" · "Sohbet kullanılamıyor: Twitch'e yeniden giriş yap" · "Sohbette değil: sohbet varlığı geri gelene kadar NoPixel izleme süresi sayılmaz" · "Günlük paketler kazanın ve çekilişlere katılın. İzleme süresi kazanmak için izlenen kanalın sohbetine katılınır, bu yüzden izleyici listesinde görünürsünüz."
- **zh_CN**: "始终进入频道聊天室" · "加入每个正在观看的频道的聊天室。主播和管理员可以在聊天室观众列表中看到你。不会发送任何消息。" · "在聊天室中" · "正在加入聊天室…" · "聊天室不可用" · "聊天室不可用：请重新登录 Twitch" · "不在聊天室中：恢复聊天室在线前，NoPixel 观看时长不会累计" · "获取每日卡包并参加抽奖。累计观看时长需要加入正在观看的频道的聊天室，因此你会出现在其观众列表中。"

The en, fr, pt_BR and ru `extensionNoPixelHint` texts name "Lurkloot", so follow each catalog's existing product-name usage. If a catalog never names the product, rephrase it without the name, as the es, it, hi, tr, zh_CN and ar texts already do.

- [ ] **Step 7: Run the popup tests and the locale checks**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/chatPresencePopup.test.tsx tests/settingsRegistry.test.ts tests/settingsSearch.test.ts tests/popupTwitchExtensionToggle.test.tsx && pnpm locales:check && pnpm typecheck`
Expected: PASS. `locales:check` prints "Locale keys match en.json in 11 catalogs."

- [ ] **Step 8: Commit**

```bash
git add packages/popup-ui/src packages/locales/messages packages/extension/tests/chatPresencePopup.test.tsx packages/extension/tests/settingsRegistry.test.ts
git commit -m "feat(popup): show chat presence and add Always enter channel chat"
```

---

### Task 8: Docs and full verification

**Files:**
- Modify: `docs/architecture.md`. Add a `## Chat Presence` section after `## Tabless Watch` (line 841), and a row in the "Host ports and jobs" capability prose.
- Modify: `docs/twitch-extensions/foundation.md`. Note under "## NoPixel evidence" that watch time requires chat presence.
- Modify: `docs/twitch-extensions/acceptance.md`. Update the NoPixelV daily watchtime row.

- [ ] **Step 1: Write the docs**

`docs/architecture.md`, new section after "Tabless Watch":

```markdown
## Chat Presence

Some rewards need the account in the watched channel's chat: NoPixelV credits daily watch time from the channel's chatter list (#683). `background/chatPresence.ts` keeps one `ChatPresenceClient` per platform in an `ObserverSlot` and reconciles it after each tick commit and settings save, against the committed session only (`chatPresenceDecision` in `core/chatPresence.ts`). Presence is wanted while a platform watches **tablessly** with healthy auth and no manual pause, and either `platform.<p>.alwaysEnterChat` is on or the watching Twitch Extension provider declares `needsChatPresence`. Tab watches never use it: the page joins chat itself. A commit that leaves auth unhealthy or ends the watch stops it before any await. Presence never affects heartbeat health, rotation or tab fallback; its status is attached to snapshots as `state.chatPresence` and never persisted.

The Twitch client (`platforms/twitch/chatPresence.ts`) speaks IRC exactly as the web client does: `CAP REQ :twitch.tv/tags twitch.tv/commands`, `PASS`, `NICK`, `USER`, `JOIN`, switching with `JOIN` then `PART` on one socket. It answers `PING`, follows `RECONNECT`, blocks on an auth `NOTICE`, and sends an idle `PING` after 25 s so Chromium keeps the MV3 worker alive on quiet channels. It never sends a chat message. Only the extension declares the `chatPresence` capability; the CLI reports `alwaysEnterChat` as unsupported. See docs/superpowers/specs/2026-10-05-chat-presence-design.md.
```

`docs/twitch-extensions/foundation.md`, append to "## NoPixel evidence":

```markdown
Daily watch time accrues only while the viewer is in the channel's chat. A 2026-10-04 live A/B test showed this: during tabless farming the counter started climbing as soon as the channel's popout chat was opened. The vendor client has no presence heartbeat, and the streamer must connect their Twitch account so the backend can read the chatter list. NoPixelV therefore declares `needsChatPresence`, and the chat presence service joins the watched channel's chat (#683).
```

`docs/twitch-extensions/acceptance.md`, in the NoPixelV daily watchtime row, replace the evidence and status cells with: "Counter read proven. Growth requires chat presence (popout-chat A/B test, 2026-10-04); the chat presence service provides it." and "Implemented; live growth with LurkLoot's own presence is the release gate."

- [ ] **Step 2: Run the full check**

Run: `pnpm check`
Expected: PASS. That covers the script tests, `locales:test` and `locales:check`, workspace typechecks, the extension and CLI tests, and the site build.

- [ ] **Step 3: Build both browsers**

Run: `pnpm build && pnpm build:firefox`
Expected: both succeed, with no manifest permission change. Confirm with `git diff origin/develop -- packages/extension/wxt.config.ts` showing nothing.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: describe chat presence"
```

- [ ] **Step 5: Hand off the live acceptance to the user**

These are not automatable. Ask the user to run them on this build and report only states and counters:
1. NoPixelV enabled, every Twitch tab closed. The NoPixelV daily counter climbs within ~15 minutes, and the strip shows "In chat".
2. Chromium, channel-points push off (Settings → Twitch → advanced), a quiet NoPixel channel. Presence holds for 15 minutes with no "Chat unavailable" flicker.
3. Disabling Twitch, logging out of Twitch, opening the channel yourself (manual watch) and reloading the extension each end presence promptly, and presence comes back when each is undone.

---

## Plan 2 (Kick), for later

Write `docs/superpowers/plans/2026-10-05-chat-presence-kick.md` after this plan lands. Its first task is the throwaway origin spike from the spec's "Implementation order", and its result decides whether the Kick client runs from the worker or through `pageContexts`. It then adds:
- `kick/realtime.ts`: both transports, with the Pusher code moved out of `kick/discoverySignals.ts`.
- `kick/chatPresence.ts`.
- `KickAdapter.createChatPresenceClient`.
- The Kick settings row.
- Kick-specific popup reasons (`origin-rejected`, `unsupported-provider`).
