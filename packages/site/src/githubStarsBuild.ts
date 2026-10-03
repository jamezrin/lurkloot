// Build-time half of the nav's star count (see githubStars.ts). Fetched once
// per build and shared by every page. A token, when the build has one, only
// lifts the anonymous rate limit; the repository is public either way.
import { GITHUB_REPO_API, starsFromRepo } from "./githubStars";

let pending: Promise<number | null> | undefined;

export function buildTimeStars(): Promise<number | null> {
  pending ??= (async () => {
    try {
      const token = process.env.GITHUB_TOKEN;
      const response = await fetch(GITHUB_REPO_API, {
        headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok ? starsFromRepo(await response.json()) : null;
    } catch {
      return null;
    }
  })();
  return pending;
}
