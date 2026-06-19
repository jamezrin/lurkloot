// FAQ content — rendered both as the on-page accordion and as FAQPage JSON-LD.
// Answers are plain text (no markup) so they're valid for structured data.

export interface FaqItem {
  q: string;
  a: string;
}

export const faqItems: FaqItem[] = [
  {
    q: "Is Lurkloot free?",
    a: "Yes. Lurkloot is completely free and open source. There are no accounts, no subscriptions, and no paywalled features — install it from the Chrome Web Store and it works immediately. The headless CLI and its Docker image are free too.",
  },
  {
    q: "Does it need my Twitch or Kick password?",
    a: "Never. The browser extension reuses the session you are already logged into, and the headless CLI authorizes through each platform's device-login — a short code you approve on any device. Either way it does not ask for your password, and it does not export or upload your cookies or tokens. Your credentials stay where they are.",
  },
  {
    q: "Does it farm drops while I'm AFK or the tab is in the background?",
    a: "Yes — that is the whole point. By default it uses a lightweight background mode that keeps your watch time counting without a video tab open at all. If progress ever stalls, it automatically falls back to a pinned, muted tab to keep your drops moving while you do other things.",
  },
  {
    q: "Can I run it without a browser, on a server?",
    a: "Yes. Alongside the browser extension, Lurkloot ships a headless command-line version that runs the exact same farming engine with no browser at all — both Twitch and Kick farm over plain HTTP. There is a prebuilt, multi-arch Docker image, so you can leave it running 24/7 on a server, a NAS, or a Raspberry Pi. You authorize each platform once with a device-login code, then it just collects.",
  },
  {
    q: "Is Lurkloot open source?",
    a: "Yes. The whole codebase is open source on GitHub — the extension, the headless CLI, and the shared farming engine. You can read every line, build it yourself, and confirm exactly what it does. Since nothing is hidden and nothing phones home, you do not have to take our word for the privacy claims.",
  },
  {
    q: "Which games and drops does it support?",
    a: "It works with any Twitch or Kick drops campaign the platform offers — including popular titles like Rust and Valorant, plus everything else with active drops. It discovers live campaigns automatically, tracks the right channel for each drop, and switches channels as campaigns finish.",
  },
  {
    q: "Is it safe to use? Will I get banned?",
    a: "Lurkloot operates entirely within your own normal, logged-in browser session and does not touch your password or export any data. That said, it is an unofficial tool and is not affiliated with, endorsed by, or sponsored by Twitch or Kick. Automating viewing may be against a platform's terms of service, so use it at your own discretion.",
  },
  {
    q: "How does the auto-claim work?",
    a: "When a drop becomes claimable, Lurkloot claims it for you automatically — including Twitch channel points if you enable that toggle. You can also turn on notifications so you know the moment a reward lands, and it tells you when all campaigns are exhausted.",
  },
  {
    q: "Can I control which campaigns it prioritizes?",
    a: "Fully. Drag campaigns to set an explicit farming order, or pick a strategy: ending soonest first, lowest availability first, or priority-list only. You can exclude specific campaigns and channels, choose which games to farm, and keep a per-platform Watch Queue as a fallback so you keep earning even when no drops are active.",
  },
];
