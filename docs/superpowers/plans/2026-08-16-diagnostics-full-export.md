# Diagnostics Full Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Diagnostics users download the complete retained diagnostic history for the selected platform as a `.log` file, while **Copy loaded** still copies only the on-screen page.

**Architecture:** A new `exportDiagnostics` runtime message reads every retained matching diagnostic from IndexedDB in one shot (no 100-row page cap, no search query). The popup formats that list with the existing `buildActivityExport` helper, adds `coverage: full`, and the extension adapter downloads a `.log` via Blob URL. Activity keeps today's **Copy log**.

**Tech Stack:** TypeScript, React, IndexedDB, Vitest, `@lurkloot/shared` messages, `@lurkloot/popup-ui`, JSON locale catalogs.

## Global Constraints

- Export is Diagnostics-only; Activity keeps **Copy log** and gains no export control.
- Platform scope matches the list: selected platform plus platform-less unscoped events; never the other platform.
- **Export all** ignores the search box; **Copy loaded** still copies the on-screen (possibly searched) list.
- File body is the same `timestamp [level] message` text as copy; export header adds `coverage: full`; clipboard text does not change.
- Filename is `lurkloot-diagnostics-{platform}-{YYYYMMDDTHHMMSSZ}.log`.
- Retention stays 2,000 diagnostic records / seven days; do not migrate IndexedDB or raise `getActivity`'s `MAX_LIMIT`.
- No new extension permissions. Core and the CLI stay untouched.
- Diagnostic line bodies stay English literals. Do not add catalog keys that start with `diagnostic` (see `diagnosticsLocale.test.ts`).
- Two-space indentation, double quotes, semicolons.

## File structure

- `packages/shared/src/messages.ts`: `exportDiagnostics` message and `DiagnosticsExport` return type.
- `packages/extension/src/core/activityStorage.ts`: one-shot `exportDiagnostics(platform)` walk.
- `packages/extension/src/core/activityMessages.ts`: route the new message.
- `packages/extension/entrypoints/background.ts`: wire the repository method.
- `packages/extension/tests/coreBoundary.test.ts`: history-API guard includes the new names.
- `packages/popup-ui/src/activity.logic.ts`: `coverage: "full"` and `.log` filename helper; export request generation.
- `packages/popup-ui/src/activity.tsx`: **Copy loaded** / **Export all** on Diagnostics.
- `packages/popup-ui/src/Popup.tsx`: send, format, download, discard stale exports.
- `packages/popup-ui/src/types.ts` / `entrypoints/popup/app.tsx`: optional `downloadFile` hook.
- `packages/popup-ui/src/demo.ts`: exhaustive `exportDiagnostics` case; omit `downloadFile`.
- `packages/locales/messages/*.json`: toolbar chrome only.
- Tests: `activityStorage.test.ts`, `activityMessages.test.ts`, `activityView.test.ts`, `activityLogView.test.tsx`, `popupDiagnosticsExport.test.tsx`.

This worktree needs `pnpm install --frozen-lockfile` once before Task 1 if `node_modules` is missing.

---

### Task 1: One-shot diagnostic export in IndexedDB

**Files:**

- Modify: `packages/extension/src/core/activityStorage.ts`
- Test: `packages/extension/tests/activityStorage.test.ts`

**Interfaces:**

- Consumes: existing `CATEGORY_INDEX`, diagnostic retention cutoff, and list platform rule (`!event.platform || event.platform === platform`).
- Produces: `ActivityRepository.exportDiagnostics(platform: Platform): Promise<ActivityHistoryRecord[]>` (newest-first, no cursor, no text query, no 100-row cap) and `exportDiagnosticsEvents(platform)` wrapper.

- [ ] **Step 1: Write the failing repository tests**

Add these cases next to the existing diagnostic search tests. Reuse `NOW` and `DAY_MS`.

