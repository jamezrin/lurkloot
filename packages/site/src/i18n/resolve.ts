import type { SupportedLocale } from "@lurkloot/shared/models";
import { readCache } from "./cache.ts";
import { translationId } from "./strings.ts";

export async function resolveLeaves(input: {
  cacheDir: string;
  locale: SupportedLocale;
  english: string[];
}): Promise<string[]> {
  if (input.locale === "en") return input.english;
  const cache = await readCache(input.cacheDir, input.locale);
  return input.english.map((text) => cache[translationId(text)] ?? text);
}
