import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const {
  assertCycleTlsBinary,
  cycleTlsBinaryName,
  cycleTlsBinaryPath,
  loadStandaloneImpit,
  MissingCycleTlsError,
  standaloneAppRoot,
  standaloneCycleTlsDir,
  standaloneDir,
} = await import("../src/runtime/standalone");
const { defaultAppRoot } = await import("../src/runtime/appAssets");
const { cycleTlsFileName } = await import("../scripts/executable.mjs");
const { initCycle } = await import("../src/transport/cycle");

const posixExecutable = {
  isSea: () => true,
  execPath: "/opt/lurkloot/lurkloot",
  platform: "linux" as const,
};
const windowsExecutable = {
  isSea: () => true,
  execPath: join("C:", "Lurkloot", "lurkloot.exe"),
  platform: "win32" as const,
};
const plainNode = { isSea: () => false, execPath: "/usr/bin/node", platform: "linux" as const };

describe("standalone executable paths", () => {
  it("resolve beside the executable", () => {
    expect(standaloneDir(posixExecutable)).toBe("/opt/lurkloot");
    expect(standaloneCycleTlsDir(posixExecutable)).toBe(join("/opt/lurkloot", "cycletls"));
    expect(cycleTlsBinaryPath(posixExecutable)).toBe(join("/opt/lurkloot", "cycletls", "cycletls"));
    expect(standaloneAppRoot(posixExecutable)).toBe(join("/opt/lurkloot", "app"));
    expect(cycleTlsBinaryPath(windowsExecutable)).toBe(
      join("C:", "Lurkloot", "cycletls", "cycletls.exe"),
    );
  });

  it("are absent under plain node, never the node binary's directory", () => {
    expect(standaloneDir(plainNode)).toBeUndefined();
    expect(standaloneCycleTlsDir(plainNode)).toBeUndefined();
    expect(standaloneAppRoot(plainNode)).toBeUndefined();
  });

  it("find the cycletls binary beside the bundle under plain node", () => {
    const bundle = pathToFileURL(join("/srv", "lurkloot", "dist", "index.mjs")).href;
    expect(cycleTlsBinaryPath(plainNode, bundle)).toBe(
      join("/srv", "lurkloot", "dist", "cycletls", "cycletls"),
    );
    // Inside an executable the module URL is the executable's own path.
    expect(cycleTlsBinaryPath(posixExecutable, bundle)).toBe(
      join("/opt/lurkloot", "cycletls", "cycletls"),
    );
  });

  it("name the cycletls binary per platform, as the build names it", () => {
    for (const platform of ["win32", "darwin", "linux"] as const)
      expect(cycleTlsBinaryName(platform)).toBe(cycleTlsFileName(platform));
    expect(cycleTlsBinaryName("win32")).toBe("cycletls.exe");
    expect(cycleTlsBinaryName("darwin")).toBe("cycletls");
    expect(cycleTlsBinaryName("linux")).toBe("cycletls");
  });
});

describe("loadStandaloneImpit", () => {
  it("never loads a module from a node_modules above the shipped folder", async () => {
    // A planted package beside the install, where Node's lookup would reach it
    // for any dependency the folder does not ship.
    const outside = await mkdtemp(join(tmpdir(), "lurkloot-planted-"));
    try {
      mkdirSync(join(outside, "node_modules", "planted"), { recursive: true });
      writeFileSync(
        join(outside, "node_modules", "planted", "index.js"),
        "globalThis.__lurklootPlanted = true; module.exports = 'planted';",
      );
      const pkg = join(outside, "impit");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{"name":"impit","main":"index.js"}');
      writeFileSync(
        join(pkg, "index.js"),
        [
          "let planted;",
          "try { require('planted'); planted = 'loaded'; } catch (error) { planted = error.code; }",
          "module.exports = { planted, builtin: typeof require('node:path').join };",
        ].join("\n"),
      );
      const outcomes = loadStandaloneImpit(pkg) as unknown as { planted: string; builtin: string };
      expect(outcomes.planted).toBe("MODULE_NOT_FOUND");
      expect(outcomes.builtin).toBe("function");
      expect((globalThis as { __lurklootPlanted?: boolean }).__lurklootPlanted).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("initCycle", () => {
  it("names the missing binary instead of looking for another copy", async () => {
    await expect(initCycle("/nowhere/cycletls/cycletls")).rejects.toThrow(MissingCycleTlsError);
    await expect(initCycle("/nowhere/cycletls/cycletls")).rejects.toThrow(
      /The cycletls binary is missing/,
    );
  });

  it("accepts a binary that is there", () => {
    expect(() => assertCycleTlsBinary("/opt/cycletls", () => true)).not.toThrow();
  });
});

describe("defaultAppRoot", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "lurkloot-standalone-"));
    mkdirSync(join(base, "app"));
    writeFileSync(join(base, "app", "index.html"), "<!doctype html>");
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("uses app/ beside the executable inside one", () => {
    expect(defaultAppRoot(undefined, join(base, "app"))).toBe(join(base, "app"));
  });

  it("ignores the module URL inside an executable", () => {
    const elsewhere = pathToFileURL(join(base, "app", "index.mjs")).href;
    expect(defaultAppRoot(elsewhere, join(base, "app"))).toBe(join(base, "app"));
  });

  it("serves no app when the executable has none beside it", () => {
    expect(defaultAppRoot(undefined, join(base, "missing"))).toBeUndefined();
  });

  it("keeps finding app/ beside the module outside an executable", () => {
    expect(defaultAppRoot(pathToFileURL(join(base, "index.mjs")).href)).toBe(
      `${join(base, "app")}/`,
    );
  });
});
