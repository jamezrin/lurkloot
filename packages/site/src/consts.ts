import { englishCopy } from "./copy/en.ts";

// Shared, single-source-of-truth content for the landing page.

export const SITE = {
  name: "Lurkloot",
  tagline: englishCopy.meta.tagline,
  // Used for canonical/OG absolute URLs. Mirrors astro.config `site`.
  url: "https://lurkloot.jamezrin.com",
  description: englishCopy.meta.description,
  // SEO keyword spread — woven into copy, not stuffed.
  keywords: [
    "farm twitch drops",
    "twitch drops farmer",
    "auto claim twitch drops",
    "afk twitch drops",
    "kick drops farmer",
    "farm kick drops",
    "rust twitch drops",
    "valorant drops",
    "twitch drops extension",
    "twitch drops cli",
    "headless twitch drops",
    "self-hosted twitch drops",
    "twitch drops docker",
    "open source twitch drops",
    "watch twitch drops automatically",
    "drops auto claim",
    "lurkloot",
  ].join(", "),
} as const;

// Published headless image — built multi-arch (amd64 + arm64) on GHCR by the
// unified release workflow. Used verbatim in the CLI section's snippet.
export const DOCKER_IMAGE = "ghcr.io/jamezrin/lurkloot-cli:latest";

export const EXTERNAL_URLS = {
  chrome:
    "https://chromewebstore.google.com/detail/lurkloot/aobaackpofkghaejdnnmpmeaiaoibhdn",
  github: "https://github.com/jamezrin/lurkloot",
  cli: "https://github.com/jamezrin/lurkloot/tree/main/packages/cli",
  ghcr: "https://github.com/jamezrin/lurkloot/pkgs/container/lurkloot-cli",
} as const;

function withCampaign(url: string, campaign: "extension_install" | "open_source"): string {
  const attributed = new URL(url);
  attributed.searchParams.set("utm_source", "lurkloot_website");
  attributed.searchParams.set("utm_medium", "referral");
  attributed.searchParams.set("utm_campaign", campaign);
  return attributed.href;
}

export const LINKS = {
  chrome: withCampaign(EXTERNAL_URLS.chrome, "extension_install"),
  // On-site page (rendered from the same source policy).
  privacy: "/privacy",
  changelog: "/changelog",
  x: "https://x.com/jamezrin",
  // The open-source repo (not the profile) — surfaced across hero/CLI/footer.
  github: withCampaign(EXTERNAL_URLS.github, "open_source"),
  cli: withCampaign(`${EXTERNAL_URLS.cli}#readme`, "open_source"),
  ghcr: withCampaign(EXTERNAL_URLS.ghcr, "open_source"),
} as const;
