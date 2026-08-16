import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { changelog } from "../src/changelog.ts";
import { SITE } from "../src/consts.ts";
import { englishCopy } from "../src/copy/en.ts";
import { faqItems } from "../src/faq.ts";
import { writeCache } from "../src/i18n/cache.ts";
import { hashEnglish } from "../src/i18n/hash.ts";
import { collectSiteEnglish, loadChangelog, loadSiteCopy } from "../src/i18n/siteStrings.ts";
import { collectStringLeaves } from "../src/i18n/strings.ts";

test("english copy includes hero, faq, and changelog chrome", () => {
  assert.match(JSON.stringify(englishCopy), /Farm Twitch/);
  assert.match(englishCopy.hero.title, /Farm Twitch &amp; Kick drops<br \/>/);
  assert.equal(englishCopy.meta.tagline, "Farm Twitch & Kick drops on autopilot.");
  assert.match(englishCopy.footer.tagline, /Farm Twitch & Kick drops/);
  assert.doesNotMatch(englishCopy.meta.tagline, /&amp;/);
  assert.doesNotMatch(englishCopy.footer.tagline, /&amp;/);
  assert.equal(englishCopy.faq.items.length, 9);
  assert.equal(englishCopy.changelog.title, "Changelog");
  assert.equal(englishCopy.changelog.kind.new, "New");
});

test("site English collector includes every changelog bullet", () => {
  const collected = collectSiteEnglish();
  const bullets = changelog.flatMap((entry) => entry.changes.map((change) => change.text));
  for (const bullet of bullets) assert.equal(collected.includes(bullet), true);
  assert.equal(collectStringLeaves(englishCopy).every((leaf) => collected.includes(leaf)), true);
});

test("faq items and SITE meta stay the current English values", () => {
  assert.equal(faqItems.length, 9);
  assert.deepEqual(
    faqItems,
    englishCopy.faq.items.map((item) => ({ q: item.q, a: item.a })),
  );
  assert.equal(SITE.tagline, englishCopy.meta.tagline);
  assert.equal(SITE.description, englishCopy.meta.description);
  assert.equal(SITE.tagline, "Farm Twitch & Kick drops on autopilot.");
});

test("loadSiteCopy returns English for en and applies cached leaves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lurkloot-i18n-"));
  try {
    const english = await loadSiteCopy("en", dir);
    assert.equal(english.changelog.title, "Changelog");
    assert.equal(english.faq.items.length, 9);
    await writeCache(dir, "es", { [hashEnglish(englishCopy.changelog.title)]: "Registro de cambios" });
    const es = await loadSiteCopy("es", dir);
    assert.equal(es.changelog.title, "Registro de cambios");
    assert.equal(es.changelog.kind.new, "New");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadChangelog translates change texts and leaves versions intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lurkloot-i18n-"));
  try {
    const first = changelog[0].changes[0].text;
    const en = await loadChangelog("en", dir);
    assert.equal(en[0].changes[0].text, first);
    await writeCache(dir, "es", { [hashEnglish(first)]: "Traducido" });
    const es = await loadChangelog("es", dir);
    assert.equal(es[0].changes[0].text, "Traducido");
    assert.equal(es[0].version, changelog[0].version);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("translate CLI exits 0 when credentials are unset", () => {
  const result = spawnSync(process.execPath, ["scripts/translate.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", WORKERS_AI_API_TOKEN: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Skipping site translation/);
});
