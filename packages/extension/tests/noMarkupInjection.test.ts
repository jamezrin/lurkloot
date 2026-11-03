import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

// Firefox Add-ons review flags every assignment of markup to the DOM in the
// add-on's own code, even of a constant, and asks the developer to justify or
// remove it. Build nodes with createElement / createElementNS and textContent
// instead. React's own internals are bundled too, but they are a known library.
const here = dirname(fileURLToPath(import.meta.url));
const bundled = [
  resolve(here, "../src"),
  resolve(here, "../entrypoints"),
  resolve(here, "../../core/src"),
  resolve(here, "../../shared/src"),
  resolve(here, "../../popup-ui/src"),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx)$/.test(full) ? [full] : [];
  });
}

const MARKUP_WRITE =
  /\.(?:innerHTML|outerHTML)\s*=[^=]|\binsertAdjacentHTML\s*\(|\bdangerouslySetInnerHTML\b|\bdocument\.write(?:ln)?\s*\(/;

describe("bundled sources", () => {
  it("never write markup strings into the DOM", () => {
    const offenders = bundled
      .flatMap(sourceFiles)
      .filter((file) => MARKUP_WRITE.test(readFileSync(file, "utf8")))
      .map((file) => relative(resolve(here, "../.."), file));

    expect(offenders).toEqual([]);
  });
});
