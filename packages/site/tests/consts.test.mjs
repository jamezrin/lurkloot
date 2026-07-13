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
