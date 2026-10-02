// FAQ content — rendered both as the on-page accordion and as FAQPage JSON-LD.
// Answers are plain text (no markup) so they're valid for structured data.

export interface FaqItem {
  q: string;
  a: string;
}

export const multipleAccountsFaq: FaqItem = {
  q: "Can I farm drops on multiple accounts at once?",
  a: "Yes, one account per browser profile. The extension farms whichever account is signed in to the browser it runs in, so create a separate profile for each account (in Chrome, click your profile icon in the top-right corner), sign in to a different Twitch or Kick account in each one, and install Lurkloot in every profile. Each profile farms on its own with its own settings; there is no single dashboard across them. For many accounts, the headless CLI works the same way: give each account its own config directory, or its own Docker container and data volume.",
};

// Twitch landing page (/twitch-drops-farmer). Deliberately different questions
// from the homepage set and from the Kick page: these are the things people ask
// about *Twitch* drops specifically — integrity, tiers, channel points, the
// headless CLI.
export const twitchFaqItems: FaqItem[] = [
  {
    q: "How does Lurkloot farm Twitch Drops automatically?",
    a: "It reads your Twitch inventory and the live drops directory to work out which campaigns you can still earn, picks a channel that is actually live in the campaign's game and has drops enabled, and keeps your watch time counting there. When a campaign ends, a stream goes offline, or a reward tier completes, it re-routes to the next eligible channel on its own.",
  },
  {
    q: "Do I need to keep a Twitch tab open?",
    a: "No. The default mode sends the same minute-watched heartbeat Twitch's own player sends, with no video tab open at all, so your machine stays cool and your bandwidth stays free. If those heartbeats ever stop registering progress, Lurkloot falls back to a pinned, muted twitch.tv tab automatically so the drop keeps moving.",
  },
  {
    q: "Does it claim Twitch Drops and channel points for me?",
    a: "Yes, both. A drop is claimed as soon as its watch requirement is met, and Twitch channel points bonuses are collected on the channel you are farming. Each is a separate toggle, both on by default. Multi-tier campaigns are tracked tier by tier, so a five-hour campaign claims its one-hour reward without waiting for the rest.",
  },
  {
    q: "Can I farm Twitch Drops on a server, with no browser?",
    a: "The headless CLI can run on a server or NAS without a browser. It uses Twitch's Smart TV device-code login. Twitch currently withholds the full campaign dashboard from headless clients, so the CLI scans live channels in games you configure and may miss offline or unscanned campaigns. The browser extension remains the choice for full campaign discovery while this CLI path is being verified end to end.",
  },
  {
    q: "Which browsers does the Twitch Drops extension work in?",
    a: "Any Chromium browser: Chrome, Edge, Brave, Opera and Vivaldi all install it from the Chrome Web Store. Firefox builds are published on GitHub Releases. It runs on the Twitch session you are already signed into, so there is nothing to connect and no password to hand over.",
  },
  {
    q: "Can I choose which Twitch campaigns it farms first?",
    a: "Yes. Pin campaigns in the queue and reorder them, rank your favourite games, or choose a strategy for the remaining campaigns. You can also farm pinned campaigns only. You can exclude individual campaigns and channels, restrict it to chosen games, and decide whether campaigns that need an account link or an active channel subscription are farmed at all. A per-platform Idle Watchlist covers the hours when nothing is droppable.",
  },
];

