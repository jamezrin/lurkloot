# Kick Watch Signal Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Kick tabless watch count as healthy only after a watch event is written to an open socket, so the minute check that already reconnects a down watch, and the tab fallback that already follows repeated failures, actually run.

**Architecture:** `KickWatcher` remains the only owner of the viewer socket and the watch payload. The minute watch alarm keeps calling `KickWatcher.tick()` and trusting `HeartbeatResult.ok`. Revival stays the branch already in `tick()`: if the watcher is not connected and has not hard-failed, call `connect()`. A hard socket error still sets `failed` and does not reconnect; after `tablessFallbackFailureLimit` failed heartbeats the existing coordinator opens a real tab. This plan does not add a second connection, a second alarm, or a level client. Level and the daily reward move when Kick accepts this same watch event. Drop watches and idle watches already share this watcher, so the scheduler stays unchanged.

**Tech Stack:** TypeScript, Vitest in `packages/extension` (Node, globals on). Production change is confined to `@lurkloot/core`.

## Global Constraints

- Diagnostics are English literals. Do not add locale keys for them.
- No inline imports.
- `@lurkloot/core` must not import WXT or browser globals.
- Two-space indent, double quotes, semicolons.
- Do not change the watch payload (`tracking.user.watch.livestream`, `channel_id`, `livestream_id`).
- Do not change heartbeat alarms, `tablessFallbackFailureLimit`, or tab-fallback policy.
- Do not poll Kick level, XP, or gamification progress from the watcher.

---

## File Structure

- Modify `packages/core/src/platforms/kick/watch.ts` — honest writes, and `tick()` uses the socket state the reconnect branch already understands.
- Modify `packages/core/src/core/tablessWatch.ts` — one comment so `tick()` is not described as only observing the interval.
- Test `packages/extension/tests/tablessWatch.test.ts` — watcher behavior only. No heartbeat-coordinator tests: `HeartbeatResult` does not change shape.

## Why this layer

`tick()` revives a watch when `connected` is false and `failed` is false. It reports healthy when `connected` is true and `lastWatchSentAt` is inside `HEALTH_WINDOW_MS` (2.5 minutes). Both of those can be true while `readyState` is not `OPEN`:

- `sendWatchEvent` stamps `lastWatchSentAt` and logs `Sent Kick watch event` after `safeSend`.
- `safeSend` returns without writing when the socket is missing or not open, and it does not clear `connected` on that path. It clears `connected` only when `send` throws.
- `connected` is cleared on the close event. A socket that is already closed, before that event runs, stays "connected".

While that lasts, `tick()` does not enter `connect()`, and it does not return `ok: false`, so the tab fallback does not run either. Issue #738 is that shape: the log says a watch was sent, the popup says it is watching, and Kick does not move the level or the daily reward.

The 13-second interval can still write while the service worker stays awake. It is not a second clock. It shares `lastWatchSentAt` with `tick()`. The alarm is the wake that still runs after the worker sleeps, so `tick()` has to write a due event itself and has to notice a socket that is no longer open.

---

### Task 1: Count a watch event only when the socket accepts it

**Files:**

- Modify: `packages/core/src/platforms/kick/watch.ts` (`sendWatchEvent`, `safeSend`)
- Test: `packages/extension/tests/tablessWatch.test.ts` (inside `describe("kick viewer watcher")`)

**Interfaces:**

- Consumes: existing `KickWatcher`, `FakeSocket`, `kickChannel` in the test file.
- Produces: `sendWatchEvent(): boolean`. `true` only after `WebSocket.send` on an `OPEN` socket. That is the only path that assigns `lastWatchSentAt` or logs `Sent Kick watch event` / the one-shot farming-active line. If the livestream id is missing, it returns `false` and leaves `connected` alone. If the socket is missing or not open, or `send` throws, it returns `false`, leaves `lastWatchSentAt` unchanged, does not log either success line, and sets `connected` to false. `safeSend` stays for ping and handshake and still returns nothing. The interval must not call `connect()`; the next `tick()` does.

