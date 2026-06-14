# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript pnpm monorepo (`packages/*`, see `pnpm-workspace.yaml`) centered on a WXT WebExtension for Twitch and Kick drop farming. Four workspace packages:

- **`packages/extension`** — the WXT extension. Entrypoints are in `entrypoints/`: `background.ts` starts the controller, content scripts are split by platform (`kick.content.ts`, `twitch.content.ts`, `twitchKeepAlive.content.ts`), and `popup/` mounts the React popup. Core logic lives in `src/core/` (`scheduler.ts`, `storage.ts`, `tabs.ts`, `tablessWatch.ts`, `twitchIntegrity.ts`, `version.ts`, `links.ts`, …), the scheduler/controller in `src/background/controller.ts`, and platform adapters/parsers in `src/platforms/` (`adapter.ts` plus `twitch/` and `kick/`). Tests are in `tests/**/*.test.ts`. Static assets and localized messages are in `public/` (`public/_locales` for i18n). `wxt.config.ts` declares the manifest, permissions, and content scripts.
- **`packages/popup-ui`** — the shared React popup UI (`Popup.tsx`, `primitives.tsx`, view components like `watchQueue.tsx`/`drops.tsx`/`settings.tsx`, and the rate-nudge logic), imported by the extension as `@lurkloot/popup-ui`.
- **`packages/shared`** — framework-agnostic shared core imported as `@lurkloot/shared`: `models.ts`, `settings.ts`, `messages.ts`, `categories.ts`, `i18n.ts`, `logging.ts`.
- **`packages/site`** — the Astro marketing site (deployed to Cloudflare Pages at `https://lurkloot.jamezrin.com`). Pages in `src/pages/` (`index.astro`, `privacy.astro`, `changelog.astro`), content data in `src/changelog.ts`/`src/faq.ts`/`src/consts.ts`, and components/layouts/styles alongside.

Other top-level dirs: `docs/` (architecture and store-listing notes), `scripts/` (repo tooling), and `references/` (optional, untracked local snapshots — see below).

## Build, Test, and Development Commands

Use pnpm for all package tasks. The root `package.json` orchestrates the workspace; these scripts run from the repo root and delegate to the right package via `--filter`.

- `pnpm install`: install dependencies from `pnpm-lock.yaml`.
- `pnpm dev`: run the WXT development server for Chromium.
- `pnpm dev:firefox`: run WXT for Firefox.
- `pnpm dev:site`: run the Astro site dev server.
- `pnpm test`: run the extension Vitest suite once.
- `pnpm typecheck`: run `tsc --noEmit` across all packages (`pnpm -r typecheck`).
- `pnpm build` / `pnpm build:firefox`: create production extension builds.
- `pnpm build:site`: build the Astro site; `pnpm build:all` builds every package.
- `pnpm verify`: run typecheck, tests, and both browser builds.
- `pnpm zip` / `pnpm zip:firefox`: package release artifacts into `packages/extension/.output/`.

## Cutting a Release

Releases ship the extension to the Chrome Web Store and AMO, with the public changelog on the site kept in lockstep. Follow these steps from the repo root on a clean `main`:

1. **Pick the version (semver).** `patch` for bugfixes only, `minor` for backwards-compatible features, `major` for breaking changes. This choice matters beyond convention: on update the extension auto-opens the changelog **only for minor/major bumps** (see `isMinorOrMajorBump` in `packages/extension/src/core/version.ts`), so patch releases ship silently.
2. **Bump the version.** Update `"version"` to the new number in the four in-lockstep manifests: `package.json` (root), `packages/extension/package.json`, `packages/popup-ui/package.json`, and `packages/shared/package.json`. WXT reads `packages/extension/package.json` for the built `manifest.json`; the others are kept in sync for tidiness. (The `packages/site` version is independent — leave it.)
3. **Update the changelog.** Add a new top entry to `packages/site/src/changelog.ts` with the `version`, the release `date` (ISO `YYYY-MM-DD`, the Chrome Web Store publish date), and the user-facing `changes` grouped by `kind` (`new` / `improved` / `fixed`). The page renders newest-first and the extension deep-links to `#v{version}`. If a future version was already staged as an `Unreleased` entry (no `date`), just fill in its `date`.
4. **Verify.** Run `pnpm verify` (tests, typecheck, and both browser builds). Don't proceed if it fails.
5. **Regenerate the artifacts.** Run `pnpm zip` and `pnpm zip:firefox`. They write `lurkloot-{version}-{browser}.zip` (and a sources zip for Firefox) to `packages/extension/.output/`.
6. **Commit.** Stage the version bumps and the changelog change together and commit with the existing convention: `Bump version to X.Y.Z`. Optionally tag `vX.Y.Z`.
7. **Publish.** Upload the Chrome zip to the Chrome Web Store and the Firefox zip + sources to AMO. Use the actual store-publish date in the changelog entry from step 3 if review lag moves it.
8. **Deploy the site** so the new notes are live before users update: `pnpm --filter @lurkloot/site cf:deploy`. This matters because the extension opens `https://lurkloot.jamezrin.com/changelog#v{version}` on update.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Keep imports explicit and prefer `type` imports for types. Follow the existing two-space indentation, double quotes, semicolons, and camelCase functions/variables. Use PascalCase for React components and TypeScript types. Put cross-package types, models, and settings in `@lurkloot/shared` rather than duplicating them. Keep platform behavior behind `PlatformAdapter`; do not mix Twitch/Kick parsing logic into scheduler or UI code.

## Reference Implementations

`references/` is an optional, untracked local directory for source snapshots of similar open-source drop-farming apps (e.g. KickDropsMiner, TwitchDropsMiner). When present, use them as inspiration for platform behavior, parsing ideas, or edge cases, but adapt code to this extension's WXT, browser-session, and `PlatformAdapter` architecture. It is not committed, so don't assume it exists.

## Testing Guidelines

Tests use Vitest in a Node environment with globals enabled and live in `packages/extension/tests/`. Add focused `*.test.ts` files matching the module being exercised, such as `scheduler.test.ts`, `parsers.test.ts`, or `version.test.ts`. Prefer deterministic unit tests with mocked adapters, browser APIs, or storage rather than live Twitch/Kick calls. Run `pnpm test` for test-only changes and `pnpm verify` before releases.

## Commit & Pull Request Guidelines

Recent history uses short imperative commit subjects, for example `Fix viewer count refresh in scheduler` or `Add popup schedule refresh button`; one conventional prefix exists: `feat: initial commit`. Keep commits focused and describe the behavior or module changed. Pull requests should include a concise summary, testing performed, linked issues when applicable, and screenshots or recordings for popup UI changes.

## Security & Configuration Tips

Do not add features that store credentials, export cookies, or bypass platform detection. The extension relies on normal logged-in browser sessions and visible muted tabs. Keep `permissions` and `host_permissions` scoped to the services declared in `packages/extension/wxt.config.ts`, and document any new permission in the PR.