```ts
it("exports every retained diagnostic for a platform without the page cap or search filter", async () => {
  await repository.append([
    ...Array.from({ length: 101 }, (_, index) => ({
      category: "diagnostic" as const,
      level: "debug" as const,
      platform: "kick" as const,
      message: `kick-${String(index).padStart(3, "0")}`,
      emittedAt: new Date(NOW.getTime() - index * 1_000).toISOString(),
    })),
    {
      category: "diagnostic",
      level: "info",
      platform: "twitch",
      message: "twitch-only",
      emittedAt: NOW.toISOString(),
    },
    {
      category: "diagnostic",
      level: "error",
      message: "global",
      emittedAt: new Date(NOW.getTime() + 1_000).toISOString(),
    },
  ]);

  const page = await repository.load({ category: "diagnostic", platform: "kick", limit: 100 });
  const searched = await repository.load({ category: "diagnostic", platform: "kick", query: "global" });
  const exported = await repository.exportDiagnostics("kick");

  expect(page.events).toHaveLength(100);
  expect(page.nextCursor).toBeDefined();
  expect(searched.events.map((event) => event.message)).toEqual(["global"]);
  expect(exported.map((event) => event.message)).toEqual([
    "global",
    ...Array.from({ length: 101 }, (_, index) => `kick-${String(index).padStart(3, "0")}`),
  ]);
  expect(exported.some((event) => event.message === "twitch-only")).toBe(false);
});

it("omits diagnostics past the seven-day cutoff from a full export", async () => {
  const eightDaysAgo = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
  await repository.importLegacy([
    { id: "old", at: eightDaysAgo, category: "diagnostic", level: "info", message: "expired", legacy: true },
    { id: "current", at: NOW.toISOString(), category: "diagnostic", level: "info", platform: "kick", message: "current", legacy: true },
  ]);

  expect((await repository.exportDiagnostics("kick")).map((event) => event.message)).toEqual(["current"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension test tests/activityStorage.test.ts`

Expected: FAIL because `exportDiagnostics` is not a function.

- [ ] **Step 3: Implement the repository walk**

Add `exportDiagnostics(platform: Platform): Promise<ActivityHistoryRecord[]>` to `ActivityRepository` and the IndexedDB class. Walk `CATEGORY_INDEX` newest-first (`"prev"`) with the diagnostic retention cutoff, the same way `load` does, but collect every platform-eligible row and stop only when the cursor ends. Do not apply `query`, `limit`, or `MAX_LIMIT`.

```ts
async exportDiagnostics(platform: Platform): Promise<ActivityHistoryRecord[]> {
  const database = await this.open();
  const transaction = database.transaction(EVENT_STORE, "readonly");
  const index = transaction.objectStore(EVENT_STORE).index(CATEGORY_INDEX);
  const cutoff = new Date(Date.now() - retentionMs("diagnostic")).toISOString();
  const range = IDBKeyRange.bound(["diagnostic", cutoff, ""], ["diagnostic", []]);
  const request = index.openCursor(range, "prev");
  const events: ActivityHistoryRecord[] = [];

  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("Could not export diagnostics"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const event = cursor.value as ActivityHistoryRecord;
      if (!event.platform || event.platform === platform) events.push(event);
      cursor.continue();
    };
  });
  await transactionDone(transaction);
  return events;
}
```

Import `Platform` from `@lurkloot/shared/models`. Export a module wrapper:

```ts
export function exportDiagnosticsEvents(platform: Platform): Promise<ActivityHistoryRecord[]> {
  return repository.exportDiagnostics(platform);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension test tests/activityStorage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/core/activityStorage.ts packages/extension/tests/activityStorage.test.ts
git commit -m "feat(activity): export full diagnostic history from indexeddb"
```

---

### Task 2: Route `exportDiagnostics` through the extension host

**Files:**

- Modify: `packages/shared/src/messages.ts`
- Modify: `packages/extension/src/core/activityMessages.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/extension/tests/coreBoundary.test.ts`
- Test: `packages/extension/tests/activityMessages.test.ts`

**Interfaces:**

- Consumes: `exportDiagnostics(platform)` from Task 1.
- Produces:

