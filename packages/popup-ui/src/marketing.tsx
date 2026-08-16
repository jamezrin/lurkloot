import React, { useEffect, useState } from "react";
import { Gem, Gift, ListVideo, type LucideIcon } from "lucide-react";
import type { SupportedLocale } from "@lurkloot/shared/models";
import { DEFAULT_LOCALE, isRtlLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import { PROMO_GRADIENT } from "./constants";
import type { ScreenshotVariant } from "./types";
import { variantShowsPopup } from "./types";

function useScreenshotCatalog(locale: SupportedLocale | undefined): (key: string) => string {
  const [catalog, setCatalog] = useState<MessageCatalog | undefined>(undefined);
  const [fallback, setFallback] = useState<MessageCatalog | undefined>(undefined);
  useEffect(() => {
    void loadCatalog(locale ?? DEFAULT_LOCALE).then(setCatalog);
    void loadCatalog(DEFAULT_LOCALE).then(setFallback);
  }, [locale]);
  return (key: string) => translateFromCatalogs(key, undefined, catalog, fallback ?? catalog ?? {});
}

function Eyebrow({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="mb-4 text-[13px] font-semibold uppercase tracking-[0.14em] bg-linear-to-r from-[#c4a7ff] to-[#b7ff6a] bg-clip-text text-transparent">
      {children}
    </p>
  );
}

function CopyBlock({
  eyebrowKey,
  headlineKey,
  subcopyKey,
  translate,
  showSubcopy = true,
  className,
}: {
  eyebrowKey: string;
  headlineKey: string;
  subcopyKey: string;
  translate: (key: string) => string;
  showSubcopy?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <div className={className}>
      <Eyebrow>{translate(eyebrowKey)}</Eyebrow>
      <h1 className="font-display text-[56px] font-bold leading-[0.98] tracking-normal text-[#ecedf5]">
        {translate(headlineKey)}
      </h1>
      {showSubcopy ? (
        <p className="mt-5 max-w-[520px] text-[20px] leading-snug text-[#9c9db4]">
          {translate(subcopyKey)}
        </p>
      ) : null}
    </div>
  );
}

function PopupFrame({ children, className }: { children: React.ReactNode; className?: string }): React.ReactElement {
  return (
    <div className={`h-[600px] w-[400px] shrink-0 overflow-hidden ${className ?? ""}`}>
      {children}
    </div>
  );
}

function ExtrasCard({
  icon: Icon,
  name,
  meta,
}: {
  icon: LucideIcon;
  name: string;
  meta: string;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-white/8 bg-white/[0.03] p-5 backdrop-blur-sm">
      <Icon size={22} className="mb-4 text-[#c4a7ff]" strokeWidth={1.75} />
      <div className="text-[17px] font-semibold text-[#ecedf5]">{name}</div>
      <div className="mt-1.5 text-[13px] leading-snug text-[#9c9db4]">{meta}</div>
    </div>
  );
}

function StepItem({
  number,
  title,
  sub,
}: {
  number: string;
  title: string;
  sub: string;
}): React.ReactElement {
  return (
    <div className="min-w-0 flex-1">
      <div className="font-display text-[32px] font-bold leading-none text-[#c4a7ff]/80">{number}</div>
      <div className="mt-3 text-[18px] font-semibold text-[#ecedf5]">{title}</div>
      <div className="mt-1.5 text-[14px] leading-snug text-[#9c9db4]">{sub}</div>
    </div>
  );
}

export function StoreScreenshot({
  variant,
  children,
  locale = DEFAULT_LOCALE,
}: {
  variant: ScreenshotVariant;
  children?: React.ReactNode;
  locale?: SupportedLocale;
}): React.ReactElement {
  const translate = useScreenshotCatalog(locale);
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";
  const rtl = dir === "rtl";
  const popup = variantShowsPopup(variant) ? children : null;

  return (
    <div
      dir={dir}
      data-layout={variant.layout}
      className="relative h-[800px] w-[1280px] overflow-hidden bg-[#060609] text-[#ecedf5]"
    >
      <div className="pointer-events-none absolute inset-0" style={{ background: variant.glow }} />

      {variant.layout === "hero" ? (
        <>
          <CopyBlock
            className="absolute start-[7%] bottom-[12%] end-[40%] z-10"
            eyebrowKey={variant.eyebrowKey}
            headlineKey={variant.headlineKey}
            subcopyKey={variant.subcopyKey}
            translate={translate}
          />
          {popup ? (
            <div className={`absolute end-[7%] top-[9%] z-20 origin-center ${rtl ? "rotate-[2deg]" : "rotate-[-2deg]"}`}>
              <PopupFrame>{popup}</PopupFrame>
            </div>
          ) : null}
        </>
      ) : null}

      {variant.layout === "extras" ? (
        <>
          <CopyBlock
            className="absolute start-[7%] top-[12%] end-[40%] z-10"
            eyebrowKey={variant.eyebrowKey}
            headlineKey={variant.headlineKey}
            subcopyKey={variant.subcopyKey}
            translate={translate}
          />
          <div className="absolute start-[7%] bottom-[12%] end-[7%] z-10 flex gap-3">
            <ExtrasCard
              icon={Gem}
              name={translate("screenshotExtrasPointsName")}
              meta={translate("screenshotExtrasPointsMeta")}
            />
            <ExtrasCard
              icon={Gift}
              name={translate("screenshotExtrasChallengesName")}
              meta={translate("screenshotExtrasChallengesMeta")}
            />
            <ExtrasCard
              icon={ListVideo}
              name={translate("screenshotExtrasWatchlistName")}
              meta={translate("screenshotExtrasWatchlistMeta")}
            />
          </div>
        </>
      ) : null}

      {variant.layout === "steps" ? (
        <>
          <CopyBlock
            className="absolute start-[7%] top-[12%] end-[40%] z-10"
            eyebrowKey={variant.eyebrowKey}
            headlineKey={variant.headlineKey}
            subcopyKey={variant.subcopyKey}
            translate={translate}
            showSubcopy={false}
          />
          <div className="absolute inset-inline-[7%] bottom-[14%] z-10 flex gap-7">
            <StepItem
              number="01"
              title={translate("screenshotEasyInstallTitle")}
              sub={translate("screenshotEasyInstallSub")}
            />
            <StepItem
              number="02"
              title={translate("screenshotEasyPinTitle")}
              sub={translate("screenshotEasyPinSub")}
            />
            <StepItem
              number="03"
              title={translate("screenshotEasyEnableTitle")}
              sub={translate("screenshotEasyEnableSub")}
            />
            <StepItem
              number="04"
              title={translate("screenshotEasyProfitTitle")}
              sub={translate("screenshotEasyProfitSub")}
            />
          </div>
        </>
      ) : null}

      {variant.layout === "settings" ? (
        <>
          {popup ? (
            <div className="absolute start-[5%] top-[8%] z-20">
              <PopupFrame>{popup}</PopupFrame>
            </div>
          ) : null}
          <CopyBlock
            className="absolute start-[42%] end-[7%] top-[18%] z-10"
            eyebrowKey={variant.eyebrowKey}
            headlineKey={variant.headlineKey}
            subcopyKey={variant.subcopyKey}
            translate={translate}
          />
        </>
      ) : null}

      {variant.layout === "updated" ? (
        <CopyBlock
          className="absolute start-[8%] end-[18%] bottom-[14%] max-w-[640px] z-10"
          eyebrowKey={variant.eyebrowKey}
          headlineKey={variant.headlineKey}
          subcopyKey={variant.subcopyKey}
          translate={translate}
        />
      ) : null}
    </div>
  );
}

// Platform names only — no Twitch/Kick logos, which are trademarked. The brand
// colour lives in a small status dot so the pills read as one neutral glass
// control instead of two solid brand-coloured buttons.
const PLATFORMS = [
  { name: "Twitch", color: "#a970ff" },
  { name: "Kick", color: "#53fc18" },
];

function PromoPills({ translate, scale = 1 }: { translate: (key: string) => string; scale?: number }): React.ReactElement {
  const px = (value: number) => `${value * scale}px`;
  const pad = `${px(9)} ${px(15)}`;
  return (
    <div className="flex flex-wrap items-center" style={{ fontSize: px(15), gap: px(10) }}>
      <span
        className="inline-flex items-center rounded-full border border-white/15 bg-white/10 font-semibold text-white"
        style={{ padding: pad, gap: px(10) }}
      >
        {PLATFORMS.map((platform, index) => (
          <React.Fragment key={platform.name}>
            {index > 0 && <span className="font-normal text-white/25">/</span>}
            <span className="inline-flex items-center" style={{ gap: px(7) }}>
              <span
                className="rounded-full"
                style={{ width: px(7), height: px(7), background: platform.color, boxShadow: `0 0 ${px(9)} ${platform.color}` }}
              />
              {platform.name}
            </span>
          </React.Fragment>
        ))}
      </span>
      <span className="rounded-full border border-white/12 bg-white/5 font-medium text-zinc-300" style={{ padding: pad }}>
        {translate("autoClaimReady")}
      </span>
    </div>
  );
}

export function PromoTile({
  format,
  locale = DEFAULT_LOCALE,
}: {
  format: "small" | "marquee";
  locale?: SupportedLocale;
}): React.ReactElement {
  const translate = useScreenshotCatalog(locale);
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";

  if (format === "small") {
    return (
      <div
        dir={dir}
        className="relative flex h-[280px] w-[440px] flex-col justify-center overflow-hidden bg-zinc-950 px-9 text-white"
      >
        <div className="pointer-events-none absolute inset-0" style={{ background: PROMO_GRADIENT }} />
        <div className="relative">
          <div className="mb-5 flex items-center gap-3">
            <img src="/logo-ring.svg" alt="" width={52} height={52} className="h-[52px] w-[52px]" />
            <span className="font-display text-[27px] font-bold leading-none tracking-tight text-white">
              {translate("extensionName")}
            </span>
          </div>
          <p className="mb-6 max-w-[360px] text-[18px] font-semibold leading-tight text-zinc-200">
            {translate("promoTagline")}
          </p>
          <PromoPills translate={translate} scale={0.82} />
        </div>
      </div>
    );
  }

  return (
    <div
      dir={dir}
      className="relative grid h-[560px] w-[1400px] grid-cols-[1fr_520px] items-center overflow-hidden bg-zinc-950 text-white"
    >
      <div className="pointer-events-none absolute inset-0" style={{ background: PROMO_GRADIENT }} />
      <section className="relative z-10 flex min-w-0 flex-col justify-center px-24">
        <div className="mb-8 flex items-center gap-4">
          <img src="/logo-ring.svg" alt="" width={68} height={68} className="h-[68px] w-[68px]" />
          <span className="font-display text-[34px] font-bold leading-none tracking-tight text-white">
            {translate("extensionName")}
          </span>
        </div>
        <h1 className="font-display max-w-[660px] text-[56px] font-bold leading-[0.98] tracking-normal text-white">
          {translate("screenshotHeroHeadline")}
        </h1>
        <p className="mt-6 max-w-[560px] text-[21px] leading-snug text-zinc-300">
          {translate("extensionDescription")}
        </p>
        <div className="mt-10">
          <PromoPills translate={translate} />
        </div>
      </section>
      <section className="relative flex h-full items-center justify-center">
        <div
          className="pointer-events-none absolute h-[520px] w-[520px] rounded-full opacity-70 blur-2xl"
          style={{ background: "radial-gradient(circle, rgba(145,71,255,0.45), rgba(83,252,24,0.18) 55%, transparent 72%)" }}
        />
        <img src="/logo-ring.svg" alt="" width={300} height={300} className="relative h-[300px] w-[300px] drop-shadow-2xl" />
      </section>
    </div>
  );
}
