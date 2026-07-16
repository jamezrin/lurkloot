# GitHub-UI Release Lifecycle Design

## Goal

Replace the manifest-driven release toggle on `main` with a controlled release train that is operated through GitHub pull requests and Actions. All work merged to `develop` at the release cut belongs to the next normal release. Hotfixes can ship from `main` without including unreleased `develop` commits. Chrome Web Store review, GitHub releases, Docker publication, and Cloudflare Pages deployments must promote the same reviewed candidate.

The normal path must require no local release command. Exceptional version selection, cancellation, status refresh, and recovery must also be available through the GitHub UI.

## Branch Model

- `main` contains the source of the latest stable release plus any hotfix currently being prepared from it.
- `develop` is the integration branch. Everything merged into it before a release cut is included in that normal release.
- `release/VERSION` is a short-lived, automated snapshot of `develop` at the point a normal candidate is frozen for review.
- `hotfix/SHORT-DESCRIPTION` starts from `main` and targets `main`. It never contains `develop` commits.

A mutable normal prerelease can follow the head of `develop`. Preparing it creates `release/VERSION` and a draft PR to `main`; updating it refreshes that draft branch from a newer `develop` head. Freezing it for CWS review locks the recorded candidate commit. Further `develop` commits then belong to the following release. The candidate code cannot change while CWS review is active.

After a hotfix reaches `main`, automation opens a `main` to `develop` synchronization PR. Conflicts remain visible for manual resolution; automation must never merge `develop` into `main` as part of hotfix synchronization.

## Release State Model

Each version has one explicit state:

1. **Mutable draft**: GitHub prerelease assets, the prerelease tag, the unsubmitted CWS draft, Docker candidate aliases, and the preview site may be replaced from a selected source ref.
2. **Pending review**: the candidate has been submitted to CWS with staged publishing. Its source commit and artifacts are frozen.
3. **Staged**: CWS approved the exact candidate and is waiting for explicit publication. The release PR is eligible to merge when all other required checks and reviews pass.
4. **Stable**: the release PR was merged, the staged CWS revision was published, the GitHub prerelease was promoted, stable Docker aliases were updated, and the production site was deployed. The tag and assets are immutable.
5. **Cancelled**: CWS submission was cancelled when applicable. The release PR is returned to draft for replacement or closed as abandoned. Historical workflow runs and comments remain as the audit trail.

State transitions are monotonic except that cancelling `PENDING_REVIEW` returns the version to a mutable draft. A stable release can never return to a prerelease or be rebuilt from different code.

## GitHub UI Operations

### Prepare or update prerelease

A manually dispatched `Prepare prerelease` workflow accepts:

- `version`: an explicit stable SemVer such as `1.5.0`;
- `source_ref`: defaults to `develop`, but may be another branch or commit for recovery;
- `release_kind`: normal or hotfix;
- `pr_number`: required for a hotfix candidate and inferred for an existing release candidate.

For normal releases, the workflow validates that the source is reachable from `develop`. For hotfixes, it validates that the PR targets `main`, its branch is based on `main`, and its head does not contain commits reachable only from `develop`.

The workflow calculates and validates version ordering against the latest stable version and every active CWS candidate. Convenience `release/patch`, `release/minor`, and `release/major` PR labels may prefill or validate the expected bump, but labels never initiate publication or override an explicit version.

For a normal release, the workflow creates or refreshes `release/VERSION` from the exact source SHA and creates its draft PR to `main` if needed. For a hotfix, the existing hotfix PR is the release PR. The workflow applies the release version in the build workspace, verifies the repository, builds signed extension artifacts and Docker images, and creates or replaces the `vVERSION` GitHub prerelease. It uploads the same Chrome ZIP to the unsubmitted CWS draft, deploys the site to the Cloudflare `next` branch, and records the source SHA plus asset hashes in the GitHub release body and PR comment.

Updating is permitted only while CWS has no active submitted revision for the version. The workflow moves the prerelease `vVERSION` tag only during this mutable phase. It refuses to modify a `PENDING_REVIEW`, `STAGED`, or stable version.

### Freeze and submit for review

