# Kick Idle Watch Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tabless Idle Watchlist session a real minute-heartbeat target, so Kick level and the daily reward keep moving when no drop is being farmed.

**Architecture:** `heartbeatContextKey` is the only authority the watch alarm uses. A drop watch is keyed by campaign and reward. A supplemental watch is keyed by its id. An idle watch is the third authority: tabless, on a channel, with neither a campaign nor a reward. Once that key exists, the coordinator already commits a cadence, keeps the same watcher across discovery ticks, and `runWatchHeartbeat` calls `KickWatcher.tick()`. Do not add an idle branch in `heartbeat.ts`, a second alarm, or a level client. `tick()` also sends one overdue handshake or ping, because that cadence lives on `setInterval` and dies when the service worker sleeps. One frame, not a catch-up burst. The watch payload stays `tracking.user.watch.livestream`.

**Tech Stack:** TypeScript, Vitest in `packages/extension` (Node, globals on). Production change is confined to `@lurkloot/core`.

## Global Constraints

- Diagnostics are English literals. Do not add locale keys for them.
- No inline imports.
- `@lurkloot/core` must not import WXT or browser globals.
- Two-space indent, double quotes, semicolons.
- Do not change the watch payload (`tracking.user.watch.livestream`, `channel_id`, `livestream_id`).
- Do not change `packages/core/src/background/heartbeat.ts`. The missing key is why idle never commits.
- Do not change `tablessFallbackFailureLimit` or tab-fallback policy.
- Do not poll Kick level, XP, or gamification progress.
- A drop key stays `[campaignId, rewardId]`. A supplemental key stays `["supplemental", id]`. Adding a tag to either would drop every in-flight cadence.

---

## File Structure

- Modify `packages/core/src/core/heartbeatCadence.ts` — idle is a heartbeat authority.
- Modify `packages/core/src/platforms/kick/watch.ts` — `tick()` sends one overdue handshake or ping.
- Modify `packages/core/src/core/tablessWatch.ts` — one comment so `tick()` is described as writing the overdue protocol frames.
- Test `packages/extension/tests/heartbeatCadence.test.ts` — key shape, and the scheduler keeps an idle cadence.
- Test `packages/extension/tests/backgroundController/heartbeat.test.ts` — the minute alarm calls `tick()` for an idle Kick watch, and the next discovery tick reuses the watcher.
- Test `packages/extension/tests/tablessWatch.test.ts` — one overdue protocol frame from `tick()`, and no second frame a second later.

## Why this layer

An idle fallback session is `watching` a channel with `campaignId`, `rewardId`, and `supplementalWatch` all unset. `heartbeatContextKey` returns `undefined` for that shape. `reserveTablessWatchers` then starts the watcher with no context, and publish sets `lane.committed` back to `undefined`. `requestPlatformHeartbeat` returns without calling `watcher.tick()` when nothing is committed.

The popup still says it is watching. Idle progress is not a drop minute counter, so `noProgress` never rotates the channel. The only sender left is the 13-second interval inside `KickWatcher`. That interval stops when the service worker sleeps. A drop being on fills campaign and reward, the alarm commits, and `tick()` runs every minute. That is the split in issue #738.

`retainTablessHeartbeat` already keeps a cadence when the previous key and the next key match. It needs no edit. Giving idle a stable key makes that path apply.

---

### Task 1: Give an idle tabless watch a heartbeat key

**Files:**

- Modify: `packages/core/src/core/heartbeatCadence.ts` (`heartbeatContextKey`)
- Test: `packages/extension/tests/heartbeatCadence.test.ts`
- Test: `packages/extension/tests/backgroundController/heartbeat.test.ts`

**Interfaces:**

- Consumes: `WatchSession.watchMode`, `channel`, `supplementalWatch`, `campaignId`, `rewardId`.
- Produces: `heartbeatContextKey(session): string | undefined`. For a tabless session with a channel:
  - supplemental watch: the existing key ending in `"supplemental"` and the supplemental id
  - both `campaignId` and `rewardId`: the existing key ending in those two ids
  - neither `campaignId` nor `rewardId`: the same channel prefix, ending in `"idle_watchlist"`
  - only one of `campaignId` or `rewardId`: `undefined`
  - `watchMode` other than `"tabless"`, or no channel: `undefined`

