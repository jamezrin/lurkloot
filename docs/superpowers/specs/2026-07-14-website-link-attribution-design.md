# Website Link Attribution Design

## Goal

Identify visits that leave the Lurkloot marketing website for the Chrome Web Store or GitHub-owned project pages without adding client-side analytics to the website.

## Design

Visible outbound links rendered by the website will carry standard UTM query parameters. Chrome Web Store links will use:

- `utm_source=lurkloot_website`
- `utm_medium=referral`
- `utm_campaign=extension_install`

Links to the GitHub repository, CLI documentation, and GHCR package will use:

- `utm_source=lurkloot_website`
- `utm_medium=referral`
- `utm_campaign=open_source`

The website link catalog in `packages/site/src/consts.ts` remains the single source of truth. A small URL helper will append parameters safely so GitHub CLI documentation links retain the `#readme` fragment after the query string.

Canonical destinations used as structured metadata, including the Schema.org `downloadUrl`, will remain untagged. Website anchors will use attributed variants. Links in the extension popup, repository README, and other non-website surfaces are out of scope because they do not represent website referrals.

## Measurement Boundaries

Chrome Web Store forwards `utm_source`, `utm_medium`, and `utm_campaign` to its analytics and associates them with listing and install events. GitHub does not expose UTM campaign dimensions in repository traffic analytics; its Insights view reports the referring website. The GitHub parameters provide consistent attribution labels but do not add new GitHub-side reporting.

No Google Tag Manager or other client-side analytics script will be introduced. This avoids expanding website data collection or requiring related privacy-policy changes.

## Verification

- Add focused tests for URL construction, including fragment ordering and preservation of canonical URLs.
- Run the site typecheck and production build.
- Inspect generated HTML to confirm attributed anchor URLs and an untagged structured-data `downloadUrl`.
