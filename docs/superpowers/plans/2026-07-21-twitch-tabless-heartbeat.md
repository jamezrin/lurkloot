# Twitch Tabless Heartbeat Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Twitch's recommended Spade tabless heartbeat and replace bare network errors with credential-safe stage and hostname diagnostics.

**Architecture:** Keep compatibility resolution and scheduler fallback unchanged. Grant the extension exact access to the three Twitch service hosts used by Spade, wrap extension-owned fetches with safe hostname context, and preserve POST transport failures through the Spade strategy's existing one-retry path.

**Tech Stack:** TypeScript 7, WXT 0.20, WebExtension manifests, Vitest 4, pnpm 11.

## Global Constraints

- Add only `https://assets.twitch.tv/*`, `https://spade.twitch.tv/*`, and `https://beacon.twitch.tv/*`; do not add `https://*.twitch.tv/*`.
- Never log URL paths, query strings, headers, cookies, tokens, or request payloads.
- Preserve the current Spade retry count, scheduler `offlineRetryLimit`, and managed watch-tab fallback.
- Keep `@lurkloot/core` browser-free and do not add dependencies or settings.
- Keep the Kick and settings-session improvements out of this branch.

---

### Task 1: Preserve contextual Spade POST failures

**Files:**
- Modify: `packages/core/src/platforms/twitch/heartbeat/spade.ts`
- Test: `packages/extension/tests/twitchHeartbeat.test.ts`

**Interfaces:**
- Consumes: existing `TwitchHeartbeatPost(url, init): Promise<{ status: number }>`.
- Produces: internal `SpadeSendResult = { ok: true } | { ok: false; message: string }`; no public contract change.

- [ ] **Step 1: Add failing tests for destination and POST failures**

Add these cases inside `describe("Spade v1")`:

```ts
it("preserves a contextual destination-fetch failure", async () => {
  const strategy = createSpadeHeartbeat({
    fetchText: vi.fn(async () => { throw new Error("Twitch Spade destination fetch failed for assets.twitch.tv: Failed to fetch"); }),
    post: vi.fn(),
  });

  await expect(strategy.tick(context())).resolves.toEqual({
    ok: false,
    live: true,
    message: "Twitch Spade destination fetch failed for assets.twitch.tv: Failed to fetch",
  });
});

it("preserves the final contextual POST failure after one retry", async () => {
  const fetchText = vi.fn()
    .mockResolvedValueOnce('{"spade_url":"https://spade.twitch.tv/stale"}')
    .mockResolvedValueOnce('{"spade_url":"https://beacon.twitch.tv/fresh"}');
  const post = vi.fn(async (url: string) => {
    throw new Error(`Twitch Spade heartbeat POST failed for ${new URL(url).hostname}: Failed to fetch`);
  });
  const strategy = createSpadeHeartbeat({ fetchText, post });

  await expect(strategy.tick(context())).resolves.toEqual({
    ok: false,
    live: true,
    message: "Twitch Spade heartbeat POST failed for beacon.twitch.tv: Failed to fetch",
  });
  expect(post).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the focused test and confirm the POST assertion fails**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts`

Expected: destination-fetch test passes through the existing outer catch; POST test fails because the strategy currently returns `Twitch Spade heartbeat returned an unexpected status`.

- [ ] **Step 3: Return structured results from the private send helper**

In `spade.ts`, add:

```ts
type SpadeSendResult = { ok: true } | { ok: false; message: string };
```

Change `send` to return `Promise<SpadeSendResult>`. Return `{ ok: true }` only for HTTP 204, return a status-specific message for other responses, and return the thrown error message from `catch`:

```ts
const send = async (destination: string, context: TwitchHeartbeatContext): Promise<SpadeSendResult> => {
  if (!isAllowedTwitchUrl(destination)) return { ok: false, message: "Unsafe Twitch Spade destination" };
  // Build the existing event and request unchanged.
  try {
    const response = await options.post(destination, existingRequest);
    return response.status === 204
      ? { ok: true }
      : { ok: false, message: `Twitch Spade heartbeat returned HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Twitch Spade heartbeat POST failed",
    };
  }
};
```

In `tick`, retain the first result only long enough to decide whether to refresh. After the second send, return its message:

```ts
const first = await send(destination, context);
if (first.ok) return { ok: true, live: true };

