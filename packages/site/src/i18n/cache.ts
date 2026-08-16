import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupportedLocale } from "@lurkloot/shared/models";

export function defaultCacheDir(from = import.meta.dirname): string {
  return join(from, "../../.i18n-cache");
}

export function cachePath(dir: string, locale: Exclude<SupportedLocale, "en">): string {
  return join(dir, `${locale}.json`);
}

export async function readCache(
  dir: string,
  locale: Exclude<SupportedLocale, "en">,
): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(cachePath(dir, locale), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function writeCache(
  dir: string,
  locale: Exclude<SupportedLocale, "en">,
  entries: Record<string, string>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(cachePath(dir, locale), `${JSON.stringify(sorted, null, 2)}\n`);
}
