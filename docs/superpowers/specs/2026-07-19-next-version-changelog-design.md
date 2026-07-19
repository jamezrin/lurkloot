# Version 1.7.0 Changelog Design

## Goal

Add a concise, customer-facing changelog entry for version 1.7.0 based on the product changes merged after version 1.6.0.

## Scope

Prepend an undated `1.7.0` entry to `packages/site/src/changelog.json`. Release preparation will assign the date later.

The entry will contain three changes:

- `new`: Added automatic claiming for completed Kick daily challenges, with separate per-platform controls for Kick challenges and Twitch channel points.
- `new`: Lurkloot now avoids farming rewards that cannot be completed before their deadline, with an adjustable safety margin.
- `improved`: Twitch now starts progressing toward the next reward sooner after a claim instead of waiting for the next scheduled cycle.

Internal release-pipeline fixes, dependency updates, and repository documentation changes are excluded because they do not change the customer experience.

## Validation

Run the site tests to validate the changelog JSON and rendered site, then run the release-note renderer for version 1.7.0 to confirm the generated headings and bullets.
