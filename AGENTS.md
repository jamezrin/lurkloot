# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript pnpm monorepo (`packages/*`, see `pnpm-workspace.yaml`) centered on a WXT WebExtension for Twitch and Kick drop farming. Seven workspace packages:

- **`packages/extension`** — the WXT extension shell. Entrypoints are in `entrypoints/`: `background.ts` wires browser lifecycle/runtime APIs to the controller, content scripts are split by platform (`kick.content.ts`, `twitch.content.ts`, `twitchKeepAlive.content.ts`), and `popup/` mounts the React popup. Extension-specific browser adapters and helpers live in `src/core/` (`storage.ts`, `tabs.ts`, `playbackContent.ts`, `keepAliveContent.ts`, `version.ts`, `links.ts`). Tests are in `tests/**/*.test.ts`. Static assets are in `public/`. `wxt.config.ts` declares the manifest, permissions, content scripts, and localized-message copy step.
- **`packages/core`** — the browser-free farming engine imported as `@lurkloot/core`. It owns the scheduler/controller (`packages/core/src/core/scheduler.ts`, `packages/core/src/background/controller.ts`), shared tab/watch abstractions, tabless watch logic, Twitch integrity handling, and platform adapters/parsers under `packages/core/src/platforms/` (`adapter.ts`, `twitch/`, `kick/`). It must not import WXT or browser globals; `packages/extension/tests/coreBoundary.test.ts` guards this so the extension and CLI can both reuse it.
- **`packages/cli`** — the headless/Docker runtime imported as `@lurkloot/cli`. It reuses `@lurkloot/core` and `@lurkloot/shared`, provides Node transports/auth/config/storage, and builds to `dist/index.mjs`.
- **`packages/locales`** — the localized message catalog package imported as `@lurkloot/locales`. JSON catalogs live in `messages/`, and `src/index.ts` exposes the async catalog loader used by the extension and popup UI.
- **`packages/popup-ui`** — the shared React popup UI imported as `@lurkloot/popup-ui` (`Popup.tsx`, `primitives.tsx`, view components like `watchQueue.tsx`/`drops.tsx`/`settings.tsx`, and the rate-nudge logic), consumed by both the extension popup and the site demo.
- **`packages/shared`** — framework-agnostic shared contracts imported as `@lurkloot/shared`: `models.ts`, `settings.ts`, `messages.ts`, `categories.ts`, `i18n.ts`, `logging.ts`.
- **`packages/site`** — the Astro marketing site (deployed to Cloudflare Pages at `https://lurkloot.jamezrin.com`). Pages are in `src/pages/` (`index.astro`, `privacy.astro`, `changelog.astro`), changelog data is in `src/changelog.json` with types in `src/changelog.ts`, other content data is in `src/faq.ts`/`src/consts.ts`, and components/layouts/styles are alongside. It imports the real popup UI for the live demo.

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
- `pnpm check`: run script tests, workspace typechecks, extension tests, and the Astro site build.
- `pnpm verify`: run `pnpm check` and both browser builds.
- `pnpm zip` / `pnpm zip:firefox`: package release artifacts into `packages/extension/.output/`.

## Cutting a Release

Releases run from the Actions tab. Run **Prepare release** (choose patch/minor/major) to open the
version-bump PR into `main`, merge it, then run **Release** on `main`. Release tags the commit,
builds every artifact, publishes the GitHub release, GHCR aliases, the Chrome Web Store submission
and the production site, then opens the `main` to `develop` sync PR. Every step is idempotent: if
one fails, fix the cause and run **Release** again. Do not push tags by hand.

Follow [RELEASING.md](RELEASING.md) for the `preview` and `production` environments, the single release approval, credentials, Chrome Web Store publication timing, and required repository configuration.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Keep imports explicit and prefer `type` imports for types. Follow the existing two-space indentation, double quotes, semicolons, and camelCase functions/variables. Use PascalCase for React components and TypeScript types. Put cross-package types, models, and settings in `@lurkloot/shared` rather than duplicating them. Keep platform behavior behind `PlatformAdapter`; do not mix Twitch/Kick parsing logic into scheduler or UI code.

## Reference Implementations

`references/` is an optional, untracked local directory for source snapshots of similar open-source drop-farming apps (e.g. KickDropsMiner, TwitchDropsMiner). When present, use them as inspiration for platform behavior, parsing ideas, or edge cases, but adapt code to this extension's WXT, browser-session, and `PlatformAdapter` architecture. It is not committed, so don't assume it exists.

## Testing Guidelines

Tests use Vitest in a Node environment with globals enabled and live in `packages/extension/tests/`. Add focused `*.test.ts` files matching the module being exercised, such as `scheduler.test.ts`, `parsers.test.ts`, or `version.test.ts`. Prefer deterministic unit tests with mocked adapters, browser APIs, or storage rather than live Twitch/Kick calls. Run `pnpm test` for test-only changes and `pnpm verify` before releases.

## Commit & Pull Request Guidelines

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) using `<type>[optional scope]: <description>`. Use lowercase types and imperative, present-tense descriptions without a trailing period. Keep commits focused and use a scope when it adds useful context, such as `feat(popup): add schedule refresh button` or `fix(scheduler): refresh viewer counts`.

Use these commit types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. Mark breaking changes with `!` before the colon and explain them in a `BREAKING CHANGE:` footer. Release commits use `chore(release): bump version to X.Y.Z`.

Name branches `<type>/<short-kebab-case-description>`, using the same types as commits; for example, `feat/popup-schedule-refresh`, `fix/scheduler-viewer-count`, or `docs/release-process`. This repository-specific convention takes precedence over generic agent, plugin, or automation defaults such as `agent/*`; derive new branch names from this section unless the user explicitly requests another format. Use `release/X.Y.Z` for release preparation and `hotfix/<short-kebab-case-description>` for urgent production fixes. Keep established bot-generated branch formats such as `renovate/*` unchanged. Do not include issue numbers unless they help identify the work; when used, put one after the type, for example `fix/123-scheduler-timeout`.

Pull requests should include a concise summary, testing performed, linked issues when applicable, and screenshots or recordings for popup UI changes. PR titles should also follow Conventional Commits so squash merges preserve a valid commit subject.

## License

The repository is licensed under Apache License 2.0; see `LICENSE`. New source files and contributions are covered by the repository license. Preserve required copyright, license, attribution, and `NOTICE` information when reusing third-party code, and record significant changes to Apache-2.0-licensed files as required by that license. Do not copy code from references or elsewhere unless its license is compatible and its obligations are satisfied.

## Security & Configuration Tips

Do not add features that store credentials, export cookies, or bypass platform detection. The extension relies on normal logged-in browser sessions and visible muted tabs. Keep `permissions` and `host_permissions` scoped to the services declared in `packages/extension/wxt.config.ts`, and document any new permission in the PR.