```ts
export interface DiagnosticsExport {
  events: ActivityHistoryRecord[];
}

export type RuntimeMessage =
  | CoreRuntimeMessage
  | ({ type: "getActivity" } & ActivityQuery)
  | { type: "exportDiagnostics"; platform: Platform }
  | { type: "clearActivity" }
  | { type: "resetExtension" }
  | { type: "exportCliCredentials" };
```

Handler returns `DiagnosticsExport` for that message. Dispatcher sends `exportDiagnostics` to the activity handler, never core.

- [ ] **Step 1: Write the failing message tests**

Update `createActivityMessageHandler` fixtures to include `exportDiagnostics`. Add:

```ts
it("exports diagnostics through the extension repository", async () => {
  const events = [{ id: "d1", at: "2026-08-16T00:00:00.000Z", category: "diagnostic", level: "info", message: "hello" }];
  const exportDiagnostics = vi.fn(async () => events);
  const handler = createActivityMessageHandler({
    load: vi.fn(),
    clear: vi.fn(),
    exportDiagnostics,
  });

  await expect(handler({ type: "exportDiagnostics", platform: "kick" }))
    .resolves.toEqual({ events });
  expect(exportDiagnostics).toHaveBeenCalledWith("kick");
});
```

Extend the dispatcher `it.each` list with `{ type: "exportDiagnostics", platform: "twitch" } as const`.

In `coreBoundary.test.ts`, change:

```ts
const HISTORY_API = /\b(?:ActivityPage|DiagnosticsExport|getActivity|exportDiagnostics|clearActivity|activityStorage)\b/;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension test tests/activityMessages.test.ts tests/coreBoundary.test.ts`

Expected: FAIL on missing `exportDiagnostics` in the handler/dispatcher types.

- [ ] **Step 3: Implement the contract and routing**

Add `DiagnosticsExport` and the message variant in `packages/shared/src/messages.ts`.

Widen `ActivityMessageRepository`:

```ts
interface ActivityMessageRepository {
  load(query: ActivityQuery): Promise<ActivityPage>;
  exportDiagnostics(platform: Platform): Promise<ActivityHistoryRecord[]>;
  clear(): Promise<void>;
}
```

Handle it before the `undefined` return:

```ts
if (message.type === "exportDiagnostics") {
  return { events: await repository.exportDiagnostics(message.platform) };
}
```

Return type becomes `Promise<ActivityPage | DiagnosticsExport | void | undefined>`.

Dispatcher:

```ts
if (message.type === "getActivity" || message.type === "exportDiagnostics" || message.type === "clearActivity") {
  return deps.handleActivityMessage(message);
}
```

Wire background.ts:

```ts
import { appendActivityEvents, clearActivityEvents, exportDiagnosticsEvents, loadActivityEvents } from "../src/core/activityStorage";

const handleActivityMessage = createActivityMessageHandler({
  load: loadActivityEvents,
  exportDiagnostics: exportDiagnosticsEvents,
  clear: clearActivityEvents,
});
```

Update existing handler tests that construct `{ load, clear }` so they also pass `exportDiagnostics: vi.fn()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension test tests/activityMessages.test.ts tests/coreBoundary.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/messages.ts packages/extension/src/core/activityMessages.ts packages/extension/entrypoints/background.ts packages/extension/tests/activityMessages.test.ts packages/extension/tests/coreBoundary.test.ts
git commit -m "feat(extension): route diagnostics export message"
```

---

### Task 3: Full-coverage export text and `.log` filename

**Files:**

- Modify: `packages/popup-ui/src/activity.logic.ts`
- Modify: `packages/popup-ui/src/index.ts`
- Test: `packages/extension/tests/activityView.test.ts`

**Interfaces:**

- Consumes: existing `buildActivityExport`.
- Produces:

```ts
coverage?: "full"; // on ActivityExportInput; omit for copy

export function buildDiagnosticsExportFilename(platform: Platform, at: Date): string;
```

When `coverage === "full"`, the header includes `coverage: full` after `events:`. Copy omits the field, so clipboard text is unchanged.

- [ ] **Step 1: Write the failing formatter tests**

In the existing `describe("activity export")` block:

```ts
it("adds coverage: full only when requested", () => {
  const events = [{
    id: "a",
    at: "2026-07-14T11:00:00.000Z",
    category: "diagnostic" as const,
    level: "info" as const,
    message: "first",
  }];
  const copied = buildActivityExport({ ...exportInput, diagnostics: true, events }, t);
  const full = buildActivityExport({ ...exportInput, diagnostics: true, coverage: "full", events }, t);
  const empty = buildActivityExport({ ...exportInput, diagnostics: true, coverage: "full", events: [] }, t);

  expect(copied).not.toContain("coverage:");
  expect(full.split("\n\n")[0].split("\n")).toContain("coverage: full");
  expect(full).toContain("2026-07-14T11:00:00.000Z [info] first");
  expect(empty).toContain("coverage: full");
  expect(empty).toContain("events: 0");
  expect(empty.trimEnd().endsWith("(no events)")).toBe(true);
});

it("builds a windows-safe diagnostics log filename", () => {
  expect(buildDiagnosticsExportFilename("twitch", new Date("2026-08-16T14:33:27.000Z")))
    .toBe("lurkloot-diagnostics-twitch-20260816T143327Z.log");
});
```

Import `buildDiagnosticsExportFilename` from `@lurkloot/popup-ui`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension test tests/activityView.test.ts`

Expected: FAIL because `coverage` is ignored and the filename helper is missing.

- [ ] **Step 3: Implement formatter and filename**

```ts
export interface ActivityExportInput {
  events: readonly ActivityHistoryRecord[];
  platform: Platform;
  diagnostics: boolean;
  version: string;
  userAgent: string;
  locale: string;
  at: string;
  coverage?: "full";
}

export function buildActivityExport(input: ActivityExportInput, t: TFunction): string {
  const header = [
    `Lurkloot ${input.diagnostics ? "diagnostics" : "activity"} log`,
    `version: ${input.version}`,
    `platform: ${input.platform}`,
    `locale: ${input.locale}`,
    `exported: ${input.at}`,
    `browser: ${input.userAgent}`,
    `events: ${input.events.length}`,
    ...(input.coverage === "full" ? ["coverage: full"] : []),
  ].join("\n");
  // body unchanged
}

export function buildDiagnosticsExportFilename(platform: Platform, at: Date): string {
  const stamp = at.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
  return `lurkloot-diagnostics-${platform}-${stamp}.log`;
}
```

Re-export `buildDiagnosticsExportFilename` from `packages/popup-ui/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension test tests/activityView.test.ts`

Expected: PASS. Existing copy tests still have no `coverage:` line.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/activity.logic.ts packages/popup-ui/src/index.ts packages/extension/tests/activityView.test.ts
git commit -m "feat(popup): mark full diagnostic log coverage"
```

---

### Task 4: Diagnostics toolbar — Copy loaded and Export all

**Files:**

- Modify: `packages/popup-ui/src/activity.tsx`
- Modify: every `packages/locales/messages/*.json`
- Test: `packages/extension/tests/activityLogView.test.tsx`

**Interfaces:**

- Consumes: locale keys below; optional `onExportAll(): Promise<number | undefined>`.
- Produces: Diagnostics shows **Copy loaded** and **Export all**; Activity still shows **Copy log** and no export control. `onExportAll` missing hides **Export all**. Returning `undefined` is a stale no-op (no success, no error). Throwing shows **Could not export the log. Try again.** Success shows **Exported N events** for 2500ms.

Locale keys (must not start with `diagnostic`):

| key | en |
| --- | --- |
| `copyLoadedActivityLog` | Copy loaded |
| `exportAllDiagnostics` | Export all |
| `exportAllDiagnosticsDone` | Exported $1 events |
| `exportAllDiagnosticsFailed` | Could not export the log. Try again. |

Add the same four keys to `ar`, `de`, `es`, `fr`, `hi`, `it`, `pt_BR`, `ru`, `tr`, `zh_CN`:

