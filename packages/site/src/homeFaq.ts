import { multipleAccountsFaq, type FaqItem } from "./faq";

// Shared by the redesigned homepage disclosures and its FAQ structured data.
export const homeFaqItems: FaqItem[] = [
  { q: "Is Lurkloot really free?", a: "Yes. The browser extension, headless CLI, and Docker image are free and open source. There are no subscriptions or paywalled features, and you do not need a separate Lurkloot account." },
  { q: "What do I need to get started?", a: "Install the extension from the Chrome Web Store in a compatible Chromium browser, then sign in to Twitch or Kick as usual. Choose your games and enable farming. Some campaigns also require linking your game account; Lurkloot cannot complete that step for you." },
  { q: "Does my browser need to stay open?", a: "Yes, when you use the extension. Your computer must stay awake and your browser must remain running. Background farming can work without a video tab; if it stalls, Lurkloot can fall back to a muted tab. For a machine without a desktop browser, use the headless CLI or Docker image." },
  multipleAccountsFaq,
  { q: "Can I choose what gets farmed first?", a: "Yes. Use the game controls and campaign queue to adjust your priorities, exclude campaigns you do not want, and choose a farming strategy. A watchlist can keep your preferred channels playing when no eligible drop campaigns remain." },
  { q: "Does it support Twitch extensions?", a: "Yes. The browser extension includes optional support for selected Twitch extensions. Enable the support you want and grant any required permissions. Availability and reward requirements depend on the supported extension; this is separate from ordinary Twitch Drops." },
  { q: "Will it work with every campaign?", a: "Lurkloot discovers campaigns from Twitch and Kick, but earning a reward still depends on campaign availability, eligible channels, and your account meeting the requirements. It is an independent, unofficial tool. Platform changes can affect farming, and rewards are not guaranteed." },
];
