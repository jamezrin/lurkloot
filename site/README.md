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

The "Try it yourself" section imports the **real** popup React components from
`entrypoints/popup/app.tsx` and renders them as an Astro React island
(`src/popup-ui/PopupDemo.tsx`) inside a **Shadow DOM** — running on mock data via
the extension's built-in demo mode. Style isolation comes from the Shadow DOM +
the extension's compiled CSS; `wxt/browser` is aliased to a mock
(`src/popup-ui/browser-mock.ts`) that also flips on demo mode.

Two build outputs are committed so `pnpm deploy` stays self-contained; regenerate
them whenever the popup UI changes:

```bash
# from the repo root — build the extension, then sync its compiled CSS + locales
pnpm build
node site/scripts/sync-popup-ui.mjs   # -> src/popup-ui/popup.generated.css,
                                      #    public/_locales/*, public/logo-ring.svg
```

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
