# In-page Panel Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the in-page panel default-on while removing stable greppable DOM/WAR/console “Lurkloot” fingerprints from Twitch/Kick page scans (approach A).

**Architecture:** Persist per-install opaque `buttonId`/`panelId` in `storage.local`. Drive injected element ids from those tokens. Ship icon-only page chrome (Lurkloot only in tooltip/aria). Rename the WXT panel entrypoint so the WAR file is opaque (`p.html`). Quiet the page `console.warn`. Do not touch farming content scripts, keep-alive, or `showInPagePanel` default.

**Tech Stack:** TypeScript, WXT extension entrypoints, Vitest, `wxt/browser` mocks, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-09-in-page-panel-hardening-design.md` (PR #515).

**Workspace:** Implement on a feature branch off `develop` (or continue from `docs/in-page-panel-hardening-spec` after merging the docs). If `node_modules` is missing, run `pnpm install --frozen-lockfile` before Task 1.

## Global Constraints

- `DEFAULT_SETTINGS.showInPagePanel` stays `true`; do not flip the default.
- Visible page chrome is **icon-only** — no “Lurkloot” text node in the nav button or panel title bar.
- Tooltip / accessible name **may** still say “Open Lurkloot” (or equivalent).
- Opaque ids are **per-install** (persist in `storage.local`), length 12–16, from `crypto.getRandomValues`, and must not contain substrings `lurkloot`, `panel`, or `nav` (case-insensitive).
- WAR resource must not be named `inpagePanel.html`; use static opaque `p.html` via renaming `entrypoints/inpagePanel` → `entrypoints/p`.
- Keep WAR `matches` scoped to Twitch + Kick; never `<all_urls>`.
- Do not change MAIN-world keep-alive, playback telemetry, managed-tab gating behavior, or farming scheduler code.
- Popup UI inside the iframe may remain branded (trusted extension page).
- English product comments in `models.ts` about default-on stay accurate; update only if wording becomes false.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/extension/src/core/inPagePanelDom.ts` | Pure opaque-id generate/normalize helpers + storage key + panel document path constant |
| `packages/extension/src/core/inPagePanel.ts` | Mount/reconcile panel; consume tokens; icon-only chrome; quiet console; `getURL` to `/p.html` |
| `packages/extension/entrypoints/p/` | Renamed from `entrypoints/inpagePanel/` so WXT emits `p.html` |
| `packages/extension/wxt.config.ts` | WAR `resources: ["p.html"]` |
| `packages/extension/tests/inPagePanelDom.test.ts` | Unit tests for opaque ids |
| `packages/extension/tests/inPagePanel.test.ts` | DOM chrome + storage wiring tests with `wxt/browser` mock |
| `packages/extension/tests/manifestPermissions.test.ts` | Assert WAR name / no `inpagePanel.html` |
| `packages/extension/tests/settings.test.ts` | Keep default-on pin (no behavior change) |

---

### Task 1: Opaque DOM token helpers

**Files:**
- Create: `packages/extension/src/core/inPagePanelDom.ts`
- Create: `packages/extension/tests/inPagePanelDom.test.ts`

**Interfaces:**
- Consumes: none.
- Produces:

```ts
export const IN_PAGE_PANEL_DOM_KEY = "inPagePanelDom";
export const PANEL_DOCUMENT_PATH = "/p.html";

export interface InPagePanelDomTokens {
  buttonId: string;
  panelId: string;
}

export function generateOpaqueId(byteLength?: number): string;
export function isForbiddenOpaqueId(id: string): boolean;
export function normalizeInPagePanelDomTokens(raw: unknown): InPagePanelDomTokens;
```

- [ ] **Step 1: Write the failing helper tests**

