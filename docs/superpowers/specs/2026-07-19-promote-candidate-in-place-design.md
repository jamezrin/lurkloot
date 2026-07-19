# Promote The Candidate Release In Place Design

## Summary

A release currently exists as two GitHub release objects. The candidate is published as a mutable
prerelease tagged `candidate-vX.Y.Z`; on merge, `release.yml` creates a **separate** stable release
tagged `vX.Y.Z` at the merge commit, rebuilds every artifact, and then deletes the candidate.

This design collapses them into one. The candidate is published as a prerelease tagged `vX.Y.Z` from
the start and mutated on every push. Merging the release pull request flips that same object to
`prerelease: false` with `make_latest: true`. The tag never moves at promotion, and the artifacts that
ship are byte-for-byte the ones that were built, signed, and reviewed as the candidate.

## Goals

- One release object and one tag, `vX.Y.Z`, across candidacy and stable publication.
- Mutate the prerelease on every push to the release branch.
- Promote by flipping prerelease/latest, never by creating or deleting a release.
- Ship the reviewed and signed artifacts rather than rebuilt ones.
- Keep `vX.Y.Z` naming a tree that is genuinely what landed on `main`.

## Non-goals

- Changing the merge-first flow from `2026-07-19-merge-first-release-flow-design.md`.
- Changing Chrome Web Store submission timing or the single production approval.
- Changing how the production site is built and deployed.
- Rebuilding or retagging the Docker image from candidate digests (see Deliberate asymmetry).

## Current behavior

| Concern | Today | Reference |
| --- | --- | --- |
| Candidate tag | `candidate-vX.Y.Z` | `pipeline.mjs:35-38` |
| Candidate mutation | In place, ref moved, assets replaced | `github.mjs:127-155` |
| Stable tag | Created fresh at the merge commit | `release.yml:169-177` |
| Stable release | Created fresh with `--latest` | `release.yml:178-186` |
| Stable assets | Rebuilt by the `extension` job | `release.yml:79-89` |
| Candidate teardown | Ref and release both deleted | `release.yml:239`, `github.mjs:178-186` |

## The tag identity problem

Promotion in place means the tag was created during candidacy, pointing at the **release branch
head**. The merge commit on `main` is a different SHA. The tag therefore names the branch head
permanently.

That is sound only if the branch head's tree is what actually landed on `main`. Because `main` admits
merge commits only, the branch head is always an ancestor of `main` — but if `main` advances between
the cut and the merge, the merge result's tree differs from the branch head's tree, and `vX.Y.Z` would
name a tree that never existed on `main`.

The fix is to require the release pull request to be up to date with `main` before it can merge, via
`strict_required_status_checks_policy` on the `main` ruleset. With that set, the branch head tree and
the merge result tree are identical by construction.

## Changes

### Candidate identity

`candidateTag(version)` returns `v${version}`. The ownership marker written into the release body is
unchanged in structure and still binds the release to one pull request and head branch, which is what
prevents a candidate from being mutated by anything other than its own release pull request. The
`refusing to modify candidate-v${version}` message in `assertOwnedPrerelease` is reworded, since the
tag no longer carries that prefix.

`assertOwnedPrerelease` keeps rejecting any release that is not a prerelease. This is the guard that
stops a candidate build from overwriting an already-promoted stable release: once promotion sets
`prerelease: false`, every later `reconcilePrerelease` call against that tag fails loudly.

### Promotion replaces creation

In `release.yml`, delete the "Tag the released commit" step (lines 169–177) entirely. The tag already
exists; creating it is now an error, and moving it is what the current guard rightly refuses.

Replace the create-or-update step (lines 178–186) with a promotion that requires the prerelease to
exist:

```
gh release view "v$VERSION" --json isPrerelease   # must exist and be a prerelease
gh release edit "v$VERSION" --prerelease=false --latest --notes-file notes.md
```

If no release is found, fail with a message directing the operator to re-run the candidate build. A
manual `workflow_dispatch` recovery on a version that never had a candidate is not a supported path,
and silently creating a release would defeat the point of promoting reviewed bits.

### Assets come from the prerelease

Delete the `extension` job from `release.yml` (lines 79–89) and its `needs` entry. The `publish` job
instead downloads the already-signed assets from the release it is about to promote:

```
gh release download "v$VERSION" --dir release-assets
cd release-assets && sha256sum -c SHA256SUMS
```

`SHA256SUMS` is generated at signing time (`build-extension.yml:179-181`) and covers every shipped
file, so this verifies the download end to end. The `assert-assets` step added in the previous change
still runs against the downloaded directory, so the published set is still checked against the
allowlist.

The Chrome Web Store step keeps using `release-assets/lurkloot-$VERSION-chrome.zip`, which now refers
to the downloaded, reviewed ZIP rather than a rebuilt one.

`retire-candidate` (line 239) is deleted, and `retirePrerelease` is removed from `github.mjs` and
`cli.mjs`. Deleting the release is now precisely the wrong action.

### Repository configuration

Add `strict_required_status_checks_policy: true` to the `required_status_checks` rule in
`mainRuleset()`. This is the constraint that makes tagging the branch head correct, so it is part of
this change rather than an operational afterthought, and `repository-config.test.mjs` asserts it.

## Deliberate asymmetry: Docker

The Docker image is still built in `release.yml` from the merge commit and published with the existing
digest-immutability check (`release.yml:194-223`). It is not promoted from the candidate digest.

This is consistent rather than sloppy: the strict up-to-date requirement makes the branch head tree and
the merge result tree identical, so a merge-commit build and a branch-head build have the same input.
That same equality is what makes tagging the branch head safe. Promoting Docker digests too would be a
reasonable follow-up, but it is not required for correctness and is out of scope here.

## Consequences accepted

`vX.Y.Z` is a published, moving tag for the duration of candidacy. Anyone fetching it mid-review gets a
pre-release commit. `make_latest: "false"` on the prerelease keeps it out of `/releases/latest`, so the
exposure is limited to consumers pinning the raw tag. This is accepted as the cost of a single release
identity.

Under the merge-first flow the label-time candidate builds the source pull request's tree, so the first
`vX.Y.Z` prerelease points at a `develop` commit before being re-pointed at the release branch head.
The version overlay (`fix/candidate-version-overlay`) keeps its artifacts correctly named meanwhile.

`release.yml` no longer independently rebuilds the extension, so it no longer detects a candidate whose
artifacts disagree with its source. That verification moves entirely to the candidate build, which is
where the reviewed artifacts are produced. This is the intended trade: ship what was reviewed.

## Testing

`pipeline.test.mjs` covers `candidateTag` returning `vX.Y.Z`. `github.test.mjs` covers
`reconcilePrerelease` refusing to touch a promoted (non-prerelease) release, and loses its
`retirePrerelease` cases. `workflows.test.mjs` asserts `release.yml` creates no tag, contains no
`gh release create`, promotes with `--prerelease=false --latest`, downloads and checksums its assets,
and no longer references `retire-candidate`. `repository-config.test.mjs` asserts the strict policy.

End-to-end verification requires a real release; `1.6.0` is the first one through both this and the
merge-first change.