destinations.delete(channel);
const refreshed = await resolveDestination(context);
if (!refreshed) return failed("Unable to refresh the Twitch Spade destination");
destinations.set(channel, refreshed);
const second = await send(refreshed, context);
if (second.ok) return { ok: true, live: true };
destinations.delete(channel);
return failed(second.message);
```

- [ ] **Step 4: Run heartbeat tests**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts`

Expected: all Twitch heartbeat tests pass, including the two new contextual failure cases and the existing retry tests.

- [ ] **Step 5: Commit the core behavior**

```bash
git add packages/core/src/platforms/twitch/heartbeat/spade.ts packages/extension/tests/twitchHeartbeat.test.ts
git commit -m "fix(twitch): preserve spade heartbeat failures"
```

### Task 2: Add safe extension transport context and exact permissions

**Files:**
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/extension/wxt.config.ts`
- Create: `packages/extension/src/core/twitchHeartbeatTransport.ts`
- Create: `packages/extension/tests/heartbeatTransport.test.ts`
- Create: `packages/extension/tests/manifestPermissions.test.ts`

**Interfaces:**
- Consumes: `TwitchHeartbeatFetchText` and `TwitchHeartbeatPost` injected into `TwitchAdapter`.
- Produces: `twitchHeartbeatFetchText(url, init)` and `twitchHeartbeatPost(url, init)` from the focused extension transport module, used unchanged by the adapter.

- [ ] **Step 1: Write failing transport tests**

Create `heartbeatTransport.test.ts` with mocked `globalThis.fetch` and assertions that errors contain only safe hostname context:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { twitchHeartbeatFetchText, twitchHeartbeatPost } from "../src/core/twitchHeartbeatTransport";

afterEach(() => vi.unstubAllGlobals());

describe("Twitch heartbeat extension transport", () => {
  it("identifies destination-fetch failures without leaking URL details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const url = "https://assets.twitch.tv/config/settings.secret.js?token=do-not-log";

    await expect(twitchHeartbeatFetchText(url)).rejects.toThrow(
      "Twitch Spade destination fetch failed for assets.twitch.tv: Failed to fetch",
    );
    await expect(twitchHeartbeatFetchText(url)).rejects.not.toThrow(/settings\.secret|do-not-log/);
  });

  it("identifies heartbeat POST failures without leaking URL details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const url = "https://spade.twitch.tv/track?token=do-not-log";

    await expect(twitchHeartbeatPost(url, { method: "POST" })).rejects.toThrow(
      "Twitch Spade heartbeat POST failed for spade.twitch.tv: Failed to fetch",
    );
    await expect(twitchHeartbeatPost(url, { method: "POST" })).rejects.not.toThrow(/track|do-not-log/);
  });

  it("reports non-success destination responses with hostname and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status: 403 })));
    await expect(twitchHeartbeatFetchText("https://assets.twitch.tv/config/settings.js"))
      .rejects.toThrow("Twitch Spade destination fetch failed for assets.twitch.tv: HTTP 403");
  });
});
```

- [ ] **Step 2: Write the failing manifest permission test**

Create `manifestPermissions.test.ts` using `readFileSync` and `fileURLToPath` to read `../wxt.config.ts`, following `coreBoundary.test.ts`. Assert the source contains the three exact quoted entries and does not contain the wildcard:

```ts
expect(source).toContain('"https://assets.twitch.tv/*"');
expect(source).toContain('"https://spade.twitch.tv/*"');
expect(source).toContain('"https://beacon.twitch.tv/*"');
expect(source).not.toContain('"https://*.twitch.tv/*"');
```

- [ ] **Step 3: Run the new tests and confirm failure**

Run: `pnpm --filter @lurkloot/extension test -- heartbeatTransport.test.ts manifestPermissions.test.ts`

Expected: FAIL because the named transport functions are not exported and the three manifest hosts are absent.