Create `packages/extension/tests/inPagePanelDom.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  generateOpaqueId,
  isForbiddenOpaqueId,
  normalizeInPagePanelDomTokens,
  PANEL_DOCUMENT_PATH,
} from "../src/core/inPagePanelDom";

describe("inPagePanelDom", () => {
  it("points the iframe at the opaque panel document", () => {
    expect(PANEL_DOCUMENT_PATH).toBe("/p.html");
    expect(PANEL_DOCUMENT_PATH.toLowerCase()).not.toContain("inpage");
    expect(PANEL_DOCUMENT_PATH.toLowerCase()).not.toContain("lurkloot");
  });

  it("generates opaque ids of the expected shape", () => {
    const id = generateOpaqueId();
    expect(id).toMatch(/^[a-z0-9]{12,16}$/);
    expect(isForbiddenOpaqueId(id)).toBe(false);
  });

  it("rejects ids that embed product or role substrings", () => {
    expect(isForbiddenOpaqueId("lurklootabc123")).toBe(true);
    expect(isForbiddenOpaqueId("xxpanelxx1234")).toBe(true);
    expect(isForbiddenOpaqueId("mynavbutton99")).toBe(true);
    expect(isForbiddenOpaqueId("ab12cd34ef56")).toBe(false);
  });

  it("reuses valid persisted tokens and regenerates missing or corrupt ones", () => {
    const valid = { buttonId: "ab12cd34ef56", panelId: "gh78ij90kl12" };
    expect(normalizeInPagePanelDomTokens(valid)).toEqual(valid);

    const repaired = normalizeInPagePanelDomTokens({ buttonId: "lurkloot-nav-button", panelId: 1 });
    expect(repaired.buttonId).toMatch(/^[a-z0-9]{12,16}$/);
    expect(repaired.panelId).toMatch(/^[a-z0-9]{12,16}$/);
    expect(repaired.buttonId).not.toBe("lurkloot-nav-button");
    expect(isForbiddenOpaqueId(repaired.buttonId)).toBe(false);
    expect(isForbiddenOpaqueId(repaired.panelId)).toBe(false);
    expect(repaired.buttonId).not.toBe(repaired.panelId);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/inPagePanelDom.test.ts
```

Expected: FAIL because `../src/core/inPagePanelDom` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `packages/extension/src/core/inPagePanelDom.ts`:

```ts
export const IN_PAGE_PANEL_DOM_KEY = "inPagePanelDom";
export const PANEL_DOCUMENT_PATH = "/p.html";

export interface InPagePanelDomTokens {
  buttonId: string;
  panelId: string;
}

const FORBIDDEN = /lurkloot|panel|nav/i;

export function isForbiddenOpaqueId(id: string): boolean {
  return FORBIDDEN.test(id);
}

export function generateOpaqueId(byteLength = 8): string {
  // 8 bytes → 16 hex chars; trim to 12–16 by using 6–8 bytes.
  const size = Math.min(8, Math.max(6, byteLength));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!isForbiddenOpaqueId(id)) return id;
  }
  // Extremely unlikely with random hex; still avoid forbidden substrings.
  return `x${Date.now().toString(36)}`.slice(0, 16);
}

function isUsableId(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9]{12,16}$/.test(value)
    && !isForbiddenOpaqueId(value);
}

export function normalizeInPagePanelDomTokens(raw: unknown): InPagePanelDomTokens {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const buttonId = isUsableId(record.buttonId) ? record.buttonId : generateOpaqueId();
  let panelId = isUsableId(record.panelId) ? record.panelId : generateOpaqueId();
  if (panelId === buttonId) panelId = generateOpaqueId();
  return { buttonId, panelId };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/inPagePanelDom.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/core/inPagePanelDom.ts packages/extension/tests/inPagePanelDom.test.ts
git commit -m "$(cat <<'EOF'
feat(extension): add opaque in-page panel DOM tokens

EOF
)"
```

---

### Task 2: Wire panel mount to tokens + icon-only chrome

**Files:**
- Modify: `packages/extension/src/core/inPagePanel.ts`
- Create: `packages/extension/tests/inPagePanel.test.ts`

**Interfaces:**
- Consumes: `IN_PAGE_PANEL_DOM_KEY`, `PANEL_DOCUMENT_PATH`, `normalizeInPagePanelDomTokens`, `InPagePanelDomTokens` from `./inPagePanelDom`.
- Produces: `mountInPagePanel` behavior unchanged externally; injected button has **no** text content “Lurkloot”; element ids come from stored tokens; iframe `src` uses `browser.runtime.getURL(PANEL_DOCUMENT_PATH)`; missing-anchor warn has no `[Lurkloot]` prefix.

- [ ] **Step 1: Write the failing mount tests**

Create `packages/extension/tests/inPagePanel.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, unknown>();

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://test${path}`,
      sendMessage: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | string) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (storage.has(key)) out[key] = storage.get(key);
          return out;
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
  },
}));

const { mountInPagePanel } = await import("../src/core/inPagePanel");
const { IN_PAGE_PANEL_DOM_KEY } = await import("../src/core/inPagePanelDom");

