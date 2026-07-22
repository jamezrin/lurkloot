# Turkish Language and Store-Listing Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Turkish extension localization with complete Chrome Web Store listing assets and describe Kick watch-time farming consistently in every store language.

**Architecture:** Extend the existing explicit `SupportedLocale` registry and statically analyzable catalog loaders with `tr`, while leaving WXT's catalog-discovery hook unchanged. Keep store artwork reproducible by adding Turkish to the current Playwright capture allowlists, then generate gitignored PNG outputs from the real popup. Treat listing prose as documentation and validate locale/catalog/asset invariants with deterministic tests and shell checks.

**Tech Stack:** TypeScript 7, React 19, WXT 0.20, Vitest 4, Playwright 1.61, pnpm 11, ImageMagick, JSON Chrome i18n catalogs.

## Global Constraints

- Work only in `.worktrees/turkish-language` on `feat/turkish-language`, based on `origin/develop`.
- Use locale code `tr`, native label `Türkçe`, and recognize browser locale `tr-TR`.
- Turkish must contain every English catalog key and preserve every `$N` placeholder sequence.
- Store output is five 1280×800 screenshots plus 440×280 and 1400×560 opaque RGB promo tiles.
- All eleven detailed store descriptions must mention Kick watch-time farming, idle-watchlist automation, and lower-resource tabless watching without promising badges or platform outcomes.
- Do not add permissions, farming behavior, credentials, email sends, or Chrome Web Store publication.
- Generated `packages/extension/artifacts/**` files remain gitignored; commit only reproducible sources and documentation.

---

### Task 1: First-class Turkish locale contract

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/settings.ts`
- Modify: `packages/shared/src/i18n.ts`
- Modify: `packages/extension/tests/i18n.test.ts`
- Modify: `packages/extension/tests/settings.test.ts`

**Interfaces:**
- Produces: `SupportedLocale` including `"tr"`, `SUPPORTED_LOCALES` including `"tr"`, and `LOCALE_OPTIONS` containing `{ value: "tr", labelKey: "languageTurkish", nativeName: "Türkçe" }`.

- [ ] **Step 1: Add failing locale and settings tests**

Add these assertions to the existing focused tests:

```ts
// Add LOCALE_OPTIONS to the existing @lurkloot/shared/i18n import.
import { LOCALE_OPTIONS } from "@lurkloot/shared/i18n";

expect(normalizeBrowserLocale("tr-TR")).toBe("tr");
expect(effectiveLocale("tr", "en-US")).toBe("tr");
expect(LOCALE_OPTIONS).toContainEqual({
  value: "tr",
  labelKey: "languageTurkish",
  nativeName: "Türkçe",
});
```

In `settings.test.ts`, extend the language normalization case with:

```ts
expect(mergeSettings({ languageOverride: "tr" }).languageOverride).toBe("tr");
```

- [ ] **Step 2: Run the focused tests and verify red state**

Run: `pnpm --filter @lurkloot/extension test -- tests/i18n.test.ts tests/settings.test.ts`

Expected: TypeScript/Vitest fails because `"tr"` is not assignable to `SupportedLocale` and the option is absent.

- [ ] **Step 3: Extend the explicit locale registries**

Apply these exact additions:

```ts
// packages/shared/src/models.ts
export type SupportedLocale = "en" | "es" | "fr" | "it" | "ru" | "de" | "zh_CN" | "hi" | "pt_BR" | "ar" | "tr";

// packages/shared/src/settings.ts
export const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar", "tr"];

// packages/shared/src/i18n.ts, append to LOCALE_OPTIONS
{ value: "tr", labelKey: "languageTurkish", nativeName: "Türkçe" },

```

No Turkish-specific branch is needed in `normalizeBrowserLocale`; its base-language logic resolves `tr-TR` once `tr` is supported.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm --filter @lurkloot/extension test -- tests/i18n.test.ts tests/settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the locale contract**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/shared/src/i18n.ts packages/extension/tests/i18n.test.ts packages/extension/tests/settings.test.ts
git commit -m "feat(locales): register Turkish language support"
```

### Task 2: Complete Turkish catalog

**Files:**
- Create: `packages/locales/messages/tr.json`
- Modify: `packages/locales/src/index.ts`
- Modify: `packages/locales/messages/en.json`
- Modify: `packages/locales/messages/es.json`
- Modify: `packages/locales/messages/fr.json`
- Modify: `packages/locales/messages/it.json`
- Modify: `packages/locales/messages/ru.json`
- Modify: `packages/locales/messages/de.json`
- Modify: `packages/locales/messages/zh_CN.json`
- Modify: `packages/locales/messages/hi.json`
- Modify: `packages/locales/messages/pt_BR.json`
- Modify: `packages/locales/messages/ar.json`
- Modify: `packages/extension/tests/i18n.test.ts`
- Modify: `packages/extension/tests/tips.test.ts`

