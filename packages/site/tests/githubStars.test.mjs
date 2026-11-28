import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EXTERNAL_URLS } from "../src/consts.ts";
import { GITHUB_REPO, GITHUB_REPO_API, formatStars, starsFromRepo } from "../src/githubStars.ts";

test("points at the published repository", () => {
  assert.equal(`https://github.com/${GITHUB_REPO}`, EXTERNAL_URLS.github);
  assert.equal(GITHUB_REPO_API, `https://api.github.com/repos/${GITHUB_REPO}`);
});

test("reads a finite star count and ignores anything else", () => {
  assert.equal(starsFromRepo({ stargazers_count: 24 }), 24);
  assert.equal(starsFromRepo({ stargazers_count: 0 }), 0);
  assert.equal(starsFromRepo({ stargazers_count: 1.5 }), 1.5);
  assert.equal(starsFromRepo({ stargazers_count: -1 }), null);
  assert.equal(starsFromRepo({ stargazers_count: "24" }), null);
  assert.equal(starsFromRepo(null), null);
});

test("abbreviates the way GitHub does", () => {
  assert.equal(formatStars(24), "24");
  assert.equal(formatStars(1200), "1.2k");
});

const pages = [
  "index.html",
  "privacy/index.html",
  "changelog/index.html",
  "twitch-drops-farmer/index.html",
  "kick-drops-farmer/index.html",
  "guide/index.html",
  "guide/getting-started/install/index.html",
];

// The page and the scripts it loads, one import deep: a script that several
// headers share is bundled into its own file rather than into the page.
async function withScripts(page) {
  const dist = new URL("../dist/", import.meta.url);
  const html = await readFile(new URL(page, dist), "utf8");
  const read = (path) => readFile(new URL(path.replace(/^\//, ""), dist), "utf8").catch(() => "");
  const scripts = await Promise.all(
    [...html.matchAll(/<script[^>]*src="(\/_astro\/[^"]+\.js)"/g)].map(async ([, src]) => {
      const code = await read(src);
      const imports = [...code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)].map(([, file]) =>
        read(`/_astro/${file}`),
      );
      return [code, ...(await Promise.all(imports))].join("\n");
    }),
  );
  return { html, code: scripts.join("\n") };
}

test("leaves the star slot empty until the browser asks GitHub", async () => {
  for (const page of pages) {
    const { html, code } = await withScripts(page);
    assert.match(html, /data-github-stars-wrap hidden/, page);
    assert.match(html, /<span data-github-stars><\/span>/, page);
    assert.match(`${html}\n${code}`, new RegExp(GITHUB_REPO_API.replaceAll(".", "\\.")), page);
    assert.doesNotMatch(html, /localStorage/, page);
  }
});
