# Stream Autopilot

A cross-browser TypeScript WebExtension for farming Twitch and Kick drops through normal logged-in browser sessions. By default it uses real, visible, pinned, muted tabs; optional tabless low-resource mode sends platform watch heartbeats and automatically falls back to visible tabs if progress stops. It reuses the user's session context, including Kick's same-origin session cookie for Kick API calls, without asking for credentials or exporting cookies.

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm build:firefox
```

For implementation details, see [docs/architecture.md](docs/architecture.md).

## Scope

- Twitch and Kick platform adapters are isolated behind a common interface.
- The scheduler keeps at most one pinned muted watch tab per platform unless tabless mode is enabled and healthy.
- Campaign selection supports popup-defined campaign priority, discovered game priority, ending-soonest and scarcity fallback modes, ACL/channel-specific preference, Watch Queue channels, and auto-claim.
- The popup is the only extension UI. It provides Twitch/Kick automation toggles, sortable Drops and Watch Queue lists, add-channel controls, and advanced playback and farming settings. There is no credential, cookie, diagnostics, acceptance, or settings import/export UI.
