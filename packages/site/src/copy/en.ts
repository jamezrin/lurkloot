export const englishCopy = {
  meta: {
    tagline: "Farm Twitch & Kick drops on autopilot.",
    description:
      "Lurkloot is a free, open-source farmer for Twitch and Kick drops that runs through your own logged-in session. Use it as a browser extension, or run it headless with the prebuilt Docker image — lightweight tabless mode, auto-claim, smart channel switching, and a private, no-password design. Works with Rust, Valorant, and any drops campaign.",
  },
  hero: {
    eyebrow: "Lurkloot",
    title: 'Farm Twitch & Kick drops<br /><span class="grad-text">on autopilot.</span>',
    sub: "It watches the right channels, switches as campaigns end, and auto-claims every reward — in your browser or headless on a server. You just collect.",
    addToBrowser: "Add to your browser — free",
    runHeadless: "Run it headless",
    ways: "Browser extension · Headless CLI · Docker",
    openSource: "Open source",
    scroll: "scroll",
    scrollAria: "Scroll down",
  },
  manifesto: {
    eyebrow: "Why you'll love it",
    lede: "Drops, on your terms.",
    deck: "Stop arranging your life around drop campaigns. Let them arrange themselves around you.",
    perks: [
      {
        n: "01",
        head: 'Always <span class="grad-text">first</span> to the drops.',
        sub: "The second a campaign goes live, it's already farming — you never miss a limited or timed reward again.",
      },
      {
        n: "02",
        head: 'Watch who you <span class="grad-text">love</span>. Farm the rest.',
        sub: "Keep enjoying your favorite streamers while it quietly grinds drops on whoever's eligible in the background.",
      },
      {
        n: "03",
        head: 'Wake up to a <span class="grad-text">full inventory</span>.',
        sub: "Leave it running overnight and collect the whole haul by morning. Zero babysitting, zero missed claims.",
      },
    ],
  },
  how: {
    eyebrow: "How it works",
    title: 'Set it up once.<br /><span class="grad-text">Then forget it.</span>',
    steps: [
      {
        n: "01",
        title: "Install & stay logged in",
        body: "Add it to your browser. It rides on the Twitch and Kick sessions you're already signed into — nothing to connect, no password to hand over.",
      },
      {
        n: "02",
        title: "Pick what to farm",
        body: "Enable each platform and let it auto-discover live campaigns. Prioritize the drops and games you care about, or just leave the defaults and walk away.",
      },
      {
        n: "03",
        title: "It watches & claims",
        body: "It quietly keeps your watch time counting in the background — no video tab required. It hops channels as campaigns end and claims every reward the moment it unlocks.",
      },
    ],
  },
  demo: {
    eyebrow: "See it first",
    title: "This is how the<br />extension looks.",
    deck: "An interactive — but non-functional — demo of the actual popup, running on mock data. Switch Twitch/Kick, open Settings, reorder campaigns, flip toggles. Nothing here is really farming; it's just exactly the UI you get after installing.",
    pill: "interactive demo · mock data",
  },
  features: {
    eyebrow: "Under the hood",
    title: "More than a tab<br />that watches a stream.",
    beats: [
      {
        kicker: "Default · low-resource",
        title: "Sips, doesn't chug.",
        body: "Instead of pinning a video tab and burning bandwidth, it keeps your watch time counting quietly in the background. Drops tick up while your machine stays cool — and if progress ever stalls, it falls back to a muted tab so you never miss out.",
      },
      {
        kicker: "Smart scheduler",
        title: "Farms the right thing first.",
        body: "It tracks the exact channel dropping what you want and re-routes the instant a campaign ends. Drag to set your own order, or pick a strategy and let it decide.",
      },
      {
        kicker: "Hands-off rewards",
        title: "Claimed the instant it unlocks.",
        body: "Every drop is claimed for you automatically — along with Twitch channel points and Kick's daily challenge cards, each on by default and switchable per platform. You just open your inventory and find it already there.",
      },
      {
        kicker: "Total transparency",
        title: "Always know what it's doing.",
        body: "A real-time log records every decision — channel switches, claims, skips, retries — with diagnostic detail on demand. It's never a black box.",
      },
    ],
    meme: {
      withoutWho: "Without Lurkloot",
      withoutTag: "manual and annoying grind",
      vs: "vs",
      withWho: "With Lurkloot",
      withTag: "fully automatic and efficient",
    },
    scheduler: {
      chips: ["Ending soonest", "Lowest availability", "Priority list"],
      farmingNow: "farming now",
      upNext: "up next",
      idleFallback: "idle fallback",
      dragHint: "⠿ drag to reorder",
    },
    claims: [
      { name: "Signal Booster", status: "claimed ✓" },
      { name: "Marathon Crate", status: "claimed ✓" },
      { name: "Arena Skin", status: "2h 16m" },
    ],
    log: [
      { time: "14:02", level: "INFO", text: "Switched to RivalsPilot · Rust drops live" },
      { time: "14:09", level: "CLAIM", text: "Reward unlocked & claimed" },
      { time: "14:18", level: "INFO", text: "Campaign ended · re-routing" },
    ],
    more: [
      { t: "Idle Watchlist fallback", d: "Up to 20 selected channels keep you earning when no eligible drops are available." },
      { t: "Game & category filters", d: "Farm everything, or pin just the games you care about." },
      { t: "Reward notifications", d: "Get pinged the moment a drop is claimable — or when you're all done." },
      { t: "Ten languages", d: "Fully localized UI. English or Spanish? You've got more options too." },
    ],
  },
  cli: {
    eyebrow: "No browser required",
    title: 'Prefer the terminal?<br />Run it on a <span class="grad-text">server</span>.',
    deck: "The exact same farming engine, headless. No browser, no video tab — drop it on a box you already keep running and let your drops pile up 24/7.",
    bar: "lurkloot — docker",
    comments: [
      "# config.json is created with sensible defaults",
      "# then leave the farming loop running",
    ],
    points: [
      {
        t: "The same engine as the extension",
        d: "It runs @lurkloot/core directly — no faked browser globals, no headless Chrome. Identical farming logic.",
      },
      {
        t: "No browser at all",
        d: "Both platforms farm over plain HTTP, with a real Chrome TLS fingerprint to reach Kick. Twitch and Kick, no tab.",
      },
      {
        t: "Prebuilt, multi-arch image",
        d: "Pull it from GHCR for amd64 and arm64 — nothing to build. Perfect for a server, a NAS, or a Raspberry Pi.",
      },
      {
        t: "Device-login for both",
        d: "Authorize Twitch and Kick from any device with a code. No password, no cookie export, ever.",
      },
    ],
    github: "View on GitHub",
    docs: "Read the CLI docs",
  },
  coverage: {
    eyebrow: "Coverage",
    title: "Two platforms.<br />Every drop campaign.",
    deck: "Wherever a campaign runs, it's already on it — watching a channel that <b>actually counts</b> toward your drop. No hunting, no guesswork.",
    supported: "supported",
    gamesLede:
      '<span class="grad-text">Any game, any campaign.</span> If a drop exists, it gets farmed the moment it goes live — these are just a few of them.',
    imageAltSuffix: "Twitch drops supported",
    twitch: {
      blurb:
        "It finds the Twitch drops you can earn, keeps you on a channel that's actually dropping them, and claims every reward for you — channel points included.",
      points: ["Finds every drop you can earn", "Always on a dropping channel", "Claims drops + channel points"],
    },
    kick: {
      blurb:
        "Full Kick drops support, right in your browser. It follows live campaigns, picks the right channel for the reward you want, and claims it the moment it unlocks — daily challenge cards included.",
      points: ["Follows live Kick campaigns", "Picks the right channel for you", "Claims drops + daily challenges"],
    },
  },
  privacyHome: {
    eyebrow: "Private by design",
    title: "Your account<br />stays yours.",
    deck: "Other farmers ask you to hand over tokens or run on someone else's server. This does neither — a local-only, fully open-source tool that never sees a password and never phones home.",
    guarantees: [
      { t: "No password, ever", d: "It uses the session you're already logged into. Your credentials are never requested." },
      { t: "Nothing leaves your device", d: "No exported cookies or tokens, no remote servers, no analytics harvesting your activity." },
      { t: "No middleman servers", d: "It talks to Twitch and Kick straight from your browser — nothing is routed through anyone else." },
      { t: "No tracking or telemetry", d: "Your viewing activity stays on your machine — it's never collected, profiled, or sold." },
      {
        t: "Open source",
        d: "Every line is public. Read it, build it yourself, and verify it does exactly what it says — no trust required.",
        wide: true,
      },
    ],
  },
  faq: {
    eyebrow: "Answers",
    title: "Good to know.",
    deck: "Everything people want to know before installing.",
    items: [
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
        a: "When a drop becomes claimable, Lurkloot claims it for you automatically. The same goes for Twitch channel points and Kick's daily challenge cards, which are opened as soon as their watch-time goal is met — both are on by default, with a separate toggle per platform. You can also turn on notifications so you know the moment a reward lands, and it tells you when all campaigns are exhausted.",
      },
      {
        q: "Can I control which campaigns it prioritizes?",
        a: "Fully. Drag campaigns to set an explicit farming order, or pick a strategy: ending soonest first, lowest availability first, or priority-list only. You can exclude specific campaigns and channels, choose which games to farm, and keep a per-platform Idle Watchlist as a fallback for when no eligible drops are available.",
      },
    ],
  },
  cta: {
    eyebrow: "Ready when you are",
    title: 'Stop watching.<br />Start <span class="grad-text">collecting</span>.',
    lede: "Free, and running in under a minute. Install once and let your drops pile up while you do literally anything else.",
    addToBrowser: "Add to your browser — free",
    assure: [
      "No .exe, no download — just an extension",
      "Open source — audit every line",
      "Or run it headless via Docker",
      "Windows · macOS · Linux · ChromeOS",
      "Updated for every Twitch & Kick change",
    ],
    fine: "No account · No password · No tracking",
  },
  footer: {
    brand: "Lurkloot",
    logoAlt: "Lurkloot",
    tagline: "Farm Twitch & Kick drops on autopilot — free and private.",
    navLabel: "Footer",
    chrome: "Chrome Web Store",
    source: "Source code",
    changelog: "Changelog",
    privacy: "Privacy Policy",
    followX: "Follow on X",
    viewGithub: "View on GitHub",
    disclaimer:
      "Not affiliated with, endorsed by, or sponsored by Twitch or Kick. All trademarks belong to their respective owners. Use at your own discretion.",
  },
  pills: {
    label: "Works on every Chromium browser",
  },
  changelog: {
    title: "Changelog",
    eyebrow: "Release notes",
    kind: {
      new: "New",
      improved: "Improved",
      fixed: "Fixed",
    },
    unreleased: "Unreleased",
    back: "← Back to home",
    addToBrowser: "Add to browser",
    pageTitle: "Changelog — Lurkloot",
    pageDescription:
      "What's new in Lurkloot — release notes for every version of the Twitch and Kick drops farming extension.",
  },
  privacyPage: {
    eyebrow: "Legal",
    title: "Privacy Policy",
    addToBrowser: "Add to browser",
    back: "← Back to home",
    pageTitle: "Privacy Policy — Lurkloot",
    pageDescription:
      "Lurkloot does not collect, transmit, sell, or share user data. Everything stays on your device. Read the full privacy policy.",
  },
} as const;
