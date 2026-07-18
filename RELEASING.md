# Releasing Lurkloot

Label a pull request into `main`, merge the release pull request that appears, then run **Release**.
That covers every release, including hotfixes. Do not create or move tags by hand; the only branch CI
ever pushes is the generated `release/X.Y.Z`. It cannot push to `main` or `develop` — beyond that
branch it only creates tags, releases and pull requests.

## Before you start: write the changelog

Release notes are rendered *only* from `packages/site/src/changelog.json`. Add the entry for the new
version to the branch you are releasing — `develop` for a normal release — before you apply the
label, since Prepare release cuts from that branch. Put it at the top of the array; omit `date`,
because Prepare release stamps it:

```json
{ "version": "1.5.1", "changes": [
  { "kind": "fixed", "text": "Fixed a thing." }
] }
```

The only valid `kind` values are `new`, `improved` and `fixed`; anything else fails the site build.

If no entry exists, Prepare release creates one with `"changes": []` rather than failing, and the
GitHub release then ships with an **empty body**. That is the intended escape hatch for a build-only
release, but it is silent — so write the entry first unless you mean it.

## The three steps

1. **Open a pull request into `main` and label it** `release/patch`, `release/minor` or
   `release/major`. For a normal release that is the `develop` to `main` promotion pull request; for
   a hotfix it is the fix's own pull request. Prepare release cuts `release/X.Y.Z` from that pull
   request's head, bumps the version in all seven `package.json` files, stamps the date on the
   changelog entry, and opens its own pull request into `main`.
2. **Review and merge the `release/X.Y.Z` pull request.** This merge *is* the promotion. There is no
   separate promotion step.
3. **Actions → Release, run on `main`.** The workflow refuses to run from any other branch.

The label says how much to bump; the pull request says what is being released. There is no base or
version input to keep in sync with the branch, because the pull request already carries both facts.

Prepare release then comments on the pull request you labelled and **closes it**. That is deliberate:
`release/X.Y.Z` is the same branch plus the bump, so leaving both open into `main` would let you
merge the one without the version bump. If a run fails part way, remove the label and add it again to
retry.

## What Release does

- Tags `vX.Y.Z` on the released commit.
- Builds the extension, including the signed CRX, and the CLI Docker image for `linux/amd64` and
  `linux/arm64`.
- Creates or updates the GitHub release, marks it Latest, and uploads the signed CRX, both browser
  ZIPs, the sources ZIP and the checksums.
- Pushes the GHCR version tags, then moves the aliases `X.Y`, `X` and `latest`.
- Uploads the Chrome Web Store submission.
- Deploys the production site.
- Opens the `main` to `develop` synchronization pull request.

Upload the Firefox ZIP and the source ZIP from the GitHub release to AMO; AMO publication remains
manual.

## Where the version number comes from

Nobody edits a version by hand.

Prepare release derives it from **git tags, not from `package.json`**: it reads `git tag --list 'v*'`,
takes the highest stable tag, and applies the bump named by the label. Prereleases and leftover
`candidate-*` tags are filtered out, so a stray tag cannot skew a bump. It then writes that version
into all seven manifests and the changelog entry, as a single `chore(release): X.Y.Z` commit on
`release/X.Y.Z`.

Release reads the version back out of `package.json` on `main`. **That committed value is what is
actually released** — the tag, the GHCR tags and the store package all follow it.

The version is therefore derived from what was last released, and committed *before* anything is
built. Nothing is frozen, so nothing can be invalidated mid-release.

`checkWorkspace` runs as part of the bump and fails loudly if the seven manifests disagree or the
changelog has no entry for the version, so a half-edited workspace cannot reach a release. Only
`release/patch`, `release/minor` and `release/major` name a valid bump; any other `release/*` label
fails the run before a branch is created rather than guessing.

## Branch model and hotfixes

`develop` is what is in development. `main` is what is ready to release or already released.

There is no hotfix machinery, no hotfix label, and no separate workflow. A hotfix is the same three
steps against a different pull request:

1. Branch from `main`, not `develop`, and open the fix as an ordinary pull request into `main`.
   **Do not merge it.**
2. Label it `release/patch`. Prepare release cuts `release/X.Y.Z` from your fix branch, so the
   release carries the already-released commits plus your fix and *none* of develop's unreleased
   work. Your pull request is then closed as superseded.
3. Merge the `release/X.Y.Z` pull request, then run **Release** on `main` as usual.
4. Merge the `main` to `develop` sync PR that Release opens, so the fix and the version bump reach
   `develop`.

**Do not merge the fix yourself and skip the label.** Release reads the version from `package.json`
on `main`; if the hotfix does not bump it, Release re-runs against the already-published version and
does nothing — it re-tags the same version, edits the existing GitHub release, and the store reports
the version as already submitted. It succeeds while shipping nothing. Closing the labelled pull
request automatically is what keeps that from happening by accident.

## Chrome Web Store timing

The submission uses `PUBLISH_IMMEDIATELY`, so **Google publishes the item itself once review
passes** — hours or days after the run finishes, with no further human action and no polling on our
side. The store deliberately trails the GitHub release. Accepting that trade is what removed the
staged-review, polling and cancellation machinery; do not add a workflow that waits for the store.

