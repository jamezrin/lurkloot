# Browserless Twitch Web Integrity Implementation Plan

> **Implementation branch:** `feat/cli-twitch-web-integrity`, stacked on `fix/cli-twitch-recovery`. Tests precede production code.

## Goal

Let the CLI import the extension's Twitch web session and mint a valid Twitch `Client-Integrity` bundle using Node HTTP and SHA-256 only. Keep Smart TV device login working. A successful live check is a protected `ViewerDropsDashboard` response without integrity errors.

## Files and responsibilities

- `packages/cli/src/auth/twitchWebIntegrity.ts`: decode the live Kasada script's packed string pool, enumerate proof salts, fetch clearance, compute fresh proof, validate against the protected dashboard, cache a bundle, rotate the Kasada cookie, and refresh on rejection.
- `packages/cli/src/authStore.ts`, `packages/cli/src/auth/importCredentials.ts`, `packages/cli/src/twitch.ts`: store/import the web identity and cookie while retaining device-login behavior.
- `packages/shared/src/messages.ts`, `packages/extension/entrypoints/background.ts`, `packages/extension/wxt.config.ts`: include `KP_UIDz-ssn` in an explicit credential export and request only the exact `k.twitchcdn.net` host permission needed to read it.
- `packages/cli/src/transport/{common,http,impersonate,index}.ts`: provide one integrity manager per transport and pass its bundle and refresh function to TwitchAdapter.
- Focused CLI and extension tests verify parser drift handling, proof construction, import, refresh, and adapter wiring.

## Tasks

1. **Decoder and proof builder.** Write failing tests for a packed script fixture, candidate extraction, a known successful proof vector, and malformed script rejection. Implement the small decoder and SHA-256 search. Run focused tests and typecheck.
2. **Node mint and refresh.** Write failing mocked-network tests that require a dashboard-validated candidate, cookie rotation, caching, forced refresh, and a clear failure when the Kasada seed is missing. Implement HTTP minting and manager state. Run focused tests.
3. **Credential bridge.** Write failing tests for a Twitch-only extension import, cookie persistence, and preserved Smart TV identity. Extend the export and exact host permission, then implement import/store changes. Run CLI and extension tests.
4. **Adapter wiring.** Write a failing test proving a web-token CLI adapter receives a fresh integrity bundle and refreshes it after rejection. Wire both transports. Run CLI suite and workspace typecheck.
5. **Live verification.** Build the CLI, create an owner-only temporary augmented export from already saved secrets, run `auth import` and `discover` with Kick disabled, and require protected dashboard data. Check no browser or emulator process launched and no secret entered the repo or logs.

## Review focus

- Kasada script format changes must fail clearly, without accepting an unvalidated `/integrity` token.
- Twitch web OAuth must match the web Client-ID; Smart TV credentials must not be sent through web minting.
- A rejected token must trigger one new mint and preserve the bundle's device and session IDs.
- The rotating Kasada cookie and OAuth token must remain in owner-only storage and never enter logs.
- The exact host permission must cover `k.twitchcdn.net` without broadening unrelated hosts.

The current Kasada SDK path, version, and packed layout are platform-controlled. A rollout that changes them requires a CLI update; the minter fails clearly instead of trusting an unvalidated token.