- de: `Geladene kopieren` / `Alle exportieren` / `$1 Ereignisse exportiert` / `Protokoll konnte nicht exportiert werden. Bitte erneut versuchen.`
- es: `Copiar cargados` / `Exportar todo` / `$1 eventos exportados` / `No se pudo exportar el registro. Inténtalo de nuevo.`
- fr: `Copier la page` / `Tout exporter` / `$1 événements exportés` / `Impossible d'exporter le journal. Réessayez.`
- it: `Copia caricati` / `Esporta tutto` / `$1 eventi esportati` / `Impossibile esportare il registro. Riprova.`
- pt_BR: `Copiar carregados` / `Exportar tudo` / `$1 eventos exportados` / `Não foi possível exportar o registro. Tente novamente.`
- ru: `Копировать загруженное` / `Экспортировать всё` / `Экспортировано событий: $1` / `Не удалось экспортировать журнал. Попробуйте снова.`
- tr: `Yüklenenleri kopyala` / `Tümünü dışa aktar` / `$1 olay dışa aktarıldı` / `Günlük dışa aktarılamadı. Yeniden deneyin.`
- zh_CN: `复制已加载` / `全部导出` / `已导出 $1 条` / `无法导出日志。请重试。`
- ar: `نسخ المحمّل` / `تصدير الكل` / `تم تصدير $1 من الإدخالات` / `تعذر تصدير السجل. حاول مرة أخرى.`
- hi: `लोड की गई कॉपी करें` / `सभी निर्यात करें` / `$1 इवेंट निर्यात किए गए` / `लॉग निर्यात नहीं हो सका। फिर से कोशिश करें.`

Place them next to `copyActivityLog*` in each catalog.

- [ ] **Step 1: Write the failing view tests**

Extend the `ActivityLog` mount helper with `onExportAll?` and `searchQuery?` / `searchingDiagnostics?`. Add the four strings to the `t()` map. Change `copyButton` to also match `"Copy loaded"`. Add:

```ts
const exportButton = (container: Element) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("Export all") || button.textContent?.includes("Exported"));
```

```ts
it("relabels copy and offers export all only in diagnostics", () => {
  const activity = mount({ showDiagnostics: false, onExportAll: vi.fn(async () => 0) });
  expect(copyButton(activity.container)?.textContent).toContain("Copy log");
  expect(exportButton(activity.container)).toBeUndefined();

  act(() => root?.unmount());
  const diagnostics = mount({ showDiagnostics: true, onExportAll: vi.fn(async () => 0) });
  expect(copyButton(diagnostics.container)?.textContent).toContain("Copy loaded");
  expect(exportButton(diagnostics.container)?.textContent).toContain("Export all");
});

it("hides export all when the host cannot download a file", () => {
  const { container } = mount({ showDiagnostics: true });
  expect(exportButton(container)).toBeUndefined();
});

it("keeps export all enabled when search has no matches", () => {
  const { container } = mount({
    showDiagnostics: true,
    diagnosticEvents: [],
    searchQuery: "timeout",
    searchingDiagnostics: true,
    onExportAll: vi.fn(async () => 0),
  });
  expect(exportButton(container)?.disabled).toBe(false);
});

it("exports through onExportAll and confirms the count", async () => {
  const onExportAll = vi.fn(async () => 12);
  const { container } = mount({ showDiagnostics: true, onExportAll });

  await act(async () => { exportButton(container)?.click(); });

  expect(onExportAll).toHaveBeenCalledOnce();
  expect(exportButton(container)?.textContent).toContain("Exported 12 events");
});

it("reports a failed export instead of confirming", async () => {
  const { container } = mount({
    showDiagnostics: true,
    onExportAll: vi.fn(async () => { throw new Error("nope"); }),
  });

  await act(async () => { exportButton(container)?.click(); });

  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not export the log. Try again.");
  expect(exportButton(container)?.textContent).toContain("Export all");
});

it("treats an undefined export result as a stale no-op", async () => {
  const { container } = mount({
    showDiagnostics: true,
    onExportAll: vi.fn(async () => undefined),
  });

  await act(async () => { exportButton(container)?.click(); });

  expect(exportButton(container)?.textContent).toContain("Export all");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
```

