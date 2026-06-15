import type { MessageCatalog } from "@lurkloot/shared/i18n";
import type { SupportedLocale } from "@lurkloot/shared/models";

// Per-locale dynamic imports. Explicit (not a template literal) so every
// bundler can statically analyse the specifiers and emit a chunk per locale —
// only the active locale's catalog is fetched at runtime.
const loaders: Record<SupportedLocale, () => Promise<{ default: MessageCatalog }>> = {
  en: () => import("../messages/en.json"),
  es: () => import("../messages/es.json"),
  fr: () => import("../messages/fr.json"),
  it: () => import("../messages/it.json"),
  ru: () => import("../messages/ru.json"),
  de: () => import("../messages/de.json"),
  zh_CN: () => import("../messages/zh_CN.json"),
  hi: () => import("../messages/hi.json"),
  pt_BR: () => import("../messages/pt_BR.json"),
  ar: () => import("../messages/ar.json"),
};

export async function loadCatalog(locale: SupportedLocale): Promise<MessageCatalog | undefined> {
  try {
    return (await loaders[locale]()).default;
  } catch {
    return undefined;
  }
}
