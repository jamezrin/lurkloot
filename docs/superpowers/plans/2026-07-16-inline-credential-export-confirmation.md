# Inline Credential Export Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overflowing browser-native CLI credential export confirmation with an explicit inline Confirm/Cancel state that resets when Settings is left.

**Architecture:** Keep the confirmation state local to `SettingsView`, so the existing conditional mounting in `Popup` automatically discards an armed export when the user leaves Settings. Reuse the existing warning message, add localized action labels, and leave the callback and credential-download pipeline unchanged.

**Tech Stack:** React 19, TypeScript, Tailwind CSS utility classes, WXT, Vitest, LinkeDOM, pnpm workspaces

## Global Constraints

- Use no timer: confirmation remains armed until Confirm, Cancel, or `SettingsView` unmount.
- Use an inline confirmation; do not add a modal, separate screen, dependency, or browser-native dialog.
- Preserve the `onExportCredentials?: () => void | Promise<void>` interface and existing credential export/download behavior.
- Keep all ten locale catalogs structurally synchronized.
- Follow two-space indentation, double quotes, semicolons, strict TypeScript, and ES modules.

---

### Task 1: Inline credential export confirmation

**Files:**
- Create: `packages/extension/tests/settingsCredentialExport.test.tsx`
- Modify: `packages/popup-ui/src/settings.tsx:31-42,157-172`
- Modify: `packages/popup-ui/src/Popup.tsx:456-459`
- Modify: `packages/locales/messages/en.json:600-606`
- Modify: `packages/locales/messages/es.json:600-606`
- Modify: `packages/locales/messages/de.json:600-606`
- Modify: `packages/locales/messages/fr.json:600-606`
- Modify: `packages/locales/messages/it.json:600-606`
- Modify: `packages/locales/messages/pt_BR.json:600-606`
- Modify: `packages/locales/messages/ru.json:600-606`
- Modify: `packages/locales/messages/zh_CN.json:600-606`
- Modify: `packages/locales/messages/hi.json:600-606`
- Modify: `packages/locales/messages/ar.json:600-606`

**Interfaces:**
- Consumes: `SettingsView`'s existing `onExportCredentials?: () => void | Promise<void>` prop and the existing `cliExportConfirm` localized warning.
- Produces: local `exportArmed: boolean` UI state plus the new localization keys `cliExportCancel` and `cliExportConfirmButton`; no exported TypeScript interface changes.

- [ ] **Step 1: Add the focused failing interaction tests**

Create `packages/extension/tests/settingsCredentialExport.test.tsx` with a LinkeDOM harness that renders the real shared `SettingsView`:

```tsx
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { I18nContext } from "../../popup-ui/src/context";
import { SettingsView } from "../../popup-ui/src/settings";

const labels: Record<string, string> = {
  cliExportTitle: "Headless CLI",
  cliExportDescription: "Use this browser session with the CLI.",
  cliExportHint: "Keep the exported session credentials private.",
  cliExportConfirm: "Anyone with this file can use your sessions.",
  cliExportButton: "Export credentials",
  cliExportCancel: "Cancel",
  cliExportConfirmButton: "Confirm export",
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function renderSettings(onExportCredentials: () => void): void {
  act(() => {
    root?.render(
      <I18nContext.Provider value={{ t: (key) => labels[key] ?? key, dir: "ltr", locale: "en" }}>
        <SettingsView
          suggestions={{ twitch: [], kick: [] }}
          onSearchCategories={async () => []}
          settings={DEFAULT_SETTINGS}
          onSettingsChange={async () => undefined}
          onExportCredentials={onExportCredentials}
        />
      </I18nContext.Provider>,
    );
  });
}

function mount(onExportCredentials = vi.fn()) {
  const { document, window } = parseHTML("<div id=app></div>");
  const confirm = vi.fn();
  Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  root = createRoot(container);
  renderSettings(onExportCredentials);
  return { confirm, container, onExportCredentials };
}

function byText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

describe("settings credential export", () => {
  it("requires an inline confirmation and supports explicit cancellation", () => {
    const { confirm, container, onExportCredentials } = mount();

    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");

    act(() => byText(container, "Export credentials").click());
    expect(container.textContent).toContain("Anyone with this file can use your sessions.");
    expect(container.textContent).toContain("Cancel");
    expect(container.textContent).toContain("Confirm export");
    expect(onExportCredentials).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    act(() => byText(container, "Cancel").click());
    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(onExportCredentials).not.toHaveBeenCalled();

    act(() => byText(container, "Export credentials").click());
    act(() => byText(container, "Confirm export").click());
    expect(onExportCredentials).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("cancels an armed export when Settings unmounts", () => {
    const { container, onExportCredentials } = mount();

    act(() => byText(container, "Export credentials").click());
    expect(container.textContent).toContain("Confirm export");

    act(() => root?.render(<div>Outside settings</div>));
    renderSettings(onExportCredentials);

    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(onExportCredentials).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the focused test and verify the old implementation fails**

Run:

```bash
pnpm --filter @lurkloot/extension test -- settingsCredentialExport.test.tsx
```

Expected: FAIL because the first export click calls `window.confirm` and the inline **Cancel** and **Confirm export** controls do not exist.

- [ ] **Step 3: Implement the local armed state and inline controls**

In `packages/popup-ui/src/settings.tsx`, add state beside the other local view state:

```tsx
const [exportArmed, setExportArmed] = useState(false);
```

Replace the current CLI export section with:

```tsx
{onExportCredentials && (
  <SettingsSection title={t("cliExportTitle")} description={t("cliExportDescription")} icon={Terminal}>
    {exportArmed ? (
      <div className="space-y-2 px-1 py-1">
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          {t("cliExportConfirm")}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={() => setExportArmed(false)}
          >
            {t("cliExportCancel")}
          </button>
          <button
            type="button"
            className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
            onClick={() => {
              setExportArmed(false);
              void onExportCredentials();
            }}
          >
            {t("cliExportConfirmButton")}
          </button>
        </div>
      </div>
    ) : (
      <div className="flex items-center justify-between gap-3 px-1 py-1">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("cliExportHint")}</p>
        <button
          type="button"
          className="shrink-0 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          onClick={() => setExportArmed(true)}
        >
          {t("cliExportButton")}
        </button>
      </div>
    )}
  </SettingsSection>
)}
```

This state intentionally remains inside `SettingsView`; `Popup` already conditionally mounts that component only while `settingsOpen` is true, so navigating back unmounts it and resets the state without an effect or parent callback.

- [ ] **Step 4: Update the stale `Popup` comment**

In `packages/popup-ui/src/Popup.tsx`, replace the comment above `exportCredentials` with:

```ts
// Exports the session tokens the headless CLI's `login --import` consumes.
// Gated behind inline confirmation in the settings view; available only when
// the host adapter supports credential export (the live extension, not demo).
```

- [ ] **Step 5: Add localized confirmation action labels**

Immediately after `cliExportConfirm` in each catalog, add the following two keys, retaining valid JSON commas and the catalogs' existing formatting:

```json
// packages/locales/messages/en.json
"cliExportCancel": { "message": "Cancel" },
"cliExportConfirmButton": { "message": "Confirm export" }

