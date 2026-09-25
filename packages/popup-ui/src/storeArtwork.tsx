import React from "react";
import { LurklootMark } from "./mark";

import { isRtlLocale } from "@lurkloot/shared/i18n";
import type { SupportedLocale } from "@lurkloot/shared/models";
import { STORE_ARTWORK_COPY, type StoreArtworkCopy } from "./storeArtworkCopy";

export type StoreStory = keyof StoreArtworkCopy["stories"];

export function StoreArtwork({ story, children, locale = "en" }: { story: StoreStory; children: React.ReactNode; locale?: SupportedLocale }): React.ReactElement {
  const text = STORE_ARTWORK_COPY[locale];
  const copy = text.stories[story];
  const rtl = isRtlLocale(locale);
  const localized = locale !== "en";
  const light = story === "games" || story === "watchlist";
  const ink = light ? "#101010" : "#fafafa";
  const muted = light ? "#606060" : "#a5a5a5";
  const line = light ? "#d8d8d8" : "#333333";
  return (
    <div lang={locale.replace("_", "-")} data-store-artwork={story} style={{ position: "relative", width: 1280, height: 800, overflow: "hidden", background: light ? "#f5f5f5" : "#101010", color: ink, fontFamily: "Geist, sans-serif" }}>
      <header style={{ position: "absolute", top: 30, left: 48, right: 48, height: 58, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${line}`, paddingBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 23, fontWeight: 700, letterSpacing: "-0.8px" }}><LurklootMark size={32} />Lurkloot</div>
        <span style={{ fontSize: 12, letterSpacing: "1.5px", color: muted }}>{text.tagline}</span>
      </header>
      <section data-artwork-copy dir={rtl ? "rtl" : "ltr"} style={{ position: "absolute", left: 48, top: 176, width: 400 }}>
        <div style={{ fontSize: 11, letterSpacing: "1.8px", fontWeight: 600, color: muted, marginBottom: 26 }}>{copy.number} / {copy.label}</div>
        <h1 data-artwork-heading style={{ fontFamily: "Archivo, sans-serif", whiteSpace: "pre-line", fontSize: localized ? 45 : 57, lineHeight: locale === "hi" || rtl ? 1.25 : 1.04, fontWeight: 750, letterSpacing: localized ? "-1px" : "-2.8px", margin: 0 }}>{copy.title}</h1>
        <p style={{ color: muted, fontSize: localized ? 17 : 18, lineHeight: 1.55, maxWidth: localized ? 370 : 330, margin: "26px 0 36px" }}>{copy.description}</p>
        <div style={{ borderTop: `1px solid ${line}`, maxWidth: localized ? 380 : 330, paddingTop: 22, display: "grid", gap: 15 }}>
          {copy.points.map((point) => <div key={point} style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 14 }}><span aria-hidden style={{ width: 4, height: 4, flexShrink: 0, background: ink }} />{point}</div>)}
        </div>
      </section>
      <style>{`[data-store-artwork] [data-watch-source-place] > div > div:last-child, [data-store-artwork] button[data-view="nopixel"], [data-store-artwork] button[data-view="fortnite"] { display: none !important; } [data-store-popup] > main { border: 0 !important; box-shadow: none !important; }`}</style>
      <div data-store-popup style={{ position: "absolute", top: 128, left: 512, width: 720, height: 600, overflow: "hidden", boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)" }}>{story === "extensions" ? <ExtensionOverview copy={text.overview} rtl={rtl} /> : children}</div>
      <footer style={{ position: "absolute", left: 48, right: 48, bottom: 26, display: "flex", justifyContent: "space-between", fontSize: 11, color: muted }}>
        <span style={{ marginLeft: "auto" }}>{copy.caption}</span>
      </footer>
    </div>
  );
}

// Editorial feature diagram, deliberately separate from the captured product UI.
function ExtensionOverview({ copy, rtl }: { copy: StoreArtworkCopy["overview"]; rtl: boolean }): React.ReactElement {
  return (
    <div data-extension-overview dir={rtl ? "rtl" : "ltr"} style={{ width: 720, height: 600, padding: "40px 44px", background: "#f5f5f5", color: "#101010", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}><LurklootMark size={36} /><span style={{ fontSize: 12, letterSpacing: 2 }}>{copy.tagline}</span></div>
      <h2 style={{ fontFamily: "Archivo, sans-serif", fontSize: 38, lineHeight: 1.1, letterSpacing: -1.5, margin: "0 0 14px" }}>{copy.title}</h2>
      <p style={{ fontSize: 17, color: "#606060", lineHeight: 1.5, margin: "0 0 32px", maxWidth: 520 }}>{copy.description}</p>
      {copy.steps.map(([title, description], index) => {
        const number = String(index + 1).padStart(2, "0");
        return (
          <div key={number} style={{ display: "flex", gap: 22, padding: "22px 0", borderTop: "1px solid #d8d8d8" }}>
            <span style={{ fontSize: 12, color: "#737373", paddingTop: 4 }}>{number}</span>
            <div><h3 style={{ fontSize: 20, fontWeight: 650, margin: "0 0 7px" }}>{title}</h3><p style={{ fontSize: 14, color: "#606060", margin: 0, lineHeight: 1.45 }}>{description}</p></div>
          </div>
        );
      })}
    </div>
  );
}

export function StorePromo({ format, locale = "en" }: { format: "small" | "marquee"; locale?: SupportedLocale }): React.ReactElement {
  const small = format === "small";
  const text = STORE_ARTWORK_COPY[locale];
  const rtl = isRtlLocale(locale);
  const localized = locale !== "en";
  return (
    <div lang={locale.replace("_", "-")} data-store-promo={format} style={{ width: small ? 440 : 1400, height: small ? 280 : 560, position: "relative", overflow: "hidden", background: "#101010", color: "#fafafa", fontFamily: "Geist, sans-serif", padding: small ? 26 : 48, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: small ? 20 : 26, fontWeight: 700, letterSpacing: -0.8 }}><LurklootMark size={small ? 28 : 36} />Lurkloot</div>
      <h1 data-artwork-heading style={{ fontFamily: "Archivo, sans-serif", fontWeight: 750, whiteSpace: "pre-line", width: small ? 388 : 690, direction: rtl ? "rtl" : "ltr", fontSize: small ? (localized ? 37 : 43) : (localized ? 60 : 76), lineHeight: rtl || locale === "hi" ? 1.2 : 1.02, letterSpacing: localized ? -0.5 : small ? -1.8 : -3.5, margin: small ? "23px 0 18px" : "66px 0 24px" }}>{text.stories.queue.title}</h1>
      <p data-promo-description dir={rtl ? "rtl" : "ltr"} style={{ width: small ? 388 : 690, color: "#b0b0b0", fontSize: small ? 13 : 20, lineHeight: 1.6, margin: 0 }}>{text.promo.lines.map((line) => <span key={line} style={{ display: "block" }}>{line}</span>)}</p>
      {!small ? <div data-promo-steps dir={rtl ? "rtl" : "ltr"} style={{ position: "absolute", top: 48, bottom: 48, right: 48, width: 520, display: "flex", flexDirection: "column", justifyContent: "space-between", paddingLeft: 40, borderLeft: "1px solid #333" }}>
        {text.promo.steps.map(([title, description], index) => <div key={index} style={{ padding: "18px 0" }}><div style={{ fontSize: 11, color: "#8c8c8c", letterSpacing: 2, marginBottom: 14 }}>{String(index + 1).padStart(2, "0")} / LURKLOOT</div><h2 style={{ fontFamily: "Archivo, sans-serif", fontSize: localized ? 26 : 29, letterSpacing: -0.8, margin: "0 0 8px" }}>{title}</h2><p style={{ color: "#a5a5a5", fontSize: 16, margin: 0 }}>{description}</p></div>)}
      </div> : null}
    </div>
  );
}
