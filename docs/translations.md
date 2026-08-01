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