// packages/locales/messages/es.json
"cliExportCancel": { "message": "Cancelar" },
"cliExportConfirmButton": { "message": "Confirmar exportación" }

// packages/locales/messages/de.json
"cliExportCancel": { "message": "Abbrechen" },
"cliExportConfirmButton": { "message": "Export bestätigen" }

// packages/locales/messages/fr.json
"cliExportCancel": { "message": "Annuler" },
"cliExportConfirmButton": { "message": "Confirmer l’exportation" }

// packages/locales/messages/it.json
"cliExportCancel": { "message": "Annulla" },
"cliExportConfirmButton": { "message": "Conferma esportazione" }

// packages/locales/messages/pt_BR.json
"cliExportCancel": { "message": "Cancelar" },
"cliExportConfirmButton": { "message": "Confirmar exportação" }

// packages/locales/messages/ru.json
"cliExportCancel": { "message": "Отмена" },
"cliExportConfirmButton": { "message": "Подтвердить экспорт" }

// packages/locales/messages/zh_CN.json
"cliExportCancel": { "message": "取消" },
"cliExportConfirmButton": { "message": "确认导出" }

// packages/locales/messages/hi.json
"cliExportCancel": { "message": "रद्द करें" },
"cliExportConfirmButton": { "message": "निर्यात की पुष्टि करें" }

// packages/locales/messages/ar.json
"cliExportCancel": { "message": "إلغاء" },
"cliExportConfirmButton": { "message": "تأكيد التصدير" }
```

Use each catalog's normal expanded representation in the actual files:

```json
"cliExportCancel": {
  "message": "Cancel"
},
"cliExportConfirmButton": {
  "message": "Confirm export"
},
```

- [ ] **Step 6: Run the focused test and verify it passes**

Run:

```bash
pnpm --filter @lurkloot/extension test -- settingsCredentialExport.test.tsx
```

Expected: both tests PASS; the callback runs once only after explicit confirmation, cancellation restores the initial state, remounting starts unarmed, and the native `confirm` spy remains unused.

- [ ] **Step 7: Run repository verification proportional to the popup and locale change**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build:site
```

Expected: all workspace typechecks pass, the full extension Vitest suite passes, and the Astro site builds with the shared popup UI and updated locale catalogs.

- [ ] **Step 8: Inspect the final diff and commit the implementation**

Run:

```bash
git diff --check
git diff -- packages/popup-ui/src/settings.tsx packages/popup-ui/src/Popup.tsx packages/extension/tests/settingsCredentialExport.test.tsx packages/locales/messages
git status --short
```

Expected: no whitespace errors; only the scoped popup UI, test, and locale changes are present in addition to any pre-existing user changes.

Commit only these implementation files:

```bash
git add packages/popup-ui/src/settings.tsx packages/popup-ui/src/Popup.tsx packages/extension/tests/settingsCredentialExport.test.tsx packages/locales/messages/en.json packages/locales/messages/es.json packages/locales/messages/de.json packages/locales/messages/fr.json packages/locales/messages/it.json packages/locales/messages/pt_BR.json packages/locales/messages/ru.json packages/locales/messages/zh_CN.json packages/locales/messages/hi.json packages/locales/messages/ar.json
git commit -m "fix(popup): replace credential export browser dialog"
```