**Interfaces:**
- Consumes: `languageTurkish` from Task 1's locale option.
- Produces: a `MessageCatalog` at `@lurkloot/locales/messages/tr.json` with exactly the English key set and identical placeholder sequences.
- Produces: `loadCatalog("tr")` through the static loader `tr: () => import("../messages/tr.json")`.

- [ ] **Step 1: Strengthen failing catalog coverage**

Update the locale expectations and translation checks:

```ts
expect(locales).toContain("tr");
expect(readCatalog("tr").languageTurkish.message).toBe("Türkçe");
expect(readCatalog("tr").subscriptionCampaigns.message).toBe("Abonelik kampanyaları");
```

Add `tr: "Abonelik kampanyaları"` to the existing `translations` record. Add `"tr"` to the fixed locale list in `tips.test.ts`. Do not weaken the existing key-parity, placeholder-parity, or unchanged-English checks.

- [ ] **Step 2: Run tests and verify the missing catalog failure**

Run: `pnpm --filter @lurkloot/extension test -- tests/i18n.test.ts tests/tips.test.ts`

Expected: FAIL because `tr.json` and `languageTurkish` messages do not exist.

- [ ] **Step 3: Add the Turkish language name to every catalog**

Insert a `languageTurkish` message beside the other language names in all eleven catalogs. Use the localized name of Turkish in each existing catalog and use this exact Turkish entry:

```json
"languageTurkish": {
  "message": "Türkçe"
}
```

- [ ] **Step 4: Translate the complete Turkish catalog**

Create `tr.json` in the same key order as `en.json`. Translate every user-visible message into natural Turkish; preserve `Lurkloot`, Twitch, Kick, Drops, URLs, `$1`/`$2` tokens, punctuation semantics, and Chrome message JSON structure. Use gaming terms rather than agricultural language. The store-specific keys must communicate these meanings:

```json
"extensionStoreName": { "message": "Lurkloot - Twitch ve Kick'te Drop ve İzlenme Süresi Kas" },
"languageTurkish": { "message": "Türkçe" },
"screenshotTwitchHeadline": { "message": "Twitch droplarını otomatik kas" },
"screenshotKickHeadline": { "message": "Kick droplarını ve izlenme süresini kas" },
"screenshotIdleWatchlistHeadline": { "message": "İzleme listeni sen belirle" },
"screenshotSettingsHeadline": { "message": "Nasıl kasacağını özelleştir" },
"screenshotActivityHeadline": { "message": "Her şeyi tek bakışta takip et" },
"promoTagline": { "message": "Twitch ve Kick droplarını otomatik kas" }
```

Before committing, compare each final Turkish phrase against its UI context and keep the extension description concise enough for manifest/store use.

Append the statically analyzable loader in `packages/locales/src/index.ts`:

```ts
tr: () => import("../messages/tr.json"),
```

- [ ] **Step 5: Validate JSON keys, placeholders, and translation tests**

Run: `pnpm --filter @lurkloot/extension test -- tests/i18n.test.ts tests/tips.test.ts`

Expected: both test files pass; all locale keys and placeholders remain synchronized.

Run: `pnpm --filter @lurkloot/locales typecheck && pnpm --filter @lurkloot/shared typecheck`

Expected: both packages pass typechecking.

- [ ] **Step 6: Commit the catalog**

```bash
git add packages/locales/messages packages/locales/src/index.ts packages/extension/tests/i18n.test.ts packages/extension/tests/tips.test.ts
git commit -m "feat(locales): translate Lurkloot into Turkish"
```

### Task 3: Store capture parity and listing copy

**Files:**
- Modify: `packages/extension/scripts/capture-store-screenshot.mjs`
- Modify: `packages/extension/scripts/capture-store-promo.mjs`
- Modify: `packages/extension/tests/i18n.test.ts`
- Modify: `docs/store-descriptions.md`
- Modify: `docs/chrome-web-store-submission.md`

**Interfaces:**
- Consumes: the Turkish catalog and marketing keys from Task 2.
- Produces: capture CLIs that accept `tr`, plus complete CWS documentation for eleven locales.

- [ ] **Step 1: Add a failing capture-pipeline invariant test**

In `i18n.test.ts`, read both scripts and assert every catalog locale is represented:

```ts
const extensionRoot = dirname(import.meta.dirname);
const captureScripts = [
  join(extensionRoot, "scripts/capture-store-screenshot.mjs"),
  join(extensionRoot, "scripts/capture-store-promo.mjs"),
];
for (const script of captureScripts) {
  const source = readFileSync(script, "utf8");
  for (const locale of localeCodes()) expect(source, `${script}:${locale}`).toContain(`"${locale}"`);
}
```

