import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "@lurkloot/store-sync";

const storeDir = join(import.meta.dirname, "..", "scripts", "store");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : entry.name.endsWith(".mjs")
        ? [join(directory, entry.name)]
        : [],
  );
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("store generators and the sync package", () => {
  // @lurkloot/store-sync is meant to be lifted out of this repository. It stays
  // liftable only while what depends on it uses what it publishes, not what it
  // is made of.
  it("reach the sync package only through its public entry points", () => {
    const files = sources(storeDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith("@lurkloot/store-sync")) continue;
        expect(
          ["@lurkloot/store-sync", "@lurkloot/store-sync/cli"],
          `${file} imports ${specifier}`,
        ).toContain(specifier);
      }
    }
  });

  it("never import the sync package by its path", () => {
    for (const file of sources(storeDir)) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(
          /store-sync\/(src|tests)|\.\.\/.*store-sync/,
        );
      }
    }
  });

  it("publish what a producer needs and not the consumer's machinery", () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        "BUNDLE_MANIFEST",
        "DESCRIPTION_MAX_LENGTH",
        "GLOBAL",
        "MAX_SCREENSHOTS",
        "PARTS",
        "PROMO_TILES",
        "SCREENSHOT_SIZES",
        "gitProvenance",
        "isLocaleCode",
        "readBundle",
        "sectionId",
        "sectionPath",
        "stampBundle",
      ].sort(),
    );
  });
});
