import type React from "react";
import { useEffect, useRef } from "react";
import { Check, ArrowRight, SlidersHorizontal, ListOrdered, Gift } from "lucide-react";
import { LurklootMark } from "./mark";
import { isRtlLocale } from "@lurkloot/shared/i18n";
import type { SupportedLocale } from "@lurkloot/shared/models";
import { STORE_ARTWORK_COPY, type StoreArtworkCopy } from "./storeArtworkCopy";

export type StoreStory = keyof StoreArtworkCopy["stories"];

// Store artwork is a focused, enlarged excerpt of the real product. Its camera
// styles are scoped here; the normal popup and the site's demo keep their UI.
export function StoreArtwork({
  story,
  children,
  secondary,
  locale = "en",
}: {
  story: StoreStory;
  children: React.ReactNode;
  secondary?: React.ReactNode;
  locale?: SupportedLocale;
}): React.ReactElement {
  const copy = STORE_ARTWORK_COPY[locale].stories[story];
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
      const maxHeight = story === "queue" ? 350 : 230;
      const minSize = story === "queue" ? 64 : 72;
      let size = story === "queue" ? 80 : 104;
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
          {copy.title}
        </h1>
      </section>
      {story === "extensions" ? <p className="store-feature-label">{copy.points[0]}</p> : null}
      <div data-store-popup>
        {story === "extensions" ? (
          <ExtensionOverview copy={STORE_ARTWORK_COPY[locale].overview} />
        ) : story === "kick" ? (
          <div className="store-platforms">
            <div className="store-platform" data-platform="twitch">
              <h2>
                <span />
                Twitch
              </h2>
              <div className="store-focus">{children}</div>
            </div>
            <div className="store-platform" data-platform="kick">
              <h2>
                <span />
                Kick
              </h2>
              <div className="store-progress-focus">{secondary}</div>
            </div>
          </div>
        ) : story === "queue" ? (
          <div className="store-full-popup">{children}</div>
        ) : (
          <div className="store-focus">{children}</div>
        )}
      </div>
      {story === "queue" ? (
        <div className="store-outcome">
          <Check size={32} strokeWidth={3} />
          {copy.points[1]}
        </div>
      ) : null}
    </div>
  );
}

// An editorial sequence, not an imitation of the product's extension screens.
function ExtensionOverview({ copy }: { copy: StoreArtworkCopy["overview"] }): React.ReactElement {
  const icons = [SlidersHorizontal, ListOrdered, Gift];
  return (
    <div data-extension-overview>
      {copy.steps.map(([title], index) => {
        const Icon = icons[index];
        return (
          <div className="store-extension-step" key={title}>
            <span className="store-step-icon">
              <Icon size={56} strokeWidth={1.5} />
            </span>
            <h2 data-artwork-detail>{title}</h2>
            {index < copy.steps.length - 1 ? (
              <ArrowRight className="store-step-arrow" size={32} />
            ) : null}
          </div>
        );
      })}
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
