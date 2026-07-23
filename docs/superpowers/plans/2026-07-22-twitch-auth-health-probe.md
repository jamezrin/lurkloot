# Twitch Authentication Health Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Twitch's placeholder authentication health with an explicit authenticated `CurrentUser` probe and safe credential-versus-availability classification.

**Architecture:** The existing extension controller continues to own cookie availability preflight. `TwitchAdapter.checkAuthHealth()` runs the inline `CurrentUser` query through the existing Twitch GQL transport; a small internal typed transport error preserves whether a failure came from request transport, credential rejection, or Twitch service/GQL availability without exposing raw content in health state.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest, `@lurkloot/core`, `@lurkloot/shared`.

## Global Constraints

- Implement issue #202 only; scheduler suspension, degraded operational state, and account-operation gating remain in issue #204.
- Only a successful authenticated GQL response with non-null `currentUser` may produce `healthy`.
- Missing `auth-token` remains an extension-controller preflight and must avoid adapter invocation.
- Client-Integrity availability must remain separate and `checkAuthHealth()` must not call `ensureIntegrity`.
- Health state, events, diagnostics, and logs must not contain tokens, cookies, authenticated response bodies, request URLs, headers, user ids, or raw error messages.
- Existing Twitch inventory, heartbeat, channel-points, and reward-claim behavior must remain unchanged.
- Follow red-green-refactor: every production change follows a focused failing test whose expected failure is observed first.

---

### Task 1: Twitch authenticated identity probe and classification

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Consumes: `TwitchGqlTransport`, `TwitchGqlResponse<T>`, and the existing inline `CURRENT_USER_QUERY` in `packages/core/src/platforms/twitch/index.ts`.
- Produces: `TwitchAdapter.checkAuthHealth(): Promise<PlatformAuthHealth>` returning only normalized shared health fields.
- Produces internally: `TwitchGqlFailureKind = "network" | "credentials" | "platform"` and `TwitchGqlFailure`, used only to classify probe failures while preserving existing thrown-error behavior for other Twitch operations.

- [ ] **Step 1: Add failing healthy and anonymous-response tests**

Insert at the start of the existing `describe("TwitchAdapter", ...)` block in `packages/extension/tests/adapters.test.ts`:

```ts
  it("reports healthy only when the authenticated CurrentUser probe returns a user", async () => {
    const ensureIntegrity = vi.fn(async () => true);
    const fetcher = jsonFetcher((_url, init) => {
      expect(operation(init)).toBe("CurrentUser");
      expect(requestBody(init).query).toContain("currentUser { id }");
      return { data: { currentUser: { id: "private-user-id" } } };
    });

    await expect(new TwitchAdapter(fetcher, ensureIntegrity).checkAuthHealth()).resolves.toEqual({
      status: "healthy",
      checkedAt: expect.any(String),
      message: { key: "authHealthy" },
    });
    expect(ensureIntegrity).not.toHaveBeenCalled();
  });

  it.each([
    { data: { currentUser: null } },
    { data: {} },
    { data: { user: { id: "public-user-id" } } },
  ])("rejects a completed response without authenticated identity: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "invalid_credentials",
      checkedAt: expect.any(String),
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
  });
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts`

Expected: FAIL because `checkAuthHealth()` still returns `{ status: "checking" }` and does not send `CurrentUser`.

- [ ] **Step 3: Implement the minimal successful/null identity probe**

Replace the placeholder method in `TwitchAdapter` with:

```ts
  async checkAuthHealth(): Promise<PlatformAuthHealth> {
    const checkedAt = new Date().toISOString();
    const response = await this.gqlTransport<{ currentUser?: { id?: string } | null }>(
      "CurrentUser",
      "",
      {},
      CURRENT_USER_QUERY,
      undefined,
      this.emit,
    );
    if (response.data?.currentUser) {
      return { status: "healthy", checkedAt, message: { key: "authHealthy" } };
    }
    return {
      status: "invalid_credentials",
      checkedAt,
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    };
  }
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts`

Expected: the new identity tests pass and all existing adapter tests pass.

- [ ] **Step 5: Add failing credential, network, and platform-error classification tests**

Add after the identity tests:

```ts
  it.each([
    { error: "Unauthorized", message: "OAuth token is invalid" },
    { errors: [{ message: "Unauthenticated" }] },
  ])("classifies explicit Twitch credential rejection as invalid: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "invalid_credentials",
      checkedAt: expect.any(String),
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
  });

  it("classifies request transport failure as network unavailability", async () => {
    const fetcher = jsonFetcher(() => {
      throw new TypeError("Failed to fetch secret-url");
    });

    await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "unavailable",
      checkedAt: expect.any(String),
      reasonCode: "network_unavailable",
      message: { key: "authNetworkUnavailable" },
    });
  });

  it.each([
    { errors: [{ message: "service unavailable" }] },
    { error: "Service Unavailable", message: "upstream failed" },
    null,
  ])("classifies Twitch response failure as platform unavailability: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "unavailable",
      checkedAt: expect.any(String),
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    });
  });
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts`

Expected: FAIL because transport and Twitch errors still reject instead of returning classified health.

