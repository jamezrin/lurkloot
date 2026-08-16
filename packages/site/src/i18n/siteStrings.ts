import type { SupportedLocale } from "@lurkloot/shared/models";
import { changelog, type ChangelogEntry } from "../changelog.ts";
import { englishCopy } from "../copy/en.ts";
import type { SiteCopy } from "../copy/types.ts";
import { defaultCacheDir } from "./cache.ts";
import { resolveLeaves } from "./resolve.ts";
import { applyStringLeaves, collectStringLeaves } from "./strings.ts";

export function collectSiteEnglish(): string[] {
  return [
    ...collectStringLeaves(englishCopy),
    ...changelog.flatMap((entry) => entry.changes.map((change) => change.text)),
  ];
}

export async function loadSiteCopy(locale: SupportedLocale, cacheDir = defaultCacheDir()): Promise<SiteCopy> {
  const english = collectStringLeaves(englishCopy);
  const resolved = await resolveLeaves({ cacheDir, locale, english });
  return applyStringLeaves(englishCopy, resolved);
}

export async function loadChangelog(locale: SupportedLocale, cacheDir = defaultCacheDir()): Promise<ChangelogEntry[]> {
  const english = changelog.flatMap((entry) => entry.changes.map((change) => change.text));
  const resolved = await resolveLeaves({ cacheDir, locale, english });
  let i = 0;
  return changelog.map((entry) => ({
    ...entry,
    changes: entry.changes.map((change) => ({ ...change, text: resolved[i++] ?? change.text })),
  }));
}
