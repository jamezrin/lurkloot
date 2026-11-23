// The popup links straight into the guide (popup-ui/src/constants.ts). Those
// URLs ship inside the extension, so check they land on a real page and
// heading of the guide this site builds.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GUIDE_SKIPPED_URL, GUIDE_URL } from "../../popup-ui/src/constants.ts";
import { SITE } from "../src/consts.ts";

test("points the popup's guide links at pages and headings that exist", async () => {
  for (const url of [GUIDE_URL, GUIDE_SKIPPED_URL]) {
    const { origin, pathname, hash } = new URL(url);
    assert.equal(origin, SITE.url, url);
    const page = `${pathname.replace(/^\//, "").replace(/\/?$/, "/")}index.html`;
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8").catch(() => "");
    assert.ok(html, `${url} is a page of the site`);
    if (hash) assert.ok(html.includes(`id="${hash.slice(1)}"`), `${url} names a heading on that page`);
  }
});