describe("in-page panel chrome", () => {
  beforeEach(() => {
    storage.clear();
    document.body.innerHTML = `<header class="top-nav__menu"><div class="top-nav__prime"></div></header>`;
    storage.set("settings", { showInPagePanel: true });
    storage.set("schedulerState", { managedWatchTabs: {}, managedPageContextTabs: {} });
  });

  it("injects an icon-only button with opaque ids and no lurkloot DOM ids", async () => {
    mountInPagePanel("twitch");
    // mount kicks async reconcile — wait a turn
    await vi.waitFor(() => {
      expect(document.querySelector("button")).not.toBeNull();
    });

    const button = document.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent?.replace(/\s+/g, "").toLowerCase()).not.toContain("lurkloot");
    expect(button!.querySelector("svg")).not.toBeNull();
    expect(button!.id.toLowerCase()).not.toContain("lurkloot");
    expect(document.getElementById("lurkloot-nav-button")).toBeNull();

    const tokens = storage.get(IN_PAGE_PANEL_DOM_KEY) as { buttonId: string; panelId: string };
    expect(tokens.buttonId).toBe(button!.id);
    expect(button!.getAttribute("title")?.toLowerCase()).toContain("lurkloot");
  });

  it("reuses the same opaque button id across remount reconcile", async () => {
    mountInPagePanel("twitch");
    await vi.waitFor(() => expect(document.querySelector("button")).not.toBeNull());
    const firstId = document.querySelector("button")!.id;

    document.querySelector("button")!.remove();
    // storage.onChanged is not auto-fired by our mock; call mount path by writing settings
    // Re-importing is unnecessary — trigger reconcile via storage listener if captured,
    // otherwise remount is enough when tokens already exist.
    mountInPagePanel("twitch");
    await vi.waitFor(() => expect(document.querySelector("button")).not.toBeNull());
    expect(document.querySelector("button")!.id).toBe(firstId);
  });
});
```

If `vi.waitFor` is unavailable in this Vitest version, replace with a short `await Promise.resolve()` loop (`for (let i = 0; i < 10; i++) { await Promise.resolve(); if (document.querySelector("button")) break; }`).

Note: `mountInPagePanel` registers listeners on every call — for the second test, prefer exporting a test-only `reconcileForTests` **only if** remount double-registers break the suite. Prefer fixing the production module to be idempotent on repeated `mountInPagePanel` (guard with a `started` flag) if tests expose double-listener issues.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/inPagePanel.test.ts
```

Expected: FAIL on visible “Lurkloot” text and/or `#lurkloot-nav-button` still present / tokens missing.

- [ ] **Step 3: Update `inPagePanel.ts`**

Apply these concrete edits to `packages/extension/src/core/inPagePanel.ts`:

1. Remove `const BUTTON_ID = "lurkloot-nav-button"` and `const PANEL_ID = "lurkloot-panel"`.
2. Import:

```ts
import {
  IN_PAGE_PANEL_DOM_KEY,
  PANEL_DOCUMENT_PATH,
  normalizeInPagePanelDomTokens,
  type InPagePanelDomTokens,
} from "./inPagePanelDom";
```

3. Keep module-level `let` state; add `let domTokens: InPagePanelDomTokens | undefined`.
4. Add:

```ts
async function ensureDomTokens(): Promise<InPagePanelDomTokens> {
  if (domTokens) return domTokens;
  const stored = await browser.storage.local.get(IN_PAGE_PANEL_DOM_KEY);
  const normalized = normalizeInPagePanelDomTokens(stored[IN_PAGE_PANEL_DOM_KEY]);
  const previous = stored[IN_PAGE_PANEL_DOM_KEY] as InPagePanelDomTokens | undefined;
  if (!previous || previous.buttonId !== normalized.buttonId || previous.panelId !== normalized.panelId) {
    await browser.storage.local.set({ [IN_PAGE_PANEL_DOM_KEY]: normalized });
  }
  domTokens = normalized;
  return normalized;
}
```

5. At the start of `reconcile()`, after reading settings/state and before `ensureButton()`, `await ensureDomTokens()`.
6. In `createButton()`:
   - `el.id = (domTokens ?? { buttonId: "" }).buttonId` — but only call `createButton` after tokens exist; use `domTokens!.buttonId`.
   - Change `el.innerHTML = \`${ICON}<span>Lurkloot</span>\`` to `el.innerHTML = ICON`.
   - Keep `el.title = "Open Lurkloot"`.
   - Because there is no visible text, set `el.setAttribute("aria-label", "Open Lurkloot")` (accessible name can no longer come from text content).
7. In `openPanel()`, set `panel.id = domTokens!.panelId`.
8. Change title bar label from `title.textContent = "Lurkloot"` to `title.textContent = ""` (or a single non-breaking space / generic “Panel” **without** the product name — prefer empty string + keep close button `aria-label` "Close").
9. Change `frame.src = browser.runtime.getURL("/inpagePanel.html")` to `browser.runtime.getURL(PANEL_DOCUMENT_PATH)`.
10. Change `warnOnce` message from `` `[Lurkloot] ${message}` `` to just `message` (or `` `[extension] ${message}` `` with no product name).
11. Make `mountInPagePanel` / `start` idempotent: if a module-level `started` is already true, skip re-adding listeners; still allow `reconcile()`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/inPagePanel.test.ts tests/inPagePanelDom.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/core/inPagePanel.ts packages/extension/tests/inPagePanel.test.ts
git commit -m "$(cat <<'EOF'
feat(extension): harden in-page panel DOM chrome

