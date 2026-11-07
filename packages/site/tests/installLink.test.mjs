import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EXTERNAL_URLS, LINKS } from "../src/consts.ts";
import { installLinkFor } from "../src/installLink.ts";

const agents = {
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  firefoxAndroid: "Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  firefoxIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
};

test("attributes Firefox Add-ons website referrals like the Chrome Web Store", () => {
  const url = new URL(LINKS.firefox);

  assert.equal(url.origin + url.pathname, EXTERNAL_URLS.firefox);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    utm_source: "lurkloot_website",
    utm_medium: "referral",
    utm_campaign: "extension_install",
  });
});

test("sends Firefox to Firefox Add-ons and everything else to the Chrome Web Store", () => {
  assert.equal(installLinkFor(agents.firefox, LINKS), LINKS.firefox);
  assert.equal(installLinkFor(agents.firefoxAndroid, LINKS), LINKS.firefox);
  assert.equal(installLinkFor(agents.chrome, LINKS), LINKS.chrome);
  assert.equal(installLinkFor(agents.edge, LINKS), LINKS.chrome);
  // Firefox on iOS cannot install add-ons.
  assert.equal(installLinkFor(agents.firefoxIos, LINKS), LINKS.chrome);
});

// The HTML carries the Chrome Web Store link for crawlers and visitors without
// scripts; only buttons marked data-install-link are switched in Firefox, so
// an unmarked one would send Firefox visitors to a store they cannot use.
test("marks every install button so Firefox visitors get Firefox Add-ons", async () => {
  const escaped = LINKS.chrome.replaceAll("&", "&amp;");
  for (const page of [
    "index.html",
    "twitch-drops-farmer/index.html",
    "kick-drops-farmer/index.html",
  ]) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    const anchors = [...html.matchAll(/<a\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes(escaped) || tag.includes(LINKS.chrome));

    assert.ok(anchors.length > 0, `${page} has install buttons`);
    for (const tag of anchors) assert.match(tag, /data-install-link/, `${page}: ${tag}`);
  }
});

test("lists Firefox among the supported browsers in structured data", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const software = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)]
    .map((match) => JSON.parse(match[1]))
    .find((block) => block["@type"] === "SoftwareApplication");

  assert.match(software.operatingSystem, /Firefox/);
  assert.match(software.operatingSystem, /Chrome/);
});