For a normal release, a manually dispatched `Submit candidate` workflow verifies that the draft `release/VERSION` branch still resolves to the recorded candidate source. It verifies that a fresh build from that source produces the recorded Chrome ZIP checksum.

For a hotfix, the existing hotfix PR is the release PR and its current head must match the recorded candidate SHA.

After verifying provenance, the workflow submits the existing CWS draft using `STAGED_PUBLISH`. This makes deferred publication mandatory rather than relying on a dashboard checkbox. It marks the release PR ready for review and prevents changes to candidate code.

When the candidate upload initially completes, the workflow comments on the release PR and tags the GitHub user who initiated the candidate. The comment links to the CWS dashboard, identifies the version, source SHA, GitHub prerelease, and Chrome ZIP checksum, and explains how to inspect and submit the candidate. After API submission it comments with the observed CWS state.

### Monitor CWS review

A required commit status or check run named `cws-release-ready` gates the release PR. A scheduled workflow polls active release PRs every 30 minutes. A manually dispatched `Refresh CWS status` workflow provides an immediate refresh.

The monitor maps CWS states as follows:

- `PENDING_REVIEW`: keep the check pending and comment once on transition;
- `STAGED`: write or update the single release-metadata commit described below, pass the check, and comment once, tagging the initiating releaser that the PR is ready for final approval and merge;
- `REJECTED`, `CANCELLED`, policy warning, or takedown: fail the check and comment once with recovery guidance;
- `PUBLISHED`: pass only in an explicitly recognized partial-publication recovery;
- missing or mismatched version: fail closed.

Comments are transition-based and deduplicated using the last state recorded in a release PR marker or workflow-owned metadata. Scheduled polling must not generate repeated comments.

### Cancel or abandon

A manually dispatched `Cancel candidate` workflow accepts the version and whether to keep it mutable or abandon it.

If CWS is `PENDING_REVIEW`, the workflow calls `cancelSubmission` and waits until the submission is cancelled or absent. A staged candidate cannot be silently replaced; cancellation must either be supported by the current CWS state or fail with dashboard guidance. The workflow returns a kept candidate's PR to draft and enables replacement. For abandonment, it closes the release PR, marks the GitHub prerelease as cancelled in its title and body, removes mutable Docker aliases if safely attributable, and leaves immutable historical tags/assets unless deletion is explicitly chosen in a separate recovery operation.

A higher candidate version may be prepared after cancellation or abandonment. It only needs to be greater than the latest stable and compatible with CWS version ordering; it need not be the originally planned bump.

### Promote

Merging the release PR is the deliberate stable-release boundary. Branch protection requires normal validation, the configured human review policy, and `cws-release-ready` success.

The merge-triggered promotion workflow reads the version and candidate metadata from the merged release PR and immutable release record. It verifies:

- the PR head source and candidate record match;
- the Chrome ZIP hash matches the artifact uploaded before review;
- CWS reports the same version as `STAGED`, or `PUBLISHED` during idempotent recovery;
- the GitHub release is still a prerelease and its tag points to the recorded candidate commit;
- no stable release already exists at different code or with different assets.

It publishes CWS first, promotes Docker aliases second, converts the existing GitHub prerelease to a stable release third, and deploys the production site last. It never rebuilds extension artifacts during promotion. Each step is idempotent so the same merged commit can be rerun after partial failure.

When CWS first reaches `STAGED`, the monitor adds one workflow-owned release-metadata commit to the release PR. It synchronizes package manifest versions, changes the matching changelog entry from Unreleased to the current date, and contains no extension source changes. Candidate provenance continues to point to the earlier reviewed source SHA; verification permits only this declared metadata delta between that SHA and the final PR head. Branch protection runs validation again and any configured approval-after-latest-push rule applies. No bot commit is made after merge, and the production site is therefore reproducible from `main`.

## Hotfix Flow

A hotfix author creates a branch from `main`, opens a PR to `main`, and optionally applies `release/patch` or another release-bump label. `Prepare prerelease` targets that PR head and otherwise follows the same artifact, CWS draft, preview, submission, monitoring, and promotion lifecycle.

The required CWS and validation checks prevent the hotfix PR from merging before the candidate is approved. Merging publishes exactly the reviewed hotfix artifacts. Unreleased `develop` commits are absent by construction and verified by ancestry checks.

