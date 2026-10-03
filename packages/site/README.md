# Lurkloot — landing page

Marketing site for the [Lurkloot](../README.md) browser extension. Built
with [Astro](https://astro.build) (static, mostly zero-JS), deployed to
**Cloudflare Pages** at **https://lurkloot.jamezrin.com**.

## Develop

```bash
pnpm install          # from the repo root
pnpm dev:site         # http://localhost:4321
pnpm build:site       # outputs to packages/site/dist
pnpm --filter @lurkloot/site preview   # serve the production build
```

## The real popup on the homepage (shared with the extension)

The homepage imports the shared popup React package (`@lurkloot/popup-ui`) and
renders it inside a **Shadow DOM** (`src/popup-ui/mountPopup.tsx`): once as the
interactive demo under the hero (`PopupDemo.tsx`), and as read-only views of the
queue, games and idle watchlist in the farming-order section
(`PopupExcerpt.tsx`). Both are backed by the package's deterministic demo
adapter, so the site has no WXT or extension runtime dependency.

Style isolation comes from the Shadow DOM plus the popup package stylesheet
(`@lurkloot/popup-ui/styles.css?inline`), compiled by Astro's Vite
Tailwind plugin. No generated popup CSS sync step is required.

## Regenerating the social card

```bash
pnpm --filter @lurkloot/site exec node scripts/make-og.mjs   # -> public/og.png (uses the extension's playwright)
```

## Deployment — Cloudflare Pages (Direct Upload)

Deployed with `wrangler pages deploy` — we build locally and upload `dist/`
straight to Cloudflare, so Cloudflare never needs access to this (private) repo.

```bash
cd packages/site
wrangler login            # one-time browser OAuth
pnpm cf:create            # one-time: create the "lurkloot" project
pnpm cf:deploy            # build + upload dist/ to production (branch main)
```

`pnpm cf:deploy` runs `astro build` then
`wrangler pages deploy dist --project-name=lurkloot --branch=main`.
Long-cache headers for fingerprinted assets are in `public/_headers`.

GitHub release deployments use the same Pages project with channel-specific
branches. Pre-releases deploy to the `next` preview branch at
`https://next.lurkloot.pages.dev`, while stable releases deploy to `main` and
therefore update `https://lurkloot.jamezrin.com`. GitHub records these against
the `prerelease-site` and `production-site` environments, respectively. The
pre-release build blocks all crawlers in `robots.txt` and sends an
`X-Robots-Tag: noindex, nofollow, noarchive` header for every route; production
remains crawlable.

**Custom domain — `lurkloot.jamezrin.com`** (zone already on this
Cloudflare account). The domain is attached to the project; it needs one DNS
record (wrangler's OAuth scope can't edit DNS, so add it once):

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `lurkloot` | `lurkloot.pages.dev` | Proxied |

Or via an API token with *Zone → DNS → Edit*:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/6f294a67aaab25efccb036e73a8f4658/dns_records" \
  -H "Authorization: Bearer <DNS_EDIT_TOKEN>" -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"lurkloot","content":"lurkloot.pages.dev","proxied":true,"ttl":1}'
```

Cloudflare auto-validates and issues HTTPS once the record resolves.

The canonical URL and sitemap come from `site` in `astro.config.mjs` — update it
(and `SITE.url` in `src/consts.ts`, plus the `Sitemap:` line in
`public/robots.txt`) together if the domain ever changes.
