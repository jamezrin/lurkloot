# Releases

`release.yml` is the canonical declaration of the version currently being built and whether it is mutable (`prerelease: true`) or stable. `pnpm release:check` verifies that declaration, all in-lockstep package manifests, semver, and the changelog agree.

## Prepare a pre-release

From a clean `main`, run:

```bash
git switch main
git pull --ff-only
git switch -c release/1.5.0

pnpm release:prepare 1.5.0 --prerelease
```

This updates `release.yml`, synchronizes the root, extension, core, CLI, locales, popup UI, and shared package versions, and creates an empty Unreleased changelog entry when needed. Fill in its user-facing changes in `packages/site/src/changelog.ts`, then validate and publish the preparation branch:

```bash
pnpm release:check
pnpm verify

git add release.yml package.json packages/*/package.json packages/site/src/changelog.ts
git commit -m "chore(release): bump version to 1.5.0"
git push -u origin release/1.5.0
```

Open a pull request and merge it into `main`. The unified workflow creates the GitHub pre-release and attaches the Chrome CRX/ZIP, Firefox ZIP/source ZIP, and checksums. It also publishes the `VERSION`, `main`, and `sha-COMMIT` Docker tags; `latest` remains on the newest stable version.

While `prerelease: true`, every subsequent successful `main` build replaces the pre-release assets, moves the version tag, and updates its mutable Docker tags.

## Promote to stable

Use the actual public/store release date:

```bash
git switch main
git pull --ff-only
git switch -c release/1.5.0-stable

pnpm release:prepare 1.5.0 --stable --date YYYY-MM-DD
pnpm release:check
pnpm verify

git add release.yml package.json packages/*/package.json packages/site/src/changelog.ts
git commit -m "chore(release): bump version to 1.5.0"
git push -u origin release/1.5.0-stable
```

Open and merge the promotion pull request, then approve its waiting `stable-releases` deployment in GitHub Actions. The workflow rebuilds all assets, promotes the GitHub release, and publishes `VERSION`, `MAJOR.MINOR`, `MAJOR`, `latest`, and `sha-COMMIT` Docker tags.

After the workflow succeeds:

1. Download the verified Chrome and Firefox artifacts from the stable GitHub Release and upload them to their stores.
2. Deploy the dated public changelog with `pnpm --filter @lurkloot/site cf:deploy`.
3. Prepare the next pre-release before merging further feature changes. The stable-release guard intentionally refuses to mutate the released version.

## Artifacts and credentials

The release contains Chrome CRX/ZIP, Firefox ZIP/source ZIP, and `SHA256SUMS`. CRX3 packaging uses the pinned `crx3@2.0.0` CLI and the `CRX_PRIVATE_KEY` Actions secret. Store a PEM-encoded RSA private key in that secret and preserve it permanently: replacing it changes the sideloaded extension ID. Pull requests build unsigned ZIPs and both Docker architectures, but do not receive that secret or publish anything.

Create the GitHub environments `prereleases` and `stable-releases`; add required reviewers to `stable-releases`. `GITHUB_TOKEN` supplies scoped release and GHCR access. No registry deletion occurs during publication. The scheduled retention workflow removes only old untagged GHCR versions and keeps at least ten.

## Recovery

Re-run a failed workflow after correcting credentials or transient infrastructure. Mutable pre-releases may safely be rebuilt: assets and mutable tags are replaced only after validation succeeds. A stable rebuild requires a manual workflow dispatch with `allow_stable_rebuild` and approval through `stable-releases`; use this only to recover corrupt or missing artifacts, never for code changes.

If publication partially succeeds, rerun the same commit. The release job re-uploads the full asset set and verifies its checksums, while Docker publication recreates the multi-architecture manifest. Never manually move a stable tag to different source code.

## Store upload

GitHub Releases are the canonical built artifacts, but Chrome Web Store and AMO submission remains manual. Download the verified Chrome ZIP and Firefox ZIP/source ZIP from the stable GitHub release, upload them to their stores, and deploy the site so its dated changelog is live before users update.
