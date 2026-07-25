# Tabless Fallback Failure Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted 1–10 setting, defaulting to 5, that independently controls how many consecutive tabless heartbeat failures occur before Lurkloot opens a watch tab.

**Architecture:** The setting belongs to the shared `EngineSettings` contract so every core host receives the same normalized policy. The background heartbeat loop triggers a scheduler tick at the threshold, and the scheduler uses the same threshold to choose the sticky tab fallback; `offlineRetryLimit` remains exclusive to channel and playback health. The popup exposes the value through the existing advanced settings registry, while Client-Integrity capture remains an immediate, separately tested page-context operation.

**Tech Stack:** TypeScript 7, React 19, Vitest, pnpm workspace, JSON locale catalogs.

## Global Constraints

- Name the setting `tablessFallbackFailureLimit`.
- Default to `5`; normalize to an integer from `1` through `10`.
- Do not add a settings migration; missing values must default through `mergeEngineSettings`.
- Do not change heartbeat cadence, offline detection, playback-health thresholds, or sticky fallback semantics.
- Do not change `ensureTwitchIntegrityWithBrowser`; a missing token must open or reuse Twitch page context immediately.
- Keep all eleven locale catalogs in key parity.
- Follow test-driven development and run `pnpm verify` before completion.

---

### Task 1: Shared settings contract and normalization

**Files:**
- Modify: `packages/shared/src/models.ts:136-149,306-346`
- Modify: `packages/shared/src/settings.ts:22-75,105-170`
- Test: `packages/extension/tests/settings.test.ts:139-150`
- Test: `packages/extension/tests/backgroundController.test.ts:1270-1290`

**Interfaces:**
- Consumes: existing `clampInteger(value, min, max, fallback): number`.
- Produces: `EngineSettings.tablessFallbackFailureLimit: number`, defaulted and normalized by `DEFAULT_ENGINE_SETTINGS` and `mergeEngineSettings`.

- [ ] **Step 1: Write failing normalization tests**

Extend the numeric-settings test with explicit default, clamp, rounding, and independence assertions:

```ts
expect(DEFAULT_ENGINE_SETTINGS.tablessFallbackFailureLimit).toBe(5);
expect(mergeEngineSettings({}).tablessFallbackFailureLimit).toBe(5);
expect(mergeEngineSettings({ tablessFallbackFailureLimit: 0 }).tablessFallbackFailureLimit).toBe(1);
expect(mergeEngineSettings({ tablessFallbackFailureLimit: 11 }).tablessFallbackFailureLimit).toBe(10);
expect(mergeEngineSettings({ tablessFallbackFailureLimit: 4.6 }).tablessFallbackFailureLimit).toBe(5);
expect(mergeEngineSettings({ tablessFallbackFailureLimit: Number.NaN }).tablessFallbackFailureLimit).toBe(5);
expect(mergeEngineSettings({
  offlineRetryLimit: 9,
  tablessFallbackFailureLimit: 2,
})).toMatchObject({
  offlineRetryLimit: 9,
  tablessFallbackFailureLimit: 2,
});
```

In the controller save-settings test, include an invalid incoming value and assert the normalized value is persisted in the harness:

```ts
const nextSettings = {
  ...DEFAULT_SETTINGS,
  running: true,
  pollIntervalMinutes: Number.NaN,
  offlineRetryLimit: 0,
  tablessFallbackFailureLimit: 99,
};
// after handleMessage(...)
expect(env.settings.tablessFallbackFailureLimit).toBe(10);
expect(env.deps.saveSettings).toHaveBeenCalledWith(
  expect.objectContaining({ tablessFallbackFailureLimit: 10 }),
);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/settings.test.ts tests/backgroundController.test.ts
```

Expected: TypeScript/runtime assertions fail because `tablessFallbackFailureLimit` is absent.

- [ ] **Step 3: Add the shared setting**

Add the field beside `offlineRetryLimit` in `EngineSettings`, documenting that it counts consecutive failed tabless heartbeats. Update the `WatchSession.heartbeatChecks` comment to name `tablessFallbackFailureLimit`.

Add the default:

```ts
offlineRetryLimit: 3,
tablessFallbackFailureLimit: 5,
pollIntervalMinutes: 1,
```

Normalize it:

```ts
offlineRetryLimit: clampInteger(value?.offlineRetryLimit, 1, 10, DEFAULT_ENGINE_SETTINGS.offlineRetryLimit),
tablessFallbackFailureLimit: clampInteger(
  value?.tablessFallbackFailureLimit,
  1,
  10,
  DEFAULT_ENGINE_SETTINGS.tablessFallbackFailureLimit,
),
```

