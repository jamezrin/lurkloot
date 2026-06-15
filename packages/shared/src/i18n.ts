import type { LanguageOverride, SupportedLocale } from "./models";
import { SUPPORTED_LOCALES } from "./settings";

export type MessageCatalog = Record<string, { message: string }>;

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const RTL_LOCALES: SupportedLocale[] = ["ar"];

export const LOCALE_OPTIONS: Array<{ value: LanguageOverride; labelKey: string; nativeName: string }> = [
  { value: "browser", labelKey: "languageBrowser", nativeName: "Use browser language" },
  { value: "en", labelKey: "languageEnglish", nativeName: "English" },
  { value: "es", labelKey: "languageSpanish", nativeName: "Español" },
  { value: "fr", labelKey: "languageFrench", nativeName: "Français" },
  { value: "it", labelKey: "languageItalian", nativeName: "Italiano" },
  { value: "ru", labelKey: "languageRussian", nativeName: "Русский" },
  { value: "de", labelKey: "languageGerman", nativeName: "Deutsch" },
  { value: "zh_CN", labelKey: "languageChinese", nativeName: "简体中文" },
  { value: "hi", labelKey: "languageHindi", nativeName: "हिन्दी" },
  { value: "pt_BR", labelKey: "languagePortuguese", nativeName: "Português (Brasil)" },
  { value: "ar", labelKey: "languageArabic", nativeName: "العربية" },
];

export function normalizeBrowserLocale(value: string | undefined): SupportedLocale {
  if (!value) return DEFAULT_LOCALE;
  const normalized = value.replace("-", "_");
  if (SUPPORTED_LOCALES.includes(normalized as SupportedLocale)) return normalized as SupportedLocale;
  const base = normalized.split("_")[0];
  if (base === "zh") return "zh_CN";
  if (base === "pt") return "pt_BR";
  if (SUPPORTED_LOCALES.includes(base as SupportedLocale)) return base as SupportedLocale;
  return DEFAULT_LOCALE;
}

export function effectiveLocale(languageOverride: LanguageOverride, browserLocale: string | undefined): SupportedLocale {
  return languageOverride === "browser" ? normalizeBrowserLocale(browserLocale) : languageOverride;
}

export function isRtlLocale(locale: SupportedLocale): boolean {
  return RTL_LOCALES.includes(locale);
}

export function translateFromCatalogs(
  key: string,
  substitutions: string | string[] | undefined,
  catalog: MessageCatalog | undefined,
  fallbackCatalog: MessageCatalog,
): string {
  const template = catalog?.[key]?.message || fallbackCatalog[key]?.message || key;
  const values = Array.isArray(substitutions)
    ? substitutions
    : substitutions == null
      ? []
      : [substitutions];
  return values.reduce((text, value, index) => text.replaceAll(`$${index + 1}`, value), template);
}
