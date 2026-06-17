import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Guards the headless boundary: @lurkloot/core must stay browser-free so the
// extension AND any non-extension runtime (a headless CLI, tests) can reuse the
// farming engine without faking chrome/browser globals. Any import of wxt or a
// webextension polyfill inside core means a browser dependency leaked back in —
// fail loudly here rather than at the next runtime that tries to consume core.
const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, "../../core/src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const FORBIDDEN = /\b(?:import|require)\b[^\n]*["'](wxt(?:\/[^"']*)?|webextension-polyfill)["']/;

describe("@lurkloot/core browser-free boundary", () => {
  it("never imports wxt or a webextension polyfill", () => {
    const offenders = tsFiles(coreSrc).filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")));
    expect(offenders, `core must stay browser-free; offending files:\n${offenders.join("\n")}`).toEqual([]);
  });
});
