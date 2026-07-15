# Compatibility Profile Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bundled, per-platform compatibility profiles, validated expert overrides, CLI configuration, extension Advanced Settings controls, and effective-version diagnostics without changing platform behavior yet.

**Architecture:** `@lurkloot/shared` owns persisted selection contracts, while `@lurkloot/core` owns the immutable registry and host-aware resolver. Hosts inject runtime facts when constructing adapters; popup code receives source-controlled registry metadata and never accepts raw endpoints or query text.

**Tech Stack:** TypeScript, React 19, Vitest, pnpm workspaces, JSONC CLI configuration.

## Global Constraints

- Profiles are bundled only; no remote compatibility downloads.
- No editable endpoint, client ID, header, hash, GraphQL document, or host-allowlist fields.
- `auto` is the persisted default for profiles and every expert override.
- Invalid, removed, or host-incompatible values resolve to `auto` with a diagnostic warning.
- Security and claim-expiry behavior remain outside compatibility profiles.
- Preserve the browser-free `@lurkloot/core` boundary.

---

### Task 1: Shared compatibility settings contract

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/settings.ts`
- Test: `packages/extension/tests/settings.test.ts`

**Interfaces:**
- Produces: `CompatibilitySettings`, `TwitchCompatibilitySettings`, `KickCompatibilitySettings`, and `DEFAULT_ENGINE_SETTINGS.compatibility`.
- Produces normalized string selections; registry-aware host validation remains in Task 2.

- [ ] **Step 1: Write failing settings tests**

Add cases asserting defaults and preservation of bundled identifiers:

```ts
expect(mergeSettings(undefined).compatibility).toEqual({
  twitch: { profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "auto" },
  kick: { profile: "auto", claimLinkHandling: "auto" },
});
expect(mergeSettings({ compatibility: {
  twitch: { profile: "twitch-2026-07", heartbeatTransport: "twitch-heartbeat-gql-v1", inventoryQueryVersion: "auto" },
  kick: { profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" },
} } as never).compatibility.twitch.profile).toBe("twitch-2026-07");
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- settings.test.ts`

Expected: FAIL because `compatibility` is absent.

- [ ] **Step 3: Add the contracts and normalization**

Define:

```ts
export interface TwitchCompatibilitySettings {
  profile: string;
  heartbeatTransport: string;
  inventoryQueryVersion: string;
}
export interface KickCompatibilitySettings {
  profile: string;
  claimLinkHandling: string;
}
export interface CompatibilitySettings {
  twitch: TwitchCompatibilitySettings;
  kick: KickCompatibilitySettings;
}
```

Add `compatibility: CompatibilitySettings` to `EngineSettings`, defaults with all fields set to `"auto"`, merge each nested object independently, and extend `SettingsPatch`/`applySettingsPatch` so partial compatibility updates do not erase sibling selections. Normalize non-string and blank values to `"auto"`; registry-aware validation is deliberately deferred.

- [ ] **Step 4: Run settings tests**

Run: `pnpm --filter @lurkloot/extension test -- settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/extension/tests/settings.test.ts
git commit -m "feat(settings): add compatibility selections"
```

### Task 2: Bundled registry and host-aware resolver

**Files:**
- Create: `packages/core/src/compatibility/types.ts`
- Create: `packages/core/src/compatibility/registry.ts`
- Create: `packages/core/src/compatibility/resolve.ts`
- Create: `packages/extension/tests/compatibility.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `CompatibilityHostFacts`, `ResolvedCompatibility`, `CompatibilityWarning`.
- Produces: `resolveCompatibility(settings, host): { compatibility, warnings }`.
- Produces: `COMPATIBILITY_REGISTRY` metadata for the UI and later behavior plans.

- [ ] **Step 1: Write failing resolver tests**

Cover extension/web and CLI/Android automatic resolution, valid legacy overrides, unknown values, and host-incompatible Trowel selection:

```ts
expect(resolveCompatibility(defaults, { host: "extension", twitchIdentity: "web" }).compatibility.twitch)
  .toMatchObject({ profile: "twitch-2026-07", heartbeat: "twitch-heartbeat-spade-v1" });
expect(resolveCompatibility(defaults, { host: "cli", twitchIdentity: "android" }).compatibility.twitch.heartbeat)
  .toBe("twitch-heartbeat-trowel-v1");
expect(resolveCompatibility(overridden, { host: "extension", twitchIdentity: "web" }).warnings[0].code)
  .toBe("incompatible_override");
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts`

Expected: FAIL because the compatibility module does not exist.

- [ ] **Step 3: Implement immutable metadata and resolution**

Use discriminated IDs and lifecycle metadata:

```ts
export type CompatibilityLifecycle = "recommended" | "legacy" | "experimental";
export interface CompatibilityHostFacts { host: "extension" | "cli"; twitchIdentity: "web" | "android"; }
export interface ResolvedCompatibility {
  twitch: { profile: string; heartbeat: string; inventory: string };
  kick: { profile: string; claim: string };
}
export interface CompatibilityWarning {
  code: "unknown_selection" | "incompatible_override";
  platform: "twitch" | "kick";
  field: string;
  requested: string;
  resolved: string;
}
```

Register `twitch-2026-07`, `kick-2026-07`, the three heartbeat IDs, `twitch-inventory-v1`, `kick-claim-v1`, and `kick-claim-v2`. Defer later Twitch inventory versions until independent real response evidence verifies their parser contract. Freeze exported registry objects. Resolve profile defaults first, then compatible explicit overrides; never silently switch versions after runtime request failure.

- [ ] **Step 4: Run resolver tests and core boundary test**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts coreBoundary.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/compatibility packages/core/src/index.ts packages/extension/tests/compatibility.test.ts
git commit -m "feat(core): resolve bundled compatibility profiles"
```

### Task 3: Wire host facts and compatibility diagnostics

**Files:**
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/cli/src/transport/http.ts`
- Modify: `packages/cli/src/transport/impersonate.ts`
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/compatibility.test.ts`

**Interfaces:**
- Consumes: `resolveCompatibility` from Task 2.
- Produces: resolved compatibility passed through adapter construction options.
- Produces one startup diagnostic per enabled platform.

- [ ] **Step 1: Write failing host and diagnostic tests**

Assert the extension resolves web facts, CLI resolves Android facts, and startup emits structured profile/capability fields without credentials:

```ts
expect(event).toMatchObject({
  category: "diagnostic",
  platform: "twitch",
  compatibilityProfile: "twitch-2026-07",
  compatibilityCapability: "twitch-heartbeat-spade-v1",
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts backgroundController.test.ts`

Expected: FAIL because adapter construction and events lack resolved metadata.

- [ ] **Step 3: Inject facts and emit resolved configuration**

Resolve once per settings load using `{ host: "extension", twitchIdentity: "web" }` in the extension and `{ host: "cli", twitchIdentity: "android" }` in CLI transports. Extend engine-event diagnostic types with optional compatibility fields. Emit one concise event per enabled platform when the controller initializes or the effective selection changes; do not include token, cookie, response body, or headers.

- [ ] **Step 4: Run controller, compatibility, and type tests**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts backgroundController.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/entrypoints/background.ts packages/cli/src/transport/http.ts packages/cli/src/transport/impersonate.ts packages/core/src/background/controller.ts packages/extension/tests
git commit -m "feat(core): report effective compatibility versions"
```

### Task 4: CLI JSONC configuration

**Files:**
- Modify: `packages/cli/src/settings.ts`
- Modify: `packages/cli/src/config.ts`
- Test: `packages/cli/src/settings.test.ts`
- Test: `packages/cli/src/config.test.ts`

**Interfaces:**
- Consumes shared compatibility settings and registry-valid string selections.
- Produces documented JSONC fields under `settings.compatibility`.

- [ ] **Step 1: Write failing parser and template tests**

Assert generated JSONC contains both profile selectors and expert fields, valid selections round-trip, and blank/non-string selections become `auto`.

- [ ] **Step 2: Run CLI tests and verify failure**

Run: `pnpm --filter @lurkloot/cli test -- settings.test.ts config.test.ts`

Expected: FAIL because CLI settings reject or omit compatibility.

- [ ] **Step 3: Implement CLI parsing and documented template output**

Add `compatibility` to `CliSettings`, its strict key allowlist, defaults, and parser. Render comments stating that identifiers are bundled, `auto` is recommended, and raw destinations/hashes cannot be supplied. Surface resolver warnings through the existing `CliConfig.warnings` path.

- [ ] **Step 4: Run CLI tests and typecheck**

Run: `pnpm --filter @lurkloot/cli test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/settings.ts packages/cli/src/config.ts packages/cli/src/settings.test.ts packages/cli/src/config.test.ts
git commit -m "feat(cli): configure compatibility profiles"
```

### Task 5: Extension Advanced Settings UI

**Files:**
- Create: `packages/popup-ui/src/compatibilitySettings.tsx`
- Modify: `packages/popup-ui/src/settings.tsx`
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/locales/messages/en.json`
- Modify: `packages/locales/messages/ar.json`
- Modify: `packages/locales/messages/de.json`
- Modify: `packages/locales/messages/es.json`
- Modify: `packages/locales/messages/fr.json`
- Modify: `packages/locales/messages/hi.json`
- Modify: `packages/locales/messages/it.json`
- Modify: `packages/locales/messages/pt_BR.json`
- Modify: `packages/locales/messages/ru.json`
- Modify: `packages/locales/messages/zh_CN.json`
- Test: `packages/extension/tests/compatibilitySettingsView.test.tsx`

**Interfaces:**
- Consumes registry metadata and resolved compatibility from popup adapter state.
- Produces nested settings patches only; never accepts free-form implementation text.

- [ ] **Step 1: Write failing UI tests**

Render Advanced Settings and assert Automatic defaults, effective versions, lifecycle badges, collapsed expert controls, host-inapplicable option filtering, override warning, and reset action:

```tsx
expect(screen.getByRole("combobox", { name: /Twitch compatibility profile/i })).toHaveValue("auto");
expect(screen.queryByText("twitch-heartbeat-trowel-v1")).not.toBeInTheDocument();
await user.click(screen.getByRole("button", { name: /Restore automatic compatibility/i }));
expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ compatibility: expect.any(Object) }));
```

- [ ] **Step 2: Run the UI test and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- compatibilitySettingsView.test.tsx`

