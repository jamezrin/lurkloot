// Refreshes every [data-github-stars] count from the GitHub API. The answer is
// cached per visitor for an hour, which keeps page views well inside the
// anonymous rate limit; storage may be unavailable, so every access is guarded.
import { GITHUB_REPO_API, formatStars, starsFromRepo } from "../githubStars";

const CACHE_KEY = "lurkloot:github-stars";
const MAX_AGE_MS = 60 * 60 * 1000;

function render(count: number) {
  for (const element of document.querySelectorAll<HTMLElement>("[data-github-stars]")) {
    element.textContent = formatStars(count);
    element.closest<HTMLElement>("[data-github-stars-wrap]")?.removeAttribute("hidden");
  }
}

function cached(): number | null {
  try {
    const entry = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as { count?: unknown; at?: unknown } | null;
    if (!entry || typeof entry.at !== "number" || Date.now() - entry.at > MAX_AGE_MS) return null;
    return starsFromRepo({ stargazers_count: entry.count });
  } catch {
    return null;
  }
}

async function refresh() {
  const fresh = cached();
  if (fresh !== null) return render(fresh);
  try {
    const response = await fetch(GITHUB_REPO_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) return;
    const count = starsFromRepo(await response.json());
    if (count === null) return;
    render(count);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ count, at: Date.now() }));
    } catch {
      // No storage: the next page view simply asks again.
    }
  } catch {
    // Offline or blocked: keep whatever the build rendered.
  }
}

if (document.querySelector("[data-github-stars]")) void refresh();
