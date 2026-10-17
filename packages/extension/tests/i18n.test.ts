import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  effectiveLocale,
  isRtlLocale,
  LOCALE_OPTIONS,
  normalizeBrowserLocale,
  translateFromCatalogs,
  type MessageCatalog,
} from "@lurkloot/shared/i18n";
import {
  STORE_SCREENSHOT_LOCALES,
  STORE_SCREENSHOT_VARIANTS,
  // @ts-expect-error The capture manifest is an executable JavaScript module.
} from "../scripts/store-screenshot-config.mjs";

// Catalogs live in the single-source @lurkloot/locales package as <locale>.json.
const messagesDir = dirname(
  createRequire(import.meta.url).resolve("@lurkloot/locales/messages/en.json"),
);
const localeCodes = () =>
  readdirSync(messagesDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/, ""));
const readCatalog = (locale: string) =>
  JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), "utf8")) as MessageCatalog;

describe("i18n", () => {
  it("normalizes browser locales to supported extension locales", () => {
    expect(normalizeBrowserLocale("es-MX")).toBe("es");
    expect(normalizeBrowserLocale("zh-TW")).toBe("zh_CN");
    expect(normalizeBrowserLocale("pt-PT")).toBe("pt_BR");
    expect(normalizeBrowserLocale("tr-TR")).toBe("tr");
    expect(normalizeBrowserLocale("ja-JP")).toBe("ja");
    expect(normalizeBrowserLocale("id-ID")).toBe("id");
    expect(normalizeBrowserLocale("pl-PL")).toBe("pl");
    expect(normalizeBrowserLocale("ko-KR")).toBe("ko");
    expect(normalizeBrowserLocale("uk-UA")).toBe("uk");
    expect(normalizeBrowserLocale("cs-CZ")).toBe("cs");
    expect(normalizeBrowserLocale("unknown")).toBe("en");
  });

  it("resolves explicit overrides and Arabic RTL", () => {
    expect(effectiveLocale("browser", "de-DE")).toBe("de");
    expect(effectiveLocale("ar", "de-DE")).toBe("ar");
    expect(effectiveLocale("tr", "en-US")).toBe("tr");
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("en")).toBe(false);
  });

  it("offers each language using its native name", () => {
    expect(LOCALE_OPTIONS).toContainEqual({
      value: "tr",
      labelKey: "languageTurkish",
      nativeName: "Türkçe",
    });
    expect(LOCALE_OPTIONS).toContainEqual({
      value: "ja",
      labelKey: "languageJapanese",
      nativeName: "日本語",
    });
    expect(LOCALE_OPTIONS).toContainEqual({
      value: "id",
      labelKey: "languageIndonesian",
      nativeName: "Bahasa Indonesia",
    });
    expect(LOCALE_OPTIONS).toContainEqual({
      value: "pl",
      labelKey: "languagePolish",
      nativeName: "Polski",
    });
    expect(LOCALE_OPTIONS).toContainEqual({
      value: "ko",
      labelKey: "languageKorean",
      nativeName: "한국어",
    });
    expect(LOCALE_OPTIONS).toContainEqual({
      value: "uk",
      labelKey: "languageUkrainian",
      nativeName: "Українська",
    });
    expect(LOCALE_OPTIONS).toContainEqual({
      value: "cs",
      labelKey: "languageCzech",
      nativeName: "Čeština",
    });
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

  it("inserts replacement-pattern characters literally", () => {
    const catalog: MessageCatalog = {
      patterns: { message: "$1|$2|$3" },
    };

    expect(translateFromCatalogs("patterns", ["$&", "$$", "$`"], catalog, catalog)).toBe(
      "$&|$$|$`",
    );
  });

  it("keeps locale catalog keys in sync", () => {
    const locales = localeCodes();
    const english = readCatalog("en");
    const englishKeys = Object.keys(english).sort();

    expect(locales).toContain("ar");
    expect(locales).toContain("tr");
    for (const locale of locales) {
      const catalog = readCatalog(locale);
      expect(Object.keys(catalog).sort(), locale).toEqual(englishKeys);
    }
  });

  it("localizes popup authentication health in every catalog", () => {
    const englishMessages: Record<string, string> = {
      automationChecking: "Checking",
      automationNeedsSignIn: "Needs sign-in",
      automationBlocked: "Blocked",
      automationUnavailable: "Unavailable",
      authCheckingDetail: "Checking your signed-in session…",
      authSignInMissing: "Sign in to continue farming drops.",
      authSignInRejected: "Your session is no longer valid. Sign in again to continue.",
      signInToTwitch: "Sign in to Twitch",
      signInToKick: "Sign in to Kick",
      authBrowserProfileBlocked:
        "Kick rejected this browser profile. Signing in alone may not resolve it.",
      authCredentialCheckUnavailable:
        "Your browser session could not be checked. Lurkloot will retry automatically.",
      authNetworkTemporarilyUnavailable:
        "The network is temporarily unavailable. Lurkloot will retry automatically.",
      authPlatformTemporarilyUnavailable:
        "The platform is temporarily unavailable. Lurkloot will retry automatically.",
    };
    const english = readCatalog("en");

    for (const [key, message] of Object.entries(englishMessages)) {
      expect(english[key]?.message, key).toBe(message);
    }
    for (const locale of localeCodes()) {
      const catalog = readCatalog(locale);
      for (const key of Object.keys(englishMessages)) {
        expect(catalog[key]?.message, `${locale}:${key}`).toBeTypeOf("string");
        expect(catalog[key].message.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("localizes the subscription campaign filter in every catalog", () => {
    const translations: Record<string, string> = {
      ar: "حملات الاشتراك",
      de: "Abo-Kampagnen",
      en: "Subscription campaigns",
      es: "Campañas de suscripción",
      fr: "Campagnes avec abonnement",
      hi: "सदस्यता अभियान",
      it: "Campagne con abbonamento",
      pt_BR: "Campanhas de assinatura",
      ru: "Кампании за подписку",
      tr: "Abonelik kampanyaları",
      zh_CN: "订阅活动",
      ja: "サブスクキャンペーン",
      id: "Kampanye langganan",
      pl: "Kampanie subskrypcyjne",
      ko: "구독 캠페인",
      uk: "Кампанії за підпискою",
      cs: "Kampaně s předplatným",
    };

    for (const locale of localeCodes()) {
      expect(readCatalog(locale).subscriptionCampaigns?.message, locale).toBe(translations[locale]);
    }
  });

  it("uses each catalog's native language name", () => {
    const names: Record<string, [string, string]> = {
      tr: ["languageTurkish", "Türkçe"],
      ja: ["languageJapanese", "日本語"],
      id: ["languageIndonesian", "Bahasa Indonesia"],
      pl: ["languagePolish", "Polski"],
      ko: ["languageKorean", "한국어"],
      uk: ["languageUkrainian", "Українська"],
      cs: ["languageCzech", "Čeština"],
    };
    for (const [locale, [key, name]] of Object.entries(names)) {
      expect(readCatalog(locale)[key]?.message, locale).toBe(name);
    }
    expect(readCatalog("tr").subscriptionCampaigns?.message).toBe("Abonelik kampanyaları");
  });

  it("captures store artwork for every catalog locale", () => {
    expect(STORE_SCREENSHOT_LOCALES.map(({ code }: { code: string }) => code).sort()).toEqual(
      localeCodes().sort(),
    );
    const promoSource = readFileSync(
      join(dirname(import.meta.dirname), "scripts/capture-store.mjs"),
      "utf8",
    );
    expect(promoSource).toContain('from "./store-screenshot-config.mjs"');
    expect(promoSource).toContain("STORE_SCREENSHOT_LOCALES");
    expect(promoSource).not.toMatch(/const ALL_LOCALES = \[/);
  });

  it("captures the five reworked screenshot stems", () => {
    expect(STORE_SCREENSHOT_VARIANTS.map(({ file }: { file: string }) => file)).toEqual([
      "01-drops",
      "02-extras",
      "03-easy",
      "04-settings",
      "05-updated",
    ]);
  });

  it("defines subscription drop states with matching placeholders in every catalog", () => {
    const englishMessages = {
      subscriptionRequired: "Subscription required",
      subscriptionRewards: "Subscription rewards",
      qualifyingSubscriptionsRequired: "$1 qualifying subscriptions required",
      subscriptionProgressUnknown: "Progress unavailable",
      notEarnableByWatching: "Not earnable by watching",
      subscribedRefresh: "I've subscribed — refresh status",
      waitingForSubscription: "Waiting for a qualifying subscription",
      actionRequired: "Action required",
      earned: "Earned",
    };
    const placeholders = (message: string) => message.match(/\$\d+/g) ?? [];

    const english = readCatalog("en");
    for (const [key, message] of Object.entries(englishMessages)) {
      expect(english[key]?.message, key).toBe(message);
    }

    for (const locale of localeCodes()) {
      const catalog = readCatalog(locale);
      for (const key of Object.keys(englishMessages)) {
        expect(catalog[key]?.message, `${locale}:${key}`).toBeTypeOf("string");
        expect(placeholders(catalog[key].message), `${locale}:${key}`).toEqual(
          placeholders(english[key].message),
        );
      }
    }
  });

  it("defines the reworked store-screenshot copy in English", () => {
    const english = {
      screenshotHeroEyebrow: "Twitch + Kick",
      screenshotHeroHeadline: "Farm drops while you do anything else.",
      screenshotHeroSubcopy: "Auto-claim from your own logged-in session. No passwords.",
      screenshotExtrasEyebrow: "Beyond campaigns",
      screenshotExtrasHeadline: "More than drops.",
      screenshotExtrasSubcopy:
        "Channel points, Kick challenges, and 2-minute drops — also claimed for you. An idle watchlist when nothing is left to farm.",
      screenshotExtrasPointsName: "Channel points",
      screenshotExtrasPointsMeta: "Twitch · also claimed for you",
      screenshotExtrasChallengesName: "Daily challenges",
      screenshotExtrasChallengesMeta: "Kick · also claimed for you",
      screenshotExtrasWatchlistName: "Idle watchlist",
      screenshotExtrasWatchlistMeta: "Watches your streamers between campaigns",
      screenshotExtrasFlashName: "2-minute drops",
      screenshotExtrasFlashMeta: "Kick · picked up as they land",
      screenshotEasyEyebrow: "Easy to use",
      screenshotEasyHeadline: "That easy.",
      screenshotEasyInstallTitle: "Install",
      screenshotEasyInstallSub: "Chrome Web Store. No account.",
      screenshotEasyPinTitle: "Pin it",
      screenshotEasyPinSub: "Keep the popup one click away.",
      screenshotEasyEnableTitle: "Enable a platform",
      screenshotEasyEnableSub: "Twitch, Kick, or both.",
      screenshotEasyProfitTitle: "Profit",
      screenshotEasyProfitSub: "It farms. You do other things.",
      screenshotSettingsEyebrow: "Your rules",
      screenshotSettingsHeadline: "Farm exactly how you want.",
      screenshotSettingsSubcopy: "Priorities, games, tabless mode, auto-claim — per platform.",
      screenshotUpdatedEyebrow: "Open source",
      screenshotUpdatedHeadline: "Featureful. Always updated.",
      screenshotUpdatedSubcopy:
        "Frequent releases as Twitch and Kick change — and open to ideas and improvements.",
      screenshotUpdatedBrowsersTitle: "Chromium-based browsers",
      screenshotUpdatedBrowsersSub: "Chrome Web Store listing. Same extension.",
      screenshotUpdatedHeadlessTitle: "CLI",
      screenshotUpdatedHeadlessSub: "Headless. Same engine.",
      screenshotUpdatedDockerTitle: "Docker",
      screenshotUpdatedDockerSub: "Same engine. In a container.",
      screenshotUpdatedLicense: "Apache-2.0",
    };
    const catalog = readCatalog("en");
    for (const [key, message] of Object.entries(english)) {
      expect(catalog[key]?.message, key).toBe(message);
    }
    for (const stale of [
      "screenshotTwitchHeadline",
      "screenshotTwitchSubcopy",
      "screenshotKickHeadline",
      "screenshotKickSubcopy",
      "screenshotIdleWatchlistHeadline",
      "screenshotIdleWatchlistSubcopy",
      "screenshotActivityHeadline",
      "screenshotActivitySubcopy",
      "screenshotUpdatedReviews",
      // Removed: the Chrome Web Store forbids listing assets that mimic an
      // extension's rating, install count or other store standing.
      "screenshotUpdatedRating",
      "screenshotUpdatedUsers",
    ]) {
      expect(catalog[stale], stale).toBeUndefined();
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
      "settingsGroupDrops",
      "settingsGroupNotifications",
      // Footer link labels: two are brand names, and "Website" is the German
      // word as well as the English one.
      "chromeWebStoreAttributionShort",
      "githubAttributionShort",
      "siteAttributionShort",
      // "Diagnostics" is spelled the same in French.
      "diagnosticsViewTab",
      // "Extensions" is spelled the same in French.
      "extensionDropsTitle",
      // Rail labels that are the same word in some languages: "Drops" is the
      // common term the watch-source labels already share, "Platform" is spelled
      // the same in Turkish, and "Extensions" the same in French.
      "navGroupDrops",
      "navPlatform",
      "navExtensions",
      // "Badge" is the French and Italian word too.
      "rewardBadge",
      "rewardBadgeNamed",
      // "Beta" is the same word in Spanish, German, Italian, Portuguese and Turkish.
      "navBeta",
      // Provider names, which are brands and never translated.
      "navNoPixel",
      "navFortnite",
      // Watch-source labels include provider brands and the common Drops term.
      "watchSourceNoPixel",
      "watchSourceFortnite",
      "watchSourceDrops",
      // Brand-only store screenshot eyebrow.
      "screenshotHeroEyebrow",
      "screenshotUpdatedHeadlessTitle",
      "screenshotUpdatedDockerTitle",
      "screenshotUpdatedLicense",
      // "in $1" is the same phrase in German.
      "relativeIn",
      // Two numbers and XP, the common gaming term Kick itself uses everywhere.
      "kickLevelXp",
    ]);

    // Loanwords that are correct as written in these languages.
    const loanwords: Record<string, Set<string>> = {
      de: new Set(["rewardKindEmote", "rewardKindItemShort"]),
      es: new Set(["rewardKindEmote"]),
      pt_BR: new Set(["rewardKindEmote"]),
      fr: new Set(["rewardKindBadge"]),
    };

    for (const locale of localeCodes().filter((entry) => entry !== "en")) {
      const catalog = readCatalog(locale);
      const unchanged = Object.keys(english).filter(
        (key) =>
          catalog[key]?.message === english[key]?.message
          && !allowedSameAsEnglish.has(key)
          && !loanwords[locale]?.has(key),
      );
      expect(unchanged, locale).toEqual([]);
    }
  });

  it("localizes the manual watch-tab close pause in every catalog", () => {
    const englishMessages: Record<string, string> = {
      automationPausedTabClosed: "Paused — tab closed",
      watchTabClosedPauseDetail: "You closed the farming tab, so Lurkloot stopped farming here.",
      resumeFarming: "Resume farming",
      activityReasonManualTabClose: "farming tab closed",
    };
    const english = readCatalog("en");

    for (const [key, message] of Object.entries(englishMessages)) {
      expect(english[key]?.message, key).toBe(message);
    }
    for (const locale of localeCodes()) {
      const catalog = readCatalog(locale);
      for (const key of Object.keys(englishMessages)) {
        expect(catalog[key]?.message, `${locale}:${key}`).toBeTypeOf("string");
        expect(catalog[key].message.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("localizes the new settings section labels in every catalog", () => {
    const required = [
      "settingsSearchPlaceholder",
      "settingsSearchNoResults",
      "settingsShowAdvancedTitle",
      "settingsGroupAppearance",
      "settingsGroupNotifications",
      "settingsGroupDrops",
      "settingsGroupFarmingTabs",
      "settingsGroupAdvanced",
      "settingsGroupCategories",
      "settingsGroupExcludedChannels",
      "settingsGroupPlatformAdvanced",
      "twitchSectionDescription",
      "kickSectionDescription",
      "twitchAdvancedDescription",
      "kickAdvancedDescription",
    ];
    for (const locale of localeCodes()) {
      const catalog = readCatalog(locale);
      for (const key of required) {
        expect(catalog[key]?.message, `${locale}.${key}`).toBeTruthy();
      }
    }
  });
});
