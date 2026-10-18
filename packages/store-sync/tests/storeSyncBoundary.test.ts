import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageDir = join(import.meta.dirname, "..");
const sourceDir = join(packageDir, "src");

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("store-sync is self-contained", () => {
  const files = readdirSync(sourceDir).filter((name) => name.endsWith(".mjs"));

  it("imports only itself, node and playwright", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(join(sourceDir, file), "utf8"))) {
        const allowed = specifier.startsWith(".")
          ? /^\.\/[\w-]+\.mjs$/.test(specifier)
          : /^(node:|playwright$)/.test(specifier);
        expect(allowed, `src/${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("names no product", () => {
    for (const file of files) {
      expect(readFileSync(join(sourceDir, file), "utf8"), `src/${file}`).not.toMatch(
        /lurkloot|twitch|kick\b/i,
      );
    }
  });

  it("depends on nothing in the workspace", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });

    expect(dependencies).toEqual(["playwright"]);
  });
});