- [ ] **Step 1: Write the failing test**

Add this test inside `describe("kick viewer watcher")` in `packages/extension/tests/tablessWatch.test.ts`:

```ts
it("does not record a watch event when the socket is not open", async () => {
  const socket = new FakeSocket();
  const fetchJson = vi.fn(async (url: string) => {
    if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
    if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
    throw new Error(`unexpected url ${url}`);
  });
  const watcher = new KickWatcher({
    fetcher: { fetchJson: fetchJson as never },
    createWebSocket: () => socket,
    now: () => 1_000,
  });

  await watcher.start(kickChannel, {});
  socket.readyState = 3;
  socket.emit("open");

  const events = watcher.drainEvents();
  expect(events.some((event) => event.message.startsWith("Sent Kick watch event"))).toBe(false);
  expect(events.some((event) => event.message.includes("tabless farming active"))).toBe(false);
  expect(socket.parsed().some((message) => message.type === "user_event")).toBe(false);
  await watcher.stop();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Install once in this worktree (`pnpm install --frozen-lockfile`), then run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/tablessWatch.test.ts -t "does not record a watch event when the socket is not open"
```

Expected: FAIL. The open handler currently logs the farming-active line and stamps the send even though `readyState` is not open, so no `user_event` was written.

- [ ] **Step 3: Write the minimal implementation**

In `packages/core/src/platforms/kick/watch.ts`, add the connecting constant next to `WEBSOCKET_OPEN`:

```ts
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
```

Replace `sendWatchEvent` and keep `safeSend` for ping and handshake. `sendWatchEvent` must not stamp or log a success unless `send` ran:

```ts
private sendWatchEvent(): boolean {
  if (!this.targets?.liveStreamId) return false;
  if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN) {
    this.connected = false;
    return false;
  }
  try {
    this.ws.send(JSON.stringify({
      type: "user_event",
      data: {
        message: {
          name: "tracking.user.watch.livestream",
          channel_id: numericOrString(this.targets.channelId),
          livestream_id: numericOrString(this.targets.liveStreamId),
        },
      },
    }));
  } catch (error) {
    this.connected = false;
    this.log("debug", `Kick viewer send failed; will reconnect: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  this.lastWatchSentAt = this.now();
  if (!this.watchAnnounced) {
    this.watchAnnounced = true;
    this.log("info", `Kick tabless farming active for ${this.channel?.username ?? "channel"} — sending watch events every 60s`);
  } else {
    this.log("debug", `Sent Kick watch event for ${this.channel?.username ?? "channel"} (livestream ${this.targets.liveStreamId})`);
  }
  return true;
}
```

`refreshTargetsIfDue` can keep calling `sendWatchEvent()` and ignoring the boolean. The open handler can too.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/tablessWatch.test.ts -t "does not record a watch event when the socket is not open"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/kick/watch.ts packages/extension/tests/tablessWatch.test.ts
git commit -m "$(cat <<'EOF'
fix(kick): count a watch event only when the socket accepts it

EOF
)"
```

---

### Task 2: Let the existing minute check see a down socket and write a due event

**Files:**

- Modify: `packages/core/src/platforms/kick/watch.ts` (`connect`, `tick`)
- Modify: `packages/core/src/core/tablessWatch.ts` (the `TablessWatchController` comment only)
- Test: `packages/extension/tests/tablessWatch.test.ts`

**Interfaces:**

- Consumes: `sendWatchEvent(): boolean` from Task 1. `false` means `connected` is already false and `lastWatchSentAt` was not moved.
- Produces: no new exports. `tick()` still returns `HeartbeatResult`. A socket whose `readyState` is neither `OPEN` nor `CONNECTING` is treated as down, and the existing `if (!this.connected && !this.failed) await this.connect()` runs. `CONNECTING` does not open a second socket. `failed === true` still does not reconnect. An `OPEN` socket whose last successful write is at least `WATCH_EVENT_INTERVAL_MS` old gets one write from `tick()`.

