// FAQ content — rendered both as the on-page accordion and as FAQPage JSON-LD.
// Answers are plain text (no markup) so they're valid for structured data.

export interface FaqItem {
  q: string;
  a: string;
}

export const faqItems: FaqItem[] = [
  {
    q: "Is Stream Autopilot free?",
    a: "Yes. Stream Autopilot is completely free. There are no accounts, no subscriptions, and no paywalled features — install it from the Chrome Web Store and it works immediately.",
  },
  {
    q: "Does it need my Twitch or Kick password?",
    a: "Never. It runs inside your browser and reuses the session you are already logged into. It does not ask for your password, and it does not export or upload your cookies or tokens. Your credentials stay where they are.",
  },
  {
    q: "Does it farm drops while I'm AFK or the tab is in the background?",
    a: "Yes — that is the whole point. By default it uses a lightweight tabless mode that sends watch heartbeats in the background, so you don't need a video tab open at all. If progress ever stalls, it automatically falls back to a pinned, muted tab to keep your drops moving while you do other things.",
  },
  {
    q: "Which games and drops does it support?",
    a: "It works with any Twitch or Kick drops campaign the platform offers — including popular titles like Rust and Valorant, plus everything else with active drops. It discovers live campaigns automatically, tracks the right channel for each drop, and switches channels as campaigns finish.",
  },
  {
    q: "Is it safe to use? Will I get banned?",
    a: "Stream Autopilot operates entirely within your own normal, logged-in browser session and does not touch your password or export any data. That said, it is an unofficial tool and is not affiliated with, endorsed by, or sponsored by Twitch or Kick. Automating viewing may be against a platform's terms of service, so use it at your own discretion.",
  },
  {
    q: "How does the auto-claim work?",
    a: "When a drop becomes claimable, Stream Autopilot claims it for you automatically — including Twitch channel points if you enable that toggle. You can also turn on notifications so you know the moment a reward lands, and it tells you when all campaigns are exhausted.",
  },
  {
    q: "Can I control which campaigns it prioritizes?",
    a: "Fully. Drag campaigns to set an explicit farming order, or pick a strategy: ending soonest first, lowest availability first, or priority-list only. You can exclude specific campaigns and channels, choose which games to farm, and keep a per-platform Watch Queue as a fallback so you keep earning even when no drops are active.",
  },
];
