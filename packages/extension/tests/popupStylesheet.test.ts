import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../popup-ui/src/styles.css");

// Compiles the popup's stylesheet exactly as the build does: Tailwind scans the
// popup's sources for candidate classes and emits the utilities they name.
async function buildPopupCss(): Promise<string> {
  const base = dirname(stylesPath);
  const compiler = await compile(await readFile(stylesPath, "utf8"), { base, onDependency: () => undefined });
  const scanner = new Scanner({ sources: compiler.sources });
  return compiler.build(scanner.scan());
}

describe("popup stylesheet", () => {
  // An extension popup is re-measured after every layout by laying the
  // document out at a tiny width and back. A width media query flips on each of
  // those passes and forces a full style recalculation and relayout of the
  // popup — the regression behind a sluggish popup, brought in by Tailwind's
  // .container utility after a comment mentioned a "container query".
  it("has no viewport-width media queries", async () => {
    const css = await buildPopupCss();

    expect(css).toContain(".\\@container");
    expect(css.match(/@media[^{]*(width|height)[^{]*\{/g) ?? []).toEqual([]);
  });
});
