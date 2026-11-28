import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLI_GUIDE_PATH,
  EXTERNAL_URLS,
  HOME_SECTIONS,
  LINKS,
  NAV_LINKS,
  SITE,
} from "../src/consts.ts";

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
  for (const key of ["github", "ghcr"]) {
    const url = new URL(LINKS[key]);

    assert.equal(`${url.origin}${url.pathname}`, EXTERNAL_URLS[key]);
    assert.equal(url.searchParams.get("utm_source"), "lurkloot_website");
    assert.equal(url.searchParams.get("utm_medium"), "referral");
    assert.equal(url.searchParams.get("utm_campaign"), "open_source");
  }
});

// Structured data is now per-page (Base.astro emits SoftwareApplication
// everywhere, BreadcrumbList + FAQPage only where the page supplies them), so
// these read every ld+json block and select by @type rather than by position.
async function structuredData(page) {
  const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
  return [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map(
    (match) => JSON.parse(match[1]),
  );
}

const ldOfType = (blocks, type) => blocks.find((block) => block["@type"] === type);
const indexablePages = [
  "index.html",
  "privacy/index.html",
  "changelog/index.html",
  "twitch-drops-farmer/index.html",
  "kick-drops-farmer/index.html",
  "guide/index.html",
  "guide/getting-started/install/index.html",
  "guide/getting-started/first-run/index.html",
];

test("keeps the structured download URL canonical", async () => {
  const software = ldOfType(await structuredData("index.html"), "SoftwareApplication");

  assert.ok(software);
  assert.equal(software.downloadUrl, EXTERNAL_URLS.chrome);
});

test("derives the structured software version from the root application version", async () => {
  const root = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const software = ldOfType(await structuredData("index.html"), "SoftwareApplication");

  assert.equal(SITE.version, root.version);
  assert.equal(software.softwareVersion, root.version);
});

test("scopes FAQ structured data to pages that render the questions", async () => {
  for (const page of [
    "index.html",
    "twitch-drops-farmer/index.html",
    "kick-drops-farmer/index.html",
  ]) {
    assert.ok(ldOfType(await structuredData(page), "FAQPage"), `${page} should carry FAQPage`);
  }
  // The layout used to emit the homepage FAQ on every page, describing content
  // that was not there.
  for (const page of ["privacy/index.html", "changelog/index.html"]) {
    assert.equal(ldOfType(await structuredData(page), "FAQPage"), undefined, `${page} should not`);
  }
});

test("drops the meta keywords tag from every page", async () => {
  for (const page of indexablePages) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    assert.ok(!/<meta name="keywords"/.test(html), `${page} should not declare meta keywords`);
  }
});

test("gives each indexable page a distinct title and description", async () => {
  const titles = new Set();
  const descriptions = new Set();

  for (const page of indexablePages) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1];

    assert.ok(title, `${page} has a title`);
    assert.ok(description, `${page} has a description`);
    titles.add(title);
    descriptions.add(description);
  }

  assert.equal(titles.size, indexablePages.length);
  assert.equal(descriptions.size, indexablePages.length);
});

test("describes Twitch CLI login and only user-initiated Kick credential transfer", async () => {
  const twitch = await readFile(
    new URL("../dist/twitch-drops-farmer/index.html", import.meta.url),
    "utf8",
  );
  const kick = await readFile(
    new URL("../dist/kick-drops-farmer/index.html", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(twitch, /plain HTTP/);
  assert.match(twitch, /sees every drop campaign/);
  assert.match(twitch, /only shows it the\s+campaigns you have already started/);
  assert.match(kick, /optional, user-initiated session-token transfer/i);
});

test("links the platform landing pages from the homepage and the sitemap", async () => {
  const home = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../dist/sitemap-0.xml", import.meta.url), "utf8");

  for (const href of [LINKS.twitchFarmer, LINKS.kickFarmer]) {
    assert.ok(home.includes(`href="${href}"`), `homepage links to ${href}`);
    assert.ok(sitemap.includes(`${SITE.url}${href}/`), `sitemap lists ${href}`);
  }
});

test("cross-links the two platform pages to each other", async () => {
  const twitch = await readFile(
    new URL("../dist/twitch-drops-farmer/index.html", import.meta.url),
    "utf8",
  );
  const kick = await readFile(
    new URL("../dist/kick-drops-farmer/index.html", import.meta.url),
    "utf8",
  );

  assert.ok(twitch.includes(`href="${LINKS.kickFarmer}"`));
  assert.ok(kick.includes(`href="${LINKS.twitchFarmer}"`));
});

test("links the user guide from every page's nav and lists every guide page in the sitemap", async () => {
  const sitemap = await readFile(new URL("../dist/sitemap-0.xml", import.meta.url), "utf8");
  const guideIndex = await readFile(new URL("../dist/guide/index.html", import.meta.url), "utf8");
  const pages = [...guideIndex.matchAll(/href="(\/guide\/[^"]+)"/g)].map((match) => match[1]);

  assert.ok(pages.length > 0, "the guide index links its pages");
  for (const href of new Set(pages.map((page) => page.replace(/\/$/, "")))) {
    assert.ok(sitemap.includes(`${SITE.url}${href}/`), `sitemap lists ${href}`);
  }
  for (const page of [
    "privacy/index.html",
    "changelog/index.html",
    "twitch-drops-farmer/index.html",
  ]) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    assert.ok(html.includes(`href="${LINKS.guide}"`), `${page} links to the guide`);
  }
});

test("links every guide page only to pages and headings that exist", async () => {
  const { readdir } = await import("node:fs/promises");
  const dist = new URL("../dist/", import.meta.url);
  const files = (await readdir(new URL("guide/", dist), { recursive: true }))
    .filter((file) => file.endsWith("index.html"))
    .map((file) => `guide/${file}`);
  const html = new Map();
  for (const file of ["index.html", ...files]) {
    html.set(
      `/${file.replace(/\/?index\.html$/, "")}`.replace(/\/$/, "") || "/",
      await readFile(new URL(file, dist), "utf8"),
    );
  }
  const pathOf = (href) => href.split("#")[0].replace(/\/$/, "") || "/";

  for (const file of files) {
    const page = html.get(`/${file.replace(/\/index\.html$/, "")}`);
    for (const [, href] of page.matchAll(/href="(\/guide[^"]*)"/g)) {
      const target = html.get(pathOf(href));
      assert.ok(target, `${file} links to missing page ${href}`);
      const anchor = href.split("#")[1];
      if (anchor)
        assert.ok(target.includes(`id="${anchor}"`), `${file} links to missing heading ${href}`);
    }
  }
});

