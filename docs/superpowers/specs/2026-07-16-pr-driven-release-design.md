# PR-Driven Release Automation Design

## Summary

Lurkloot releases will be activated and controlled by pull requests to `main`, not by manually dispatching release workflows. A release label opts a PR into the lifecycle. Draft PRs own mutable candidates, making the PR ready starts Chrome Web Store (CWS) submission, and merging a staged candidate promotes it to stable.

The automation is a reconciler: every relevant PR event reads the current PR, candidate metadata, GitHub release, and CWS state, then performs the minimum safe transition toward the desired state. This makes duplicate events, reruns, label replacement, and interrupted workflows idempotent.

Git tags remain the canonical release identity. The PR head branch is only the temporary reviewed workspace and need not follow a release-specific naming convention.

## Goals

- Make a labeled PR to `main` the normal release activator.
- Require no manual workflow dispatch during a successful release.
- Calculate versions from the stable version on `main` and exactly one release label.
- Keep draft candidates mutable and refresh them when their head changes.
- Automatically begin CWS submission when the PR becomes ready for review.
- Promote the exact reviewed candidate when the PR is merged.
- Reconcile label and head changes safely, including after CWS submission.
- Notify the PR author about progress, required actions, and blockers.
- Ensure only administrators can authorize credentialed deployment of a candidate SHA.
- Preserve narrowly scoped, idempotent recovery operations.

## Non-goals

- Replacing CWS staged publishing or its review process.
- Automating AMO publication.
- Treating branch names as release authorization.
- Allowing an explicitly entered version to override label-derived versioning.
- Supporting multiple simultaneous CWS candidates; the store permits only one active submitted revision.

## Release classification and versioning

Release automation applies only to same-repository PRs targeting `main`. Fork PRs are always ineligible.

The recognized, mutually exclusive labels are:

| Label | Kind | Version derived from stable `X.Y.Z` on `main` |
| --- | --- | --- |
| `release/patch` | normal | `X.Y.(Z+1)` |
| `release/minor` | normal | `X.(Y+1).0` |
| `release/major` | normal | `(X+1).0.0` |
| `release/hotfix` | hotfix | `X.Y.(Z+1)` |

Exactly one recognized label opts a PR into release automation. No recognized label means the PR is ordinary and causes no release action unless automation must retire a candidate previously associated with it. Two or more recognized labels fail the `release-policy` check and prevent new release-side effects.

Normal release heads must be snapshots derived from `develop`. At initial authorization, the current `develop` commit must be an ancestor of the candidate head. The automation records that develop SHA as provenance; later movement of `develop` does not invalidate the snapshot.

Hotfix heads must descend from `main` and must not include commits that are exclusive to `develop`, using the repository's existing hotfix-history validation.

The label-derived version, stable base version, release kind, provenance SHAs, PR number, and authorizing administrator are recorded in candidate metadata. Reruns validate these values rather than silently reinterpreting an existing candidate. If `main` advances before a candidate is frozen, reconciliation retires the obsolete candidate and recalculates from the new stable base. A frozen candidate blocks such reinterpretation until it has been cancelled safely.

## Authorization and trust boundaries

A label is intent, not deployment authority.

The actor applying or changing a release label must have repository `admin` permission. An unauthorized label remains visible but inert: `release-policy` fails and the bot explains that an administrator must remove or reapply it. Automation does not silently rewrite user labels.

Authorization is bound to the PR number, head SHA, selected release label, and derived version. A push changes the SHA and invalidates earlier authorization and all environment approvals. Credential-free validation and builds may run for the new SHA, but signing or deployment requires fresh administrator approval. The approval of the first protected deployment environment for that SHA renews authorization; an administrator does not need to remove and reapply an unchanged label after every push. A label replacement still requires the replacement label event itself to come from an administrator.

Credentialed operations remain separated behind protected GitHub environments with administrator reviewers:

- `prereleases` for candidate publication state and signed artifacts;
- `cws-review` for CWS submission;
- `prerelease-site` for the Cloudflare `next` deployment;
- `stable-releases` for stable GitHub and container promotion;
- `production-site` for the production site.

Environment configuration must prevent self-review where appropriate and invalidate approval when the job or candidate SHA changes.

Release orchestration and credentialed mutation use trusted tooling checked out from `main` at an immutable SHA. Candidate code cannot replace scripts that receive credentials. Jobs that execute candidate-controlled build scripts are credential-free. Signed artifacts, GHCR writes, CWS mutation, and Cloudflare deployment occur in isolated authorized jobs. Artifacts crossing that boundary are identified by checksum and candidate SHA.

## Architecture

### PR release controller

A small controller reacts to relevant `pull_request` events for PRs targeting `main`:

- `opened`
- `reopened`
- `synchronize`
- `labeled`
- `unlabeled`
- `converted_to_draft`
- `ready_for_review`
- `closed`

The controller runs trusted code, obtains the relevant concurrency lock, re-reads live PR state, validates authorization and policy, inspects candidate and CWS state, derives a desired state, and invokes the minimum transition. Event payloads are hints only; live state is authoritative.

