import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Browser tabs are an extension-only capability (#598): the CLI reaches the
// platforms through @lurkloot/core/transport and declares no tabs, so it never
// imports the tab registry or the extension's tab mechanics.
const here = dirname(fileURLToPath(import.meta.url));
const cliSrc = resolve(here, "../src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const TABS_IMPORT = /["'](?:@lurkloot\/core\/(?:tabs|tabRegistry)|[^"']*browserTabs)["']/;

describe("CLI tab boundary", () => {
  it("never imports tab code", () => {
    const offenders = tsFiles(cliSrc).filter((file) => TABS_IMPORT.test(readFileSync(file, "utf8")));
    expect(offenders, `the CLI must not import browser tab code; offending files:\n${offenders.join("\n")}`).toEqual([]);
  });
});