- [ ] **Step 1: Write the failing tests**

Add these three tests inside `describe("kick viewer watcher")`:

```ts
it("reconnects from tick when the socket is closed without a close event", async () => {
  const sockets: FakeSocket[] = [];
  const fetchJson = vi.fn(async (url: string) => {
    if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
    if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
    throw new Error(`unexpected url ${url}`);
  });
  const watcher = new KickWatcher({
    fetcher: { fetchJson: fetchJson as never },
    createWebSocket: () => {
      const socket = new FakeSocket();
      // FakeSocket starts OPEN. A replacement socket has not opened yet.
      if (sockets.length > 0) socket.readyState = 0;
      sockets.push(socket);
      return socket;
    },
    now: () => 1_000,
  });

  await watcher.start(kickChannel, {});
  sockets[0]?.emit("open");
  watcher.drainEvents();
  sockets[0]!.readyState = 3;

  const result = await watcher.tick({});

  expect(result).toMatchObject({ ok: false, live: true, message: "Kick viewer connection idle" });
  expect(sockets).toHaveLength(2);
  expect(sockets[0]?.readyState).toBe(3);
  expect(watcher.drainEvents().some((event) => event.message.startsWith("Sent Kick watch event"))).toBe(false);
  await watcher.stop();
});

it("writes a due watch event from tick while the socket stays open", async () => {
  let now = 1_000;
  const socket = new FakeSocket();
  const fetchJson = vi.fn(async (url: string) => {
    if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
    if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
    throw new Error(`unexpected url ${url}`);
  });
  const watcher = new KickWatcher({
    fetcher: { fetchJson: fetchJson as never },
    createWebSocket: () => socket,
    now: () => now,
  });

  await watcher.start(kickChannel, {});
  socket.emit("open");
  now += 61_000;

  await expect(watcher.tick({})).resolves.toMatchObject({ ok: true, live: true });
  expect(socket.parsed().filter((message) => message.type === "user_event")).toHaveLength(2);
  await watcher.stop();
});

it("does not open another socket after a hard websocket error", async () => {
  const sockets: FakeSocket[] = [];
  const fetchJson = vi.fn(async (url: string) => {
    if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
    if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
    throw new Error(`unexpected url ${url}`);
  });
  const watcher = new KickWatcher({
    fetcher: { fetchJson: fetchJson as never },
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => 1_000,
  });

  await watcher.start(kickChannel, {});
  sockets[0]?.emit("open");
  sockets[0]?.emit("error");

  await expect(watcher.tick({})).resolves.toMatchObject({
    ok: false,
    message: "Kick viewer WebSocket error; falling back to a watch tab",
  });
  expect(sockets).toHaveLength(1);
  await watcher.stop();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/tablessWatch.test.ts -t "reconnects from tick|writes a due watch event|hard websocket error"
```

Expected: FAIL. With the socket closed and no close event, `tick()` still sees `connected` and a recent `lastWatchSentAt`, returns `ok: true`, and does not construct a second socket. With the socket left open, `tick()` does not write a second `user_event` unless the livestream id changed. The hard-error case may already pass; keep it so the reconnect guard cannot swallow `failed`.

- [ ] **Step 3: Write the minimal implementation**

Add `releaseSocket` and call it at the start of `connect()`, before the token fetch, so the socket `tick()` is replacing cannot deliver a late close onto the new connection. `intentionallyClosedSockets` already ignores that close:

```ts
private releaseSocket(): void {
  const ws = this.ws;
  if (!ws) return;
  this.intentionallyClosedSockets.add(ws);
  this.ws = undefined;
  this.connected = false;
  try {
    ws.close();
  } catch {
    // The socket may already be closing.
  }
}
```