The controller never checks out and executes PR-controlled release tooling with credentials. Its permissions are limited by phase, and external mutations remain in reusable workflows protected by environments.

### Durable state

The GitHub prerelease and its `candidate.json` remain the canonical candidate record. The record includes at least:

- schema version;
- release version and kind;
- stable base version and SHA;
- normal-release develop provenance SHA when applicable;
- candidate source SHA and current PR head SHA;
- PR number;
- PR author and authorizing administrator;
- selected release label;
- trusted tooling SHA;
- artifact names and SHA-256 checksums;
- Docker digests;
- CWS state;
- preview deployment URL;
- creation and last-reconciliation timestamps.

The existing `cws-mutation` concurrency group serializes store changes. Candidate preparation is serialized per PR, and stable promotion remains globally serialized. Before every mutation, the workflow rechecks the PR head, labels, authorization, candidate metadata, and external state after acquiring the lock.

## Lifecycle

### Draft candidate

When a draft PR has one valid release label and current administrator authorization, automation:

1. Validates ancestry, version availability, changelog structure, and workspace checks.
2. Builds extension artifacts and candidate Docker images from the authorized SHA.
3. Produces signed release artifacts in an isolated authorized phase.
4. Uploads or replaces the mutable CWS draft.
5. Creates or replaces the mutable `vVERSION` Git tag and GitHub prerelease.
6. Publishes the version and `next` Docker candidate aliases from recorded digests.
7. Builds and deploys the site to the Cloudflare Pages `next` branch.
8. Updates checks and PR notifications.

A push while the PR is draft invalidates the previous SHA, waits for renewed administrator authorization where credentials are required, and replaces the candidate only after the new build succeeds. The previous candidate remains intact if replacement fails.

### Ready for review

The `ready_for_review` event automatically starts submission; users do not dispatch a workflow. The controller first verifies that candidate metadata, tag, artifacts, label, authorization, and PR head all agree.

Submission pauses at the protected `cws-review` environment. The bot notifies the PR author that administrator approval is required. After approval, the workflow independently rebuilds the unsigned Chrome ZIP in a credential-free job, compares its normalized checksum with the recorded candidate, and submits the exact version with `STAGED_PUBLISH`.

The candidate becomes frozen. Its tag, source SHA, artifacts, version, and Docker digests must not change while CWS is `PENDING_REVIEW` or `STAGED`. The `cws-release-ready` check stays pending until CWS is staged and release metadata validation finishes.

### CWS monitoring and finalization

The scheduled monitor continues polling CWS, with an optional immediate refresh recovery command. It comments only when state changes.

When CWS reports `STAGED`, automation dates the changelog and synchronizes package versions in a tightly scoped metadata-only commit on the PR head. It verifies that this is the sole difference from the frozen candidate, reruns validation, updates GitHub release notes, and completes `cws-release-ready`. No extension or Docker artifact is rebuilt.

The bot then tells the PR author that CWS has approved the candidate and the PR can be approved and merged.

### Stable promotion

Closing or merging an unlabeled or invalidly labeled PR performs no stable release action. A merged PR promotes only when all of these match:

- PR number;
- derived version and release kind;
- frozen source SHA plus the permitted metadata-only finalization commit;
- immutable candidate tag and checksums;
- successful release checks;
- CWS `STAGED` state;
- recorded administrator authorization.

Promotion retains the current order and recovery behavior:

1. Verify the reviewed candidate and stable merge.
2. Publish the staged CWS revision.
3. Promote stored Docker digests to version, minor, major, and `latest` aliases.
4. Convert the existing GitHub prerelease to a stable release.
5. Deploy the merged site to Cloudflare Pages production.
6. Open a `main` to `develop` synchronization PR.
7. Notify the release PR that publication completed.

Promotion is idempotent and never rebuilds stable artifacts or force-moves a stable tag.

## Reconciliation rules

### Label removal or replacement

If a mutable candidate's label is removed, automation retires it and stops. If the label is replaced with another single valid label, automation retires the old candidate and prepares the newly derived one after administrator authorization.

If CWS is `PENDING_REVIEW` or `STAGED`, removal or replacement automatically attempts to cancel the exact submitted revision, marks the old GitHub prerelease as cancelled, clears candidate checks, and converts the PR to draft. With one valid replacement label, the new candidate is prepared only after cancellation is confirmed and the new mode and SHA are authorized.

Multiple recognized labels are an invalid desired state. Automation safely cancels or retires an existing candidate, converts the PR to draft when necessary, and blocks until exactly one or zero labels remain.

### Head changes

A head change while mutable replaces the candidate after renewed authorization. A head change while submitted triggers cancellation, cancellation confirmation, conversion to draft, and preparation of the new candidate. It never mutates a frozen tag or overwrites a submitted CWS revision in place.

### Draft conversion and closure

Converting a ready PR back to draft cancels an active CWS submission and restores a mutable candidate only after cancellation is confirmed.