After stable publication succeeds, automation opens a `main` to `develop` synchronization PR tagged as a hotfix forward-merge. This PR uses normal validation and remains open on conflicts.

## Provenance Without a Candidate Tag

The dedicated `cws-vVERSION-candidate` tag is removed. Before stability, `vVERSION` itself is the mutable prerelease tag and points to the candidate source commit. The GitHub prerelease records:

- candidate source SHA;
- release PR number;
- initiating GitHub user;
- Chrome ZIP SHA-256;
- checksums for every downloadable artifact;
- CWS version and last observed state;
- Docker image digests;
- preview deployment URL.

Once CWS review begins, the tag and assets freeze. Once promoted, the same `vVERSION` tag and GitHub release become immutable. Stable promotion trusts the frozen GitHub artifact hashes and CWS version/status, not a second tag or a rebuild.

## Concurrency and Security

- One repository-wide CWS mutation concurrency group serializes upload, submission, cancellation, and publication.
- Per-version groups serialize candidate preparation and GitHub release mutation.
- Stable promotion never uses `cancel-in-progress`; a newer run may not interrupt external publication.
- Candidate workflows use the `prereleases` environment. Submission and cancellation use a protected `cws-review` environment. Promotion uses `stable-releases` and production site environments.
- Workflows triggered from forks never receive signing, CWS, Cloudflare, or package-publishing credentials.
- Workflow inputs are validated before a privileged job checks out or executes repository-controlled code.
- GitHub permissions are job-scoped and minimized. Release branch creation, PR comments, checks, and release mutation receive only their required write scopes.

## Failure and Recovery

External services cannot be updated transactionally. Operations therefore run in an order that avoids claiming stability before CWS publication and are idempotent at every boundary.

- A failed mutable candidate build leaves the previous candidate intact.
- A failed CWS upload does not move the prerelease tag or replace GitHub assets.
- A failed submission can be retried against the same artifact.
- A failed status poll changes no release state.
- A promotion failure is rerun for the same merged release PR and candidate hashes.
- If CWS published but a later service failed, recovery accepts the matching `PUBLISHED` version and completes GitHub, Docker, and site promotion.
- A stable tag or asset mismatch stops recovery and requires manual investigation; automation never force-moves a stable tag.

Every privileged workflow writes a concise job summary and a transition comment on the release PR. Errors identify the observed version/state and the exact safe next action.

## Validation and Tests

Unit tests cover version ordering, release-state transitions, CWS action selection, candidate metadata parsing, checksum validation, hotfix ancestry, and comment deduplication. Workflow-level tests or script fixtures cover normal release, mutable replacement, cancellation and replacement, higher-version abandonment, hotfix isolation, CWS rejection, and partial-promotion recovery.

Repository validation continues on both `develop` and `main`. Branch protection must require the existing typecheck, tests, extension builds, Docker build, and site build. Release workflows rerun the relevant verification before external mutation.

## Migration

1. Create and protect `develop`, initially at `main`.
2. Add the CWS review environment and required branch checks.
3. Introduce the new scripts and workflows alongside the existing declared-release workflow with publishing disabled in one path.
4. Test candidate preparation and CWS status reads without publishing.
5. Migrate the next prerelease to the new lifecycle.
6. Remove `release.channel`, the manifest-driven stable toggle, the old unified release workflow, and creation of `cws-vVERSION-candidate` after the new path completes one stable release.
7. Preserve existing stable tags and releases. Delete the obsolete candidate tag only after confirming it is not needed for an in-flight release.

## Operator Documentation

Root `RELEASING.md` is the canonical human release runbook and contains a Mermaid diagram for the normal and hotfix lifecycles. `README.md`, `AGENTS.md`, and the compatibility page at `docs/releases.md` link to that single source instead of duplicating instructions. `AGENTS.md` is the canonical repository guidance for coding agents; `CLAUDE.md` is a relative symbolic link to it.

## Out of Scope

- Automatically uploading to AMO unless separate credentials and publication requirements are designed.
- Selecting individual `develop` commits for a normal release.
- Rewriting stable releases or force-moving stable tags.
- Automatically resolving `main` to `develop` synchronization conflicts.