Expected: FAIL because the controls do not exist.

- [ ] **Step 3: Implement the focused compatibility component**

Keep profile controls in the existing Advanced section. Put overrides behind a disclosure. Use source-controlled `<option>` values from registry metadata, show effective profile/capability text, lifecycle badges, and a warning when any stored field differs from `auto`. Reset both platform objects atomically to all-`auto` values. Do not render text inputs.

- [ ] **Step 4: Add complete locale keys and run UI tests**

Add English copy first, then translations/fallback-compatible keys in every catalog. Run: `pnpm --filter @lurkloot/extension test -- compatibilitySettingsView.test.tsx settings.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src packages/locales/messages packages/extension/tests/compatibilitySettingsView.test.tsx
git commit -m "feat(popup): configure compatibility profiles"
```

### Task 6: Foundation verification

**Files:** No production changes expected.

- [ ] **Step 1: Run focused suites**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts compatibilitySettingsView.test.tsx settings.test.ts backgroundController.test.ts`

Expected: PASS.

- [ ] **Step 2: Run repository verification**

Run: `pnpm verify`

Expected: all script tests, workspace typechecks, extension tests, site build, and browser builds pass.

- [ ] **Step 3: Commit only if verification required a fix**

Stage the specific source or test files changed to correct verification, confirm `git diff --cached --stat` contains no unrelated files, then commit:

```bash
git commit -m "fix(core): address compatibility profile verification"
```
