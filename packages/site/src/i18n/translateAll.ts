import type { SupportedLocale } from "@lurkloot/shared/models";
import { readCache, writeCache } from "./cache.ts";
import { prefixedLocales } from "./locale.ts";
import { translationId } from "./strings.ts";
import type { TranslationItem, Translator } from "./translator.ts";

export async function translateAll(input: {
  cacheDir: string;
  english: string[];
  locales?: Exclude<SupportedLocale, "en">[];
  translator: Translator;
}): Promise<void> {
  for (const locale of input.locales ?? prefixedLocales()) {
    const cache = await readCache(input.cacheDir, locale);
    const uniqueMisses = new Map<string, TranslationItem>();
    for (const text of input.english) {
      const id = translationId(text);
      if (cache[id] === undefined && !uniqueMisses.has(id)) {
        uniqueMisses.set(id, { id, text });
      }
    }

    const items = [...uniqueMisses.values()];
    if (items.length === 0) continue;

    const output = await input.translator.translate({ locale, items });
    const translated = Object.fromEntries(output.map((item) => [item.id, item.text]));
    const missingIds = items.filter((item) => translated[item.id] === undefined).map((item) => item.id);
    if (missingIds.length > 0) {
      throw new Error(`Translator response is missing ids for ${locale}: ${missingIds.join(", ")}`);
    }

    await writeCache(input.cacheDir, locale, { ...cache, ...translated });
  }
}
