# Stream Autopilot — landing page

Marketing site for the [Stream Autopilot](../README.md) browser extension. Built
with [Astro](https://astro.build) (static, zero-JS), deployed to **Cloudflare
Pages** at **https://stream-autopilot.jamezrin.com**.

## Develop

```bash
cd site
pnpm install
pnpm dev        # http://localhost:4321/stream-autopilot
pnpm build      # outputs to site/dist
pnpm preview    # serve the production build
```

## Regenerating assets

The product screenshots and the social card are checked into `src/assets/` and
`public/` so the build is self-contained. Regenerate them only when the popup UI
or branding changes:

```bash
# from the repo root — builds the extension, then captures the clean popup shots
pnpm build
node site/scripts/capture-popup.mjs      # -> site/src/assets/screenshots/*.png

# the Open Graph / Twitter card (1200x630)
node site/scripts/make-og.mjs            # -> site/public/og.png
```

Both scripts use the `playwright` install from the repo root.

## Deployment — Cloudflare Pages (Direct Upload)

Deployed with `wrangler pages deploy` — we build locally and upload `dist/`
straight to Cloudflare, so Cloudflare never needs access to this (private) repo.

```bash
cd site
wrangler login            # one-time browser OAuth
pnpm cf:create            # one-time: create the "stream-autopilot" project
pnpm deploy               # build + upload dist/ to production (branch main)
```

`pnpm deploy` runs `astro build` then
`wrangler pages deploy dist --project-name=stream-autopilot --branch=main`.
Long-cache headers for fingerprinted assets are in `public/_headers`.

**Custom domain — `stream-autopilot.jamezrin.com`** (zone already on this
Cloudflare account). The domain is attached to the project; it needs one DNS
record (wrangler's OAuth scope can't edit DNS, so add it once):

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `stream-autopilot` | `stream-autopilot.pages.dev` | Proxied |

Or via an API token with *Zone → DNS → Edit*:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/6f294a67aaab25efccb036e73a8f4658/dns_records" \
  -H "Authorization: Bearer <DNS_EDIT_TOKEN>" -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"stream-autopilot","content":"stream-autopilot.pages.dev","proxied":true,"ttl":1}'
```

Cloudflare auto-validates and issues HTTPS once the record resolves.

The canonical URL and sitemap come from `site` in `astro.config.mjs` — update it
(and `SITE.url` in `src/consts.ts`, plus the `Sitemap:` line in
`public/robots.txt`) together if the domain ever changes.
