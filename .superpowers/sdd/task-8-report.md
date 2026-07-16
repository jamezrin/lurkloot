# Task 8 report

## Outcome

- Replaced both dispatch-only lifecycle workflows with exact reusable `workflow_call` contracts.
- Cancellation is serialized by the global CWS lock, validates schema-v2 candidate ownership and live PR/release state, fails closed for published, mismatched, policy-blocked, or unknown state, confirms terminal cancellation, then drafts the PR. Audit tag/assets are retained; Docker deletion is retirement-only and uniquely attributable.
- Submission rebuilds the unsigned Chrome package, uses live-main trusted tooling, validates provenance/checksum and exact ready PR ownership before the approval gate, revalidates after `cws-review` approval, submits staged publishing idempotently, and emits a deduplicated `cws-pending` milestone without changing PR readiness.
- Added reusable automatic lifecycle milestone guidance and snapshot coverage for `candidate-rebuilding`, `environment-approval`, `cws-pending`, and `reconciliation-blocked`.

## Verification

- `node --test scripts/release/workflows.test.mjs scripts/release/github.test.mjs`: 36 passed.
- `pnpm release:test`: 97 passed.
- `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`: passed.
- `pnpm dlx actionlint@1.7.7` could not run because npm has no matching package version; the pinned upstream Go command was used instead.
- `git diff --check`: passed.

## Self-review

- Privileged jobs execute only a SHA independently resolved from live `main`; candidate code never receives CWS credentials.
- Both CWS mutations share `cws-mutation` with `cancel-in-progress: false`.
- All replacement-success outputs remain false until cancellation is read back as no submission or the exact version in `CANCELLED`.
- Task 6 controller wiring remains intentionally deferred; these interfaces are ready for it.

## Concerns

- GitHub reusable-workflow outputs from a failed cancellation job are not intended as a recovery API; callers must treat workflow failure as `safe_to_replace=false`, regardless of any partial output visibility.

## Review fixes

- Replaced every schema-v2 `releaseLabel` lookup with the canonical `label` field and added workflow contract guards against regression.
- Submission now resolves and verifies live `main`, passes both the exact candidate `version` and independently resolved trusted tooling SHA into the verification rebuild, and checks the rebuilt Chrome checksum against the frozen candidate.
- Cancellation now reads `isDraft` and only runs `gh pr ready --undo` when necessary. Its CWS confirmation, draft conversion, release annotation, and retirement cleanup remain retry-safe after partial success.
- The pre-approval verification job now seals the complete downloaded release assets, candidate metadata, fresh Chrome checksum, version, source/head SHA, release label, and trusted tooling SHA into an uploaded evidence artifact. After `cws-review`, submission downloads that sealed evidence and the frozen release assets again, verifies both checksum manifests, reruns schema-v2 metadata/assets validation, compares every identity field, and rechecks live `main`, PR, prerelease, and tag state before CWS mutation.
- Cancellation always publishes false outputs before failure, updates `release-candidate`, upserts the sticky release status, and emits a deduplicated `reconciliation-blocked` notification. Submission similarly upserts blocked recovery state and fails `cws-release-ready` when its mutation path fails.
- Successful submission idempotently updates the sticky status, GitHub prerelease CWS notes, pending `cws-release-ready` check, and deduplicated `cws-pending` milestone.
- Expanded workflow contract coverage for all review findings.

## Review verification

- `node --test scripts/release/workflows.test.mjs scripts/release/github.test.mjs`: 36 passed.
- `pnpm release:test`: 97 passed.
- `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`: passed against all workflows.
- `git diff --check`: passed.
