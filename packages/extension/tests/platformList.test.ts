import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

// The platform list is declared once, as `PLATFORMS` in @lurkloot/shared/models,
// and `Platform` is derived from it (#1069). A literal copy of the list, or of the
// union, is one more place a new platform has to be added by hand; derive it from
// `PLATFORMS` or `Platform` instead.
const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(here, "../..");
const declaration = resolve(packagesDir, "shared/src/models.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules") return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const LIST_COPY =
  /\[\s*["']twitch["']\s*,\s*["']kick["']\s*\]|\[\s*["']kick["']\s*,\s*["']twitch["']\s*\]/;
const UNION_COPY = /["']twitch["']\s*\|\s*["']kick["']|["']kick["']\s*\|\s*["']twitch["']/;

describe("platform list", () => {
  it("is declared only in @lurkloot/shared/models", () => {
    const sources = readdirSync(packagesDir)
      .map((name) => join(packagesDir, name, "src"))
      .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      .flatMap(sourceFiles)
      .filter((file) => file !== declaration);
    const offenders = sources
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return LIST_COPY.test(text) || UNION_COPY.test(text);
      })
      .map((file) => relative(packagesDir, file));
    expect(offenders, "derive platform lists from PLATFORMS in @lurkloot/shared/models").toEqual(
      [],
    );
  });

  it("derives Platform from PLATFORMS", () => {
    const text = readFileSync(declaration, "utf8");
    expect(text).toMatch(/export const PLATFORMS = \[[^\]]+\] as const;/);
    expect(text).toContain("export type Platform = (typeof PLATFORMS)[number];");
  });
});
