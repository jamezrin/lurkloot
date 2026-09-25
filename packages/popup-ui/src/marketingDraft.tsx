import React from "react";
import { LurklootMark } from "./mark";

// English-only art direction draft. Opt in with ?screenshot=store&draft=queue|games|kick|watchlist|extensions.
const STORIES = {
  queue: {
    number: "01", label: "AUTOMATIC DROPS", title: <>Your drops.<br />On autopilot.</>,
    description: "Pick what matters. Lurkloot finds a stream, tracks your progress, and claims your rewards.",
    points: ["Twitch + Kick", "Automatic claiming", "Your account. Your control."],
    caption: "The queue, the stream, the next reward. All in one place.",
  },
  games: {
    number: "02", label: "YOUR WATCH ORDER", title: <>Your games.<br />Your priorities.</>,
    description: "Pin a campaign. Star a favourite game. Block the rest. Make the next reward one you actually want.",
    points: ["Pin individual campaigns", "Put favourite games first", "Skip games you don't play"],
    caption: "Choose what gets your watch time.",
  },
  kick: {
    number: "03", label: "TWITCH + KICK", title: <>Two platforms.<br />One workspace.</>,
    description: "Keep an eye on your Kick rewards with the same clear controls you use for Twitch.",
    points: ["Separate platform controls", "Live campaign progress", "Idle watchlists for the gaps"],
    caption: "Switch platforms. Keep the same routine.",
  },
  watchlist: {
    number: "04", label: "IDLE WATCHLIST", title: <>Keep your<br />favourites close.</>,
    description: "Choose the channels you want to watch when no eligible drops are available. Keep a separate list for each platform.",
    points: ["Your channels, in your order", "Up to 20 channels per platform", "Choose your watch-source priority"],
    caption: "A plan for the time between campaigns.",
  },
  extensions: {
    number: "05", label: "TWITCH EXTENSIONS", title: <>More ways<br />to earn.</>,
    description: "Lurkloot also supports rewards from selected Twitch extensions. Enable the support you want and set your watch order.",
    points: ["Optional Twitch extension support", "Dedicated progress views", "One place to manage your sources"],
    caption: "Support for selected extensions. Enabled on your terms.",
  },
};
export type StoreDraftStory = keyof typeof STORIES;