// Kick landing page (/kick-drops-farmer). Kick's mechanics differ enough from
// Twitch's that these are genuinely separate answers, not restatements: the
// viewer socket, the Pusher campaign-start signal, gamification challenge
// cards, and the Cloudflare-fingerprint constraint on the headless path.
export const kickFaqItems: FaqItem[] = [
  {
    q: "How does Lurkloot farm Kick Drops automatically?",
    a: "It follows Kick's live drops campaigns, picks a channel streaming the campaign's category right now, and holds a viewer session on it so the drop's watch timer advances. As campaigns finish or a streamer ends their broadcast, it moves to the next channel that still counts toward a reward you have not earned.",
  },
  {
    q: "How fast does it notice a new Kick campaign?",
    a: "Usually within seconds. Alongside its regular polling, Lurkloot subscribes to Kick's realtime campaign channel and gets pushed a signal the moment a campaign starts in a category you farm — which is what makes short flash-drop windows catchable at all instead of being missed between polls.",
  },
  {
    q: "Does it claim Kick Drops and daily challenges?",
    a: "Yes. Kick drops are claimed as soon as their watch requirement is met, and Kick's daily challenge cards are opened the moment their goal is reached rather than sitting unclaimed until you remember them. Both are on by default and can be switched off independently of the Twitch side.",
  },
  {
    q: "Does Kick farming need a visible tab?",
    a: "Usually not. Lurkloot opens Kick's viewer socket directly from the extension's background worker, which advances the watch timer with no video playing. Because that socket is opened from the extension rather than from kick.com itself, Kick can occasionally refuse the handshake — when that happens Lurkloot notices the watch is unhealthy and falls back to a pinned, muted kick.com tab, so farming carries on either way.",
  },
  {
    q: "Can I farm Kick Drops headless, in Docker?",
    a: "Yes, with one caveat worth knowing. Kick's Cloudflare protection inspects the TLS and HTTP/2 fingerprint of every request, so a plain Node request is rejected outright — the CLI's default transport sends a real Chrome fingerprint instead and reaches Kick's API and viewer socket with no browser. Authorization uses Kick's smart-TV link flow: the CLI prints a kick.com/tv/login URL and a six-digit code that you confirm on a device where you are already signed in.",
  },
  {
    q: "Do I need a Kick password or a cookie export?",
    a: "Neither. In the browser the extension reuses the Kick session you are already logged into. Headless, the smart-TV link approval hands back a session token directly, so the CLI requires no export. An optional, user-initiated session-token transfer from the extension is also available if you want to move an existing session.",
  },
];

// The homepage FAQ, rendered in its accordion and its FAQPage structured data.
export const homeFaqItems: FaqItem[] = [
  { q: "Is Lurkloot really free?", a: "Yes. The browser extension, headless CLI, and Docker image are free and open source. There are no subscriptions or paywalled features, and you do not need a separate Lurkloot account." },
  { q: "What do I need to get started?", a: "Install the extension from the Chrome Web Store in a compatible Chromium browser, then sign in to Twitch or Kick as usual. Choose your games and enable farming. Some campaigns also require linking your game account; Lurkloot cannot complete that step for you." },
  { q: "Does my browser need to stay open?", a: "Yes, when you use the extension. Your computer must stay awake and your browser must remain running. Background farming can work without a video tab; if it stalls, Lurkloot can fall back to a muted tab. For a machine without a desktop browser, use the headless CLI or Docker image." },
  { q: "Can I watch streams myself while Lurkloot is farming?", a: "Yes. When Lurkloot detects that you are watching a stream yourself, it pauses farming, and it resumes automatically once you pause, close, or switch away from that stream. You can turn this off in Settings under Appearance & behavior (Pause when watching manually), but watching several channels at the same time is not recommended: Twitch and Kick may not count your watch time correctly when more than one stream is playing, and the result is undefined." },
  multipleAccountsFaq,
  { q: "Can I choose what gets farmed first?", a: "Yes. Use the game controls and campaign queue to adjust your priorities, exclude campaigns you do not want, and choose a farming strategy. A watchlist can keep your preferred channels playing when no eligible drop campaigns remain." },
  { q: "Does it support Twitch extensions?", a: "Yes. The browser extension includes optional support for selected Twitch extensions. Enable the support you want and grant any required permissions. Availability and reward requirements depend on the supported extension; this is separate from ordinary Twitch Drops." },
  { q: "Will it work with every campaign?", a: "Lurkloot discovers campaigns from Twitch and Kick, but earning a reward still depends on campaign availability, eligible channels, and your account meeting the requirements. It is an independent, unofficial tool. Platform changes can affect farming, and rewards are not guaranteed." },
];