A half-identified drop must not become an idle watch. The idle key must differ from the drop key of the same channel, and must change when the channel URL changes.

- [ ] **Step 1: Write the failing key tests**

In `packages/extension/tests/heartbeatCadence.test.ts`, replace the last assertion of `"admits supplemental heartbeat targets without fabricated campaigns or rewards"`:

```ts
    expect(heartbeatContextKey({ ...session, supplementalWatch: undefined })).toBeUndefined();
```

with:

```ts
    const idle = heartbeatContextKey({ ...session, supplementalWatch: undefined });
    expect(idle).toContain("idle_watchlist");
    expect(idle).not.toBe(heartbeatContextKey(session));
```

That session already has `campaignId` and `rewardId` cleared. Clearing supplemental leaves an idle watch, so the old assertion is the bug.

Add this test in the same `describe("tabless heartbeat cadence")` block:

```ts
  it("keys an idle watchlist target and leaves a half-identified drop without a key", () => {
    const idle = tablessSession({ campaignId: undefined, rewardId: undefined });
    const drop = tablessSession({ campaignId: "campaign", rewardId: "reward" });

    expect(heartbeatContextKey(idle)).toContain("idle_watchlist");
    expect(heartbeatContextKey(idle)).not.toBe(heartbeatContextKey(drop));
    expect(heartbeatContextKey({
      ...idle,
      channel: { ...idle.channel!, url: "https://www.twitch.tv/other", username: "other" },
    })).not.toBe(heartbeatContextKey(idle));
    expect(heartbeatContextKey({ ...idle, campaignId: "campaign" })).toBeUndefined();
    expect(heartbeatContextKey({ ...idle, rewardId: "reward" })).toBeUndefined();
    expect(heartbeatContextKey({ ...idle, watchMode: "tab" })).toBeUndefined();
  });
```

Add this test in `describe("scheduler tabless heartbeat cadence state")`. `heartbeatState` always puts the session on Twitch, so build the Kick state inline:

```ts
  it("retains cadence metadata for an unchanged idle watchlist target", async () => {
    const channel: ChannelCandidate = {
      platform: "kick",
      username: "rewardstation",
      displayName: "rewardstation",
      url: "https://kick.com/rewardstation",
    };
    const session = tablessSession({
      platform: "kick",
      channel,
      campaignId: undefined,
      rewardId: undefined,
    });
    session.tablessHeartbeat = {
      generation: 3,
      contextKey: heartbeatContextKey(session) ?? "missing",
      nextDueAt: "2026-09-02T20:10:00.000Z",
    };
    const settings = heartbeatSettings(true);
    settings.platform.kick = {
      ...settings.platform.kick,
      enabled: true,
      idleWatchlistChannels: ["rewardstation"],
    };
    settings.platform.twitch = { ...settings.platform.twitch, enabled: false };

    const result = await runSchedulerTick(
      {
        authHealth: { twitch: { status: "healthy" }, kick: { status: "healthy" } },
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: session,
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings,
      {
        twitch: heartbeatAdapter([], [], false),
        kick: heartbeatAdapter([], [channel]),
      },
      { platforms: ["kick"] },
    );

    expect(result.state.sessions.kick.campaignId).toBeUndefined();
    expect(result.state.sessions.kick.rewardId).toBeUndefined();
    expect(result.state.sessions.kick.watchMode).toBe("tabless");
    expect(result.state.sessions.kick.tablessHeartbeat).toEqual(session.tablessHeartbeat);
  });
```

`ChannelCandidate` is already imported in this file.

- [ ] **Step 2: Run the key tests to verify they fail**

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/heartbeatCadence.test.ts -t "idle watchlist"
```

Expected: FAIL. `heartbeatContextKey` is `undefined` for a channel with no campaign and no supplemental watch, so the retained cadence does not match.

- [ ] **Step 3: Write the key**

Replace `heartbeatContextKey` in `packages/core/src/core/heartbeatCadence.ts`:

```ts
export function heartbeatContextKey(session: WatchSession): string | undefined {
  const channel = session.channel;
  if (session.watchMode !== "tabless" || !channel) return undefined;
  const authority = heartbeatAuthority(session);
  if (!authority) return undefined;
  return JSON.stringify([
    session.platform,
    channel.url,
    channel.username,
    channel.broadcastId ?? "",
    channel.channelId ?? "",
    channel.categoryId ?? "",
    ...authority,
  ]);
}

