# Translation Contribution Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a localized extension-popup tip that links users to an in-repository guide for submitting translation improvements.

**Architecture:** The existing `TipsBanner` receives one more descriptor and consumes a named GitHub guide URL constant. Two new keys are added to every locale catalog. A Markdown guide describes the focused contribution flow; tests assert the action is safe, the guide exists, and localization parity remains complete.

**Tech Stack:** TypeScript, React, Vitest, JSON message catalogs, Markdown, pnpm.

## Global Constraints

- Render the new content only through the existing extension popup `TipsBanner`; do not alter any Astro site page or component.
- The tip text and its action must be naturally translated in all eleven catalogs.
- Diagnostics remain English literals and are not translation keys.
- The guide URL must be `https://github.com/jamezrin/lurkloot/blob/main/docs/translations.md`.
- The guide is English and must direct pull requests to `develop`.
- Preserve strict TypeScript, two-space indentation, double quotes, semicolons, and existing safe external-link attributes.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `docs/translations.md` | Contributor-facing process for correcting catalog translations and submitting a PR. |
| `packages/popup-ui/src/constants.ts` | Stable GitHub URL for the contributor guide. |
| `packages/popup-ui/src/tips.tsx` | Descriptor that includes the guide tip in popup rotation. |
| `packages/locales/messages/*.json` | Localized tip text and localized action label. |
| `packages/extension/tests/tips.test.ts` | Regression coverage for the guide, its safe rendered link, and locale-key parity. |

### Task 1: Guide and regression tests

**Files:**
- Create: `docs/translations.md`
- Modify: `packages/extension/tests/tips.test.ts:1-104`

**Interfaces:**
- Consumes: existing `TipsBanner`, `I18nContext`, and catalog files.
- Produces: test requirements for `GITHUB_TRANSLATION_GUIDE_URL`, `tipTranslations`, `tipTranslationsAction`, and the guide headings used by contributors.

- [ ] **Step 1: Write the failing tests**

Add `readFileSync` expectations after the existing external-action test and add the two keys to `requiredKeys`:

```ts
it("links the localized translation tip to the contributor guide", () => {
  const html = renderToStaticMarkup(createElement(
    I18nContext.Provider,
    { value: { t: (key: string) => key, dir: "ltr", locale: "en" } },
    createElement(TipsBanner, { initialIndex: 8 }),
  ));

  expect(html).toContain("tipTranslations");
  expect(html).toContain("tipTranslationsAction");
  expect(html).toContain("https://github.com/jamezrin/lurkloot/blob/main/docs/translations.md");
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noreferrer"');
});

it("documents the translation contribution workflow", () => {
  const guide = readFileSync(resolve(import.meta.dirname, "../../../docs/translations.md"), "utf8");
  expect(guide).toContain("# Improving translations");
  expect(guide).toContain("packages/locales/messages/");
  expect(guide).toContain("pnpm --filter @lurkloot/extension test -- tips.test.ts");
  expect(guide).toContain("base branch: `develop`");
});
```

Add `"tipTranslations"` and `"tipTranslationsAction"` to the `requiredKeys` array. Update the rotation-boundary assertions from eight tips to nine: `randomTipIndex(9, () => 0.999)` must be `8`, `nextTipIndex(8, 9)` must be `0`, and `nextTipIndex(2, 9)` remains `3`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter @lurkloot/extension test -- tips.test.ts`

Expected: FAIL because the guide does not exist, the two locale keys are absent, and index `8` falls back to the first tip instead of rendering the translation action.

- [ ] **Step 3: Write the contributor guide**

Create `docs/translations.md` with this content:

```md
# Improving translations

Lurkloot's translations are maintained automatically with AI. Native speakers are welcome to improve wording, clarity, and accuracy through pull requests.

## Improve an existing translation

1. Find the locale file in `packages/locales/messages/` that you want to improve. Each file is a JSON message catalog; for example, `es.json` contains Spanish copy.
2. Edit only the message text for the key you are correcting. Keep the key name, JSON structure, placeholders such as `$1`, and product names intact. Do not translate diagnostic messages: diagnostics are English literals by design.
3. Keep the change focused on the wording you are improving. Add a new locale only when you are prepared to translate every existing message key.

## Submit a pull request

1. Fork the repository and create a branch from `develop`, for example `fix/spanish-tip-wording`.
2. Make the translation change and run `pnpm --filter @lurkloot/extension test -- tips.test.ts` from the repository root.
3. Commit using the repository's Conventional Commit format, for example `fix(locales): improve Spanish tip wording`.
4. Open a pull request from your fork to this repository with base branch: `develop`. Explain which locale and message keys you improved.

