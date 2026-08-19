# Store Screenshot Dashboard Automation Design

**Date:** 2026-08-19
**Status:** Approved for implementation

## Goal

Provide one local operator command that regenerates Lurkloot's Chrome Web Store screenshots, opens a visible isolated browser for interactive Google sign-in and two-factor authentication, replaces all five screenshots for every supported store locale, and saves the resulting listing draft.

The command must remove the repetitive dashboard work without storing Google credentials or submitting the listing for review.

## Context

The repository already generates five ordered 1280×800 PNGs for each of 11 locales under `packages/extension/artifacts/store-screenshots/<locale>/`. The existing Chrome Web Store service-account integration uploads extension packages and manages publication through the supported v2 API.

Google's public Chrome Web Store API does not expose listing metadata or screenshot-management endpoints. Localized screenshots remain a Developer Dashboard operation, so screenshot replacement requires authenticated browser automation rather than an extension of `scripts/cws.mjs`.

## Scope

The implementation covers:

- regenerating and validating the complete screenshot matrix before opening the dashboard;
- launching a visible, non-persistent Google Chrome browser context;
- waiting for the operator to complete Google sign-in and 2FA;
- preflighting the extension identity, locale choices, screenshot controls, and save control before mutation;
- replacing the five localized screenshots in deterministic order for all 11 locales;
- saving each locale's listing draft and confirming the save completed;
- supporting upload-only and locale-filtered retries;
- reporting progress and the exact locale and operation on failure.

The implementation does not:

- save or restore cookies, local storage, authentication headers, passwords, or browser profiles;
- attach to the operator's everyday Chrome profile;
- call undocumented dashboard HTTP endpoints directly;
- click **Submit for review**, publish the listing, cancel a review, or modify package, distribution, privacy, promotional-tile, description, or other listing data;
- run in GitHub Actions or another unattended environment.

## Operator Commands

Two root commands provide the workflow:

```bash
pnpm screenshot:store:sync
pnpm screenshot:store:upload -- --locales ar tr
```

`screenshot:store:sync` regenerates all screenshot assets and then starts the dashboard uploader for all supported locales. `screenshot:store:upload` skips generation and uploads existing assets. Its optional `--locales` argument accepts repository locale codes for targeted retries.

The uploader requires `CWS_EXTENSION_ID` and `CWS_PUBLISHER_ID`, matching existing release automation. Neither value is secret. Missing configuration is reported before browser launch.

## Screenshot Manifest and Validation

A shared module defines ordered variants and locales so capture, validation, and upload cannot drift. The variant order is `01-drops`, `02-extras`, `03-easy`, `04-settings`, and `05-updated`. The locale order is `en`, `es`, `fr`, `it`, `ru`, `de`, `zh_CN`, `hi`, `pt_BR`, `ar`, and `tr`.

Each repository code maps to the English label exposed by the dashboard locale selector. The dashboard UI is forced to English so selectors do not depend on the operator's Google language preference.

Before browser launch, validation requires exactly one expected file for every requested locale and variant. Each file must have a PNG signature, an IHDR width of 1280, and an IHDR height of 800. Missing files, unexpected PNG names in a requested locale directory, unreadable files, and invalid dimensions are fatal and cause no dashboard activity.

## Browser Session and Authentication

The uploader launches installed Google Chrome in headed mode through Playwright and creates a fresh non-persistent browser context. The implementation never calls `storageState()` or writes reusable authentication state.

While unauthenticated, the command prints a concise instruction and waits without reading, filling, or logging credential fields. The operator signs in and completes 2FA directly in Chrome. Automation resumes only after confirming the configured extension ID and Store listing surface.

Closing the browser destroys the isolated context. Authentication is intentionally repeated on later runs. If Google refuses authentication, the command exits without mutation; it does not weaken browser security flags, persist a profile, or fall back to the operator's default profile.

## Dashboard Interaction and Preflight

The adapter uses Playwright role, label, and visible-text locators. Generated CSS classes, DOM ancestry assumptions, screen coordinates, image-recognition clicks, and direct undocumented HTTP calls are prohibited. Dashboard-specific locators remain isolated from workflow logic.

Before the first deletion, a read-only preflight verifies:

