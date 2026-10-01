import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

// The engine's boundaries (#591), and nothing more:
// - no import cycles between engine modules;
// - no Twitch or Kick branches in the controller facade;
// - no browser-tab code outside packages/extension (#598).
// Services depend on each other through read-only queries and after-commit
// hooks (#585), which this does not police: that is for review.
const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../..");
const coreSrc = join(packages, "core/src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

// The source with comments and string contents blanked, keeping quotes, so
// only code matches (import specifiers are read separately).
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// The relative modules a file loads at runtime: `import … from` and
// `export … from`, not `import type` / `export type`, which erase.
export function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gms;
  for (const match of withoutComments(source).matchAll(pattern)) {
    if (match[2]) continue;
    // `import { type A, type B } from` loads nothing either.
    const clause = match[3].trim();
    const names = /^\{([\s\S]*)\}$/.exec(clause)?.[1];
    if (names !== undefined && names.split(",").map((name) => name.trim()).filter(Boolean).every((name) => name.startsWith("type "))) continue;
    if (match[4].startsWith(".")) specifiers.push(match[4]);
  }
  for (const match of withoutComments(source).matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm)) specifiers.push(match[1]);
  return specifiers;
}

function resolveModule(from: string, specifier: string, exists: (file: string) => boolean): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [`${base}.ts`, join(base, "index.ts"), base].find((candidate) => candidate.endsWith(".ts") && exists(candidate));
}

export function importCycles(
  files: readonly string[],
  read: (file: string) => string,
  exists: (file: string) => boolean = existsSync,
): string[][] {
  const graph = new Map(files.map((file) => [file, runtimeImports(read(file))
    .map((specifier) => resolveModule(file, specifier, exists))
    .filter((target): target is string => target !== undefined)]));
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (file: string): void => {
    state.set(file, "visiting");
    path.push(file);
    for (const target of graph.get(file) ?? []) {
      if (state.get(target) === "visiting") cycles.push([...path.slice(path.indexOf(target)), target]);
      else if (!state.has(target)) visit(target);
    }
    path.pop();
    state.set(file, "done");
  };
  for (const file of files) if (!state.has(file)) visit(file);
  return cycles;
}

export const PLATFORM_BRANCH = /["'](?:twitch|kick)["']/;
export const BROWSER_TAB_CODE = /\b(?:browser|chrome)\.tabs\b|\bBrowserTabApi\b|\bexecuteScript\b|["'][^"']*extension\/src\/core\/(?:tabs|tabPorts|browserTabs)["']/;

describe("engine boundaries (#591)", () => {
  it("has no import cycles between engine modules", () => {
    const cycles = importCycles(tsFiles(coreSrc), (file) => readFileSync(file, "utf8"))
      .map((cycle) => cycle.map((file) => relative(coreSrc, file)).join(" → "));
    expect(cycles, "Modules call each other through the controller's calls, not imports").toEqual([]);
  });

  it("keeps Twitch and Kick branches out of the controller facade", () => {
    const facade = withoutComments(readFileSync(join(coreSrc, "background/controller.ts"), "utf8"));
    expect(PLATFORM_BRANCH.test(facade), "controller.ts wires services; platform policy belongs to them").toBe(false);
  });

  it("keeps browser-tab code in packages/extension", () => {
    const offenders = [...tsFiles(coreSrc), ...tsFiles(join(packages, "cli/src"))]
      .filter((file) => BROWSER_TAB_CODE.test(withoutComments(readFileSync(file, "utf8"))))
      .map((file) => relative(packages, file));
    expect(offenders, "Browser tabs are an extension-only capability (#598)").toEqual([]);
  });

  // Each check fails on a seeded violation, so a broken matcher cannot pass
  // silently.
  describe("the checks themselves", () => {
    it("finds a cycle through a re-export and ignores type-only imports", () => {
      const sources: Record<string, string> = {
        "/engine/a.ts": 'import { b } from "./b";',
        "/engine/b.ts": 'export { c } from "./c";\nimport type { A } from "./a";',
        "/engine/c.ts": 'import { a } from "./a";',
        "/engine/d.ts": 'import { type A } from "./a";\nimport type { C } from "./c";',
      };
      const files = Object.keys(sources);
      expect(importCycles(files, (file) => sources[file], (file) => file in sources))
        .toEqual([["/engine/a.ts", "/engine/b.ts", "/engine/c.ts", "/engine/a.ts"]]);
      expect(runtimeImports(sources["/engine/b.ts"])).toEqual(["./c"]);
      expect(runtimeImports(sources["/engine/d.ts"])).toEqual([]);
      expect(runtimeImports('// import { a } from "./a";\nimport "./side-effect";')).toEqual(["./side-effect"]);
    });

    it("flags a platform literal and browser-tab code", () => {
      expect(PLATFORM_BRANCH.test('if (platform === "twitch") start();')).toBe(true);
      expect(PLATFORM_BRANCH.test("const platforms = PLATFORMS;")).toBe(false);
      expect(BROWSER_TAB_CODE.test("await browser.tabs.create({ url });")).toBe(true);
      expect(BROWSER_TAB_CODE.test('import { createBrowserTabs } from "../../extension/src/core/browserTabs";')).toBe(true);
      expect(BROWSER_TAB_CODE.test("registerManagedPageContextTabs(tabRegistry, {});")).toBe(false);
    });
  });
});
