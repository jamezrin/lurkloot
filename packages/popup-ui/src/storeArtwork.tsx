import type React from "react";
import { useEffect, useRef } from "react";
import { ArrowLeftRight, Check, Play, Star } from "lucide-react";
import { LurklootMark } from "./mark";
import { isRtlLocale } from "@lurkloot/shared/i18n";
import type { SupportedLocale } from "@lurkloot/shared/models";
import { STORE_ARTWORK_COPY, type StoreArtworkCopy } from "./storeArtworkCopy";

export type StoreStory = keyof StoreArtworkCopy["stories"];

type HeadingFit = { maxHeight: number; minSize: number; start: number };
const HEADING_FIT: Partial<Record<StoreStory, HeadingFit>> = {
  queue: { maxHeight: 330, minSize: 44, start: 76 },
  free: { maxHeight: 340, minSize: 88, start: 156 },
  watchlist: { maxHeight: 200, minSize: 56, start: 92 },
};
const DEFAULT_HEADING_FIT: HeadingFit = { maxHeight: 230, minSize: 64, start: 104 };

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
      // The opening headline sits in a column beside the popup; the closing
      // shot is a statement, set larger than the others.
      const { maxHeight, minSize, start } = HEADING_FIT[story] ?? DEFAULT_HEADING_FIT;
      let size = start;
      heading.style.fontSize = `${size}px`;
      while (
        (heading.offsetHeight > maxHeight || heading.scrollWidth > heading.clientWidth)
        && size > minSize
      ) {
        heading.style.fontSize = `${--size}px`;
      }
      // The platform checklists shrink together until the longest item fits.
      const lists = heading.closest("[data-store-artwork]")?.querySelector<HTMLElement>(
        "[data-platform-features]",
      );
      if (lists) {
        const overflows = (): boolean =>
          Array.from(lists.querySelectorAll("li, ul")).some(
            (item) => item.scrollWidth > item.clientWidth,
          ) || lists.scrollWidth > lists.clientWidth;
        let listSize = 38;
        lists.style.setProperty("--store-list-size", `${listSize}px`);
        while (overflows() && listSize > 28) {
          lists.style.setProperty("--store-list-size", `${--listSize}px`);
        }
      }
      // The watchlist guide shrinks as one block until it fits its column.
      const guide = heading
        .closest("[data-store-artwork]")
        ?.querySelector<HTMLElement>("[data-watch-guide]");
      if (guide) {
        const overflows = (): boolean =>
          guide.scrollHeight > guide.clientHeight
          || Array.from(guide.querySelectorAll("li")).some(
            (item) => item.scrollWidth > item.clientWidth,
          );
        let guideSize = 32;
        guide.style.setProperty("--store-guide-size", `${guideSize}px`);
        while (overflows() && guideSize > 20) {
          guide.style.setProperty("--store-guide-size", `${--guideSize}px`);
        }
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
      <section data-artwork-copy>
        {story === "queue" ? (
          <p className="store-platform-badges" dir="ltr">
            <span data-platform="twitch">Twitch</span>
            <span data-platform="kick">Kick</span>
          </p>
        ) : null}
        {"feature" in copy ? <p className="store-feature">{copy.feature}</p> : null}
        <h1 ref={headingRef} data-artwork-heading>
          {copy.title.split("\n").map((line) => (
            <span key={line}>{line}</span>
          ))}
        </h1>
        {"steps" in copy ? (
          <ul className="store-steps">
            {copy.steps.map((step) => (
              <li key={step} data-artwork-detail>
                <span className="store-check">
                  <Check size={24} strokeWidth={3.5} />
                </span>
                {step}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {subtitle ? (
        <p className="store-subtitle" data-artwork-detail>
          {subtitle}
        </p>
      ) : null}
      {"howItWorks" in copy ? <WatchGuide copy={copy} /> : null}
      <div data-store-popup>
        {story === "queue" ? (
          <div className="store-full-popup">{children}</div>
        ) : story === "kick" ? (
          <PlatformFeatures platforms={text.platforms} />
        ) : story === "free" ? (
          <ProgressRing />
        ) : (
          <div className="store-focus">{children}</div>
        )}
      </div>
    </div>
  );
}

const GUIDE_ICONS = [Star, Play, ArrowLeftRight];

// How the idle watchlist works, then what it keeps earning. The list beside it
// carries the only numbers on the canvas: its watch order.
function WatchGuide({
  copy,
}: {
  copy: StoreArtworkCopy["stories"]["watchlist"];
}): React.ReactElement {
  return (
    <div className="store-watch-guide" data-watch-guide>
      <ul className="store-guide-steps">
        {copy.howItWorks.map((step, index) => {
          const Icon = GUIDE_ICONS[index] ?? Star;
          return (
            <li key={step} data-artwork-detail>
              <span className="store-guide-icon">
                <Icon size={22} strokeWidth={2.75} />
              </span>
              {step}
            </li>
          );
        })}
      </ul>
      <div className="store-guide-earning">
        <p>{copy.earning}</p>
        <ul className="store-earns">
          {(["twitch", "kick"] as const).map((platform) => (
            <li key={platform} data-platform={platform} data-artwork-detail>
              <b>{platform === "twitch" ? "Twitch" : "Kick"}</b>
              {copy.earns[platform].join(" · ")}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// The mark's progress ring and play glyph, drawn as a large, quiet outline
// behind the closing statement instead of a background gradient.
function ProgressRing(): React.ReactElement {
  return (
    <svg className="store-ring" viewBox="0 0 128 128" fill="none" aria-hidden>
      <circle cx="64" cy="64" r="34" stroke="#ffffff" strokeOpacity="0.04" strokeWidth="9" />
      <path
        d="M64 30 A34 34 0 1 1 36.2 83.9"
        stroke="#8b5cf6"
        strokeOpacity="0.2"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path
        fill="#ffffff"
        fillOpacity="0.035"
        d="M55 50 C 55 47.2, 58.1 45.6, 60.4 47.1 L 81 60.9 C 83.1 62.3, 83.1 65.7, 81 67.1 L 60.4 80.9 C 58.1 82.4, 55 80.8, 55 78 Z"
      />
    </svg>
  );
}

// What Lurkloot supports: the features both platforms share once, then what
// each platform adds, so the lists do not repeat themselves.
function PlatformFeatures({
  platforms,
}: {
  platforms: StoreArtworkCopy["platforms"];
}): React.ReactElement {
  const tags = (features: string[]) => (
    <ul>
      {features.map((feature) => (
        <li key={feature} data-artwork-detail>
          {feature}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="store-platforms" data-platform-features>
      <section className="store-platform" data-platform="both">
        <h2>
          <span data-dot="twitch" />
          <span data-dot="kick" />
          Twitch + Kick
        </h2>
        {tags(platforms.both)}
      </section>
      <div className="store-platform-pair">
        {(["twitch", "kick"] as const).map((platform) => (
          <section className="store-platform" data-platform={platform} key={platform}>
            <h2>
              <span data-dot={platform} />
              {platform === "twitch" ? "Twitch" : "Kick"}
            </h2>
            {tags(platforms[platform])}
          </section>
        ))}
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
