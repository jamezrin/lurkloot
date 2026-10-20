import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { LurklootMark } from "./mark";
import { isRtlLocale } from "@lurkloot/shared/i18n";
import type { SupportedLocale } from "@lurkloot/shared/models";
import { STORE_ARTWORK_COPY, type StoreArtworkCopy } from "./storeArtworkCopy";

export type StoreStory = keyof StoreArtworkCopy["stories"];

// Store artwork is one large headline and one large visual per image: the
// listing shows screenshots scaled down and never at full size. Product
// visuals are real demo UI, enlarged; camera styles live in storeArtwork.css.
export function StoreArtwork({
  story,
  children,
  locale = "en",
}: {
  story: StoreStory;
  children: React.ReactNode;
  locale?: SupportedLocale;
}): React.ReactElement {
  const text = STORE_ARTWORK_COPY[locale];
  const copy = text.stories[story];
  const subtitle = "description" in copy ? copy.description : undefined;
  const rtl = isRtlLocale(locale);
  const light = story === "games" || story === "watchlist";
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      const heading = headingRef.current;
      if (cancelled || !heading) return;
      // Keep every language large, while respecting its actual bundled glyphs
      // and line breaks. Never squeeze or horizontally stretch the type.
      // The closing shot is a statement, set larger than the others.
      const closing = story === "free";
      const maxHeight = closing ? 340 : 230;
      const minSize = closing ? 88 : 64;
      let size = closing ? 156 : 104;
      heading.style.fontSize = `${size}px`;
      while (
        (heading.offsetHeight > maxHeight || heading.scrollWidth > heading.clientWidth)
        && size > minSize
      ) {
        heading.style.fontSize = `${--size}px`;
      }
      heading.dataset.artworkHeadingReady = "";
    });
    return () => {
      cancelled = true;
    };
  }, [copy.title, story]);
  return (
    <div
      lang={locale.replace("_", "-")}
      data-store-artwork={story}
      data-light={light || undefined}
      data-subtitled={subtitle ? "" : undefined}
      dir={rtl ? "rtl" : "ltr"}
    >
      <header className="store-brand">
        <LurklootMark size={36} />
        <span>Lurkloot</span>
      </header>
      <span className="store-number" dir="ltr">
        {copy.number} / 05
      </span>
      <section data-artwork-copy>
        <h1 ref={headingRef} data-artwork-heading>
          {copy.title.split("\n").map((line) => (
            <span key={line}>{line}</span>
          ))}
        </h1>
      </section>
      {subtitle ? (
        <p className="store-subtitle" data-artwork-detail>
          {subtitle}
        </p>
      ) : null}
      <div data-store-popup>
        {story === "queue" ? (
          <RewardCamera source={children} rewards={OPENING_REWARDS} />
        ) : story === "kick" ? (
          <PlatformFeatures platforms={text.platforms} />
        ) : story === "free" ? null : (
          <div className="store-focus">{children}</div>
        )}
      </div>
    </div>
  );
}

