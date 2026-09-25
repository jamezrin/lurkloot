import type { ChannelCandidate } from "@lurkloot/shared/models";

const RESERVED_ROUTES = new Set([
  "about", "account", "auth", "browse", "categories", "category", "clips",
  "dashboard", "drops", "following", "help", "inventory", "login", "moderator",
  "payments", "privacy", "search", "settings", "signup", "subscriptions",
  "terms", "videos", "wallet", "directory",
]);

export function kickChannelFromUrl(url: string | undefined): ChannelCandidate | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["kick.com", "www.kick.com"].includes(parsed.hostname.toLowerCase())) return undefined;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return undefined;
    const username = segments[0].toLowerCase();
    if (!/^[a-z0-9_-]+$/i.test(username) || RESERVED_ROUTES.has(username)) return undefined;
    return { platform: "kick", username, url: `https://kick.com/${username}` };
  } catch {
    return undefined;
  }
}
