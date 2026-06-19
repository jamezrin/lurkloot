// Shared, single-source-of-truth content for the landing page.

export const SITE = {
  name: "Lurkloot",
  tagline: "Farm Twitch & Kick drops on autopilot.",
  // Used for canonical/OG absolute URLs. Mirrors astro.config `site`.
  url: "https://lurkloot.jamezrin.com",
  description:
    "Lurkloot is a free, open-source farmer for Twitch and Kick drops that runs through your own logged-in session. Use it as a browser extension, or run it headless with the prebuilt Docker image — lightweight tabless mode, auto-claim, smart channel switching, and a private, no-password design. Works with Rust, Valorant, and any drops campaign.",
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

// Published headless image — built multi-arch (amd64 + arm64) on GHCR by
// .github/workflows/cli-docker.yml. Used verbatim in the CLI section's snippet.
export const DOCKER_IMAGE = "ghcr.io/jamezrin/lurkloot-cli";

export const LINKS = {
  chrome:
    "https://chromewebstore.google.com/detail/lurkloot/aobaackpofkghaejdnnmpmeaiaoibhdn",
  // On-site page (rendered from the same source policy).
  privacy: "/privacy",
  changelog: "/changelog",
  x: "https://x.com/jamezrin",
  // The open-source repo (not the profile) — surfaced across hero/CLI/footer.
  github: "https://github.com/jamezrin/lurkloot",
  cli: "https://github.com/jamezrin/lurkloot/tree/main/packages/cli#readme",
  ghcr: "https://github.com/jamezrin/lurkloot/pkgs/container/lurkloot-cli",
} as const;
