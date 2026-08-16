import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import changelogData from "../src/changelog.json" with { type: "json" };
import { EXTERNAL_URLS } from "../src/consts.ts";

const dist = new URL("../dist/", import.meta.url);

async function exists(rel) {
  try {
    await access(new URL(rel, dist));
    return true;
  } catch {
    return false;
  }
}

test("emits prefixed locale routes and keeps privacy English-only", async () => {
  assert.equal(await exists("es/index.html"), true);
  assert.equal(await exists("es/changelog/index.html"), true);
  assert.equal(await exists("zh-cn/changelog/index.html"), true);
  assert.equal(await exists("ar/index.html"), true);
  assert.equal(await exists("es/privacy/index.html"), false);
  assert.equal(await exists("privacy/index.html"), true);
});

test("English home stays canonical with JSON-LD and the store download URL", async () => {
  const html = await readFile(new URL("index.html", dist), "utf8");
  assert.match(html, /<html lang="en" dir="ltr"/);
  assert.match(html, /rel="canonical" href="https:\/\/lurkloot\.jamezrin\.com"/);
  assert.match(html, /"@type":"FAQPage"/);
  assert.match(html, new RegExp(EXTERNAL_URLS.chrome.replaceAll("/", "\\/")));
  assert.doesNotMatch(html, /noindex/);
});

test("Spanish changelog is noindexed and canonicalizes to English", async () => {
  const html = await readFile(new URL("es/changelog/index.html", dist), "utf8");
  assert.match(html, /<html lang="es" dir="ltr"/);
  assert.match(html, /rel="canonical" href="https:\/\/lurkloot\.jamezrin\.com\/changelog"/);
  assert.match(html, /property="og:url" content="https:\/\/lurkloot\.jamezrin\.com\/es\/changelog"/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(html, /"@type":"FAQPage"/);

  const latestDated = changelogData
    .map((entry) => entry.date)
    .filter(Boolean)
    .sort()
    .at(-1);
  assert.ok(latestDated, "expected at least one dated changelog entry");
  const esDate = new Intl.DateTimeFormat("es", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(`${latestDated}T00:00:00Z`));
  assert.match(html, new RegExp(esDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Arabic home is RTL", async () => {
  const html = await readFile(new URL("ar/index.html", dist), "utf8");
  assert.match(html, /<html lang="ar" dir="rtl"/);
});

test("production sitemap omits prefixed locales", async () => {
  const xml = await readFile(new URL("sitemap-0.xml", dist), "utf8").catch(() =>
    readFile(new URL("sitemap-index.xml", dist), "utf8"),
  );
  assert.doesNotMatch(xml, /\/es\//);
});
