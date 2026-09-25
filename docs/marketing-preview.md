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

## Store art direction draft

This is an **English-only, opt-in draft**. The existing localized capture and
store-upload commands still use the production artwork. This PR does not publish
or automatically upload the new assets.

With Playwright Chromium and ImageMagick (`magick`) installed:

```sh
pnpm build
pnpm --filter @lurkloot/extension exec node scripts/capture-store-draft.mjs
```

Output defaults to `/tmp/lurkloot-store-draft`; set `STORE_DRAFT_OUTPUT` to retain
it elsewhere. The script generates five 1280 × 800 screenshots (queue, games,
Kick, watchlist, extension support), a 440 × 280 promo, and a 1400 × 560 marquee.
The fifth screenshot is an editorial explanation, not a simulated popup view.

Use `?screenshot=store&draft=queue|games|kick|watchlist|extensions&locale=en`
or `?screenshot=promo&draft=1&format=small|marquee&locale=en` to inspect the
layouts in the built popup. All frames use the real 720 × 600 popup dimensions,
except the editorial extension overview. The capture verifies frame bounds and
checks that visible copy omits browser names and individual extension providers.

Integrating the artwork with the localized production capture/upload pipeline is
a separate follow-up after the draft is accepted for publication.