## Environments and approval

There are exactly two environments.

| Environment | Reviewer | Holds | Used by |
| --- | --- | --- | --- |
| `preview` | none | `CRX_PRIVATE_KEY` | extension signing, the Docker version-tag push, prerelease site deploys |
| `production` | required, repository admins | `CWS_SERVICE_ACCOUNT_JSON` | the `publish` job in `release.yml`, the production site deploy |

`preview` holds the signing key that *produces* artifacts. `production` gates what actually
publishes: the GitHub release, the moving GHCR aliases, the Chrome Web Store upload and the
production site.

A release run pauses for approval twice: once before `publish`, and once before the production
site deploy, because both target `production`. An unapproved build can produce artifacts and
immutable version-specific tags, but it can never move `latest` or publish anything.

Restrict `preview`'s deployment branches to `main` and `release/*`.

## Credentials

Secrets: `CRX_PRIVATE_KEY`, `CWS_SERVICE_ACCOUNT_JSON`, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. All four are currently **repository** secrets, which every job reads via
`secrets: inherit`. The "Holds" column above describes where the two publishing credentials belong
once the optional hardening below is applied; until then the environments provide the approval gate
and the branch restriction, but not a credential boundary.

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` stay at the repository level permanently — the
site deploys from both environments, so scoping them to one would break the other channel.

Variables: `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`.

The CWS service-account email must be a member of the Chrome Web Store publisher, and the CRX
private key must be preserved permanently — losing it changes the extension ID.

## Recovery

Every step is idempotent. Tagging, the GitHub release, the GHCR aliases, the store upload and the
site deploy all tolerate re-running. **This idempotency is what replaces rollback.** There is no
rollback and no cancellation flow.

If a step fails, fix the cause and run **Release** again. A re-run with nothing left to change is a
harmless no-op: the tag is updated to the same SHA, the release is edited rather than recreated, the
aliases are re-pointed at the same digest, and the store upload reports that the version is already
submitted and does nothing.

Re-applying a `release/*` label for a version that is already prepared is likewise a no-op; it
refreshes `release/X.Y.Z`, leaves the existing pull request in place, and skips the supersede comment
because the labelled pull request is already closed.

## After a release: reconcile `develop`

Both branches require linear history, so pull requests between them merge by rebase. Rebasing
rewrites the commits, so once the sync PR merges, `main` and `develop` end up with **identical trees
but no shared history** — their merge-base stays at the commit before the merge.

The consequence is cosmetic but compounds: the next `release/X.Y.Z` branch is cut from `develop`, so
its pull request diffs from that stale merge-base and shows the previous release's version bump on
top of the intended one. It still merges cleanly, because patch-equivalent commits are dropped on
rebase.

Check with:

```sh
git rev-parse origin/main^{tree} origin/develop^{tree}   # should match
git merge-base origin/main origin/develop                # should equal origin/main
```

If the trees match but the merge-base is stale, reconcile `develop` to `main`. This needs a force
push, so temporarily set `allow_force_pushes: true` and `enforce_admins: false` on `develop`, run
`git push --force-with-lease origin origin/main:refs/heads/develop`, then restore both settings
immediately. Only do this when the trees are already identical — it is a history fix, not a content
change.

## Repository configuration

Applied:

- [x] `preview` environment, no required reviewer, deployment branches restricted to `main` and
      `release/*`.
- [x] `production` environment, with repository administrators as required reviewers.
- [x] Obsolete environments `prereleases`, `cws-review`, `prerelease-site`, `production-site` and
      `stable-releases` deleted.
- [x] `cws-release-ready` removed from `main`'s required status checks. Nothing posts it any more,
      so leaving it required would have blocked every pull request forever.
- [x] `main`'s required status checks are `verify`, `extension / build`,
      `docker / build (linux/amd64, ubuntu-latest, amd64)` and
      `docker / build (linux/arm64, ubuntu-24.04-arm, arm64)`. `develop` matches.
- [x] Labels `release/patch`, `release/minor` and `release/major` exist — they are the release
      trigger. There is deliberately no `release/hotfix`: a hotfix is a `release/patch` on a pull
      request whose head is a hotfix branch.
- [x] Default workflow token permission is `read`.

### Optional hardening: scope the credentials to environments

All four secrets are currently repository secrets, which every job can read via `secrets: inherit`.
The pipeline works as-is; the environments today provide the approval gate and the branch
restriction, but not a credential boundary.

To make them a real boundary, move the two publishing credentials into environments. This cannot be
automated, because GitHub never discloses an existing secret's value — only someone holding the
plaintext can re-enter it:

```sh
gh secret set CRX_PRIVATE_KEY --env preview < path/to/lurkloot.pem
gh secret delete CRX_PRIVATE_KEY

gh secret set CWS_SERVICE_ACCOUNT_JSON --env production < path/to/service-account.json
gh secret delete CWS_SERVICE_ACCOUNT_JSON
```

Leave `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` at the repository level: the site deploys
from both environments, so scoping them to one would break the other channel.

Do this only when you have the plaintext to hand. Deleting a repository secret without having
successfully set the environment copy breaks signing or publishing on the next release, and
`CRX_PRIVATE_KEY` cannot be regenerated — losing it changes the extension ID.