test("builds a search index for the guide and keeps the badges out of it", async () => {
  const { readdir } = await import("node:fs/promises");
  const pagefind = await readdir(new URL("../dist/pagefind/", import.meta.url));
  assert.ok(pagefind.includes("pagefind.js"), "Starlight's Pagefind index is built");

  const page = await readFile(
    new URL("../dist/guide/farming/watch-streaks/index.html", import.meta.url),
    "utf8",
  );
  assert.match(page, /data-pagefind-body/);
  assert.match(page, /class="guide-support"[^>]*data-pagefind-ignore/);
});

test("gives guide pages the site's canonical form, social image and breadcrumbs", async () => {
  const page = "guide/farming/watch-streaks/index.html";
  const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");

  assert.match(
    html,
    new RegExp(`<link rel="canonical" href="${SITE.url}/guide/farming/watch-streaks"`),
  );
  assert.match(html, new RegExp(`<meta property="og:image" content="${SITE.url}/og.png"`));
  const crumbs = ldOfType(await structuredData(page), "BreadcrumbList");
  assert.deepEqual(
    crumbs.itemListElement.map((item) => item.item),
    [SITE.url, `${SITE.url}/guide`, `${SITE.url}/guide/farming/watch-streaks`],
  );
});

// Setting up the CLI is explained in the user guide. The package README on
// GitHub is written for contributors, so the site never sends people there.
test("sends people to the user guide to set up the CLI", async () => {
  const pages = ["index.html", "twitch-drops-farmer/index.html", "kick-drops-farmer/index.html"];
  for (const page of pages) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    assert.ok(html.includes(`href="${CLI_GUIDE_PATH}"`), `${page} links to ${CLI_GUIDE_PATH}`);
    assert.ok(!html.includes("lurkloot/tree/main/packages/cli"), `${page} skips the CLI README`);
  }
  await readFile(new URL(`../dist${CLI_GUIDE_PATH}/index.html`, import.meta.url), "utf8");
});

// Every page, the guide included, has the same page links in its header. The
// homepage adds a row of its own sections, each pointing at a real section.
test("gives every page the same header links", async () => {
  const pages = [
    "index.html",
    "twitch-drops-farmer/index.html",
    "kick-drops-farmer/index.html",
    "changelog/index.html",
    "privacy/index.html",
    "guide/index.html",
    "guide/farming/watch-streaks/index.html",
  ];
  for (const page of pages) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    const header = html.slice(0, html.indexOf("</header>"));
    assert.match(header, /class="sg-bar"/, `${page} uses the shared bar (SiteBar.astro)`);
    const hrefs = [
      ...header.matchAll(/<nav[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/g),
    ].flatMap((nav) => [...nav[1].matchAll(/href="([^"]+)"/g)].map((match) => match[1]));
    assert.deepEqual(
      hrefs,
      NAV_LINKS.map((link) => link.href),
      page,
    );
    // A page's section links live in the header's row (Nav.astro), never in a
    // second row of its own.
    const rows = html.match(/aria-label="On this page"/g) ?? [];
    assert.ok(rows.length <= 1, `${page} has one sections row`);
    if (rows.length === 1)
      assert.match(header, /class="sg-subnav"/, `${page} puts its sections in the header`);
  }
  const home = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  for (const section of HOME_SECTIONS) {
    assert.ok(home.includes(`href="${section.href}"`), `the sections row links ${section.href}`);
    assert.ok(home.includes(`id="${section.href.slice(1)}"`), `${section.href} is a section`);
  }
});
