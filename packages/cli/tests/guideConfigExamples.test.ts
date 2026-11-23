import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, parseConfigJsonc } from "../src/config";

// The user guide (packages/site/src/content/docs/guide) shows config.json
// examples for the CLI. Each one is meant to be copied as it is, so each must
// load without errors or warnings, and every value it sets must survive
// normalization (a value the CLI drops silently is as wrong as a typo).

const GUIDE_DIR = join(import.meta.dirname, "../../site/src/content/docs/guide");
const EXAMPLE = /```jsonc? title="config\.json"\n([\s\S]*?)\n```/g;

function guideFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return guideFiles(path);
    return /\.mdx?$/.test(entry.name) ? [path] : [];
  });
}

const examples = guideFiles(GUIDE_DIR).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(EXAMPLE)].map((match, index) => ({
    name: `${relative(GUIDE_DIR, file)} #${index + 1}`,
    text: match[1],
  })),
);

// Every leaf of `expected` is present, with the same value, in `actual`.
function expectSubset(expected: unknown, actual: unknown, path: string): void {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    expect(actual, path).toBeTypeOf("object");
    for (const [key, value] of Object.entries(expected)) {
      expectSubset(value, (actual as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toEqual(expected);
}

describe("guide config.json examples", () => {
  it("finds the examples", () => {
    expect(examples.length).toBeGreaterThan(10);
  });

  it.each(examples)("$name loads as written", ({ text }) => {
    const raw = parseConfigJsonc(text, "/data/config.json") as { settings?: unknown };
    const config = parseConfig(raw, "/data/config.json");
    expect(config.warnings).toEqual([]);
    expectSubset(raw.settings ?? {}, config.settings, "settings");
  });
});