- the current item contains `CWS_EXTENSION_ID` and the Store listing surface is visible;
- every requested locale is available;
- the localized screenshot region has exactly five thumbnails for the first requested locale;
- one unambiguous first-thumbnail remove control and one PNG file input exist;
- draft save and saved-state controls are identifiable.

Missing or ambiguous locators fail before mutation. No submit or publish operation exists on the dashboard adapter interface.

## Replacement Algorithm

The Chrome Web Store accepts at most five screenshots. Each locale uses this five-step rotation:

```text
for desiredScreenshot in [01, 02, 03, 04, 05]:
  remove the first current screenshot
  wait until four thumbnails remain
  upload desiredScreenshot
  wait for upload completion and five thumbnails
```

Starting from any five screenshots, five rotations remove every starting screenshot and append the desired files in order. The operation is idempotent after a complete run and after interruption.

The adapter waits on observable state changes, not fixed sleeps. Upload completion requires the file chooser action to succeed, progress to finish, no validation error to appear, and the thumbnail count to return to five.

## Saving, Failure, and Recovery

After all five images for a locale are present, the uploader clicks the draft save control and waits for an observable saved state before continuing. It never discovers or clicks **Submit for review**.

The workflow stops on the first failed assertion, removal, upload, or save. Errors include locale, variant when applicable, phase, expected state, and a locale-filtered recovery command. Once mutation has started, failure leaves the visible browser open for inspection and reports that nothing was submitted.

The script does not automatically retry destructive clicks. Observation may be retried, but each remove or save action is issued at most once per run. A later locale-filtered run safely replaces any mixed state.

## Module Boundaries

- `packages/extension/scripts/store-screenshot-config.mjs` owns locale/variant order, filenames, and dashboard locale labels.
- `packages/extension/scripts/store-screenshot-files.mjs` resolves and validates files without browser dependencies.
- `packages/extension/scripts/store-screenshot-dashboard.mjs` is the narrow Playwright adapter for navigation, locale selection, removal, upload, save, and state queries. It exposes no submit operation.
- `packages/extension/scripts/upload-store-screenshots.mjs` parses CLI arguments, launches the browser, coordinates preflight and replacement, reports progress, and handles cleanup.
- `packages/extension/scripts/capture-store-screenshot.mjs` consumes the shared manifest.

The coordinator depends on an adapter interface rather than selectors. File and replacement logic remains testable without an authenticated dashboard.

## Testing

Implementation follows test-driven development. Automated tests cover:

- the exact manifest, paths, and upload order;
- missing, extra, non-PNG, and non-1280×800 files;
- unknown and duplicate locale arguments;
- the five-step rotation, complete-run idempotence, and every interrupted state;
- four/five-thumbnail waits around uploads;
- one save per complete locale and no save for an incomplete locale;
- first-failure context;
- the adapter's lack of submit/publish operations;
- capture and upload sharing one manifest;
- locator ambiguity failing closed through a local accessible DOM fixture.

The authenticated dashboard is a manual integration boundary because Google provides no screenshot sandbox. Before completion, one attended live run must exercise all 11 locales, confirm 55 uploads and 11 saved states, and verify that the item remains unsubmitted.

## Documentation

`docs/chrome-web-store-submission.md` documents the commands, non-secret configuration, interactive sign-in, locale-filtered recovery, draft-only guarantee, unsupported-UI dependency, and fail-closed behavior.

## Acceptance Criteria

- One command regenerates and replaces all 55 localized screenshots.
- The operator performs only Google sign-in/2FA.
- Every locale finishes in `01-drops` through `05-updated` order and an observed saved state.
- No authentication state is written by repository tooling.
- Missing files or changed/ambiguous controls fail closed.
- Interrupted runs are recoverable by locale-filtered rerun.
- The automation cannot submit or publish the listing.
- Existing package-upload and release behavior remains unchanged.

## External References

- Chrome Web Store API reference: <https://developer.chrome.com/docs/webstore/api/reference/rest>
- Chrome localized listing workflow: <https://developer.chrome.com/docs/webstore/cws-dashboard-listing>
- Chrome listing update and review workflow: <https://developer.chrome.com/docs/webstore/update/>
- Playwright non-persistent contexts: <https://playwright.dev/docs/api/class-browsercontext>
