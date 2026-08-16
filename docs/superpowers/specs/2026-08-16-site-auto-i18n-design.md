# Site Automatic Localization Design

## Goal

Localize `https://lurkloot.jamezrin.com` for every extension locale without maintaining changelog bullets or marketing copy per language. English remains the only authored source. Other locales are produced at site-deploy time by Llama 4 Scout on Cloudflare Workers AI, cached by content hash, and emitted as static locale-prefixed pages.

## Scope

In:

- Marketing home (hero through CTA, including FAQ).
- Changelog (`changelog.json` bullets plus page chrome).
- Locale-prefixed static routes, language switcher, Arabic RTL, live popup demo locale.
- Hash-cached Scout translations during the trusted site-deploy build only.

Out:

- Privacy policy body (`privacy-policy.md` / `/privacy`). Legal copy stays English.
- Extension/popup catalogs in `packages/locales`. Those remain a separate, committed, parity-tested surface.
- Indexed non-English marketing pages. Translated routes are `noindex`; English stays canonical.
- Accept-Language redirects, Weglot-style proxies, or runtime HTML rewriting.
- GitHub Models (retired). OpenAI/Anthropic secrets. `@cf/meta/m2m100-1.2b` as the translator.

## Decisions

| Topic | Choice |
| --- | --- |
| Locales | Same eleven as `SupportedLocale`: `en`, `es`, `fr`, `it`, `ru`, `de`, `zh_CN`, `hi`, `pt_BR`, `ar`, `tr`. |
| URLs | English unprefixed (`/`, `/changelog`). Others `/es/`, `/de/changelog`, `/zh-cn/`, `/pt-br/`. |
| SEO | English is canonical. Translated pages send `noindex` and are omitted from the sitemap. |
| Translator | `@cf/meta/llama-4-scout-17b-16e-instruct` via the Workers AI REST API. |
| When it runs | Site-deploy build (trusted ref) when `WORKERS_AI_API_TOKEN` is set. PR/`pnpm check` never calls the model. |
| Cache | `packages/site/.i18n-cache/<locale>.json` mapping `sha256(english)` → translation. Gitignored. Restored/saved with GitHub Actions cache on site-deploy. |
| Missing translations | English fallback for that string. Production deploy **fails** if the token is present and any requested item is still untranslated after retries. |
| Privacy | `/privacy` only. No `/es/privacy`. Footer on localized pages links to `/privacy`. |
| JSON-LD | `SoftwareApplication` and `FAQPage` only on the English home page. |

## Architecture

English copy lives in two places:

1. `packages/site/src/copy/en.ts` — marketing chrome (hero, FAQ answers, buttons, changelog labels).
2. `packages/site/src/changelog.json` — release-note bullets. Unchanged shape.

A small i18n module (`packages/site/src/i18n/`) owns locale URL mapping, hashing, cache read/write, string collection, and the translator port. Astro pages stay static. They receive a `locale` and a resolved copy tree; they do not call the network.

```text
changelog.json + copy/en.ts
        │
        ▼
 collectStrings() ──► hash each English value
        │
        ▼
 .i18n-cache/<locale>.json  ── miss? ──► Scout (one batched call per locale)
        │
        ▼
 resolveCopy(locale) + resolveChangelog(locale)
        │
        ▼
 / , /changelog          (en)
 /es/ , /es/changelog    (and the other nine prefixes)
```

Do not use Astro's built-in `i18n.routing` folder duplication (`src/pages/es/index.astro` × ten locales). Use thin route files plus shared views:

- `src/pages/index.astro` and `src/pages/changelog.astro` render English.
- `src/pages/[locale]/index.astro` and `src/pages/[locale]/changelog.astro` `getStaticPaths` over non-English URL prefixes.
- Shared implementations live in `src/views/HomePage.astro` and `src/views/ChangelogPage.astro`.

`privacy.astro` stays a single English route.

## Locale URLs

Map `SupportedLocale` to a URL prefix. Underscores become hyphens and lower case, matching BCP 47 in the path:

| Locale | Prefix | Home | Changelog |
| --- | --- | --- | --- |
| `en` | *(none)* | `/` | `/changelog` |
| `es` | `es` | `/es/` | `/es/changelog` |
| `zh_CN` | `zh-cn` | `/zh-cn/` | `/zh-cn/changelog` |
| `pt_BR` | `pt-br` | `/pt-br/` | `/pt-br/changelog` |
| `ar` | `ar` | `/ar/` | `/ar/changelog` |

The other locales follow the `es` pattern (`fr`, `it`, `ru`, `de`, `hi`, `tr`).

Helpers:

- `localeToPrefix(locale)` / `prefixToLocale(prefix)`
- `pageHref(locale, path)` where `path` is `"/"` or `"/changelog"`
- `parseLocaleFromPathname(pathname)` for the language switcher

Unknown `[locale]` params 404 via `getStaticPaths` (only the ten prefixes are emitted).

## Copy module

`copy/en.ts` exports a typed nested object covering every user-visible marketing string currently hardcoded in Astro components, `faq.ts`, and `SITE.tagline` / `SITE.description`. `faq.ts` becomes a thin re-export of `copy.faq.items` so FAQPage JSON-LD on English keeps working.

Strings may contain a small HTML allowlist already used in the manifesto: `<span class="grad-text">…</span>` and `<br />`. The translator prompt must preserve those tags and attributes and translate only text nodes. Do not introduce new markup.

Do not put site strings into `packages/locales`. Site i18n is hash-addressed English text, not message keys, so changelog edits never require catalog parity work.

`LINKS`, `EXTERNAL_URLS`, `DOCKER_IMAGE`, game titles, platform names, and the CLI snippet stay in `consts.ts` / components and are not translated.

## Translator

Port:

```ts
export interface TranslationItem {
  id: string; // sha256 hex of the English UTF-8 text
  text: string;
}

export interface Translator {
  translate(input: {
    locale: Exclude<SupportedLocale, "en">;
    items: TranslationItem[];
  }): Promise<TranslationItem[]>;
}
```

`ScoutTranslator` POSTs to:

`https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/meta/llama-4-scout-17b-16e-instruct`

with `Authorization: Bearer {token}`. Request body uses `messages` (system + user) and **`max_tokens` of at least 8192** (Workers AI defaults this model to 256, which will truncate a locale batch).

One request per locale containing every cache miss, **deduped by hash** so repeated English strings (CTAs, “Lurkloot”) are sent once. If the model returns truncated or unparsable JSON, split the batch in half and retry those halves once. Persistent failure fails the translate step.

System prompt rules (must match popup catalog conventions):

- Translate into the named locale, natural marketing prose.
- Do not translate: Lurkloot, Twitch, Kick, Chrome Web Store, GitHub, Docker, GHCR, and game titles (Rust, Valorant, …).
- Keep “farm” / “farming” as the same gaming loanword convention used in that locale’s popup catalog (`farmingLabel` and related keys).
- Preserve HTML tags/attributes exactly; translate text nodes only.
- Return a JSON array of `{ "id", "text" }` and nothing else.

Credentials (build job only, never the Pages deploy token):

- `CLOUDFLARE_ACCOUNT_ID` (already a repository secret; today it is passed only to deploy).
- `WORKERS_AI_API_TOKEN` — new repository secret, **Workers AI Edit** (and Read) only. Must not include Cloudflare Pages deploy permission.

`astro build` never calls the network. `pnpm --filter @lurkloot/site translate` (and the site-deploy composite action) does.

## Cache

Path: `packages/site/.i18n-cache/<locale>.json`

Shape: `{ "<sha256>": "<translated text>" }`

- Gitignored. Not a human-edited catalog.
- Site-deploy restores GitHub Actions cache key `site-i18n-v1` (restore-keys the same prefix), runs translate, saves the directory back.
- Local `pnpm dev:site` / `pnpm check` use whatever is on disk; missing hashes render English.
- Changing English text changes the hash, so that line is translated again. Unchanged changelog bullets are never resent.

## Pages and chrome

`Base.astro` takes `locale`:

- `<html lang={bcp47} dir={ar ? "rtl" : "ltr"}>`
- `title` / `description` from resolved copy
- English pages: canonical = self. Localized pages: canonical = the English URL for the same path, plus `<meta name="robots" content="noindex, nofollow">`
- Open Graph URL is the actual page URL (so a shared `/es/changelog` preview is that URL)
- JSON-LD scripts only when `locale === "en"` and the page is home

`public/_headers` adds, for each non-English prefix:

```
/es/*
  X-Robots-Tag: noindex, nofollow

/zh-cn/*
  X-Robots-Tag: noindex, nofollow
```

(same for every prefixed locale). Production sitemap integration filters out any URL whose path starts with a locale prefix. Prerelease already noindexes everything.

Language switcher: native names from `LOCALE_OPTIONS` in `@lurkloot/shared/i18n` (skip `browser`). Place it in the footer on every page and in the changelog/privacy header. Switching language keeps the visitor on home or changelog; from `/privacy` it goes to that locale’s home.

Dates on the changelog use `Intl.DateTimeFormat` for the active locale.

Live demo: `PopupDemo` takes `locale` and passes it to `createDemoPopupAdapter` and `Popup` `initialState` (both already accept `SupportedLocale`). `/es/` shows the Spanish popup catalog.

## CI and credentials

`pnpm check` / PR validation stay credential-free. They build locale routes with English fallback for missing cache entries and assert routing, canonical, robots, `lang`/`dir`, and the absence of `/es/privacy`.

`.github/actions/build-site/action.yml` gains optional `workers_ai_token` and `account_id` inputs. When both are non-empty:

1. Restore `.i18n-cache/`
2. `pnpm --filter @lurkloot/site translate`
3. `pnpm build:site`
4. Save `.i18n-cache/`

When either is empty, skip translate (current PR behavior).

`site-deploy.yml` passes `secrets.WORKERS_AI_API_TOKEN` and `secrets.CLOUDFLARE_ACCOUNT_ID` into **build** only. The deploy job keeps using `CLOUDFLARE_API_TOKEN` and must not receive the Workers AI token.

Document `WORKERS_AI_API_TOKEN` in `RELEASING.md` next to the other repository secrets. Creating the token (Cloudflare dashboard → Workers AI → Use REST API → custom token with Workers AI Edit) is a one-time operator step, not code.

Candidate/release-candidate site builds that go through `build-site` without the new inputs keep English fallback. Shipping localized production copy is the production/prerelease **site-deploy** path.

## Error handling

- No token: log that translation was skipped; build continues with English fallback.
- Token set, HTTP/model error: retry the locale batch once, then fail `translate` (and therefore site-deploy build).
- Truncated JSON: split batch and retry; fail if a singleton item still cannot parse.
- Cache file corrupt: treat as empty and refill (deploy) or fall back to English (PR).

## Testing

Site tests stay Node `node:test` in `packages/site/tests/`, plus reading `dist/` after `astro build` (existing `consts.test.mjs` pattern).

Cover:

- Prefix ↔ locale mapping, `pageHref`, RTL for `ar` only.
- Hash stability; cache hit skips translator; cache miss records the translation.
- Scout client: mocked `fetch`, `max_tokens >= 8192`, glossary terms present in the prompt, JSON parse of `{id,text}[]`.
- Built English `index.html` still has unprefixed canonical and JSON-LD.
- Built `/es/changelog/index.html` (or `dist/es/changelog/index.html`) has `lang="es"`, canonical `https://lurkloot.jamezrin.com/changelog`, and `noindex`.
- No `dist/es/privacy` (or equivalent).
- Sitemap (production channel) does not list `/es/`.
- `PopupDemo` with `locale="es"` passes `es` into the adapter (unit-level; no Playwright required).

Do not call Workers AI from tests.

## Docs

- `packages/site/README.md`: locale URLs, translate command, cache, secrets.
- `RELEASING.md`: `WORKERS_AI_API_TOKEN`.
- `docs/translations.md`: one short section that site copy is hash-cached machine translation and is not edited via the popup JSON catalogs.

## Non-goals / later

- `hreflang` indexes and ranking localized landing pages.
- Human override files for individual site strings.
- Translating `privacy-policy.md`.
- Client-side language detection.
