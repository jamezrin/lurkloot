# Persian Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete Persian localization and RTL support to the extension and store sources.

**Architecture:** Extend the shared locale registries, explicit catalog loader and existing RTL behavior. The English catalog remains the message contract; generated browser catalogs remain untracked.

**Tech Stack:** TypeScript, pnpm, WXT, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-persian-language-design.md`

## Global Constraints

- Work in `.worktrees/persian-language`, branch `feat/persian-language` from `origin/develop`.
- Use locale `fa`, native label `فارسی`, and RTL for Persian.
- Delegate bulk translations to inexpensive agents; preserve keys, brands and `$N` substitutions.
- Do not translate diagnostics, add permissions, change platform behavior or bump versions.

## Review Focus

- `fa-IR` and `fa_IR` must normalize to `fa` rather than English.
- A Persian override must survive settings normalization.
- The actual catalog loader must resolve Persian and substitute values correctly.
- Every Persian message must preserve the English placeholder sequence.
- Store locale and artwork sources must include Persian; the popup must use RTL.

### Task 1: Locale behavior and catalog

**Files:** shared `models.ts`, `settings.ts`, `i18n.ts`; locales `src/index.ts`, `messages/*.json`; extension `tests/i18n.test.ts`, `settings.test.ts`, `tips.test.ts`.

**Interfaces:** `SupportedLocale`, `SUPPORTED_LOCALES`, `LOCALE_OPTIONS`, `RTL_LOCALES`, `loadCatalog("fa")`, `languagePersian`.

- [x] Add failing browser-language, settings, RTL and real-loader tests; confirm missing support fails.
- [x] Register Persian and integrate the complete delegated catalog and language-name translations.
- [x] Run locale checks, focused tests and workspace typechecks.

### Task 2: Store sources and contributor documentation

**Files:** popup-ui `storeArtworkCopy.ts`; extension `scripts/store/lurkloot.mjs`, `store-descriptions/fa.txt`; `docs/translations.md`.

**Interfaces:** `STORE_ARTWORK_COPY.fa`, store `LOCALES` containing `fa`, Persian description source.

- [x] Integrate delegated Persian artwork and listing copy, register the store locale.
- [x] Document all source locations needed to add a new locale.
- [x] Run full verification, record any baseline/platform failures, build Chrome and Firefox, inspect Persian UI and generated catalog.
- [x] Request a fresh review, address actionable findings, and leave the changes ready for user review.

## Verification outcome

Locale checks, 84 focused tests, workspace typechecks, Biome, Chrome and Firefox
builds, and the Astro site build passed. A real Chrome preview confirmed Persian
text and RTL. Independent review found no actionable issue.

The full extension run passed 3310 tests, skipped 3, and failed 3 existing tests:
`browserTabs.test.ts` (closure-path guard), `engineBoundary.test.ts` (cycle fixture),
and `popupRequestFailures.test.tsx` (auto-claim switch). All three failures were
reproduced on the unmodified `develop` checkout.

`pnpm verify` stops at six existing `scripts/release.test.mjs` cases on Windows
(synchronized manifests, mismatched versions, preparation/version synchronization,
stable-release dates, invalid dates, and an empty changelog date). All six also
failed on unmodified `develop`. Baseline store-sync browser tests additionally
require a Playwright browser installation and have Windows path assumptions.
