# Improving translations

Lurkloot's translations are maintained automatically with AI. Native speakers are welcome to improve wording, clarity, and accuracy through pull requests.

## Improve an existing translation

1. Find the locale file in `packages/locales/messages/` that you want to improve. Each file is a JSON message catalog; for example, `es.json` contains Spanish copy.
2. Edit only the message text for the key you are correcting. Keep the key name, JSON structure, placeholders such as `$1`, and product names intact. Do not translate diagnostic messages: diagnostics are English literals by design.
3. Keep the change focused on the wording you are improving. Add a new locale only when you are prepared to translate every existing message key.

## Add a new language

1. Copy `packages/locales/messages/en.json` to `<locale>.json` in the same directory and translate every message. Preserve placeholders, product names, and the gaming meaning of "farm".
2. Register the locale in `SupportedLocale` (`packages/shared/src/models.ts`), `SUPPORTED_LOCALES` (`packages/shared/src/settings.ts`), and the explicit loader in `packages/locales/src/index.ts`.
3. Add its native name to `LOCALE_OPTIONS` in `packages/shared/src/i18n.ts`. Add the corresponding language-name message key to every catalog. For a right-to-left language, also add its code to `RTL_LOCALES`; Persian uses `fa` and the native name `فارسی`.
4. Add the localized artwork copy in `packages/popup-ui/src/storeArtworkCopy.ts`, the locale in `packages/extension/scripts/store/lurkloot.mjs`, and a detailed description in `packages/extension/store-descriptions/<locale>.txt`. See [the store description guide](../packages/extension/store-descriptions/README.md).
5. Extend the locale and settings tests, including regional browser-language detection and right-to-left behavior where applicable. Include the locale in the tip translation tests. Run `pnpm locales:check`, `pnpm --filter @lurkloot/extension test -- i18n.test.ts settings.test.ts tips.test.ts`, and `pnpm typecheck`.
6. Open the popup in a real browser and check wording, text wrapping, and direction. Browser `_locales` directories are generated at build time from the catalog sources; do not commit generated outputs.

## Submit a pull request

1. Fork the repository and create a branch from `develop`, for example `fix/spanish-tip-wording`.
2. Make the translation change and run `pnpm --filter @lurkloot/extension test -- tips.test.ts` from the repository root.
3. Commit using the repository's Conventional Commit format, for example `fix(locales): improve Spanish tip wording`.
4. Open a pull request from your fork to this repository with base branch: `develop`. Explain which locale and message keys you improved.

Thank you for helping make Lurkloot clearer in every language.
