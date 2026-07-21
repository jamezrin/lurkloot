# Kick Page-Context Lifecycle Design

## Goal

Keep Kick farming fully tabless whenever service-worker requests authenticated by the normal browser session work. When Kick rejects those requests, use at most one muted, inactive, extension-managed `kick.com` page context and retain it only while the fallback remains necessary.

The change fixes the repeated opening and closing reported in issue #193 without making a Kick tab a prerequisite for tabless farming.

## Current Behavior and Root Cause

Kick requests already try the service worker first. The extension reads the normal `session_token` cookie and replays it as a Bearer token for authenticated Kick hosts. A real Kick page context is used only when the service-worker request is rejected by WAF, CORS, origin policy, or a challenge response.

The scheduler currently closes a retained page context after preparing a watch tab. Later discovery or heartbeat requests can still require that page context, so they recreate it. Persisted state, the in-memory registry, and the real browser tab can consequently move out of sync and produce visible cycling.

## Selected Approach

Use an adaptive, lifecycle-driven retained context:

1. Every Kick request continues to try cookie-authenticated service-worker transport first.
2. A successful background request does not create a page context.
3. A rejected background request reuses a qualifying user-owned Kick tab when available; otherwise it creates or reuses one extension-managed muted, inactive homepage context.
4. Ordinary scheduler/watch-tab transitions do not close a valid retained context.
5. A retained context is released after the background transport demonstrates sustained recovery: at least three consecutive successful background requests and at least ten minutes since the most recent page fallback.
6. Another page fallback resets the success count and recovery window, preventing intermittent success from causing close/reopen flapping.
7. Explicit lifecycle events close the managed context immediately: Kick is disabled, automation stops, manual watching takes over, or a qualifying user-owned Kick tab replaces it.

The recovery threshold is deliberately conservative. It removes an unnecessary context after background transport becomes healthy while favoring one stable tab over disruptive cycling when Kick behaves intermittently.

## Architecture

### Core Kick fetch policy

`createKickFetcher` remains browser-free and keeps its background-first policy. It will report safe transport outcomes through an injected lifecycle callback. The callback receives only the platform, safe hostname, outcome, and functional reason; it never receives request paths, query values, headers, cookies, tokens, or payloads.

### Browser page-context registry

The page-context registry remains the ownership authority for extension-created contexts. Retained Kick context metadata will include the last fallback time and consecutive background-success count. The fields are optional so previously persisted scheduler state remains compatible.

The registry will expose focused lifecycle operations to:

- record that a fallback is required;
- record a background success and determine whether recovery is stable;
- validate and reuse a retained browser tab;
- replace a managed context with a user-owned tab;
- close only a context whose persisted handle says it is extension-owned.

All registry mutations update the state returned by `currentManagedPageContextTabs`, allowing the controller's normal state save to synchronize browser and persisted state.

### User-visible activity events

Opening or closing an extension-managed page-context tab is a user-visible side effect, not merely a debugging detail. Each successful browser create or close operation will therefore emit a typed activity event that is stored and shown in the Activity view regardless of whether diagnostic logging is enabled:

- `page_context_opened`, with the platform, safe hostname, and reason the page context became necessary;
- `page_context_closed`, with the platform, safe hostname, and reason the page context was released.

The reason is structured data rendered through localized messages. Opening reasons include a rejected background request and recovery from a missing or unusable managed context. Closure reasons include stable background recovery, a user-owned tab becoming available, platform disablement, automation stopping, manual-watch takeover, and unusable-context replacement.

Only successful, real browser mutations create these activity records. Reusing or retaining an existing tab does not claim that a tab was opened, and discovering that a user already closed a tab does not claim that LurkLoot closed it. Those non-mutating decisions remain diagnostics.

### Scheduler ownership

The scheduler stops treating watch-tab preparation as a reason to tear down page contexts. It continues to request immediate cleanup for explicit platform lifecycle changes. This keeps page-context tabs distinct from farming/watch tabs.

### Restart and manual closure

On service-worker wake, persisted managed context metadata is registered before the tick. Reuse validates the real tab with `tabs.get`. A missing, navigated, or otherwise unusable tab is forgotten before exactly one replacement may be created.

Startup while automation is stopped retains the existing stale-state cleanup policy and closes only recorded extension-owned contexts. User-owned tabs are never persisted as managed contexts and are therefore never included in managed cleanup.

## Diagnostics and Privacy

Each lifecycle decision also emits a diagnostic with:

- platform (`kick`);
- safe hostname only (`kick.com`, `web.kick.com`, or `websockets.kick.com`);
- action (`create`, `reuse`, `retain`, `replace`, `close`, or `forget`);
- functional reason such as `background rejected`, `recovery threshold pending`, `background transport stable`, `user tab available`, `tab missing`, `platform disabled`, or `automation stopped`.

Diagnostics must not contain URL paths, query strings, cookies, authorization values, request headers, request or response bodies, or raw platform errors that may contain those values.

The corresponding user-visible open/close activity events follow the same privacy rule. Their formatter uses only the platform, safe hostname, and enumerated reason; it never displays raw error text.

## Error Handling

- Failure to inspect a persisted context treats it as stale and forgets the handle.
- Failure to close a known managed tab is tolerated because the user may already have closed it; the registry still forgets the stale handle.
- Failure to create or execute in a page context keeps the existing request error behavior and does not leave an invalid registry entry.
- Concurrent fallback requests for the same origin continue sharing the existing acquisition promise, preventing duplicate creation.

## Testing

Deterministic tests will cover:

- background cookie replay succeeds and creates no tab;
- a rejected request creates one managed context and later operations reuse it;
- scheduler and heartbeat cycles do not close and immediately recreate the context;
- fewer than three successes or less than ten minutes retains the context;
- three consecutive successes after the recovery window close the managed context;
- a new fallback resets recovery tracking;
- a user-owned Kick tab replaces the managed context without ever being closed by cleanup;
- service-worker state restoration reuses a valid context;
- a manually closed or navigated context is forgotten and replaced without duplication;
- disabling Kick, stopping automation, and manual-watch takeover close only managed contexts;
- every lifecycle action has a safe reason and diagnostics contain hostnames but no sensitive URL or request details.
- every successful managed page-context creation and closure appears in the Activity view even with diagnostic logging disabled, with the correct localized reason;
- reuse, retention, failed close attempts, and user-initiated tab closure do not produce false open/close activity events.

After focused tests, the complete `pnpm verify` command must pass before publication.

## Out of Scope

- Spoofing Kick's page origin or restricted browser headers.
- Exporting, persisting, or otherwise changing credential handling.
- Removing the page fallback when Kick demonstrably rejects service-worker access.
- Changing Twitch page-context behavior except where shared helpers require ownership-safe diagnostics.
