// Shared, single-source-of-truth content for the landing page.

export const SITE = {
  name: "Stream Autopilot",
  tagline: "Farm Twitch & Kick drops on autopilot.",
  // Used for canonical/OG absolute URLs. Mirrors astro.config `site`.
  url: "https://stream-autopilot.jamezrin.com",
  description:
    "Stream Autopilot is a free browser extension that auto-farms Twitch and Kick drops through your own logged-in session. Lightweight tabless mode, auto-claim, smart channel switching, and a private, no-password design. Works with Rust, Valorant, and any drops campaign.",
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
    "watch twitch drops automatically",
    "drops auto claim",
    "stream autopilot",
  ].join(", "),
} as const;

export const LINKS = {
  chrome:
    "https://chromewebstore.google.com/detail/stream-autopilot/aobaackpofkghaejdnnmpmeaiaoibhdn",
  // On-site page (rendered from the same source policy) — no GitHub link.
  privacy: "/privacy",
} as const;
