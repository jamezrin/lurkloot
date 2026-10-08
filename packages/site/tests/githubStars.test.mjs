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
];

test("leaves the star slot empty until the browser asks GitHub", async () => {
  for (const page of pages) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    assert.match(html, /data-github-stars-wrap hidden/, page);
    assert.match(html, /<span data-github-stars><\/span>/, page);
    assert.match(html, new RegExp(GITHUB_REPO_API.replaceAll(".", "\\.")), page);
    assert.doesNotMatch(html, /localStorage/, page);
  }
});
