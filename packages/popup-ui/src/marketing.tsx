import React, { useEffect, useState } from "react";
import type { SupportedLocale } from "@lurkloot/shared/models";
import { DEFAULT_LOCALE, isRtlLocale, loadLocaleCatalog, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { PROMO_GRADIENT } from "./constants";
import type { ScreenshotVariant } from "./types";

export function StoreScreenshot({
  variant,
  children,
  getUrl,
  locale = DEFAULT_LOCALE,
}: {
  variant: ScreenshotVariant;
  children: React.ReactNode;
  getUrl: (path: string) => string;
  locale?: SupportedLocale;
}): React.ReactElement {
  const [catalog, setCatalog] = useState<MessageCatalog | undefined>(undefined);
  const [fallback, setFallback] = useState<MessageCatalog | undefined>(undefined);
  useEffect(() => {
    void loadLocaleCatalog(locale, getUrl).then(setCatalog);
    void loadLocaleCatalog(DEFAULT_LOCALE, getUrl).then(setFallback);
  }, [getUrl, locale]);
  const translate = (key: string) => translateFromCatalogs(key, undefined, catalog, fallback ?? catalog ?? {});
  return (
    <div
      data-platform={variant.platform}
      className="grid h-[800px] w-[1280px] grid-cols-[1fr_460px] overflow-hidden bg-zinc-950 text-white"
    >
      <section className="relative flex min-w-0 flex-col justify-center px-20">
        <div className="pointer-events-none absolute inset-0" style={{ background: variant.accentGradient.replace(/_/g, " ") }} />
        <div className="relative max-w-[590px]">
          <img src="/logo-ring.svg" alt="" width={76} height={76} className="mb-8 h-[76px] w-[76px]" />
          <h1 className="font-display text-[62px] font-bold leading-[0.96] tracking-normal text-white">
            {translate(variant.headlineKey)}
          </h1>
          <p className="mt-6 max-w-[520px] text-[22px] leading-snug text-zinc-300">
            {translate(variant.subcopyKey)}
          </p>
          <div className="mt-9 flex gap-3">
            <span className="rounded-lg bg-white px-4 py-2 text-[15px] font-bold text-zinc-950">Twitch</span>
            <span className="rounded-lg bg-[#53fc18] px-4 py-2 text-[15px] font-bold text-[#07140a]">Kick</span>
            <span className="rounded-lg border border-white/18 bg-white/8 px-4 py-2 text-[15px] font-semibold text-zinc-200">{translate("autoClaimReady")}</span>
          </div>
        </div>
      </section>
      <section className="relative flex items-center justify-start">
        <div className="rounded-[28px] bg-white/10 p-5 shadow-2xl shadow-black/50 ring-1 ring-white/12">
          {children}
        </div>
      </section>
    </div>
  );
}

function PromoPills({ translate, scale = 1 }: { translate: (key: string) => string; scale?: number }): React.ReactElement {
  const pad = `${0.5 * scale}rem ${1 * scale}rem`;
  const fontSize = `${0.94 * scale}rem`;
  return (
    <div className="flex flex-wrap gap-2.5" style={{ fontSize }}>
      <span className="rounded-lg bg-white font-bold text-zinc-950" style={{ padding: pad }}>Twitch</span>
      <span className="rounded-lg bg-[#53fc18] font-bold text-[#07140a]" style={{ padding: pad }}>Kick</span>
      <span className="rounded-lg border border-white/18 bg-white/8 font-semibold text-zinc-200" style={{ padding: pad }}>
        {translate("autoClaimReady")}
      </span>
    </div>
  );
}

export function PromoTile({
  format,
  getUrl,
  locale = DEFAULT_LOCALE,
}: {
  format: "small" | "marquee";
  getUrl: (path: string) => string;
  locale?: SupportedLocale;
}): React.ReactElement {
  const [catalog, setCatalog] = useState<MessageCatalog | undefined>(undefined);
  const [fallback, setFallback] = useState<MessageCatalog | undefined>(undefined);
  useEffect(() => {
    void loadLocaleCatalog(locale, getUrl).then(setCatalog);
    void loadLocaleCatalog(DEFAULT_LOCALE, getUrl).then(setFallback);
  }, [getUrl, locale]);
  const translate = (key: string) => translateFromCatalogs(key, undefined, catalog, fallback ?? catalog ?? {});
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
          {translate("screenshotTwitchHeadline")}
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
