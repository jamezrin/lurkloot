// Star count for the nav. The build does not fetch it. The page script
// (scripts/github-stars.ts) asks GitHub from the visitor's browser.
export const GITHUB_REPO = "jamezrin/lurkloot";
export const GITHUB_REPO_API = `https://api.github.com/repos/${GITHUB_REPO}`;

/** 1234 -> "1.2k", the way GitHub abbreviates its own counters. */
export function formatStars(count: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count).toLowerCase();
}

export function starsFromRepo(body: unknown): number | null {
  const count = (body as { stargazers_count?: unknown } | null)?.stargazers_count;
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null;
}