`connect()` begins its `try` by calling `this.releaseSocket()`, then fetches targets and the token as it does now, then assigns `this.ws`.

Replace the start of `tick()` so a non-open socket uses the reconnect branch that is already there, and so a due event is written on an open socket:

```ts
async tick(_context: WatchContext): Promise<HeartbeatResult> {
  if (!this.channel) return { ok: false, message: "Kick tabless watcher has no channel" };
  if (this.ws && this.ws.readyState !== WEBSOCKET_OPEN && this.ws.readyState !== WEBSOCKET_CONNECTING) {
    this.connected = false;
  }
  if (!this.connected && !this.failed && this.ws?.readyState !== WEBSOCKET_CONNECTING) await this.connect();
  if (this.failed) {
    return { ok: false, live: this.targets?.isLive ?? true, message: this.failureMessage ?? "Kick viewer connection failed" };
  }
  if (!this.targets?.isLive) {
    return { ok: false, live: false, message: "Kick channel is offline" };
  }
  await this.refreshTargetsIfDue();
  if (!this.targets?.isLive) {
    return { ok: false, live: false, message: "Kick channel is offline" };
  }
  const expectedCategoryId = this.channel.categoryId;
  if (expectedCategoryId && this.targets.categoryId && this.targets.categoryId !== expectedCategoryId) {
    return { ok: false, live: true, message: "Kick channel category no longer matches" };
  }
  if (!this.targets.liveStreamId) {
    return { ok: false, live: true, message: "Kick channel is missing a livestream id" };
  }
  if (this.ws?.readyState === WEBSOCKET_OPEN && this.now() - this.lastWatchSentAt >= WATCH_EVENT_INTERVAL_MS) {
    this.sendWatchEvent();
  }
  const healthy = this.ws?.readyState === WEBSOCKET_OPEN && this.now() - this.lastWatchSentAt < HEALTH_WINDOW_MS;
  return { ok: healthy, live: true, message: healthy ? undefined : "Kick viewer connection idle" };
}
```

A reconnect tick may return `ok: false` with `Kick viewer connection idle` because `connect()` does not wait for `open`. That single failed heartbeat is the existing failure counter. The next tick that writes a watch event returns `ok: true` and the coordinator clears the counter. Do not treat `CONNECTING` as healthy, and do not open a second socket while one is connecting.

In `packages/core/src/core/tablessWatch.ts`, replace the sentence that says Kick's `tick()` mainly reports connection health with:

```ts
// A per-platform driver that earns drop progress for the currently-selected
// channel without a video tab. Twitch sends one minute-watched event per tick.
// Kick keeps a viewer WebSocket. Its tick writes a watch event when one is due,
// reports healthy only when that write landed on an open socket, and reconnects
// when the socket is down. A hard socket error stays failed so the heartbeat
// coordinator can fall back to a tab.
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/tablessWatch.test.ts
```

Expected: PASS, including the livestream-id refresh test. That test still sees two `user_event`s: the id-change write updates `lastWatchSentAt`, so the due-write in the same `tick()` does not send a third.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/kick/watch.ts packages/core/src/core/tablessWatch.ts packages/extension/tests/tablessWatch.test.ts
git commit -m "$(cat <<'EOF'
fix(kick): revive a tabless watch whose socket is no longer open

EOF
)"
```

---

## Self-review

- Spec coverage: honest writes are Task 1. The existing reconnect branch, the hard-failure exclusion, the due write on the alarm tick, and the unchanged coordinator are Task 2.
- No level client, no scheduler change, no new alarm, no payload change.
- `sendWatchEvent(): boolean` is the same signature in both tasks.
- Placeholder scan: none.

## Out of scope

The repeated `Could not claim` lines in issue #738 are claim attempts that return false. They are not why the level stays still. The discovery tick's keep path not flushing watcher logs is also untouched: the watch alarm already drains those logs when it calls `tick()`.
