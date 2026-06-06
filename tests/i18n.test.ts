import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveLocale, isRtlLocale, normalizeBrowserLocale, translateFromCatalogs, type MessageCatalog } from "../src/core/i18n";

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
    const root = join(process.cwd(), "public", "_locales");
    const locales = readdirSync(root).filter((entry) => !entry.startsWith("."));
    const english = JSON.parse(readFileSync(join(root, "en", "messages.json"), "utf8")) as MessageCatalog;
    const englishKeys = Object.keys(english).sort();

    expect(locales).toContain("ar");
    for (const locale of locales) {
      const catalog = JSON.parse(readFileSync(join(root, locale, "messages.json"), "utf8")) as MessageCatalog;
      expect(Object.keys(catalog).sort(), locale).toEqual(englishKeys);
    }
  });

  it("does not leave non-English catalogs as English except product/common terms", () => {
    const root = join(process.cwd(), "public", "_locales");
    const english = JSON.parse(readFileSync(join(root, "en", "messages.json"), "utf8")) as MessageCatalog;
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

    for (const locale of readdirSync(root).filter((entry) => entry !== "en" && !entry.startsWith("."))) {
      const catalog = JSON.parse(readFileSync(join(root, locale, "messages.json"), "utf8")) as MessageCatalog;
      const unchanged = Object.keys(english).filter((key) =>
        catalog[key]?.message === english[key]?.message && !allowedSameAsEnglish.has(key));
      expect(unchanged, locale).toEqual([]);
    }
  });
});
