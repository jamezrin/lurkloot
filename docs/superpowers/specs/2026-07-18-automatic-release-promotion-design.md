# Automatic Release Promotion Design

## Summary

Lurkloot will keep committed `release/X.Y.Z` pull requests as the reviewed release boundary, add
mutable preview deployments for those pull requests, and automatically publish the stable release
when the release pull request is merged into `main`. Normal development pull requests into
`develop` remain squash-only. Pull requests into `main` use merge commits so commits prepared on
`develop` retain their SHAs. After publication, a dedicated repository-scoped GitHub App merges
`main` directly back into `develop` without weakening branch protection for the general GitHub
Actions identity.

## Goals

- Select patch, minor, or major releases by applying exactly one recognized release label to a
  same-repository pull request targeting `main`.
- Keep the version bump, changelog date, and all seven workspace manifest versions committed before
  preview or stable artifacts are published.
- Refresh a mutable GitHub prerelease, candidate GHCR image, and shared `next` site deployment on
  every release pull request head change.
- Publish the stable GitHub release, GHCR aliases, Chrome Web Store submission, and production site
  automatically after the release pull request merges.
- Support a patch hotfix candidate and a later minor or major candidate at the same time.
- Preserve commit SHAs from release branches when they enter `main`.
- Squash ordinary pull requests into `develop`.
- Merge `main` directly into `develop` after a release with a narrowly scoped identity.
- Keep orchestration logic in tested Node ESM programs instead of embedding JavaScript or
  TypeScript in workflow YAML.

## Non-goals

- Displaying more than one site candidate. `next.lurkloot.pages.dev` represents the most recently
  completed candidate deployment.
- Uploading candidates to the Chrome Web Store. CWS receives only merged stable releases.
- Automating Firefox Add-ons publication.
- Cancelling a stable release or moving a stable tag.
- Making GitHub Actions itself a branch-protection bypass actor.

## Release identity and versioning

The highest stable `vX.Y.Z` tag is the released version source. A recognized label derives the next
version with ordinary SemVer arithmetic. The generated `release/X.Y.Z` branch contains the version
bump in every workspace manifest and the dated changelog entry. The generated release pull request
inherits the recognized release label so stable promotion can validate the requested bump again.

Different resulting versions may coexist. For example, while `v1.5.0` is stable, `release/1.5.1`
and `release/1.6.0` may both be open. A second pull request may not take ownership of an already-open
release branch for the same version.

After any intervening stable release, an older candidate must be brought up to date with `main` and
rebuilt before it can merge. For example, after `1.5.1` ships, `1.6.0` remains the correct minor
version, but its release branch must merge the new `main` so the hotfix is present. Required strict
checks and the candidate check prevent promotion of the stale head. If the newer stable version
makes the candidate version invalid, promotion fails and the candidate must be re-prepared under a
new version.

## Label lifecycle

The trusted label controller reacts to `labeled` and `unlabeled` events on pull requests targeting
`main`. It ignores generated `release/*` pull requests as preparation triggers.

- Exactly one recognized label prepares or refreshes its release branch and pull request.
- Two or more recognized labels post an explanatory pull request comment and fail without creating
  or modifying a candidate.
- Removing one label while another recognized label remains prepares the remaining selection.
- Removing the final recognized label posts an orphan notice. It does not delete candidate artifacts
  or branches because they may already be under review.
- Fork pull requests are ineligible. On this public repository, GitHub's native repository roles
  restrict label application; only the current administrator has triage-or-higher access.

The controller checks out trusted release tooling from the base branch separately from candidate
source. Candidate-controlled scripts never execute in the controller's write-token context.

## Candidate preview

A generated release pull request triggers candidate preparation on `opened`, `reopened`, and
`synchronize`:

1. Read and validate the committed version and release label without executing candidate code.
2. Run the workspace checks and full repository verification with a read-only token.
3. Build the normalized Chrome ZIP, Firefox ZIP, Firefox source ZIP, and signed CRX.
4. Build both CLI container architectures and publish the mutable `candidate-X.Y.Z` GHCR tag. Never
   move `latest`, `X`, `X.Y`, or the stable `X.Y.Z` tags.
5. Create or refresh the GitHub prerelease attached to the explicitly mutable
   `candidate-vX.Y.Z` tag. Refuse to take over a stable release or a candidate owned by another pull
   request.
6. Deploy the site to the shared `next` branch.
7. Maintain one sticky release-status comment on the generated release pull request.
8. Write the four validation contexts and a unique `release candidate / ready` context directly to
   the generated PR head. This preserves required-check semantics when GitHub suppresses events
   caused by the token that creates the PR.

