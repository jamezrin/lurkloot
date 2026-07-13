# Website Link Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute marketing-site referrals to the Chrome Web Store and GitHub-owned project pages without adding client-side analytics.

**Architecture:** Keep canonical external destinations separate from anchor-ready attributed links in the site link catalog. Construct the attributed variants with the standard `URL` API so existing fragments remain correctly ordered, and keep Schema.org metadata pointed at the canonical Chrome Web Store destination.

**Tech Stack:** TypeScript, Astro, Node test runner, pnpm

## Global Constraints

- Chrome links use `utm_source=lurkloot_website`, `utm_medium=referral`, and `utm_campaign=extension_install`.
- GitHub repository, CLI documentation, and GHCR links use `utm_source=lurkloot_website`, `utm_medium=referral`, and `utm_campaign=open_source`.
- Structured metadata, extension-popup links, README links, and other non-website surfaces remain untagged.
- Do not add Google Tag Manager or any client-side analytics dependency.

---

### Task 1: Build attributed website destinations

**Files:**
- Create: `packages/site/tests/consts.test.mjs`
- Modify: `packages/site/src/consts.ts`
- Modify: `packages/site/package.json`

**Interfaces:**
- Consumes: Native `URL` and `URLSearchParams` behavior.
- Produces: `EXTERNAL_URLS` canonical destination catalog and the existing `LINKS` anchor catalog with attributed Chrome and GitHub-owned URLs.

- [ ] **Step 1: Write the failing tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { EXTERNAL_URLS, LINKS } from "../src/consts.ts";

test("attributes Chrome Web Store website referrals", () => {
  const url = new URL(LINKS.chrome);
  assert.equal(url.origin + url.pathname, EXTERNAL_URLS.chrome);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    utm_source: "lurkloot_website",
    utm_medium: "referral",
    utm_campaign: "extension_install",
  });
});

test("attributes every GitHub-owned website destination", () => {
  for (const key of ["github", "cli", "ghcr"]) {
    const url = new URL(LINKS[key]);
    assert.equal(`${url.origin}${url.pathname}`, EXTERNAL_URLS[key]);
    assert.equal(url.searchParams.get("utm_source"), "lurkloot_website");
    assert.equal(url.searchParams.get("utm_medium"), "referral");
    assert.equal(url.searchParams.get("utm_campaign"), "open_source");
  }
  assert.equal(new URL(LINKS.cli).hash, "#readme");
  assert.match(LINKS.cli, /\?[^#]+#readme$/);
});
```

Add this script to `packages/site/package.json`:

```json
"test": "node --test tests/*.test.mjs"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/site test`

Expected: FAIL because `EXTERNAL_URLS` is not exported and `LINKS` is not attributed.

- [ ] **Step 3: Implement attributed links**

In `packages/site/src/consts.ts`, define canonical destinations and construct anchor URLs:

```ts
export const EXTERNAL_URLS = {
  chrome: "https://chromewebstore.google.com/detail/lurkloot/aobaackpofkghaejdnnmpmeaiaoibhdn",
  github: "https://github.com/jamezrin/lurkloot",
  cli: "https://github.com/jamezrin/lurkloot/tree/main/packages/cli",
  ghcr: "https://github.com/jamezrin/lurkloot/pkgs/container/lurkloot-cli",
} as const;

function withCampaign(url: string, campaign: "extension_install" | "open_source"): string {
  const attributed = new URL(url);
  attributed.searchParams.set("utm_source", "lurkloot_website");
  attributed.searchParams.set("utm_medium", "referral");
  attributed.searchParams.set("utm_campaign", campaign);
  return attributed.href;
}

export const LINKS = {
  chrome: withCampaign(EXTERNAL_URLS.chrome, "extension_install"),
  privacy: "/privacy",
  changelog: "/changelog",
  x: "https://x.com/jamezrin",
  github: withCampaign(EXTERNAL_URLS.github, "open_source"),
  cli: withCampaign(`${EXTERNAL_URLS.cli}#readme`, "open_source"),
  ghcr: withCampaign(EXTERNAL_URLS.ghcr, "open_source"),
} as const;
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @lurkloot/site test && pnpm --filter @lurkloot/site typecheck`

Expected: all link tests pass and Astro reports no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/site/package.json packages/site/src/consts.ts packages/site/tests/consts.test.mjs
git commit -m "feat(site): attribute outbound store and GitHub links"
```

### Task 2: Preserve canonical structured metadata

**Files:**
- Modify: `packages/site/src/layouts/Base.astro`
- Test: `packages/site/tests/consts.test.mjs`

**Interfaces:**
- Consumes: `EXTERNAL_URLS.chrome` from Task 1.
- Produces: Schema.org `SoftwareApplication.downloadUrl` with no UTM parameters while visible anchors continue using `LINKS`.

- [ ] **Step 1: Add a generated-output assertion that initially fails**

Extend the test file to read the production homepage and verify the canonical structured-data destination:

```js
import { readFile } from "node:fs/promises";

test("keeps the structured download URL canonical", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const match = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  assert.ok(match);
  const software = JSON.parse(match[1]);
  assert.equal(software.downloadUrl, EXTERNAL_URLS.chrome);
});
```

- [ ] **Step 2: Build and run the test to verify the metadata assertion fails**

Run: `pnpm --filter @lurkloot/site build && pnpm --filter @lurkloot/site test`

Expected: FAIL because `downloadUrl` still uses attributed `LINKS.chrome`.

- [ ] **Step 3: Point structured data at the canonical destination**

Update `packages/site/src/layouts/Base.astro`:

```astro
import { SITE, LINKS, EXTERNAL_URLS } from "../consts";
```

and:

```ts
downloadUrl: EXTERNAL_URLS.chrome,
```

- [ ] **Step 4: Verify tests, generated anchors, and the production build**

Run: `pnpm --filter @lurkloot/site build && pnpm --filter @lurkloot/site test && rg -o 'https://(chromewebstore\.google\.com|github\.com)[^"< ]+' packages/site/dist -g '*.html'`

Expected: tests pass; visible links include the specified UTM parameters; JSON-LD contains the canonical Chrome URL; the CLI URL places its query before `#readme`.

- [ ] **Step 5: Commit**

```bash
git add packages/site/src/layouts/Base.astro packages/site/tests/consts.test.mjs
git commit -m "test(site): verify canonical structured metadata"
```

### Task 3: Full verification and PR preparation

**Files:**
- Modify only if verification exposes an in-scope problem.

**Interfaces:**
- Consumes: Completed attributed URL catalog and canonical metadata behavior.
- Produces: A verified branch ready for review.

- [ ] **Step 1: Run repository verification**

Run: `pnpm check`

Expected: script tests, workspace typechecks, extension tests, and Astro build all pass.

- [ ] **Step 2: Inspect branch scope**

Run: `git status --short && git diff --check origin/main...HEAD && git diff --stat origin/main...HEAD`

Expected: clean status, no whitespace errors, and only the spec, plan, site constants, site layout, site test, and site package manifest are changed.

- [ ] **Step 3: Push and open a draft PR**

Push `feat/website-link-attribution` and open a draft PR titled `feat(site): attribute outbound store and GitHub links` with the implementation summary and exact verification commands.