- [ ] **Step 2: Verify the new invariant fails**

Run: `pnpm --filter @lurkloot/extension test -- tests/i18n.test.ts`

Expected: FAIL for `tr` in both capture scripts.

- [ ] **Step 3: Add Turkish to both capture allowlists**

Use this exact list in each script:

```js
const ALL_LOCALES = ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar", "tr"];
```

- [ ] **Step 4: Update all listing descriptions**

Add a `## Turkish (tr)` section with a short description of at most 132 characters and a natural detailed translation. In every language's detailed description, add one paragraph equivalent to:

```text
Lurkloot can also farm Kick watch time when no drop is active. Add the channels you prefer to the idle watchlist and it automatically chooses one that is live. Tabless watching keeps resource use low, while the normal pinned-tab fallback keeps the session resilient.
```

Localize the paragraph rather than inserting English. Do not mention or guarantee Kick's level badges. Verify short-description character counts with a small read-only Node command or manual extraction.

- [ ] **Step 5: Update submission documentation**

Add the table row:

```markdown
| tr | `store-screenshots/tr/` | Turkish |
```

Change “all 10” to “all 11”, state that Turkish promo tiles use `artifacts/store-promo/tr/`, and include `tr` in the limited-generation example.

- [ ] **Step 6: Run focused tests and documentation checks**

Run: `pnpm --filter @lurkloot/extension test -- tests/i18n.test.ts`

Expected: PASS, including both capture-script locale invariants.

Run: `rg -n "watch time|izlenme süresi|store-screenshots/tr|all 11" docs/store-descriptions.md docs/chrome-web-store-submission.md`

Expected: Turkish listing and eleven-locale documentation are present; manually confirm each language contains its localized watch-time paragraph.

- [ ] **Step 7: Commit capture and listing parity**

```bash
git add packages/extension/scripts/capture-store-screenshot.mjs packages/extension/scripts/capture-store-promo.mjs packages/extension/tests/i18n.test.ts docs/store-descriptions.md docs/chrome-web-store-submission.md
git commit -m "feat(store): add Turkish listing assets"
```

### Task 4: Generate, inspect, and package release-ready outputs

**Files:**
- Generate (gitignored): `packages/extension/artifacts/store-screenshots/tr/*.png`
- Generate (gitignored): `packages/extension/artifacts/store-promo/tr/*.png`
- Generate (gitignored): `packages/extension/.output/*chrome*.zip`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: seven verified Turkish CWS PNGs and a local Chrome pre-release archive suitable for Can's review.

- [ ] **Step 1: Run full repository verification**

Run: `pnpm verify`

Expected: script tests, all workspace typechecks/tests, site build, Chromium build, and Firefox build pass.

- [ ] **Step 2: Generate Turkish screenshots and promo tiles**

Run: `pnpm screenshot:store tr && pnpm promo:store tr`

Expected: five files under `artifacts/store-screenshots/tr/` and two files under `artifacts/store-promo/tr/`, with no raw i18n keys visible.

- [ ] **Step 3: Verify image counts, dimensions, and color model**

Run:

```bash
find packages/extension/artifacts/store-screenshots/tr -maxdepth 1 -name '*.png' | wc -l
find packages/extension/artifacts/store-promo/tr -maxdepth 1 -name '*.png' | wc -l
magick identify -format '%f %wx%h %[channels]\n' packages/extension/artifacts/store-screenshots/tr/*.png packages/extension/artifacts/store-promo/tr/*.png
```

Expected: counts `5` and `2`; screenshots are `1280x800`; promos are `440x280` and `1400x560`; promo channels contain no alpha.

- [ ] **Step 4: Visually inspect all Turkish artwork**

Open a contact sheet or each PNG and confirm text is Turkish, no text is clipped, the popup is fully rendered, ordering is 01–05, and the promo tiles have no raw keys. If copy clips, shorten the relevant Turkish marketing key, rerun Task 2 tests, rebuild, and recapture.

- [ ] **Step 5: Create the Chrome pre-release archive**

Run: `pnpm zip`

Expected: a versioned Chrome ZIP appears in `packages/extension/.output/` and contains `_locales/tr/messages.json`.

Run:

```bash
unzip -l packages/extension/.output/*chrome.zip | rg '_locales/tr/messages.json'
git status --short
```

Expected: the Turkish catalog is present in the archive; generated artifact directories remain absent from Git status.

- [ ] **Step 6: Final verification commit if visual copy required edits**

If Task 4 required tracked translation or documentation corrections:

```bash
git add packages/locales/messages/tr.json docs/store-descriptions.md
git commit -m "fix(locales): refine Turkish store copy"
```

Otherwise, make no empty commit.
