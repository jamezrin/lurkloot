# Per-Platform Automation Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each Twitch and Kick automation card render a badge and detail from one canonical per-platform lifecycle state.

**Architecture:** Extend the pure `automationPresentation` resolver to consume the platform session alongside effective settings, pending state, auth health, and manual-close pause. The popup will render only the resolver's canonical detail for non-running states and will admit a scheduler status message for `running` only when it is compatible with the settled enabled state.

**Tech Stack:** TypeScript, React, Vitest, pnpm, WXT

## Global Constraints

- Resolve Twitch and Kick independently.
- Keep diagnostic and scheduler messages as English literals; do not add diagnostic locale keys.
- User-facing transition copy must use existing locale keys.
- Badge, detail, tone, actions, and operational styling must derive from one `AutomationPresentation`.
- Do not display `Automation disabled`, `Platform disabled`, or `Starting automation` under a `Running` badge.

---

### Task 1: Canonical Per-Platform Presentation Resolver

**Files:**
- Modify: `packages/popup-ui/src/automationStatus.ts`
- Modify: `packages/extension/tests/popupAutomationStatus.test.ts`

**Interfaces:**
- Consumes: `PlatformSession` from `@lurkloot/shared/models`
- Produces: `automationPresentation({ platform, enabled, pending, authHealth, session, manualClosePaused }): AutomationPresentation`
- Produces: `AutomationPresentation.statusMessage?: string`

- [ ] **Step 1: Write failing resolver tests**

Add literal behavior tests covering:

```ts
expect(automationPresentation({
  platform: "twitch",
  enabled: true,
  pending: false,
  authHealth: HEALTHY,
  session: { platform: "twitch", status: "idle", offlineChecks: 0, message: "Starting automation" },
})).toMatchObject({
  state: "starting",
  badgeKey: "automationStarting",
  detailKey: "startingAutomation",
});
```

Also assert that an enabled healthy session with `message: "Automation disabled"`
returns `state: "running"` without exposing that message, while an ordinary
settled running message remains available as `statusMessage`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/popupAutomationStatus.test.ts
```

Expected: FAIL because `automationPresentation` does not consume `session` and
does not guard contradictory status messages.

- [ ] **Step 3: Implement the minimal resolver change**

Import `PlatformSession`, add `session` to the resolver arguments, recognize the
enabled startup marker before auth-health resolution, and add a helper that
returns a running `statusMessage` only when it is not one of:

```ts
new Set(["Starting automation", "Automation disabled", "Platform disabled"])
```

Return that safe message on the `running` presentation.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/popupAutomationStatus.test.ts
```

Expected: all presentation tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/automationStatus.ts packages/extension/tests/popupAutomationStatus.test.ts
git commit -m "fix(popup): unify platform automation presentation"
```

### Task 2: Render Only the Canonical Presentation

**Files:**
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/popup-ui/src/automation.tsx`
- Modify: `packages/extension/tests/popupAutomation.test.tsx`

**Interfaces:**
- Consumes: `AutomationPresentation.statusMessage`
- Removes: `AutomationHeroProps.statusMessage`

- [ ] **Step 1: Write a failing rendered-card test**

Render an enabled Twitch card from a snapshot whose auth is healthy and whose
session still says `Automation disabled`. Assert:

```ts
expect(screen.getByText("Running")).toBeTruthy();
expect(screen.queryByText("Automation disabled")).toBeNull();
```

Render the persisted startup-marker case and assert the card contains both the
`Starting` badge and localized `Starting automation...` detail.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/popupAutomation.test.tsx
```

Expected: FAIL because `AutomationHero` still renders the independently passed
raw session message.

- [ ] **Step 3: Wire the session into each platform resolver**

In `Popup.tsx`, pass:

```ts
session: snapshot.state.sessions[id]
```

for each platform. Stop passing `session.message` separately to
`AutomationHero`.

- [ ] **Step 4: Render the presentation's safe running detail**

Remove `statusMessage` from `AutomationHeroProps` and use
`presentation.statusMessage` in the settled running branch, falling back to
`waitingEligibleStream`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/popupAutomationStatus.test.ts tests/popupAutomation.test.tsx
```

Expected: all automation presentation and rendered-card tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/popup-ui/src/Popup.tsx packages/popup-ui/src/automation.tsx packages/extension/tests/popupAutomation.test.tsx
git commit -m "fix(popup): render canonical automation state"
```

### Task 3: Verify and Rebuild

**Files:**
- No source changes expected

**Interfaces:**
- Produces: verified Chromium build at `packages/extension/.output/chrome-mv3`

- [ ] **Step 1: Run repository verification**

Run:

```bash
pnpm verify
```

Expected: script tests, workspace typechecks, CLI tests, extension tests, site
build, Chromium build, and Firefox build all pass.

- [ ] **Step 2: Validate the rendered target flow**

The flow under test is: enable Twitch or Kick automation -> observe the
per-platform startup state -> observe the settled running state -> confirm the
badge and detail never contradict each other.

Use the Browser plugin when available. If it is unavailable, record that fact
and use the repository's existing popup test harness or Playwright without
installing dependencies.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended files changed.

- [ ] **Step 4: Push the verified commits**

Run:

```bash
git push origin HEAD
```

Expected: PR #305 receives the canonical presentation changes.
