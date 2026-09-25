import { translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import type { LanguageOverride } from "@lurkloot/shared/models";
import type { TFunction } from "./types";

export interface TranslatorOptions {
  languageOverride: LanguageOverride;
  overrideCatalog: MessageCatalog | undefined;
  fallbackCatalog: MessageCatalog | undefined;
  getMessage: (key: string, substitutions?: string | string[]) => string;
}

// Whether a catalog actually defines a key. Presence — not "the translated text
// differs from the key" — is what separates a real translation from a miss: the
// English catalog translates `later` as "later" and `live` as "live", and
// comparing text to key sent exactly those through the host fallback, where the
// browser answered in its own locale regardless of the popup's language setting
// (#565).
function catalogDefines(key: string, ...catalogs: Array<MessageCatalog | undefined>): boolean {
  return catalogs.some((catalog) => typeof catalog?.[key]?.message === "string");
}

// The popup's label lookup. Order: the host's own messages while the language
// follows the browser (so the popup matches the rest of the browser UI), then
// the selected locale's catalog, then English, and only then the host again for
// keys no catalog carries at all.
export function createTranslator({ languageOverride, overrideCatalog, fallbackCatalog, getMessage }: TranslatorOptions): TFunction {
  return (key, substitutions) => {
    if (languageOverride === "browser") {
      const hostMessage = getMessage(key, substitutions);
      if (hostMessage) return hostMessage;
    }
    if (catalogDefines(key, overrideCatalog, fallbackCatalog)) {
      return translateFromCatalogs(key, substitutions, overrideCatalog, fallbackCatalog ?? overrideCatalog ?? {});
    }
    return getMessage(key, substitutions) || key;
  };
}
