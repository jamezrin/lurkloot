# Turkish language and store-listing parity design

## Goal

Add Turkish as a first-class Lurkloot locale and give it the same Chrome Web Store support as every existing language. The release-ready output includes the translated extension, five Turkish listing screenshots, two Turkish promotional tiles, and paste-ready Turkish listing copy. Based on the requester's follow-up email, every store-language description will also explain that Lurkloot can farm Kick watch time through its idle watchlist and lower-resource automatic watching, not only earn drops.

## Scope

The feature covers the shared locale contracts, popup language selection, browser-locale normalization, catalog loading, WXT locale packaging, store capture scripts, store documentation, generated Turkish store artwork, and a local pre-release extension artifact for native-speaker testing.

It does not change farming behavior, add permissions, send email, publish to the Chrome Web Store, or promise that watch time will produce a particular Kick badge or reward. Sending the pre-release artifact to the requester remains a separate explicit action.

## Locale integration

`tr` becomes a `SupportedLocale` and appears as `Türkçe` in the language selector. Browser values such as `tr` and `tr-TR` normalize to it, explicit settings persist it, and `@lurkloot/locales` exposes a statically analyzable dynamic import for its catalog. The existing WXT build hook discovers the new catalog and emits `_locales/tr/messages.json` without special-case build logic.

The Turkish catalog will contain every English key. Placeholder sequences such as `$1` will match English exactly. Translations will use natural Turkish gaming vocabulary, retain product and platform brand names, and include localized marketing overlays for screenshots and promo tiles. English fallback behavior remains unchanged.

## Chrome Web Store parity

The screenshot and promo capture scripts will accept `tr` and include it in their default all-locale runs. The implementation will generate:

- five 1280×800 screenshots in `packages/extension/artifacts/store-screenshots/tr/`;
- one 440×280 and one 1400×560 opaque RGB promotional tile in `packages/extension/artifacts/store-promo/tr/`.

These artifacts follow the repository's existing generated, gitignored workflow. Reproducible source catalogs and capture configuration are committed; the generated PNGs remain available in the feature worktree for inspection and CWS upload.

`docs/store-descriptions.md` will gain a Turkish short and detailed listing. All eleven detailed descriptions will mention Kick watch-time farming in a restrained, factual way: users can maintain a specific idle watchlist, let Lurkloot choose an available channel automatically, and use tabless watching to reduce resource usage. The text will avoid guarantees about Kick levels, badges, or platform outcomes. Short descriptions stay within Chrome's 132-character limit.

`docs/chrome-web-store-submission.md` will list Turkish paths and update locale/asset counts and regeneration examples.

## Testing and validation

Focused tests will verify:

- `tr-TR` browser normalization and Turkish explicit settings;
- Turkish presence in supported locale options and the catalog loader;
- key parity and placeholder parity across all catalogs;
- no unintended English copy in the Turkish catalog, subject to the existing brand/common-term allowlist;
- Turkish inclusion in both store capture pipelines.

Final verification will run the repository checks and both browser builds. The Turkish store generation commands will then be run, followed by checks for file count, exact dimensions, and opaque RGB promo output. The built Chrome archive will serve as the local pre-release test artifact.

## Error handling and review

Unknown locales continue to fall back to English. Capture scripts continue to reject a request containing no known locale. Missing translations or placeholder drift fail deterministic tests before build. Native-speaker feedback from Can can be applied in a follow-up revision without altering locale architecture or store generation.
