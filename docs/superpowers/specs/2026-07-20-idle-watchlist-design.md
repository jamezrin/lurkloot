# Idle Watchlist Rename Design

## Goal

Rename the current Watch Queue feature to Idle Watchlist throughout Lurkloot without changing its behavior or losing existing extension and CLI configuration. Current product language should make clear that eligible drops remain the priority and the Idle Watchlist supplies ordered fallback channels only when no eligible drop can be farmed.

Historical changelog entries remain unchanged because they describe earlier product versions.

## Terminology

Current code, tests, UI, localization keys, documentation, and promotional copy use these names:

- `Idle Watchlist` for the feature.
- `idle watchlist` in prose where title case is not appropriate.
- `watchlist` and `channels` instead of `queue` and `queued`.
- `idleWatchlistChannels` for each platform's ordered fallback channels.
- `idleWatchlistFallbackOnly` for the setting that limits the watchlist to periods without an eligible drop.
- `idle_watchlist_selected`, `higher_priority_idle_watchlist`, and `keeping_idle_watchlist` for domain reason and event codes.

Legacy `watchQueue*` names remain only as compatibility aliases at extension-storage and CLI-config input boundaries. Historical changelogs and explicitly historical design or implementation documents may also retain the old terminology.

## Architecture

The shared settings model uses only the new names after normalization. The core scheduler, background controller, popup UI, extension adapters, CLI runtime, site demo, and tests consume that normalized model and therefore do not carry parallel legacy fields.

Both settings-loading boundaries accept old and new input shapes:

1. Read the new key when it is present.
2. Otherwise read the corresponding legacy key.
3. Apply the existing normalization, ordering, and deduplication rules.
4. Return and subsequently persist or generate only the new shape.

If old and new keys are both present, the new key wins even when its value is empty or false. This makes migration deterministic and lets users intentionally override legacy values.

No schema-version flag is required. The migration is idempotent because every load can accept the legacy shape while every current write uses the new shape.

## Product Surfaces

The rename covers:

- Popup tab, settings section, empty states, hints, tips, activity text, accessible labels, component identifiers, and demo data.
- Every supported locale catalog, including localization message keys and translated copy.
- Shared models and defaults, scheduler decisions, activity/event reason codes, controller mappings, and tests.
- CLI config parsing, validation, normalized settings, generated default config, help or log text, and compatibility tests.
- README, current architecture and store documentation, store-readiness copy, landing-site FAQ/features, and other current promotional content.
- Repository guidance that names current source files or domain concepts.

Source files and component names that encode `watchQueue` are renamed when doing so makes repository searches and ownership clearer. Public package exports are updated to the new names rather than retaining runtime aliases unless an input compatibility boundary needs them.

## Behavior

This change does not alter scheduling policy. Eligible drop campaigns remain the first-choice watch source. Idle Watchlist channels remain ordered, are checked using the same liveness behavior, ignore campaign-only excluded-channel filtering as before, and are selected according to the existing fallback-only setting.

The rename also does not add credentials, permissions, host access, or new external requests.

## Error Handling and Compatibility

Malformed legacy values follow the same defaulting and normalization behavior as malformed current values. A valid new key takes precedence over a legacy key; an invalid new value is normalized or defaulted according to existing loader rules rather than silently falling back to the legacy value.

Extension users retain saved channel lists and fallback settings on upgrade. Existing CLI config files continue to load indefinitely. Newly saved extension settings and newly generated CLI configs contain only `idleWatchlist*` keys.

Legacy event/reason codes are not accepted as settings input because they are transient internal state, not persisted configuration. They are renamed directly with their producers and consumers.

## Testing

Implementation follows test-driven development:

- Add failing shared/extension settings tests for legacy-only, new-only, and mixed-key precedence inputs before changing normalization.
- Add failing CLI settings tests for the same compatibility cases and verify generated configs use only new keys.
- Rename and update scheduler, controller, popup, tips, and locale-contract tests while preserving their behavioral assertions.
- Run repository searches that allow old terms only in intentional input aliases, migration tests, historical changelogs, and historical planning documents.
- Run the full `pnpm verify` suite before publication.

## Delivery

Work is implemented on `refactor/idle-watchlist` in `.worktrees/idle-watchlist`, committed using Conventional Commits, pushed to GitHub, and submitted as a draft pull request targeting `develop` with issue 176 linked in the description.