- [ ] **Step 4: Run the focused tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/settings.test.ts tests/backgroundController.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit the shared contract**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/extension/tests/settings.test.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(settings): add tabless fallback failure limit"
```

---

### Task 2: Scheduler and heartbeat fallback behavior

**Files:**
- Modify: `packages/core/src/core/scheduler.ts:51-66`
- Modify: `packages/core/src/background/controller.ts:730-820`
- Test: `packages/extension/tests/scheduler.test.ts:2757-2848`
- Test: `packages/extension/tests/backgroundController.test.ts:2570-2610`

**Interfaces:**
- Consumes: normalized `EngineSettings.tablessFallbackFailureLimit`.
- Produces: consistent controller trigger and scheduler fallback decisions based only on that setting.

- [ ] **Step 1: Write failing scheduler threshold tests**

Refactor the existing fallback fixture into a local helper that accepts `heartbeatChecks` and settings overrides, then cover below/at threshold and independence:

```ts
it("stays tabless below its configured fallback threshold", async () => {
  const { result, twitch } = await runTablessFallbackCase(4, {
    offlineRetryLimit: 1,
    tablessFallbackFailureLimit: 5,
  });
  expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
  expect(result.state.sessions.twitch.watchMode).toBe("tabless");
});

it("falls back exactly at its configured fallback threshold", async () => {
  const { result, twitch } = await runTablessFallbackCase(5, {
    offlineRetryLimit: 10,
    tablessFallbackFailureLimit: 5,
  });
  expect(twitch.prepareWatchTab).toHaveBeenCalledOnce();
  expect(result.state.sessions.twitch).toMatchObject({
    watchMode: "tab",
    tablessFallback: true,
  });
});

it("honors a non-default tabless fallback threshold", async () => {
  const { result } = await runTablessFallbackCase(2, {
    offlineRetryLimit: 9,
    tablessFallbackFailureLimit: 2,
  });
  expect(result.state.sessions.twitch.watchMode).toBe("tab");
});
```

The helper must build the same healthy-auth, same-channel state used by the current fallback test and return `{ result, twitch }`.

- [ ] **Step 2: Update the controller test to fail on the old coupling**

Change the existing heartbeat fallback test to use deliberately different values:

```ts
const env = tablessEnv({
  offlineRetryLimit: 1,
  tablessFallbackFailureLimit: 2,
});
```

Keep the assertion that the first failed heartbeat does not prepare a tab and the second does. This fails while the controller still reads `offlineRetryLimit`.

- [ ] **Step 3: Run focused tests and verify the threshold assertions fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/scheduler.test.ts tests/backgroundController.test.ts
```

Expected: the below-threshold scheduler case and first controller heartbeat fall back too early.

- [ ] **Step 4: Replace only tabless fallback reads**

In `chooseTablessWatch`:

```ts
if (
  sameChannel
  && previous.watchMode === "tabless"
  && (previous.heartbeatChecks ?? 0) >= settings.tablessFallbackFailureLimit
) return false;
```

In `runWatchHeartbeat`:

```ts
if (
  !ok
  && heartbeatChecks >= settings.tablessFallbackFailureLimit
  && !fallbacks.includes(platform)
) {
  fallbacks.push(platform);
  emit({ category: "diagnostic", platform, level: "warn", message: "Tabless watch heartbeat keeps failing; falling back to a watch tab" });
}
```

Update the nearby controller comment to say that `chooseTablessWatch` sees checks past the tabless fallback limit. Confirm with:

```bash
rg -n "offlineRetryLimit" packages/core/src/core/scheduler.ts packages/core/src/background/controller.ts
```

Every remaining match must concern offline or playback health, not tabless heartbeat fallback.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/scheduler.test.ts tests/backgroundController.test.ts
```

Expected: both files pass.

- [ ] **Step 6: Commit runtime behavior**

```bash
git add packages/core/src/core/scheduler.ts packages/core/src/background/controller.ts packages/extension/tests/scheduler.test.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(scheduler): honor tabless fallback threshold"
```

---

### Task 3: Advanced popup control and localization

**Files:**
- Modify: `packages/popup-ui/src/settingsRegistry.tsx:260-310`
- Modify: `packages/locales/messages/{en,es,fr,it,ru,de,zh_CN,hi,pt_BR,ar,tr}.json`
- Test: `packages/extension/tests/settingsRegistry.test.ts:110-165`
- Test: `packages/extension/tests/settingsView.test.tsx:19-105,130-190`
- Test: `packages/extension/tests/settingsSearchView.test.tsx:11-90,170-205`
- Test: `packages/extension/tests/i18n.test.ts:45-62`

**Interfaces:**
- Consumes: `ExtensionSettings.tablessFallbackFailureLimit` and existing `NumberSettingRow`.
- Produces: registry entry `general.advanced.tablessFallbackFailureLimit` plus locale keys `tablessFallbackFailureLimitTitle`, `tablessFallbackFailureLimitDescription`, `tablessFallbackFailureLimitDisabledReason`, and `failuresSuffix`.

- [ ] **Step 1: Write failing registry and render tests**

Add the registry ID immediately after `general.advanced.pollInterval` in the stable tree snapshot:

```ts
"general.advanced.pollInterval",
"general.advanced.tablessFallbackFailureLimit",
"general.advanced.postClaimHandoff",
```

Add these labels to both view-test label maps:

```ts
tablessFallbackFailureLimitTitle: "Tabless fallback threshold",
tablessFallbackFailureLimitDescription: "Open a video tab after this many consecutive failed tabless watch signals.",
tablessFallbackFailureLimitDisabledReason: "Enable tabless low-resource mode to change this setting.",
failuresSuffix: "failures",
```

Add a settings view test:

```ts
function setNumberInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

