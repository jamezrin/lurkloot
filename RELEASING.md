# Releasing Lurkloot

Releases are driven from the Actions tab. Two workflow dispatches and one pull request merge cover
every release, including hotfixes. Do not create or move tags by hand; CI never pushes to a
protected branch, it only creates tags, releases and pull requests.

## The three steps

1. **Actions → Prepare release.** Choose `patch`, `minor` or `major`, or type an explicit `X.Y.Z` to
   override the bump. The workflow branches `release/X.Y.Z` from `develop`, bumps the version in all
   seven `package.json` files, stamps the date on the changelog entry, and opens a pull request into
   `main`.
2. **Review and merge that pull request.** This merge *is* the `develop` to `main` promotion. There
   is no separate promotion step.
3. **Actions → Release, run on `main`.** The workflow refuses to run from any other branch.

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

## Branch model and hotfixes

`develop` is what is in development. `main` is what is ready to release or already released.

A hotfix is an ordinary pull request into `main` followed by **Release**. There is no hotfix
machinery, no hotfix label, and no separate workflow. The `main` to `develop` sync PR that Release
opens carries the fix back to `develop`.

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

Environment secrets: `CRX_PRIVATE_KEY` in `preview`, `CWS_SERVICE_ACCOUNT_JSON` in `production`.

Repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. These stay at the
repository level deliberately — the site deploys from both environments, so scoping them to one
would break the other channel.

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

Re-running **Prepare release** for a version that is already prepared is likewise a no-op; it
refreshes the branch and leaves the existing pull request in place.

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
- [x] Obsolete labels `release/patch`, `release/minor`, `release/major` and `release/hotfix`
      deleted.
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