// Editorial lists of what Lurkloot supports on each platform.
function PlatformFeatures({
  platforms,
}: {
  platforms: StoreArtworkCopy["platforms"];
}): React.ReactElement {
  return (
    <div className="store-platforms" data-platform-features>
      {(["twitch", "kick"] as const).map((platform) => (
        <section className="store-platform" data-platform={platform} key={platform}>
          <h2>
            <span />
            {platform === "twitch" ? "Twitch" : "Kick"}
          </h2>
          <ul>
            {platforms[platform].map((feature) => (
              <li key={feature} data-artwork-detail>
                <span className="store-check">
                  <Check size={26} strokeWidth={3.5} />
                </span>
                {feature}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// Indexes into the first campaign's rewards: claimed, in progress, not started.
const OPENING_REWARDS = [0, 1, 2] as const;

// Reward tiles are too small to read in a listing thumbnail at popup scale.
// The camera renders the real popup out of sight and photographs chosen tiles
// of its first campaign: a static copy of real UI, enlarged with CSS zoom.
function RewardCamera({
  source,
  rewards,
}: {
  source: React.ReactNode;
  rewards: readonly number[];
}): React.ReactElement {
  const sourceRef = useRef<HTMLDivElement>(null);
  const filmRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const root = sourceRef.current;
    const film = filmRef.current;
    if (!root || !film) return;
    const capture = (): boolean => {
      const row = root.querySelector("[data-campaign-id] [data-reward-row]");
      const tiles = row ? rewards.map((index) => row.children[index]) : [];
      if (!row || tiles.some((tile) => !tile)) return false;
      // Tiles read theme colours from custom properties set on the popup.
      const style = getComputedStyle(row);
      for (const name of Array.from(style)) {
        if (name.startsWith("--")) film.style.setProperty(name, style.getPropertyValue(name));
      }
      film.replaceChildren(...tiles.map((tile) => tile.cloneNode(true)));
      return true;
    };
    // Recapture on every change: the catalog and images load after the tiles
    // first appear, and the copy must show the settled UI.
    if (capture()) setReady(true);
    const observer = new MutationObserver(() => {
      if (capture()) setReady(true);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => observer.disconnect();
  }, [rewards]);
  return (
    <div className="store-reward-camera" data-reward-camera-ready={ready || undefined}>
      <div ref={filmRef} className="store-reward-film" />
      <div ref={sourceRef} className="store-camera-source" aria-hidden>
        {source}
      </div>
    </div>
  );
}

export function StorePromo({
  format,
  locale = "en",
}: {
  format: "small" | "marquee";
  locale?: SupportedLocale;
}): React.ReactElement {
  const small = format === "small";
  const text = STORE_ARTWORK_COPY[locale];
  const rtl = isRtlLocale(locale);
  const localized = locale !== "en";
  return (
    <div
      lang={locale.replace("_", "-")}
      data-store-promo={format}
      style={{
        width: small ? 440 : 1400,
        height: small ? 280 : 560,
        position: "relative",
        overflow: "hidden",
        background: "#101010",
        color: "#fafafa",
        fontFamily: "Geist, sans-serif",
        padding: small ? 26 : 48,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: small ? 20 : 26,
          fontWeight: 700,
          letterSpacing: -0.8,
        }}
      >
        <LurklootMark size={small ? 28 : 36} />
        Lurkloot
      </div>
      <h1
        data-artwork-heading
        style={{
          fontFamily: "Archivo, sans-serif",
          fontWeight: 750,
          whiteSpace: "pre-line",
          width: small ? 388 : 690,
          direction: rtl ? "rtl" : "ltr",
          fontSize: small ? (localized ? 37 : 43) : localized ? 60 : 76,
          lineHeight: rtl || locale === "hi" ? 1.2 : 1.02,
          letterSpacing: localized ? -0.5 : small ? -1.8 : -3.5,
          margin: small ? "23px 0 18px" : "66px 0 24px",
        }}
      >
        {text.stories.queue.title}
      </h1>
      <p
        data-promo-description
        dir={rtl ? "rtl" : "ltr"}
        style={{
          width: small ? 388 : 690,
          color: "#b0b0b0",
          fontSize: small ? 13 : 20,
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        {text.promo.lines.map((line) => (
          <span key={line} style={{ display: "block" }}>
            {line}
          </span>
        ))}
      </p>
      {!small ? (
        <div
          data-promo-steps
          dir={rtl ? "rtl" : "ltr"}
          style={{
            position: "absolute",
            top: 48,
            bottom: 48,
            right: 48,
            width: 520,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            paddingLeft: 40,
            borderLeft: "1px solid #333",
          }}
        >
          {text.promo.steps.map(([title, description], index) => (
            <div key={index} style={{ padding: "18px 0" }}>
              <div style={{ fontSize: 11, color: "#8c8c8c", letterSpacing: 2, marginBottom: 14 }}>
                {String(index + 1).padStart(2, "0")} / LURKLOOT
              </div>
              <h2
                style={{
                  fontFamily: "Archivo, sans-serif",
                  fontSize: localized ? 26 : 29,
                  letterSpacing: -0.8,
                  margin: "0 0 8px",
                }}
              >
                {title}
              </h2>
              <p style={{ color: "#a5a5a5", fontSize: 16, margin: 0 }}>{description}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