- [ ] **Step 7: Add typed internal GQL failures**

Add near `TwitchGqlResponse<T>`:

```ts
type TwitchGqlFailureKind = "network" | "credentials" | "platform";

class TwitchGqlFailure extends Error {
  constructor(readonly kind: TwitchGqlFailureKind, message: string) {
    super(message);
    this.name = "TwitchGqlFailure";
  }
}

function isCredentialRejection(message: string | undefined): boolean {
  return message != null && /unauthenticated|unauthorized|oauth token (?:is )?invalid|invalid oauth token|token (?:has )?expired/i.test(message);
}
```

In `createTwitchGqlTransport`, replace the direct `fetcher.fetchJson` call in `fetchOnce` with:

```ts
      let raw: unknown;
      try {
        raw = await fetcher.fetchJson<unknown>("https://gql.twitch.tv/gql", request, emit);
      } catch (error) {
        const message = error instanceof Error ? error.message : `${operationName} request failed`;
        throw new TwitchGqlFailure("network", message);
      }
```

Replace the page-error throw with:

```ts
      if (pageError) throw new TwitchGqlFailure("network", `${operationName}: ${pageError}`);
```

Replace every empty-response `throw new Error(...)` inside this transport with `throw new TwitchGqlFailure("platform", ...)` using the same existing message. Replace the final top-level and `errors[]` throws with:

```ts
    if (response.error || (response.message && response.data === undefined)) {
      const message = [response.error, response.message].filter(Boolean).join(": ") || `${operationName} failed`;
      throw new TwitchGqlFailure(isCredentialRejection(message) ? "credentials" : "platform", message);
    }
    if (response.errors?.length) {
      const message = response.errors.map((error) => error.message).filter(Boolean).join("; ") || `${operationName} failed`;
      throw new TwitchGqlFailure(isCredentialRejection(message) ? "credentials" : "platform", message);
    }
```

- [ ] **Step 8: Map typed failures to safe health results**

Wrap the `gqlTransport` call and identity classification in `checkAuthHealth()` with `try/catch` and add:

```ts
    } catch (error) {
      if (error instanceof TwitchGqlFailure && error.kind === "credentials") {
        return {
          status: "invalid_credentials",
          checkedAt,
          reasonCode: "credentials_rejected",
          message: { key: "authInvalidCredentials" },
        };
      }
      const network = error instanceof TwitchGqlFailure && error.kind === "network";
      return {
        status: "unavailable",
        checkedAt,
        reasonCode: network ? "network_unavailable" : "platform_unavailable",
        message: { key: network ? "authNetworkUnavailable" : "authPlatformUnavailable" },
      };
    }
```

Do not emit or copy `error.message` from this catch.

- [ ] **Step 9: Run focused adapter tests and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts`

Expected: all adapter tests pass, including every new classification.

- [ ] **Step 10: Commit the probe**

```bash
git add packages/core/src/platforms/twitch/index.ts packages/extension/tests/adapters.test.ts
git commit -m "fix(twitch): probe authenticated session health"
```

### Task 2: Controller recovery regression and complete verification

**Files:**
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: existing `controller.checkAuthHealth(platform)` and `controller.invalidateAuthHealth(platform)` APIs.
- Verifies: a credential-triggered recheck can replace unhealthy Twitch state with `healthy` without modifying platform settings or invoking the other platform.

- [ ] **Step 1: Add the recovery transition test**

Add after `continues to the authenticated probe when credentials are available`:

```ts
  it("recovers Twitch authentication health after login without changing enabled settings", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true }, {
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    vi.mocked(env.twitch.checkAuthHealth)
      .mockResolvedValueOnce({
        status: "invalid_credentials",
        checkedAt: "2026-07-22T12:00:00.000Z",
        reasonCode: "credentials_rejected",
        message: { key: "authInvalidCredentials" },
      })
      .mockResolvedValueOnce({
        status: "healthy",
        checkedAt: "2026-07-22T12:05:00.000Z",
        message: { key: "authHealthy" },
      });

    await env.controller.checkAuthHealth("twitch");
    await env.controller.invalidateAuthHealth("twitch");
    await env.controller.checkAuthHealth("twitch");

    expect(env.state.authHealth.twitch).toEqual({
      status: "healthy",
      checkedAt: "2026-07-22T12:05:00.000Z",
      message: { key: "authHealthy" },
    });
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.settings.platform.kick.enabled).toBe(true);
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(2);
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run focused controller tests**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts`

Expected: all controller tests pass. This is regression coverage over existing controller behavior; no production change is expected.

- [ ] **Step 3: Run Twitch regression coverage**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts twitchIntegrity.test.ts twitchHeartbeat.test.ts heartbeatTransport.test.ts backgroundController.test.ts`

Expected: all focused Twitch, transport, and recovery tests pass.

- [ ] **Step 4: Run repository verification**

Run: `pnpm verify`

Expected: script tests, all workspace typechecks, extension tests, site build, and Chromium/Firefox extension builds complete with exit code 0.

- [ ] **Step 5: Commit recovery coverage**

```bash
git add packages/extension/tests/backgroundController.test.ts
git commit -m "test(twitch): cover authentication recovery"
```