Pass `searchQuery` / `searchingDiagnostics` through to `ActivityLog` in the mount helper. Existing diagnostics copy test still uses `copyButton` and should keep working after the finder accepts **Copy loaded**.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension test tests/activityLogView.test.tsx tests/i18n.test.ts tests/diagnosticsLocale.test.ts`

Expected: FAIL because the export control and new keys are missing.

- [ ] **Step 3: Implement the toolbar and catalogs**

Add optional props to `ActivityLog`:

```ts
onExportAll?(): Promise<number | undefined>;
```

Keep `copied` / `copyFailed` as today. Add `exported: number | null`, `exportFailed`, `exporting`. Reset `exported` / `exportFailed` in the same `useEffect` that clears copy on `showDiagnostics` / `platform`. Reuse `COPY_FEEDBACK_MS` for export confirmation.

Copy label: `t(showDiagnostics ? "copyLoadedActivityLog" : "copyActivityLog")`.

Render **Export all** only when `showDiagnostics && onExportAll`. Disable it while `exporting`. Do not disable it for an empty list. On click:

```ts
async function exportAll(): Promise<void> {
  if (!onExportAll || exporting) return;
  setExporting(true);
  setExportFailed(false);
  setCopied(null);
  try {
    const count = await onExportAll();
    setExported(count ?? null);
  } catch {
    setExportFailed(true);
    setExported(null);
  } finally {
    setExporting(false);
  }
}
```

Show `exportAllDiagnosticsFailed` in an alert the same way as copy failure. Import `Download` from `lucide-react` for the idle export icon (use `Check` while confirmed), matching the copy button's `Clipboard` / `Check` pair.

Add the four keys to every locale catalog.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension test tests/activityLogView.test.tsx tests/i18n.test.ts tests/diagnosticsLocale.test.ts`

Expected: PASS. `diagnosticsLocale` stays green because none of the new keys start with `diagnostic`.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/activity.tsx packages/extension/tests/activityLogView.test.tsx packages/locales/messages
git commit -m "feat(popup): add diagnostics export all control"
```

---

### Task 5: Download the full log from the popup

**Files:**

- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/activity.logic.ts`
- Modify: `packages/popup-ui/src/index.ts`
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/popup-ui/src/demo.ts`
- Modify: `packages/extension/entrypoints/popup/app.tsx`
- Test: `packages/extension/tests/activityView.test.ts`
- Create: `packages/extension/tests/popupDiagnosticsExport.test.tsx`

**Interfaces:**

- Consumes: `DiagnosticsExport` (Task 2), `buildActivityExport` / `buildDiagnosticsExportFilename` (Task 3), `onExportAll` (Task 4).
- Produces:

```ts
downloadFile?(filename: string, contents: string, mimeType?: string): void;

