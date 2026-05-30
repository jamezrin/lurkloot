# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript WXT WebExtension for Twitch and Kick drop farming. Extension entrypoints live in `entrypoints/`: `background.ts` starts the controller, content scripts are split by platform, and `popup/` contains the React popup UI and CSS. Shared logic lives in `src/core/` for scheduling, settings, storage, tabs, messages, and models. Platform adapters and parsers are in `src/platforms/`. Tests are in `tests/**/*.test.ts`; static assets are in `public/`. `mockup-v1/` is a separate prototype app and should only change when the task targets the mockup.

## Build, Test, and Development Commands

Use pnpm for all package tasks.

- `pnpm install`: install dependencies from `pnpm-lock.yaml`.
- `pnpm dev`: run the WXT development server for Chromium.
- `pnpm dev:firefox`: run WXT for Firefox.
- `pnpm test`: run the Vitest test suite once.
- `pnpm typecheck`: run `tsc --noEmit` with strict TypeScript settings.
- `pnpm build` / `pnpm build:firefox`: create production builds.
- `pnpm verify`: run tests, typecheck, and both browser builds.
- `pnpm zip` / `pnpm zip:firefox`: package release artifacts.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Keep imports explicit and prefer `type` imports for types. Follow the existing two-space indentation, double quotes, semicolons, and camelCase functions/variables. Use PascalCase for React components and TypeScript types. Keep platform behavior behind `PlatformAdapter`; do not mix Twitch/Kick parsing logic into scheduler or UI code.

## Reference Implementations

`references/` contains source snapshots of similar open-source drop-farming apps, including `KickDropsMiner`, `StreamDropCollector`, and `TwitchDropsMiner`. Use them as implementation inspiration for platform behavior, parsing ideas, or edge cases, but adapt code to this extension's WXT, browser-session, and `PlatformAdapter` architecture.

## Testing Guidelines

Tests use Vitest in a Node environment with globals enabled. Add focused `*.test.ts` files under `tests/`, matching the module being exercised, such as `scheduler.test.ts` or `parsers.test.ts`. Prefer deterministic unit tests with mocked adapters, browser APIs, or storage rather than live Twitch/Kick calls. Run `pnpm test` for test-only changes and `pnpm verify` before releases.

## Commit & Pull Request Guidelines

Recent history uses short imperative commit subjects, for example `Fix viewer count refresh in scheduler` or `Add popup schedule refresh button`; one conventional prefix exists: `feat: initial commit`. Keep commits focused and describe the behavior or module changed. Pull requests should include a concise summary, testing performed, linked issues when applicable, and screenshots or recordings for popup UI changes.

## Security & Configuration Tips

Do not add features that store credentials, export cookies, or bypass platform detection. The extension relies on normal logged-in browser sessions and visible muted tabs. Keep host permissions scoped to the services declared in `wxt.config.ts`, and document any new permission in the PR.