it("renders and saves the tabless fallback threshold", () => {
  const { container, onSettingsChange } = mountSettings();
  const input = container.querySelector(
    'input[aria-label="Tabless fallback threshold"]',
  ) as HTMLInputElement;
  expect(input.value).toBe("5");
  expect(input.min).toBe("1");
  expect(input.max).toBe("10");

  act(() => setNumberInput(input, "7"));
  expect(onSettingsChange).toHaveBeenCalledWith(
    { tablessFallbackFailureLimit: 7 },
    { tickAfterSave: true },
  );
});
```

Add a second test mounting `tablessMode: false` and asserting the same input is disabled. Add a search-view assertion that searching for `tabless fallback` reveals this advanced entry while the advanced switch remains off.

- [ ] **Step 2: Run UI tests and verify they fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/settingsRegistry.test.ts tests/settingsView.test.tsx tests/settingsSearchView.test.tsx
```

Expected: the registry snapshot and control queries fail because the entry does not exist.

- [ ] **Step 3: Add the registry entry**

Insert after the scheduler interval:

```tsx
{
  id: "general.advanced.tablessFallbackFailureLimit",
  titleKey: "tablessFallbackFailureLimitTitle",
  descriptionKey: "tablessFallbackFailureLimitDescription",
  render: () => (
    <NumberSettingRow
      title={t("tablessFallbackFailureLimitTitle")}
      description={t("tablessFallbackFailureLimitDescription")}
      value={settings.tablessFallbackFailureLimit}
      min={1}
      max={10}
      suffix={t("failuresSuffix")}
      disabled={!settings.tablessMode}
      disabledReason={t("tablessFallbackFailureLimitDisabledReason")}
      onChange={(value) => void onSettingsChange(
        { tablessFallbackFailureLimit: value },
        { tickAfterSave: true },
      )}
    />
  ),
},
```

- [ ] **Step 4: Add localized copy to every catalog**

Keep the keys beside the existing `tablessTitle`/`tablessDescription` entries
in every catalog. Use these exact messages:

| Locale | Title | Description | Disabled reason | Suffix |
|---|---|---|---|---|
| `en` | Tabless fallback threshold | Open a video tab after this many consecutive failed tabless watch signals. | Enable tabless low-resource mode to change this setting. | failures |
| `es` | Umbral de cambio desde el modo sin pestañas | Abre una pestaña de vídeo después de esta cantidad de señales de visualización sin pestañas fallidas consecutivas. | Activa el modo de bajo consumo sin pestañas para cambiar este ajuste. | fallos |
| `fr` | Seuil de repli du mode sans onglet | Ouvre un onglet vidéo après ce nombre d’échecs consécutifs des signaux de visionnage sans onglet. | Activez le mode basse consommation sans onglet pour modifier ce réglage. | échecs |
| `it` | Soglia di fallback della modalità senza schede | Apre una scheda video dopo questo numero di segnali di visione senza schede falliti consecutivamente. | Attiva la modalità a basso consumo senza schede per modificare questa impostazione. | errori |
| `ru` | Порог перехода из режима без вкладок | Открывает вкладку с видео после указанного числа последовательных сбоев сигналов просмотра без вкладки. | Включите ресурсосберегающий режим без вкладок, чтобы изменить эту настройку. | сбоев |
| `de` | Schwellenwert für den Tabless-Rückfall | Öffnet nach dieser Anzahl aufeinanderfolgender fehlgeschlagener Tabless-Wiedergabesignale einen Video-Tab. | Aktiviere den ressourcenschonenden Tabless-Modus, um diese Einstellung zu ändern. | Fehler |
| `zh_CN` | 无标签页回退阈值 | 连续发生这么多次无标签页观看信号失败后打开视频标签页。 | 启用无标签页低资源模式以更改此设置。 | 次失败 |
| `hi` | टैबलेस फ़ॉलबैक सीमा | लगातार इतनी टैबलेस वॉच सिग्नल विफलताओं के बाद वीडियो टैब खोलें। | यह सेटिंग बदलने के लिए कम-संसाधन टैबलेस मोड चालू करें। | विफलताएँ |
| `pt_BR` | Limite de fallback do modo sem abas | Abre uma aba de vídeo após esta quantidade de falhas consecutivas nos sinais de visualização sem abas. | Ative o modo de baixo consumo sem abas para alterar esta configuração. | falhas |
| `ar` | حد الرجوع عن وضع بلا علامات تبويب | يفتح علامة تبويب فيديو بعد هذا العدد من حالات فشل إشارات المشاهدة المتتالية بلا علامة تبويب. | فعّل وضع الموارد المنخفضة بلا علامات تبويب لتغيير هذا الإعداد. | حالات فشل |
| `tr` | Sekmesiz moddan geri dönüş eşiği | Art arda bu sayıda sekmesiz izleme sinyali başarısız olduğunda bir video sekmesi açar. | Bu ayarı değiştirmek için düşük kaynak kullanan sekmesiz modu etkinleştirin. | hata |

