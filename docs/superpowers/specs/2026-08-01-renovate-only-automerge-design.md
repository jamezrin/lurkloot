# Renovate-Only Auto-Merge Design

## Goal

Allow eligible non-major Renovate dependency pull requests to merge automatically after required checks pass, while preventing GitHub from auto-merging any other pull request.

## Current issue

Renovate was configured with `platformAutomerge: true`. That setting relies on the repository-wide GitHub auto-merge option. GitHub then allowed ordinary pull requests to opt into auto-merge, which could create merge commits despite the `develop` ruleset requiring squash merges for ordinary actors.

## Design

GitHub repository auto-merge will be disabled through the repository configuration script and applied to the live repository. `renovate.json` will configure only non-major updates to use Renovate-managed pull-request auto-merge with a squash strategy; it will not ask GitHub to manage the auto-merge queue.

The existing branch rulesets remain unchanged: ordinary PRs into `develop` are squash-only, release PRs into `main` are merge-commit-only, and only the release-sync App bypasses the `develop` rule.

## Verification

Repository-configuration tests will assert `allow_auto_merge: false`. Renovate configuration will be parsed by the existing configuration checks, and the live repository will be read back after updating the setting to confirm auto-merge is disabled. The full workspace test suite will be run after the change.
