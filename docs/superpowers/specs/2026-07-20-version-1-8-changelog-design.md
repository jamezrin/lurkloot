# Version 1.8.0 Changelog Design

## Goal

Add a concise, customer-facing changelog entry for version 1.8.0 based only on product changes merged into `origin/develop` after version 1.7.0.

## Scope

Prepend an undated `1.8.0` entry to `packages/site/src/changelog.json`. Release preparation will assign the date later.

The entry will contain three improvements:

- Reorganized Settings and refreshed the footer attribution links.
- Renamed “Watch Queue” to “Idle Watchlist” to make its purpose clearer.
- Settings now migrate reliably between version upgrades, preserving preferences as configuration evolves.

Dependency updates and release-pipeline changes are excluded because they do not directly change the customer experience. Changes that exist only on unmerged branches or worktrees are also excluded.

## Validation

Validate the changelog JSON, build the Astro site, and inspect the resulting version 1.8.0 entry for correct wording and ordering.
