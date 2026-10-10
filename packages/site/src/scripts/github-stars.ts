// Fills every [data-github-stars] slot from the public GitHub API. The HTML
// ships the slot empty, so a failed request leaves the badge hidden instead of
// a count captured the last time the site was built.
import { GITHUB_REPO_API, formatStars, starsFromRepo } from "../githubStars";

function render(count: number) {
  for (const element of document.querySelectorAll<HTMLElement>("[data-github-stars]")) {
    element.textContent = formatStars(count);
    element.closest<HTMLElement>("[data-github-stars-wrap]")?.removeAttribute("hidden");
  }
}

async function refresh() {
  try {
    const response = await fetch(GITHUB_REPO_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return;
    const count = starsFromRepo(await response.json());
    if (count === null) return;
    render(count);
  } catch {
    // Offline, blocked, or rate-limited: leave the badge hidden.
  }
}

if (document.querySelector("[data-github-stars]")) void refresh();