Closing without merging retires a mutable candidate or cancels and retires a submitted candidate. Stable tags and releases are never removed. Candidate Docker aliases are removed only when their ownership can be proven unambiguously.

### Irreversible or uncertain external state

If CWS refuses cancellation, reports an unexpected version, has begun publication, or otherwise cannot prove the requested transition safe, reconciliation stops. The release checks fail and the bot posts exact recovery guidance. No replacement candidate is created over uncertain store state.

## PR checks and notifications

Required checks separate concerns:

- `release-policy`: label cardinality, administrator authorization, fork policy, ancestry, and version derivation;
- `release-candidate`: current artifacts and metadata match the authorized PR head and version;
- `cws-release-ready`: pending until the exact candidate is staged and finalized, then successful;
- existing repository validation checks.

The bot maintains one sticky release-status comment containing:

- release kind and derived version;
- current authorized source SHA;
- state: preparing, mutable, awaiting approval, CWS review, staged, promoting, stable, cancelled, or blocked;
- GitHub release, preview, CWS dashboard, and relevant workflow links;
- artifact checksum and Docker candidate tag when available;
- current automation activity;
- next expected user action;
- blocker and recovery instructions when applicable.

Stable hidden markers make status updates and milestone notifications idempotent. Repeated polling in the same state is silent. Separate milestone comments mention the PR author when:

- a candidate is ready to inspect;
- administrator environment approval is required;
- CWS submission is pending review;
- CWS is staged and the PR may be merged;
- a push or label change caused cancellation and rebuilding;
- automation needs intervention;
- stable promotion completes.

A never-activated PR with no release label receives no release comment. An unauthorized or multi-label attempt receives a blocker comment but creates no release artifacts.

## Workflow changes

- Add a trusted PR release-controller workflow and testable reconciliation model.
- Convert `prepare-prerelease.yml` into a reusable candidate-preparation phase operating on an existing PR; remove its normal responsibility for creating branches and PRs.
- Convert `submit-candidate.yml` into a reusable ready-for-review phase invoked by the controller.
- Convert `cancel-candidate.yml` into the reusable cancellation and retirement phase used by reconciliation.
- Keep `monitor-cws.yml` scheduled and reusable for immediate status refresh.
- Harden `promote-release.yml` to trust candidate metadata and checks rather than branch prefixes.
- Keep `build-extension.yml`, `build-docker.yml`, `site-deploy.yml`, and `forward-hotfix.yml` as reusable building blocks, with stricter trust boundaries where candidate code executes.
- Add the fast `release-policy` check independently of full PR validation so label mistakes receive immediate feedback.
- Update `RELEASING.md` to describe the PR-driven lifecycle and repository/environment configuration.

Normal operation exposes no manual release dispatch. Narrow recovery commands may remain for:

- reconciling a specified PR;
- immediately refreshing CWS status;
- retrying idempotent promotion for a merged PR;
- cancelling or abandoning a candidate when automatic reconciliation reports that it cannot proceed.

Recovery derives version, kind, PR, and SHA from live PR state and candidate metadata. Operators cannot supply an arbitrary replacement version.

## Failure handling

- Candidate replacement is transactional: do not retire the last good mutable candidate until its replacement artifacts are verified and the external transition can complete safely.
- Every external mutation is retryable or explicitly terminal and is followed by a state read-back.
- A stale workflow exits without mutation after detecting that labels, head SHA, authorization, or candidate identity changed.
- Check output and the sticky PR comment identify the failed phase, retained state, safe retry, and any required administrator action.
- Stable promotion accepts only documented idempotent recovery, including a matching already-published CWS version.
- Stable tag, checksum, source, Docker digest, or CWS mismatches stop promotion.

## Testing strategy

Unit-test the reconciliation model independently from GitHub Actions YAML. Cover at least:

- all label cardinalities and version bump calculations;
- unauthorized label application and authorization invalidation on push;
- normal and hotfix ancestry validation;
- duplicate and out-of-order GitHub events;
- draft refreshes and failed transactional replacements;
- label removal and each label-to-label transition;
- ready, draft, closed, and merged transitions;
- head or label changes during `PENDING_REVIEW` and `STAGED`;
- cancellation refusal and unexpected CWS states;
- stale workflow detection after lock acquisition;
- idempotent notifications and promotion recovery;
- refusal to promote an unlabeled, mismatched, or never-authorized PR.

Add script-level tests for rendered checks, comments, candidate schema, and recovery commands. Validate workflow syntax and permissions, then exercise a non-production test repository or dry-run fixture before enabling production environment secrets. Run `pnpm verify` before merging the workflow migration.

## Migration

Land the controller, reusable workflow refactors, documentation, checks, and environment protections together through the existing protected release process. Synchronize the resulting automation to both `main` and `develop` before activating PR-driven releases.

Do not migrate an active candidate mid-review. Complete or cancel it with the existing workflow first. After migration, disable the old general-purpose prepare and submit dispatch entry points, retain only documented recovery operations, and configure the new required checks and administrator environment reviewers before labeling the first release PR.