Thank you for helping make Lurkloot clearer in every language.
```

- [ ] **Step 4: Run the focused test to verify the guide assertions now pass while tip assertions still fail**

Run: `pnpm --filter @lurkloot/extension test -- tips.test.ts`

Expected: The guide-workflow test passes; the translation tip render and locale-parity checks still fail because application code and catalog entries are not present.

- [ ] **Step 5: Commit the guide and test expectations**

```bash
git add docs/translations.md packages/extension/tests/tips.test.ts
git commit -m "test(popup): cover translation contribution tip"
```

### Task 2: Localized rotating tip

**Files:**
- Modify: `packages/popup-ui/src/constants.ts:28-33`
- Modify: `packages/popup-ui/src/tips.tsx:4-24`
- Modify: `packages/locales/messages/ar.json`
- Modify: `packages/locales/messages/de.json`
- Modify: `packages/locales/messages/en.json`
- Modify: `packages/locales/messages/es.json`
- Modify: `packages/locales/messages/fr.json`
- Modify: `packages/locales/messages/hi.json`
- Modify: `packages/locales/messages/it.json`
- Modify: `packages/locales/messages/pt_BR.json`
- Modify: `packages/locales/messages/ru.json`
- Modify: `packages/locales/messages/tr.json`
- Modify: `packages/locales/messages/zh_CN.json`

**Interfaces:**
- Consumes: `TipDescriptor` (`messageKey`, optional `actionKey`, optional `href`) and existing `TipsBanner` anchor rendering.
- Produces: `GITHUB_TRANSLATION_GUIDE_URL` and the ninth `TIPS` entry: `{ messageKey: "tipTranslations", actionKey: "tipTranslationsAction", href: GITHUB_TRANSLATION_GUIDE_URL }`.

- [ ] **Step 1: Add the named guide URL and tip descriptor**

In `constants.ts`, add:

```ts
export const GITHUB_TRANSLATION_GUIDE_URL = "https://github.com/jamezrin/lurkloot/blob/main/docs/translations.md";
```

In `tips.tsx`, import that constant and append this descriptor after `tipExcludedCampaigns`:

```ts
{ messageKey: "tipTranslations", actionKey: "tipTranslationsAction", href: GITHUB_TRANSLATION_GUIDE_URL },
```

- [ ] **Step 2: Add locale messages**

Insert these entries immediately after `tipExcludedCampaigns` in every catalog, preserving the catalog's JSON formatting:

| Catalog | `tipTranslations` | `tipTranslationsAction` |
| --- | --- | --- |
| `en` | `Translations are maintained automatically with AI. Help improve them on GitHub.` | `Read the translation guide` |
| `es` | `Las traducciones se mantienen automáticamente con IA. Ayuda a mejorarlas en GitHub.` | `Leer la guía de traducción` |
| `fr` | `Les traductions sont maintenues automatiquement par IA. Aidez à les améliorer sur GitHub.` | `Lire le guide de traduction` |
| `it` | `Le traduzioni vengono gestite automaticamente con l'IA. Aiutaci a migliorarle su GitHub.` | `Leggi la guida alle traduzioni` |
| `ru` | `Переводы автоматически поддерживаются с помощью ИИ. Помогите улучшить их на GitHub.` | `Открыть руководство по переводу` |
| `de` | `Übersetzungen werden automatisch mit KI gepflegt. Hilf mit, sie auf GitHub zu verbessern.` | `Übersetzungsleitfaden lesen` |
| `zh_CN` | `翻译由 AI 自动维护。欢迎在 GitHub 上帮助改进。` | `阅读翻译指南` |
| `hi` | `अनुवादों का रखरखाव AI द्वारा स्वचालित रूप से किया जाता है। उन्हें बेहतर बनाने में GitHub पर मदद करें।` | `अनुवाद गाइड पढ़ें` |
| `pt_BR` | `As traduções são mantidas automaticamente com IA. Ajude a melhorá-las no GitHub.` | `Ler o guia de tradução` |
| `ar` | `تُصان الترجمات تلقائيًا بالذكاء الاصطناعي. ساعد في تحسينها على GitHub.` | `اقرأ دليل الترجمة` |
| `tr` | `Çeviriler yapay zekâ ile otomatik olarak güncel tutulur. GitHub'da iyileştirmeye yardımcı olun.` | `Çeviri rehberini okuyun` |

Each value has the catalog shape:

```json
"tipTranslations": { "message": "..." },
"tipTranslationsAction": { "message": "..." }
```

- [ ] **Step 3: Run the focused test to verify it passes**

Run: `pnpm --filter @lurkloot/extension test -- tips.test.ts`

Expected: PASS. The rendered ninth tip includes both localized keys, the GitHub guide URL, and the existing `target`/`rel` protections; all eleven catalogs satisfy the required-key test.

- [ ] **Step 4: Commit the implementation and translations**

```bash
git add packages/popup-ui/src/constants.ts packages/popup-ui/src/tips.tsx packages/locales/messages/*.json
git commit -m "feat(popup): link translation contribution guide"
```

### Task 3: Full verification

**Files:**
- Verify: `docs/translations.md`
- Verify: `packages/popup-ui/src/constants.ts`
- Verify: `packages/popup-ui/src/tips.tsx`
- Verify: `packages/locales/messages/*.json`
- Verify: `packages/extension/tests/tips.test.ts`

**Interfaces:**
- Consumes: committed guide, descriptor, URL, and all locale entries from Tasks 1–2.
- Produces: verified feature branch with no website-source changes.

- [ ] **Step 1: Run the complete extension test suite**

Run: `pnpm test`

Expected: PASS with all workspace tests passing.

- [ ] **Step 2: Run workspace type checking**

Run: `pnpm typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Verify scope and catalog JSON**

Run:

```bash
git diff origin/develop...HEAD --check
node -e 'for (const file of require("node:fs").readdirSync("packages/locales/messages")) if (file.endsWith(".json")) JSON.parse(require("node:fs").readFileSync(`packages/locales/messages/${file}`, "utf8"));'
git diff --name-only origin/develop...HEAD
```

Expected: no whitespace or JSON errors; changed paths are the guide, popup constants/tips, locale catalogs, tip tests, and this feature's design/plan documents — no `packages/site/` source files.

- [ ] **Step 4: Commit the implementation plan if it is not already committed**

```bash
git add docs/superpowers/plans/2026-08-01-translation-contribution-guide.md
git commit -m "docs: plan translation contribution guide"
```
