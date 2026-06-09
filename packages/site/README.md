# Stream Autopilot — landing page

Marketing site for the [Stream Autopilot](../README.md) browser extension. Built
with [Astro](https://astro.build) (static, mostly zero-JS), deployed to
**Cloudflare Pages** at **https://stream-autopilot.jamezrin.com**.

## Develop

```bash
cd site
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # outputs to site/dist
pnpm preview    # serve the production build
```

## Interactive popup demo (shared with the extension)

The "Try it yourself" section imports the shared popup React package
(`@stream-autopilot/popup-ui`) and renders it as an Astro React island
(`src/popup-ui/PopupDemo.tsx`) inside a **Shadow DOM**. The demo is backed by the
package's deterministic demo adapter, so the site has no WXT or extension
runtime dependency.

Style isolation comes from the Shadow DOM plus the popup package stylesheet
(`@stream-autopilot/popup-ui/styles.css?inline`), compiled by Astro's Vite
Tailwind plugin. No generated popup CSS sync step is required.

## Regenerating the social card

```bash
node site/scripts/make-og.mjs         # -> site/public/og.png  (uses repo-root playwright)
```

## Deployment — Cloudflare Pages (Direct Upload)

Deployed with `wrangler pages deploy` — we build locally and upload `dist/`
straight to Cloudflare, so Cloudflare never needs access to this (private) repo.

```bash
cd site
wrangler login            # one-time browser OAuth
pnpm cf:create            # one-time: create the "stream-autopilot" project
pnpm cf:deploy            # build + upload dist/ to production (branch main)
```

`pnpm cf:deploy` runs `astro build` then
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
