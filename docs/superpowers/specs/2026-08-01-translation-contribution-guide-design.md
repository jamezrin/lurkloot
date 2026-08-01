# Translation Contribution Guide Design

## Goal

Help extension users improve Lurkloot translations by adding one localized rotating tip that links to a committed GitHub contribution guide. The website must not gain any visible copy or page for this feature.

## Scope

- Add `docs/translations.md`, an English guide for correcting existing translations.
- Add one rotating popup tip explaining that translations are maintained automatically with AI and inviting people to improve them.
- Link the tip action to the guide rendered on GitHub's `main` branch.
- Localize both the tip text and action in every supported message catalog.
- Extend the existing tip tests to protect the new behavior and catalog parity.

## Popup Behavior

`packages/popup-ui/src/tips.tsx` owns the rotating banner used in the extension popup. Add a descriptor beside the existing external-action tips. Its message communicates that AI maintains translations and that human improvements are welcome; its localized action reads the translation guide. The action opens the GitHub-rendered guide in a new tab with the component's existing safe link attributes.

The new guide URL becomes a named popup constant. It points to `https://github.com/jamezrin/lurkloot/blob/main/docs/translations.md`, so installed extension versions always lead users to the current published instructions. The Astro site does not render `TipsBanner`, and no site source will be changed.

## Localization

Add `tipTranslations` and `tipTranslationsAction` to all eleven JSON catalogs under `packages/locales/messages/`. Every catalog receives natural copy in its own language. The catalogs remain key- and placeholder-compatible, and diagnostic messages remain English literals rather than localized content.

## Contributor Guide

`docs/translations.md` explains that the project uses AI-maintained translations and welcomes human corrections. It describes where the catalog files live; how to make a focused correction while preserving JSON, message keys, and placeholders; how to run the focused test; and how to fork, branch from `develop`, commit, and open a pull request into `develop`. It links back to the repository's contributor and coding conventions where useful.

## Testing

Extend `packages/extension/tests/tips.test.ts` to assert the new descriptor renders its safe external action and to require both new keys in every supported catalog. Existing rotation behavior and the no-site-change boundary remain unchanged. Run the focused test, then the project test suite and relevant typecheck before completion.

## Error Handling

The banner uses the existing catalog fallback behavior. If a future catalog omits either key, the strengthened parity test fails before release. The outbound guide URL is static and opens independently of extension state.
