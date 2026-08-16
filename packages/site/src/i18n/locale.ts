import type { SupportedLocale } from "@lurkloot/shared/models";
import { SUPPORTED_LOCALES } from "@lurkloot/shared/settings";
import { isRtlLocale } from "@lurkloot/shared/i18n";

export const SITE_LOCALES: readonly SupportedLocale[] = SUPPORTED_LOCALES;

export type SitePath = "/" | "/changelog";

export function localeToPrefix(locale: SupportedLocale): string {
  if (locale === "en") return "";
  return locale.replaceAll("_", "-").toLowerCase();
}

export function prefixToLocale(prefix: string): SupportedLocale | undefined {
  const normalized = prefix.replace(/\/+$/, "").replace(/^\/+/, "").toLowerCase();
  if (normalized === "") return "en";
  return SITE_LOCALES.find((locale) => localeToPrefix(locale) === normalized);
}

export function pageHref(locale: SupportedLocale, path: SitePath): string {
  const prefix = localeToPrefix(locale);
  if (!prefix) return path;
  return path === "/" ? `/${prefix}/` : `/${prefix}${path}`;
}

export function parseLocaleFromPathname(pathname: string): { locale: SupportedLocale; path: SitePath | string } {
  const parts = pathname.split("/").filter(Boolean);
  const maybe = parts[0] ? prefixToLocale(parts[0]) : "en";
  if (maybe && maybe !== "en") {
    const rest = `/${parts.slice(1).join("/")}`.replace(/\/$/, "") || "/";
    return { locale: maybe, path: rest };
  }
  const path = `/${parts.join("/")}`.replace(/\/$/, "") || "/";
  return { locale: "en", path };
}

export function htmlLang(locale: SupportedLocale): string {
  return locale.replace("_", "-");
}

export function htmlDir(locale: SupportedLocale): "ltr" | "rtl" {
  return isRtlLocale(locale) ? "rtl" : "ltr";
}

export function prefixedLocales(): Exclude<SupportedLocale, "en">[] {
  return SITE_LOCALES.filter((locale): locale is Exclude<SupportedLocale, "en"> => locale !== "en");
}