- [ ] **Step 4: Implement credential-safe transport wrappers**

Create `src/core/twitchHeartbeatTransport.ts` with the hostname formatter and exported wrappers:

```ts
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "unknown Twitch host";
  } catch {
    return "unknown Twitch host";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown network error";
}

export async function twitchHeartbeatFetchText(url: string, init?: RequestInit): Promise<string> {
  const hostname = safeHostname(url);
  try {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    throw new Error(`Twitch Spade destination fetch failed for ${hostname}: ${errorMessage(error)}`);
  }
}

export async function twitchHeartbeatPost(url: string, init: RequestInit): Promise<{ status: number }> {
  const hostname = safeHostname(url);
  try {
    const response = await fetch(url, init);
    return { status: response.status };
  } catch (error) {
    throw new Error(`Twitch Spade heartbeat POST failed for ${hostname}: ${errorMessage(error)}`);
  }
}
```

Replace the two inline transport closures in `createAdapters` with these functions.

- [ ] **Step 5: Add exact manifest permissions**

Add these entries after `gql.twitch.tv` in `host_permissions`:

```ts
"https://assets.twitch.tv/*",
"https://spade.twitch.tv/*",
"https://beacon.twitch.tv/*",
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm --filter @lurkloot/extension test -- heartbeatTransport.test.ts manifestPermissions.test.ts twitchHeartbeat.test.ts`

Expected: all focused tests pass with no URL path or query-string leakage.

- [ ] **Step 7: Commit extension transport and permissions**

```bash
git add packages/extension/entrypoints/background.ts packages/extension/wxt.config.ts packages/extension/src/core/twitchHeartbeatTransport.ts packages/extension/tests/heartbeatTransport.test.ts packages/extension/tests/manifestPermissions.test.ts
git commit -m "fix(extension): allow twitch spade heartbeat hosts"
```

### Task 3: Document permissions and verify browser output

**Files:**
- Modify: `docs/store-readiness.md`

**Interfaces:**
- Consumes: the exact manifest host list from Task 2.
- Produces: store-review justifications for every newly requested host.

- [ ] **Step 1: Update host permission justifications**

Add these bullets after `gql.twitch.tv`:

```md
- **`https://assets.twitch.tv/*`** — Reads Twitch's public web settings bundle to discover the current Spade/beacon endpoint used by tabless minute-watched heartbeats.
- **`https://spade.twitch.tv/*`** — Sends Twitch's web minute-watched heartbeat in tabless low-resource mode.
- **`https://beacon.twitch.tv/*`** — Sends the same tabless heartbeat when Twitch's settings select its supported beacon endpoint.
```

Update the summary near the top of `docs/store-readiness.md` so it describes the Twitch page, GQL, settings asset, and heartbeat origins rather than only “Twitch” and “Twitch GQL.”

- [ ] **Step 2: Run documentation and diff checks**

Run: `git diff --check && rg -n 'assets\.twitch|spade\.twitch|beacon\.twitch' packages/extension/wxt.config.ts docs/store-readiness.md`

Expected: no whitespace errors; every new host appears in both manifest and store-readiness documentation.

- [ ] **Step 3: Run the full verification suite**

Run: `pnpm verify`

Expected: script tests, all workspace typechecks, extension tests, site build, and Chromium/Firefox extension builds pass.

- [ ] **Step 4: Inspect generated manifests**

Run:

```bash
rg -n 'assets\.twitch\.tv|spade\.twitch\.tv|beacon\.twitch\.tv|\*\.twitch\.tv' \
  packages/extension/.output/chrome-mv3/manifest.json \
  packages/extension/.output/firefox-mv2/manifest.json
```

Expected: both generated manifests contain the three exact hosts and neither contains a wildcard Twitch host.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/store-readiness.md
git commit -m "docs(store): justify twitch heartbeat hosts"
```

- [ ] **Step 6: Confirm final branch state**

Run: `git status --short --branch && git log --oneline origin/develop..HEAD`

Expected: clean worktree with the design, implementation-plan, core fix, extension fix, and documentation commits visible.
