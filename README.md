# StreamMaxxing

A cross-browser TypeScript WebExtension for farming Twitch and Kick drops through real, visible, pinned, muted tabs. It reuses the user's normal browser sessions, including Kick's same-origin session cookie for Kick API calls, without storing or exporting credentials, importing cookies, simulating streamless watching, or bypassing detection.

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
- The scheduler keeps at most one pinned muted watch tab per platform.
- Campaign selection supports popup-defined campaign priority, discovered game priority, ending-soonest and scarcity fallback modes, ACL/channel-specific preference, Watch Queue channels, and auto-claim.
- The popup is the only extension UI. It provides Twitch/Kick automation toggles, sortable Drops and Watch Queue lists, add-channel controls, and the mockup settings surface. There is no credential, cookie, diagnostics, acceptance, or settings import/export UI.