Candidate tags and releases are preview pointers, not provenance anchors. They may move only while
the corresponding GitHub release remains a prerelease and retains matching ownership metadata.
Stable tags are immutable.

Candidate code builds in credential-free jobs. A separate credential-free job prepares the signer
from the trusted base ref and its integrity-pinned lockfile. The signing job receives only normalized
unsigned artifacts and that signer bundle, not a candidate checkout. The Docker publishing job
receives verified OCI archives but does not execute them. Preview credentials live in the `preview`
environment.

## Stable promotion

The stable workflow reacts to a merged `release/*` pull request into `main` and retains a manual
dispatch as an idempotent recovery entrypoint. It operates on the resulting `main` commit:

1. Validate the committed version, release label, stable predecessor, and workspace metadata.
2. Rebuild signed extension artifacts and export both Docker architectures as checksummed OCI
   archives from `main`, without registry credentials.
3. Pass the single `production` environment approval.
4. Create `vX.Y.Z` at the merged `main` commit, refusing to move an existing tag.
5. Create or update the stable GitHub release and upload verified artifacts.
6. Inside the production gate, publish GHCR `X.Y.Z`, `X.Y`, `X`, and `latest` aliases. Refuse to
   replace an existing version-specific digest.
7. Upload the Chrome ZIP and request `DEFAULT_PUBLISH`, which publishes after Google approval.
8. Remove the matching candidate prerelease and candidate tag only after the stable GitHub release
   exists.
9. Deploy the production site.
10. Merge `main` directly into `develop` using the dedicated sync App after verifying the merged
    tree. A fast-forward is preferred; otherwise an ordinary merge commit preserves ancestry.

Every external mutation is idempotent. A matching existing state is a no-op; an identity mismatch
fails instead of overwriting or moving a stable object.

## Branch and merge policy

Repository merge methods enable merge commits and squash merges and disable rebase merges.

- The `main` ruleset permits only merge-commit pull request merges. It requires pull requests and
  the existing verification checks plus `release candidate / ready`, blocks force pushes and
  deletions, and does not require linear history.
- The `develop` ruleset permits only squash pull request merges. It requires pull requests and the
  existing verification checks and blocks force pushes and deletions. Linear history is disabled
  because the dedicated synchronization App may add a merge commit.
- The synchronization App is the only bypass actor on the `develop` ruleset and has no bypass on
  `main`.
- The general GitHub Actions App is not a bypass actor.

## Dedicated synchronization App

The repository owner creates and installs a private GitHub App with repository `Contents: write`
and `Metadata: read`, installed only on `jamezrin/lurkloot`. Its App ID and private key are stored as
`RELEASE_SYNC_APP_ID` and `RELEASE_SYNC_APP_PRIVATE_KEY` in the protected `production` environment.
The workflow mints a repository-scoped installation token that expires after one hour. The App is
added to the `develop` ruleset bypass list and nowhere else.

The sync program fetches fresh `main` and `develop`, exits successfully when `main` is already an
ancestor of `develop`, fast-forwards when possible, and otherwise creates a merge commit. It runs
`pnpm verify` on the resulting tree before pushing. A conflict or failed verification leaves both
remote branches unchanged and fails the release run with recovery guidance.

## Repository configuration and rollout

Repository settings and rulesets are reconciled by a committed CLI using the GitHub REST API. The
CLI supports a dry-run mode and requires the installed synchronization App ID before activating the
new branch rules. Existing classic branch protections remain in place until the replacement rulesets
have been created and inspected. The rollout removes conflicting classic protection only after the
rulesets are active.

The App itself cannot be created without an owner-authorized GitHub App registration. Until its App
ID, installation, private key, environment secrets, and ruleset bypass are configured, the stable
publishing workflow fails before attempting direct synchronization rather than falling back to the
general Actions token or disabling protection.

## Testing

- Unit-test label cardinality, version derivation, generated-PR recognition, candidate ownership,
  stable promotion validation, GitHub App JWT/token behavior, prerelease reconciliation, and sync
  decisions.
- Test workflow invariants structurally: untrusted jobs have read-only tokens, credentialed jobs do
  not execute candidate source, stable tags cannot move, and the Actions App is not a bypass actor.
- Run `pnpm check`, both extension production builds, release-script tests, and YAML parsing.
- Exercise repository configuration in dry-run mode before applying it.

## Recovery

- Reapply the release label to retry preparation.
- Push a conflict resolution to a stale release branch to rebuild its candidate.
- Re-run the stable workflow manually on `main` after correcting an external failure.
- If direct synchronization conflicts, merge `main` into `develop` locally with the dedicated App
  credential or create a one-off reviewed synchronization PR; never disable branch protections.
- Never move an existing stable tag. Prepare a new version when stable identity disagrees.