Map the columns respectively to
`tablessFallbackFailureLimitTitle`,
`tablessFallbackFailureLimitDescription`,
`tablessFallbackFailureLimitDisabledReason`, and `failuresSuffix`.

- [ ] **Step 5: Run UI and locale tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/settingsRegistry.test.ts tests/settingsView.test.tsx tests/settingsSearchView.test.tsx tests/i18n.test.ts
```

Expected: all four files pass, including locale key parity.

- [ ] **Step 6: Commit the popup setting**

```bash
git add packages/popup-ui/src/settingsRegistry.tsx packages/locales/messages packages/extension/tests/settingsRegistry.test.ts packages/extension/tests/settingsView.test.tsx packages/extension/tests/settingsSearchView.test.tsx packages/extension/tests/i18n.test.ts
git commit -m "feat(popup): expose tabless fallback threshold"
```

---

### Task 4: Client-Integrity exception regression and full verification

**Files:**
- Test: `packages/extension/tests/tabs.test.ts:998-1055`
- Verify only: `packages/core/src/core/tabs.ts:510-543`

**Interfaces:**
- Consumes: existing `ensureTwitchIntegrityWithBrowser(browserApi, originUrl, timeoutMs?, emit?): Promise<boolean>`.
- Produces: regression coverage proving the first missing-token invocation immediately opens Twitch page context.

- [ ] **Step 1: Add the explicit first-miss regression test**

Add this test beside the existing Client-Integrity creation test:

```ts
it("opens page context immediately on the first missing-token check", async () => {
  const browser = browserMock();
  browser.tabs.query.mockResolvedValue([]);
  browser.tabs.create.mockResolvedValue({ id: 14 });

  const pending = ensureTwitchIntegrityWithBrowser(
    browser,
    "https://www.twitch.tv/drops/inventory",
    50,
  );

  await vi.waitFor(() => {
    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
  });
  expect(browser.tabs.create).toHaveBeenCalledWith({
    url: "https://www.twitch.tv/drops/inventory",
    pinned: false,
    active: false,
  });
  await expect(pending).resolves.toBe(false);
});
```

Do not modify `ensureTwitchIntegrityWithBrowser`.

- [ ] **Step 2: Run the Client-Integrity test**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts
```

Expected: pass, demonstrating the deliberate exception remains intact.

- [ ] **Step 3: Audit the final diff**

Run:

```bash
git diff origin/develop...HEAD --check
git diff origin/develop...HEAD -- packages/core/src/core/tabs.ts
rg -n "tablessFallbackFailureLimit|offlineRetryLimit" packages/core packages/shared packages/popup-ui packages/extension/tests
git status --short
```

Expected: no whitespace errors; no production diff in `tabs.ts`; tabless fallback reads the new setting; offline/playback health retains `offlineRetryLimit`; only the intended uncommitted test remains.

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm verify
```

Expected: script tests, workspace typechecks, extension tests, site build, and Chromium/Firefox production builds all pass.

- [ ] **Step 5: Commit the regression test**

```bash
git add packages/extension/tests/tabs.test.ts
git commit -m "test(twitch): preserve immediate integrity capture"
```

- [ ] **Step 6: Confirm clean completion state**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/develop..HEAD
```

Expected: clean worktree on `feat/tabless-fallback-failure-limit` with the design, plan, and four focused implementation commits ahead of `origin/develop`.