export type DiagnosticsExportRequest = { generation: number; platform: Platform };
export function createDiagnosticsExportRequest(platform: Platform): DiagnosticsExportRequest;
export function beginDiagnosticsExport(current: DiagnosticsExportRequest, platform: Platform): DiagnosticsExportRequest;
export function isDiagnosticsExportCurrent(request: DiagnosticsExportRequest, current: DiagnosticsExportRequest): boolean;
```

`createDiagnosticsExportRequest` starts at `generation: 0`. `beginDiagnosticsExport` returns `{ generation: current.generation + 1, platform }`. Current means both generation and platform match.

Demo omits `downloadFile` and handles `exportDiagnostics` with `{ events: [] }`.

- [ ] **Step 1: Write the failing request-scope and popup tests**

In `activityView.test.ts`:

```ts
it("does not treat a previous platform's diagnostics export as current", () => {
  expect(isDiagnosticsExportCurrent(
    { generation: 1, platform: "kick" },
    { generation: 1, platform: "twitch" },
  )).toBe(false);
  expect(isDiagnosticsExportCurrent(
    { generation: 1, platform: "kick" },
    { generation: 2, platform: "kick" },
  )).toBe(false);
  expect(isDiagnosticsExportCurrent(
    { generation: 2, platform: "kick" },
    { generation: 2, platform: "kick" },
  )).toBe(true);
});
```

Create `packages/extension/tests/popupDiagnosticsExport.test.tsx` with the same `linkedom`, `@lurkloot/locales`, and `motion/react` mocks as `tests/popupActivitySearchRequests.test.tsx`, plus `waitForCatalog`, `waitForMessage`, and `waitForElement`.

```ts
async function mount(options?: {
  downloadFile?: (filename: string, contents: string, mimeType?: string) => void;
  pendingExport?: { finish?: (value: DiagnosticsExport) => void };
}): Promise<{ container: HTMLElement; sent: RuntimeMessage[]; downloadFile: ReturnType<typeof vi.fn> }> {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(Date.now());
    return 1;
  });
  const demo = createDemoPopupAdapter();
  const sent: RuntimeMessage[] = [];
  const downloadFile = options?.downloadFile ?? vi.fn();
  const adapter: PopupAdapter = {
    ...demo,
    downloadFile,
    getStorage: async () => ({ "popup:selectedPlatform": "twitch" }),
    send: async <T,>(message: RuntimeMessage): Promise<T> => {
      sent.push(message);
      if (message.type === "exportDiagnostics") {
        if (options?.pendingExport) {
          return await new Promise<DiagnosticsExport>((resolve) => {
            options.pendingExport!.finish = resolve;
          }) as T;
        }
        return {
          events: [{
            id: "d1",
            at: "2026-08-16T00:00:00.000Z",
            category: "diagnostic",
            level: "info",
            platform: "twitch",
            message: "full history line",
          }],
        } as T;
      }
      return demo.send<T>(message);
    },
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
  });
  await waitForCatalog();
  const openActivity = container.querySelector<HTMLButtonElement>('button[aria-label="Open activity"]');
  if (!openActivity) throw new Error("Missing activity button");
  await act(async () => openActivity.click());
  const diagnosticsTab = await waitForElement(() =>
    container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]') ?? undefined);
  await act(async () => diagnosticsTab.click());
  return { container, sent, downloadFile: downloadFile as ReturnType<typeof vi.fn> };
}