export function StoreScreenshotDraft({ story, children }: { story: StoreDraftStory; children: React.ReactNode }): React.ReactElement {
  const copy = STORIES[story];
  const light = story === "games" || story === "watchlist";
  const ink = light ? "#101010" : "#fafafa";
  const muted = light ? "#606060" : "#a5a5a5";
  const line = light ? "#d8d8d8" : "#333333";
  return (
    <div data-store-draft={story} style={{ position: "relative", width: 1280, height: 800, overflow: "hidden", background: light ? "#f5f5f5" : "#101010", color: ink, fontFamily: "Geist, sans-serif" }}>
      <header style={{ position: "absolute", top: 30, left: 48, right: 48, height: 58, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${line}`, paddingBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 23, fontWeight: 700, letterSpacing: "-0.8px" }}><LurklootMark size={32} />Lurkloot</div>
        <span style={{ fontSize: 12, letterSpacing: "1.5px", color: muted }}>LESS WATCHING. MORE REWARDS.</span>
      </header>
      <section style={{ position: "absolute", left: 48, top: 176, width: 400 }}>
        <div style={{ fontSize: 11, letterSpacing: "1.8px", fontWeight: 600, color: muted, marginBottom: 26 }}>{copy.number} / {copy.label}</div>
        <h1 style={{ fontFamily: "Archivo, sans-serif", fontSize: 57, lineHeight: 1.04, fontWeight: 750, letterSpacing: "-2.8px", margin: 0 }}>{copy.title}</h1>
        <p style={{ color: muted, fontSize: 18, lineHeight: 1.55, maxWidth: 330, margin: "26px 0 36px" }}>{copy.description}</p>
        <div style={{ borderTop: `1px solid ${line}`, maxWidth: 330, paddingTop: 22, display: "grid", gap: 15 }}>
          {copy.points.map((point) => <div key={point} style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 14 }}><span aria-hidden style={{ width: 4, height: 4, background: ink }} />{point}</div>)}
        </div>
      </section>
      <style>{`[data-store-draft] [data-watch-source-place] > div > div:last-child, [data-store-draft] button[data-view="nopixel"], [data-store-draft] button[data-view="fortnite"] { display: none !important; } [data-draft-popup] > main { border: 0 !important; box-shadow: none !important; }`}</style>
      <div data-draft-popup style={{ position: "absolute", top: 128, left: 512, width: 720, height: 600, overflow: "hidden", boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)" }}>{story === "extensions" ? <ExtensionOverview /> : children}</div>
      <footer style={{ position: "absolute", left: 48, right: 48, bottom: 26, display: "flex", justifyContent: "space-between", fontSize: 11, color: muted }}>
        <span style={{ marginLeft: "auto" }}>{copy.caption}</span>
      </footer>
    </div>
  );
}

// Editorial feature diagram, deliberately separate from the captured product UI.
function ExtensionOverview(): React.ReactElement {
  return (
    <div data-extension-overview style={{ width: 720, height: 600, padding: "40px 44px", background: "#f5f5f5", color: "#101010", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}><LurklootMark size={36} /><span style={{ fontSize: 12, letterSpacing: 2 }}>REWARDS, CONNECTED.</span></div>
      <h2 style={{ fontFamily: "Archivo, sans-serif", fontSize: 38, lineHeight: 1.1, letterSpacing: -1.5, margin: "0 0 14px" }}>Beyond drops.</h2>
      <p style={{ fontSize: 17, color: "#606060", lineHeight: 1.5, margin: "0 0 32px", maxWidth: 520 }}>Bring supported Twitch extension rewards into the same workspace as your drops and idle watchlists.</p>
      {[
        ["01", "Enable optional support", "Choose which supported extensions to enable."],
        ["02", "Set the watch order", "Decide where extension rewards fit alongside drops and your watchlist."],
        ["03", "Follow your progress", "See reward progress and status in dedicated views."],
      ].map(([number, title, description]) => (
        <div key={number} style={{ display: "flex", gap: 22, padding: "22px 0", borderTop: "1px solid #d8d8d8" }}>
          <span style={{ fontSize: 12, color: "#737373", paddingTop: 4 }}>{number}</span>
          <div><h3 style={{ fontSize: 20, fontWeight: 650, margin: "0 0 7px" }}>{title}</h3><p style={{ fontSize: 14, color: "#606060", margin: 0, lineHeight: 1.45 }}>{description}</p></div>
        </div>
      ))}
    </div>
  );
}

export function StorePromoDraft({ format }: { format: "small" | "marquee" }): React.ReactElement {
  const small = format === "small";
  return (
    <div data-promo-draft={format} style={{ width: small ? 440 : 1400, height: small ? 280 : 560, position: "relative", overflow: "hidden", background: "#101010", color: "#fafafa", fontFamily: "Geist, sans-serif", padding: small ? 26 : 48, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: small ? 20 : 26, fontWeight: 700, letterSpacing: -0.8 }}><LurklootMark size={small ? 28 : 36} />Lurkloot</div>
      <h1 style={{ fontFamily: "Archivo, sans-serif", fontWeight: 750, fontSize: small ? 43 : 76, lineHeight: 1.02, letterSpacing: small ? -1.8 : -3.5, margin: small ? "23px 0 18px" : "66px 0 24px" }}>Your drops.<br />On autopilot.</h1>
      <p style={{ color: "#b0b0b0", fontSize: small ? 13 : 20, lineHeight: 1.6, margin: 0 }}>Twitch + Kick. Automatic rewards.<br />Supports selected Twitch extensions.</p>
      {!small ? <div style={{ position: "absolute", top: 48, bottom: 48, right: 48, width: 520, display: "flex", flexDirection: "column", justifyContent: "space-between", paddingLeft: 40, borderLeft: "1px solid #333" }}>
        {[
          ["01", "Drops on autopilot", "Find a stream. Track progress. Claim rewards."],
          ["02", "Twitch extensions, too", "Optional support for selected extension rewards."],
          ["03", "Your watch order", "Pin campaigns. Star games. Pick your channels."],
        ].map(([number, title, description]) => <div key={number} style={{ padding: "18px 0" }}><div style={{ fontSize: 11, color: "#8c8c8c", letterSpacing: 2, marginBottom: 14 }}>{number} / LURKLOOT</div><h2 style={{ fontFamily: "Archivo, sans-serif", fontSize: 29, letterSpacing: -0.8, margin: "0 0 8px" }}>{title}</h2><p style={{ color: "#a5a5a5", fontSize: 16, margin: 0 }}>{description}</p></div>)}
      </div> : null}
    </div>
  );
}
