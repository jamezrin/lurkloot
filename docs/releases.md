# Releases

`release.yml` is the canonical declaration of the version currently being built and whether it is mutable (`prerelease: true`) or stable. `pnpm release:check` verifies that declaration, all in-lockstep package manifests, semver, and the changelog agree.

## Prepare a pre-release

From a clean `main`, run:

```bash
pnpm release:prepare 1.5.0 --prerelease
```

This updates `release.yml`, synchronizes the root, extension, core, CLI, locales, popup UI, and shared package versions, and creates an empty Unreleased changelog entry when needed. Fill in its user-facing changes, run `pnpm release:check`, and merge the preparation PR. Every subsequent successful relevant `main` build replaces the assets for that GitHub pre-release and moves its version tag. Pre-release Docker tags are `VERSION`, `main`, and `sha-COMMIT`; `latest` is never changed.

## Promote to stable

Use the actual public/store release date:

```bash
pnpm release:prepare 1.4.0 --stable --date 2026-07-12
pnpm release:check
```

Merge the declaration and dated changelog together. The protected `stable-releases` environment should require maintainer approval. The workflow rebuilds all assets, promotes the GitHub release, and publishes `VERSION`, `MAJOR.MINOR`, `MAJOR`, `latest`, and `sha-COMMIT` Docker tags. Later builds refuse to modify that stable version; prepare the next pre-release before merging another release-triggering change.

## Artifacts and credentials

The release contains Chrome CRX/ZIP, Firefox ZIP/source ZIP, and `SHA256SUMS`. CRX3 packaging uses the pinned `crx3@2.0.0` CLI and the `CRX_PRIVATE_KEY` Actions secret. Store a PEM-encoded RSA private key in that secret and preserve it permanently: replacing it changes the sideloaded extension ID. Pull requests build unsigned ZIPs and both Docker architectures, but do not receive that secret or publish anything.

Create the GitHub environments `prereleases` and `stable-releases`; add required reviewers to `stable-releases`. `GITHUB_TOKEN` supplies scoped release and GHCR access. No registry deletion occurs during publication. The scheduled retention workflow removes only old untagged GHCR versions and keeps at least ten.

## Recovery

Re-run a failed workflow after correcting credentials or transient infrastructure. Mutable pre-releases may safely be rebuilt: assets and mutable tags are replaced only after validation succeeds. A stable rebuild requires a manual workflow dispatch with `allow_stable_rebuild` and approval through `stable-releases`; use this only to recover corrupt or missing artifacts, never for code changes.

If publication partially succeeds, rerun the same commit. The release job re-uploads the full asset set and verifies its checksums, while Docker publication recreates the multi-architecture manifest. Never manually move a stable tag to different source code.

## Store upload and migration

GitHub Releases are the canonical built artifacts, but Chrome Web Store and AMO submission remains manual. Download the verified Chrome ZIP and Firefox ZIP/source ZIP from the stable GitHub release, upload them to their stores, and deploy the site so its dated changelog is live before users update.

The initial repository migration does not mutate GitHub. A maintainer must separately backfill `v1.3.0` and its stable release at the historical release commit, configure the environments and CRX key, then run the unified workflow for declared pre-release `1.4.0`. Confirm `latest` still points to `1.3.0` until promotion.