it("requests a full diagnostics export for the selected platform and downloads a .log", async () => {
  const { container, sent, downloadFile } = await mount();
  const exportAll = await waitForElement(() =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Export all"));
  await act(async () => exportAll.click());
  const request = await waitForMessage(sent, (message) => message.type === "exportDiagnostics");
  expect(request).toEqual({ type: "exportDiagnostics", platform: "twitch" });
  expect(downloadFile).toHaveBeenCalledOnce();
  const [filename, contents, mimeType] = downloadFile.mock.calls[0];
  expect(filename).toMatch(/^lurkloot-diagnostics-twitch-\d{8}T\d{6}Z\.log$/);
  expect(contents).toContain("coverage: full");
  expect(contents).toContain("full history line");
  expect(mimeType).toBe("text/plain");
});

it("does not download a stale export after the platform changes", async () => {
  const pendingExport: { finish?: (value: DiagnosticsExport) => void } = {};
  const { container, downloadFile } = await mount({ pendingExport });
  const exportAll = await waitForElement(() =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Export all"));
  await act(async () => exportAll.click());
  const kick = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("Kick"));
  await act(async () => kick?.click());
  await act(async () => {
    pendingExport.finish?.({
      events: [{
        id: "late",
        at: "2026-08-16T00:00:00.000Z",
        category: "diagnostic",
        level: "info",
        message: "late",
      }],
    });
  });
  expect(downloadFile).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension test tests/activityView.test.ts tests/popupDiagnosticsExport.test.tsx`

Expected: FAIL because the request helpers, `downloadFile`, and Popup wiring are missing.

- [ ] **Step 3: Implement adapter, request generation, and Popup wiring**

`packages/popup-ui/src/types.ts` — next to `writeClipboard`:

```ts
  // Optional: download a text file from the popup. The live extension implements
  // it with a Blob URL; hosts that omit it (the site demo) hide Export all.
  downloadFile?(filename: string, contents: string, mimeType?: string): void;
```

`packages/extension/entrypoints/popup/app.tsx` — next to `exportSettings`:

```ts
    downloadFile: (filename, contents, mimeType = "text/plain") => {
      const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
```

In `activity.logic.ts`:

```ts
export type DiagnosticsExportRequest = { generation: number; platform: Platform };

export function createDiagnosticsExportRequest(platform: Platform): DiagnosticsExportRequest {
  return { generation: 0, platform };
}

export function beginDiagnosticsExport(
  current: DiagnosticsExportRequest,
  platform: Platform,
): DiagnosticsExportRequest {
  return { generation: current.generation + 1, platform };
}

export function isDiagnosticsExportCurrent(
  request: DiagnosticsExportRequest,
  current: DiagnosticsExportRequest,
): boolean {
  return request.generation === current.generation && request.platform === current.platform;
}
```

Re-export those three functions and the type from `index.ts`.

`demo.ts`: add `DiagnosticsExport` to the `handleDemoMessage` return union and:

```ts
    case "exportDiagnostics":
      return { events: [] };
```

Do not add `downloadFile` on the demo adapter.

`Popup.tsx`:

- Import `DiagnosticsExport` from `@lurkloot/shared/messages`.
- Import `beginDiagnosticsExport`, `buildActivityExport`, `buildDiagnosticsExportFilename`, `createDiagnosticsExportRequest`, `isDiagnosticsExportCurrent`.
- Keep `const diagnosticsExportRequestRef = useRef(createDiagnosticsExportRequest(platform));` (not the diagnostic list mutation sequence).
- Implement:

```ts
async function exportDiagnosticsLog(): Promise<number | undefined> {
  const downloadFile = adapter.downloadFile;
  if (!downloadFile) return undefined;
  const request = beginDiagnosticsExport(diagnosticsExportRequestRef.current, platform);
  diagnosticsExportRequestRef.current = request;
  const exportedAt = new Date();
  const result = await adapter.send<DiagnosticsExport>({ type: "exportDiagnostics", platform: request.platform });
  if (!isDiagnosticsExportCurrent(request, diagnosticsExportRequestRef.current)) return undefined;
  downloadFile(
    buildDiagnosticsExportFilename(request.platform, exportedAt),
    buildActivityExport({
      events: result.events,
      platform: request.platform,
      diagnostics: true,
      coverage: "full",
      version: adapter.version,
      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      locale,
      at: exportedAt.toISOString(),
    }, t),
    "text/plain",
  );
  return result.events.length;
}
```

Pass `onExportAll={adapter.downloadFile ? exportDiagnosticsLog : undefined}` to `ActivityLog`. On platform change (`selectPlatform`) and when leaving Diagnostics / Activity (`handleShowDiagnosticsChange`, `closeActivityView`), bump the export request with `beginDiagnosticsExport` so an in-flight download is discarded.

If `adapter.send` throws, let it reject so `ActivityLog` shows the failure alert.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension test tests/activityView.test.ts tests/popupDiagnosticsExport.test.tsx tests/activityLogView.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/types.ts packages/popup-ui/src/activity.logic.ts packages/popup-ui/src/index.ts packages/popup-ui/src/Popup.tsx packages/popup-ui/src/demo.ts packages/extension/entrypoints/popup/app.tsx packages/extension/tests/activityView.test.ts packages/extension/tests/popupDiagnosticsExport.test.tsx
git commit -m "feat(popup): download full diagnostic history"
```

---

### Task 6: Verify the integrated feature

- [ ] **Step 1: Type-check**

Run: `pnpm typecheck`

Expected: PASS with no TypeScript errors. `handleDemoMessage` stays exhaustive after `exportDiagnostics`.

- [ ] **Step 2: Run extension tests**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 3: Build the popup-consuming site**

Run: `pnpm build:site`

Expected: PASS; any existing Vite chunk-size advisory remains a warning.

- [ ] **Step 4: Check the final diff**

Run: `git diff origin/develop...HEAD --check && git status --short`

Expected: no whitespace errors; only the feature, tests, locales, and the already-committed spec/plan.
