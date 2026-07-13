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

Open a pull request and merge it into `main`. The unified workflow creates the GitHub pre-release, attaches the Chrome CRX/ZIP, Firefox ZIP/source ZIP, and checksums, and uploads the Chrome ZIP as an unsubmitted Chrome Web Store draft. It also publishes the `VERSION`, `main`, and `sha-COMMIT` Docker tags; `latest` remains on the newest stable version.

While `prerelease: true`, every subsequent successful `main` build replaces the pre-release assets, CWS draft, version tag, and mutable Docker tags. Once a CWS revision is submitted for review or approved for deferred publishing, later builds leave that revision frozen.

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

Before promotion, manually submit the CWS draft for review with automatic publishing disabled. Wait for its status to become ready to publish. Then open and merge the promotion pull request and approve its waiting `stable-releases` deployment in GitHub Actions. The workflow validates and publishes the approved CWS candidate before promoting the GitHub release and publishing `VERSION`, `MAJOR.MINOR`, `MAJOR`, `latest`, and `sha-COMMIT` Docker tags.

After the workflow succeeds:

1. Confirm the Chrome Web Store and GitHub Release both show the new version, then upload the Firefox ZIP/source ZIP to AMO.
2. Deploy the dated public changelog with `pnpm --filter @lurkloot/site cf:deploy`.
3. Prepare the next pre-release before merging further feature changes. The stable-release guard intentionally refuses to mutate the released version.

## Artifacts and credentials

The release contains Chrome CRX/ZIP, Firefox ZIP/source ZIP, and `SHA256SUMS`. CRX3 packaging uses the pinned `crx3@2.0.0` CLI and the `CRX_PRIVATE_KEY` Actions secret. Store a PEM-encoded RSA private key in that secret and preserve it permanently: replacing it changes the sideloaded extension ID. Pull requests build unsigned ZIPs and both Docker architectures, but do not receive that secret or publish anything.

Create the GitHub environments `prereleases` and `stable-releases`; add required reviewers to `stable-releases`. `GITHUB_TOKEN` supplies scoped release and GHCR access. No registry deletion occurs during publication. The scheduled retention workflow removes only old untagged GHCR versions and keeps at least ten.

Chrome Web Store automation requires repository secret `CWS_SERVICE_ACCOUNT_JSON` and repository variables `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID`. Add the service-account email to the publisher in the Chrome Developer Dashboard. Pull requests never receive the credential and never contact CWS.

## Chrome Web Store lifecycle

Each eligible mutable pre-release build replaces the unsubmitted CWS draft with the same declared version. A successful upload moves the automated `cws-vVERSION-candidate` tag to record its source commit and Chrome ZIP checksum. The workflow never submits a draft for review.

When choosing a candidate, submit it manually in the Developer Dashboard and disable automatic publishing after approval. CWS reports `PENDING_REVIEW` during review and `STAGED` after approval; both states freeze automated draft replacement. Approved staged submissions expire after 30 days.

Stable promotion requires all of the following:

- CWS reports the declared version as `STAGED`, or already `PUBLISHED` during recovery.
- The candidate tag is an ancestor of the promotion commit.
- No extension build inputs changed after the candidate upload.

The protected workflow publishes CWS first, Docker aliases second, and the GitHub stable release last. These services cannot be updated transactionally; if a later step fails, rerun the same commit. CWS publication is idempotent and the GitHub release remains a pre-release until its own publication step succeeds.

## Recovery

Re-run a failed workflow after correcting credentials or transient infrastructure. Mutable pre-releases may safely be rebuilt: assets and mutable tags are replaced only after validation succeeds. Resolve CWS `REJECTED`, `CANCELLED`, warning, or takedown states in the Developer Dashboard. To replace a revision under review, cancel its review before merging another candidate build.

A stable rebuild requires a manual workflow dispatch with `allow_stable_rebuild` and approval through `stable-releases`; use this only to recover corrupt or missing artifacts, never for code changes.

If publication partially succeeds, rerun the same commit. The release job re-uploads the full asset set and verifies its checksums, while Docker publication recreates the multi-architecture manifest. Never manually move a stable tag to different source code.

## Store upload

GitHub Releases are the canonical built artifacts. Chrome review submission and AMO upload remain manual; approved Chrome publication is automated during stable promotion. Download the verified Firefox ZIP/source ZIP from the stable GitHub release for AMO, and deploy the site so its dated changelog is live before users update.