EOF
)"
```

---

### Task 3: Rename panel entrypoint + WAR to `p.html`

**Files:**
- Rename: `packages/extension/entrypoints/inpagePanel/` → `packages/extension/entrypoints/p/`
- Modify: `packages/extension/wxt.config.ts`
- Modify: `packages/extension/tests/manifestPermissions.test.ts`
- Modify: any remaining references to `inpagePanel.html` / `entrypoints/inpagePanel` (grep the repo)

**Interfaces:**
- Consumes: `PANEL_DOCUMENT_PATH === "/p.html"` from Task 1.
- Produces: built/packaged WAR lists `p.html` only (not `inpagePanel.html`); WXT entrypoint folder name `p`.

- [ ] **Step 1: Write the failing WAR assertion**

In `packages/extension/tests/manifestPermissions.test.ts`, append:

```ts
describe("in-page panel web accessible resource", () => {
  it("exposes an opaque panel document scoped to Twitch and Kick", () => {
    expect(source).toContain('resources: ["p.html"]');
    expect(source).not.toContain("inpagePanel.html");
    expect(source).toContain('matches: ["https://*.twitch.tv/*", "https://*.kick.com/*"]');
    expect(source).not.toContain("<all_urls>");
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/manifestPermissions.test.ts
```

Expected: FAIL on missing `p.html` / still containing `inpagePanel.html`.

- [ ] **Step 3: Rename entrypoint and update config**

```bash
git mv packages/extension/entrypoints/inpagePanel packages/extension/entrypoints/p
```

In `packages/extension/wxt.config.ts`, change:

```ts
        resources: ["inpagePanel.html"],
```

to:

```ts
        resources: ["p.html"],
```

Update the comment above WAR so it refers to “the in-page panel document” without requiring the old filename.

Optional: in `packages/extension/entrypoints/p/index.html`, leave `<title>Lurkloot</title>` (extension-page document; not page DOM). Do not rename the HTML title unless a later pass asks for it.

Grep and fix stragglers:

```bash
rg -n "inpagePanel|inPagePanel\.html|lurkloot-nav-button|lurkloot-panel" packages docs
```

Update docs/spikes only if they claim the WAR filename is part of the public contract; otherwise leave historical spikes alone.

- [ ] **Step 4: Run focused tests + extension build smoke**

Run:

```bash
pnpm --filter @lurkloot/extension test tests/manifestPermissions.test.ts tests/inPagePanel.test.ts tests/inPagePanelDom.test.ts tests/settings.test.ts
pnpm --filter @lurkloot/extension build
```

Expected: tests PASS; build exits 0; built manifest under `.output/` (or WXT output dir) lists `p.html` and not `inpagePanel.html`.

Confirm with:

```bash
rg -n "inpagePanel\.html|\"p\.html\"" packages/extension/.output -S || true
# If .output path differs, locate the built manifest:
find packages/extension -name manifest.json | head
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/extension/entrypoints packages/extension/wxt.config.ts packages/extension/tests/manifestPermissions.test.ts
git commit -m "$(cat <<'EOF'
feat(extension): ship opaque in-page panel WAR path

EOF
)"
```

---

### Task 4: Verify

- [ ] **Step 1: Run package verification**

```bash
pnpm --filter @lurkloot/extension test
pnpm --filter @lurkloot/extension typecheck
```

Expected: exit 0.

- [ ] **Step 2: Manual checklist (extension loaded from build)**

1. Twitch + Kick: icon-only nav control appears; hover still says Open Lurkloot.
2. Open panel; chrome title bar has no “Lurkloot” wordmark; popup content inside iframe is fine branded.
3. Managed farming tab: no button.
4. Devtools Elements: no `#lurkloot-nav-button` / `#lurkloot-panel`.
5. Firefox build still loads the panel iframe.

- [ ] **Step 3: Commit only if verification forced a fix**

Use `fix(extension): …` — do not amend.

---

## Spec coverage check

| Spec requirement | Task |
| --- | --- |
| Per-install opaque button/panel ids | Task 1–2 |
| No forbidden substrings in ids | Task 1 |
| Icon-only visible chrome; Lurkloot in tooltip/aria | Task 2 |
| Quiet console warn | Task 2 |
| WAR rename to opaque static name + scoped matches | Task 3 |
| Default-on unchanged | Task 2/4 (settings pin untouched) |
| Farming CS / keep-alive out of scope | Honored (no tasks touch them) |
