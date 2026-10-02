// GitHub star count for the nav. The build renders the count it can fetch at
// that moment, and the page refreshes it from the public API in the browser,
// so it stays current between deploys. Either step may fail (offline builds,
// rate limits); the count is then simply left out until one succeeds.
import { EXTERNAL_URLS } from "./consts";

const repo = new URL(EXTERNAL_URLS.github).pathname.replace(/^\/|\/$/g, "");
export const GITHUB_REPO_API = `https://api.github.com/repos/${repo}`;

/** 1234 -> "1.2k", the way GitHub abbreviates its own counters. */
export function formatStars(count: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count).toLowerCase();
}

export function starsFromRepo(body: unknown): number | null {
  const count = (body as { stargazers_count?: unknown } | null)?.stargazers_count;
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null;
}
