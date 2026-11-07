import { loadCatalog } from "@lurkloot/locales";
import {
  effectiveLocale,
  isRtlLocale,
  translateFromCatalogs,
  type MessageCatalog,
} from "@lurkloot/shared/i18n";
import type { LanguageOverride, SupportedLocale } from "@lurkloot/shared/models";

export type Translate = (key: string, substitutions?: string | string[]) => string;

export interface AppCatalogs {
  locale: SupportedLocale;
  dir: "ltr" | "rtl";
  t: Translate;
  // The browser language's own lookup, which the popup adapter's getMessage
  // answers with while the language follows the browser. Without it the
  // popup would fall back to English there.
  browserMessage: Translate;
}

function translator(catalog: MessageCatalog | undefined, english: MessageCatalog): Translate {
  return (key, substitutions) => translateFromCatalogs(key, substitutions, catalog, english);
}

/** Loads what the app needs to speak before the popup frame mounts: the
 * screens around it (connecting, the access token) and the browser
 * language's catalog for the adapter. */
export async function loadAppCatalogs(
  languageOverride: LanguageOverride,
  browserLanguage: string,
): Promise<AppCatalogs> {
  const browserLocale = effectiveLocale("browser", browserLanguage);
  const locale = effectiveLocale(languageOverride, browserLanguage);
  const [english, browserCatalog, selected] = await Promise.all([
    loadCatalog("en"),
    loadCatalog(browserLocale),
    locale === browserLocale ? Promise.resolve(undefined) : loadCatalog(locale),
  ]);
  const fallback = english ?? {};
  return {
    locale,
    dir: isRtlLocale(locale) ? "rtl" : "ltr",
    t: translator(selected ?? browserCatalog, fallback),
    browserMessage: (key, substitutions) =>
      browserCatalog?.[key]?.message
        ? translateFromCatalogs(key, substitutions, browserCatalog, fallback)
        : "",
  };
}