// Drop and supplemental keys stay exactly as they are so a persisted cadence
// still matches. Idle is the watch that has a channel and no drop identity.
function heartbeatAuthority(session: WatchSession): string[] | undefined {
  if (session.supplementalWatch) return ["supplemental", session.supplementalWatch.id];
  if (session.campaignId && session.rewardId) return [session.campaignId, session.rewardId];
  if (!session.campaignId && !session.rewardId) return ["idle_watchlist"];
  return undefined;
}
```

- [ ] **Step 4: Run the key tests to verify they pass**

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/heartbeatCadence.test.ts
```

Expected: PASS, including the existing drop, supplemental, and category-change cases.

- [ ] **Step 5: Write the failing alarm test**

Add this test in `packages/extension/tests/backgroundController/heartbeat.test.ts`, next to `"farms tablessly without opening a tab and records heartbeat health"`. `fakeTablessWatcher`, `farming`, `harness`, `advanceToNextHeartbeatDue`, and `DEFAULT_SETTINGS` are already imported.

```ts
  it("heartbeats a Kick idle watchlist session from the minute alarm", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: {
          ...DEFAULT_SETTINGS.platform.kick,
          enabled: true,
          idleWatchlistChannels: ["rewardstation"],
        },
      },
    }));
    env.kick.supportsTabless = true;
    env.kick.refreshCampaigns = vi.fn(async () => []);
    env.kick.createTablessWatcher = vi.fn(() => watcher as unknown as TablessWatchController);

    await env.controller.tick(["kick"]);

    expect(env.state.sessions.kick).toMatchObject({
      status: "watching",
      watchMode: "tabless",
      campaignId: undefined,
      rewardId: undefined,
      channel: { username: "rewardstation" },
    });
    expect(env.state.sessions.kick.supplementalWatch).toBeUndefined();
    expect(env.state.sessions.kick.tablessHeartbeat?.contextKey).toContain("idle_watchlist");
    expect(watcher.tick).not.toHaveBeenCalled();

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.kick.lastHeartbeatOk).toBe(true);

    await env.controller.tick(["kick"]);

    expect(env.kick.createTablessWatcher).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 6: Run the alarm test to verify it fails before the key, then passes**

The key from Step 3 is already in the tree if this task is executed in order. Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController/heartbeat.test.ts -t "heartbeats a Kick idle watchlist session from the minute alarm"
```

Expected: PASS. If it fails because `tablessHeartbeat` is missing or `watcher.tick` was not called, the key is not reaching `reserveTablessWatchers`. Do not patch `heartbeat.ts`. Fix the key so this session's `watchMode`, channel, and empty campaign fields match `heartbeatAuthority`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/core/heartbeatCadence.ts packages/extension/tests/heartbeatCadence.test.ts packages/extension/tests/backgroundController/heartbeat.test.ts
git commit -m "$(cat <<'EOF'
fix(kick): heartbeat an idle tabless watch

EOF
)"
```

---

### Task 2: Send one overdue handshake from the watch tick

**Files:**

- Modify: `packages/core/src/platforms/kick/watch.ts` (`tick`, `startHandshakeTimer`, `sendPing`, `sendHandshake`, `stop`)
- Modify: `packages/core/src/core/tablessWatch.ts` (the `TablessWatchController` comment)
- Test: `packages/extension/tests/tablessWatch.test.ts` (inside `describe("kick viewer watcher")`)

**Interfaces:**

- Consumes: `HANDSHAKE_INTERVAL_MS`, `sendPing`, `sendHandshake`, `sendWatchEvent`, `lastWatchSentAt`, `counter`.
- Produces: `lastProtocolSentAt`. `sendPing` and `sendHandshake` set it only after a send on an open socket while `connected` is still true. `tick()` sends one ping or one handshake when that stamp is at least `HANDSHAKE_INTERVAL_MS` old, then the due watch event. The interval uses the same stamp, so an awake worker does not send the frame twice. A slept worker does not replay the missed 13-second slots.

- [ ] **Step 1: Write the failing test**

Add this test inside `describe("kick viewer watcher")` in `packages/extension/tests/tablessWatch.test.ts`:

```ts
  it("sends one overdue handshake from tick and does not repeat it a second later", async () => {
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
    const opened = socket.parsed().length;
    now += 61_000;

    await expect(watcher.tick({})).resolves.toMatchObject({ ok: true, live: true });
    const afterDueTick = socket.parsed();
    const sentByDueTick = afterDueTick.slice(opened);
    expect(sentByDueTick.filter((message) => message.type === "user_event")).toHaveLength(1);
    expect(sentByDueTick.filter((message) => message.type === "channel_handshake" || message.type === "ping")).toHaveLength(1);

    now += 1_000;
    await watcher.tick({});
    expect(socket.parsed()).toHaveLength(afterDueTick.length);
    await watcher.stop();
  });
