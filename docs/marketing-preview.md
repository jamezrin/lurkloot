# Marketing redesign previews

The site uses the real shared popup UI, backed by demo data. The homepage and
platform guides, changelog, and privacy page share the monochrome design.
The popup itself retains the current product branding.

## Website

```sh
pnpm dev:site
pnpm --filter @lurkloot/site test
```

Motion respects `prefers-reduced-motion`. Game artwork drifts with scrolling and
floats gently; page sections enter once. The interactive popup remains steady.
The mobile demo can be enlarged to its full size and scrolled horizontally.

The privacy page renders the existing root `privacy-policy.md` unchanged, adding
section anchors. FAQ content is shared with the corresponding structured data.

Regenerate the social card using the locally installed Archivo font:

```sh
pnpm --filter @lurkloot/site exec node scripts/make-og.mjs
```
