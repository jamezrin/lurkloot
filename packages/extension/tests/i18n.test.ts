import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { effectiveLocale, isRtlLocale, normalizeBrowserLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";

// Catalogs live in the single-source @lurkloot/locales package as <locale>.json.
const messagesDir = dirname(createRequire(import.meta.url).resolve("@lurkloot/locales/messages/en.json"));
const localeCodes = () => readdirSync(messagesDir).filter((entry) => entry.endsWith(".json")).map((entry) => entry.replace(/\.json$/, ""));
const readCatalog = (locale: string) => JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), "utf8")) as MessageCatalog;

describe("i18n", () => {
  it("normalizes browser locales to supported extension locales", () => {
    expect(normalizeBrowserLocale("es-MX")).toBe("es");
    expect(normalizeBrowserLocale("zh-TW")).toBe("zh_CN");
    expect(normalizeBrowserLocale("pt-PT")).toBe("pt_BR");
    expect(normalizeBrowserLocale("unknown")).toBe("en");
  });

  it("resolves explicit overrides and Arabic RTL", () => {
    expect(effectiveLocale("browser", "de-DE")).toBe("de");
    expect(effectiveLocale("ar", "de-DE")).toBe("ar");
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("en")).toBe(false);
  });

  it("translates with substitutions and falls back to English", () => {
    const en: MessageCatalog = {
      greeting: { message: "Hello $1" },
      fallback: { message: "Fallback" },
    };
    const es: MessageCatalog = {
      greeting: { message: "Hola $1" },
    };

    expect(translateFromCatalogs("greeting", "Alex", es, en)).toBe("Hola Alex");
    expect(translateFromCatalogs("fallback", undefined, es, en)).toBe("Fallback");
  });

  it("keeps locale catalog keys in sync", () => {
    const locales = localeCodes();
    const english = readCatalog("en");
    const englishKeys = Object.keys(english).sort();

    expect(locales).toContain("ar");
    for (const locale of locales) {
      const catalog = readCatalog(locale);
      expect(Object.keys(catalog).sort(), locale).toEqual(englishKeys);
    }
  });

  it("does not leave non-English catalogs as English except product/common terms", () => {
    const english = readCatalog("en");
    const allowedSameAsEnglish = new Set([
      "extensionName",
      "dropsTab",
      "dropsSettingsTitle",
      "debug",
      "info",
      "error",
      "live",
      "channelPlaceholder",
      "secondsSuffix",
      "notificationRewardFromCampaign",
      "autoClaimReady",
      "languageHindi",
      "notificationsTitle",
      "farmingLabel",
      "off",
    ]);

    for (const locale of localeCodes().filter((entry) => entry !== "en")) {
      const catalog = readCatalog(locale);
      const unchanged = Object.keys(english).filter((key) =>
        catalog[key]?.message === english[key]?.message && !allowedSameAsEnglish.has(key));
      expect(unchanged, locale).toEqual([]);
    }
  });
});