```

The existing test `"writes a due watch event from tick while the socket stays open"` only counts `user_event`. Leave it. After this task that tick also sends one handshake or ping.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/tablessWatch.test.ts -t "sends one overdue handshake from tick"
```

Expected: FAIL. The due tick writes the watch event and no handshake or ping.

- [ ] **Step 3: Write the minimal implementation**

In `packages/core/src/platforms/kick/watch.ts`, add the field next to `lastWatchSentAt`:

```ts
  private lastProtocolSentAt = 0;
```

Reset it in `stop()` next to `this.lastWatchSentAt = 0`:

```ts
    this.lastProtocolSentAt = 0;
```

Stamp only a send that actually ran. Replace `sendPing` and `sendHandshake`:

```ts
  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN) return;
    this.safeSend({ type: "ping" });
    if (this.connected) this.lastProtocolSentAt = this.now();
  }

  private sendHandshake(): void {
    if (!this.targets || !this.ws || this.ws.readyState !== WEBSOCKET_OPEN) return;
    this.safeSend({
      type: "channel_handshake",
      data: { message: { channelId: numericOrString(this.targets.channelId) } },
    });
    if (this.connected) this.lastProtocolSentAt = this.now();
  }
```

In `startHandshakeTimer`:

```ts
  private startHandshakeTimer(): void {
    if (this.handshakeTimer) clearInterval(this.handshakeTimer);
    this.handshakeTimer = setInterval(() => {
      if (!this.connected) return;
      this.counter += 1;
      if (this.counter % 2 === 0) this.sendPing();
      else this.sendHandshake();
      if (this.now() - this.lastWatchSentAt >= WATCH_EVENT_INTERVAL_MS) this.sendWatchEvent();
    }, HANDSHAKE_INTERVAL_MS);
  }
```

The interval always sends; only `tick()` skips a frame that was just sent, because a gate on the interval skips a beat when the previous callback ran late.

In `tick()`, immediately before the due watch-event write, send one overdue frame:

```ts
    if (this.ws?.readyState === WEBSOCKET_OPEN && this.now() - this.lastProtocolSentAt >= HANDSHAKE_INTERVAL_MS) {
      this.counter += 1;
      if (this.counter % 2 === 0) this.sendPing();
      else this.sendHandshake();
    }
    if (this.ws?.readyState === WEBSOCKET_OPEN && this.now() - this.lastWatchSentAt >= WATCH_EVENT_INTERVAL_MS) {
      this.sendWatchEvent();
    }
```

Replace the Kick sentence in the `TablessWatchController` comment in `packages/core/src/core/tablessWatch.ts` with:

```ts
// Kick keeps a viewer WebSocket. Its tick writes one overdue handshake or ping
// and a watch event when one is due, reports healthy only when that watch
// write landed on an open socket, and reconnects when the socket is down. A
// hard socket error stays failed so the heartbeat coordinator can fall back
// to a tab.
```

- [ ] **Step 4: Run the watcher tests to verify they pass**

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/tablessWatch.test.ts
```

Expected: PASS. The connect test still sees a handshake on open. The closed-socket test still records no watch event. The due-watch test still sees two `user_event` frames.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/kick/watch.ts packages/core/src/core/tablessWatch.ts packages/extension/tests/tablessWatch.test.ts
git commit -m "$(cat <<'EOF'
fix(kick): send an overdue viewer handshake from the watch tick

EOF
)"
```
