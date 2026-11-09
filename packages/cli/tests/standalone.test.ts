import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const initCycleTLS = vi.fn(async (_options?: unknown) => ({}));
vi.mock("cycletls", () => ({ default: initCycleTLS }));

const {
  assertCycleTlsPathStartable,
  cycleTlsBinaryName,
  loadStandaloneCycleTls,
  MissingCycleTlsError,
  standaloneAppRoot,
  standaloneCycleTlsDir,
  standaloneCycleTlsPath,
  standaloneDir,
} = await import("../src/runtime/standalone");
const { defaultAppRoot } = await import("../src/runtime/appAssets");
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
    expect(standaloneCycleTlsPath(posixExecutable)).toBe(
      join("/opt/lurkloot", "cycletls", "cycletls"),
    );
    expect(standaloneAppRoot(posixExecutable)).toBe(join("/opt/lurkloot", "app"));
    expect(standaloneCycleTlsPath(windowsExecutable)).toBe(
      join("C:", "Lurkloot", "cycletls", "cycletls.exe"),
    );
  });

  it("are absent under plain node, never the node binary's directory", () => {
    expect(standaloneDir(plainNode)).toBeUndefined();
    expect(standaloneCycleTlsDir(plainNode)).toBeUndefined();
    expect(standaloneCycleTlsPath(plainNode)).toBeUndefined();
    expect(standaloneAppRoot(plainNode)).toBeUndefined();
  });

  it("name the cycletls binary per platform", () => {
    expect(cycleTlsBinaryName("win32")).toBe("cycletls.exe");
    expect(cycleTlsBinaryName("darwin")).toBe("cycletls");
    expect(cycleTlsBinaryName("linux")).toBe("cycletls");
  });

  it("refuse a cycletls path the shell would split, except on Windows", () => {
    expect(() => assertCycleTlsPathStartable("/opt/lurkloot/cycletls", "linux")).not.toThrow();
    expect(() =>
      assertCycleTlsPathStartable("/Users/martínez/lurkloot-cli/cycletls", "darwin"),
    ).not.toThrow();
    expect(() => assertCycleTlsPathStartable("/home/me/My Apps/cycletls", "linux")).toThrow(
      /without spaces or shell characters/,
    );
    expect(() => assertCycleTlsPathStartable("/home/$USER/cycletls", "darwin")).toThrow();
    expect(() =>
      assertCycleTlsPathStartable("C:\\Program Files\\Lurkloot\\cycletls.exe", "win32"),
    ).not.toThrow();
  });
});

describe("loadStandaloneCycleTls", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "lurkloot-cycletls-"));
    // A stand-in package laid out as the archive ships cycletls: package.json,
    // dist/index.js, and a dependency of its own in its node_modules.
    const pkg = join(base, "cycletls");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"cycletls","main":"dist/index.js"}');
    writeFileSync(join(pkg, "node_modules", "dep", "index.js"), 'module.exports = "dep";');
    writeFileSync(
      join(pkg, "dist", "index.js"),
      'const dep = require("dep"); const init = async () => dep; module.exports = init; module.exports.default = init;',
    );
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("loads the package from its folder, with that folder's own dependencies", async () => {
    const init = loadStandaloneCycleTls(join(base, "cycletls"));
    await expect((init as unknown as () => Promise<string>)()).resolves.toBe("dep");
  });

  it("never loads a module from a node_modules above the shipped folder", async () => {
    // A planted package beside the install, where Node's lookup would reach it
    // for any dependency the folder does not ship.
    const outside = await mkdtemp(join(tmpdir(), "lurkloot-planted-"));
    try {
      for (const name of ["planted", "bufferutil"]) {
        mkdirSync(join(outside, "node_modules", name), { recursive: true });
        writeFileSync(
          join(outside, "node_modules", name, "index.js"),
          `globalThis.__lurklootPlanted = (globalThis.__lurklootPlanted ?? []).concat(${JSON.stringify(name)}); module.exports = "planted";`,
        );
      }
      const pkg = join(outside, "cycletls");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{"name":"cycletls","main":"dist/index.js"}');
      writeFileSync(
        join(pkg, "dist", "index.js"),
        [
          "const outcomes = {};",
          'for (const name of ["planted", "bufferutil"]) {',
          "  try { require(name); outcomes[name] = 'loaded'; }",
          "  catch (error) { outcomes[name] = error.code; }",
          "}",
          'outcomes.later = () => { try { require("planted"); return "loaded"; } catch (error) { return error.code; } };',
          'outcomes.builtin = typeof require("node:path").join;',
          "const init = async () => outcomes;",
          "module.exports = init;",
        ].join("\n"),
      );
      const init = loadStandaloneCycleTls(pkg) as unknown as () => Promise<{
        planted: string;
        bufferutil: string;
        later: () => string;
        builtin: string;
      }>;
      const outcomes = await init();
      expect(outcomes.planted).toBe("MODULE_NOT_FOUND");
      expect(outcomes.bufferutil).toBe("MODULE_NOT_FOUND");
      expect(outcomes.later()).toBe("MODULE_NOT_FOUND");
      expect(outcomes.builtin).toBe("function");
      expect((globalThis as { __lurklootPlanted?: string[] }).__lurklootPlanted).toBeUndefined();
      expect(process.env.WS_NO_BUFFER_UTIL).toBe("1");
      expect(process.env.WS_NO_UTF_8_VALIDATE).toBe("1");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("leaves requires from outside the folder alone", async () => {
    const { createRequire } = await import("node:module");
    expect(typeof createRequire(import.meta.url)("node:path").join).toBe("function");
    expect(createRequire(import.meta.url).resolve("vitest/package.json")).toContain("vitest");
  });

  it("names the missing folder instead of loading a copy from elsewhere", () => {
    expect(() => loadStandaloneCycleTls(join(base, "gone"))).toThrow(MissingCycleTlsError);
    expect(() => loadStandaloneCycleTls(join(base, "gone"))).toThrow(
      /The cycletls folder is missing beside the executable/,
    );
  });

  it("refuses to run outside an executable", () => {
    expect(() => loadStandaloneCycleTls(undefined)).toThrow(MissingCycleTlsError);
  });
});

describe("initCycle", () => {
  beforeEach(() => initCycleTLS.mockClear());

  it("lets cycletls find its own binary outside an executable", async () => {
    await initCycle(undefined);
    expect(initCycleTLS).toHaveBeenCalledWith();
  });

  it("starts the binary beside the executable inside one", async () => {
    await initCycle("/opt/lurkloot/cycletls");
    expect(initCycleTLS).toHaveBeenCalledWith({ executablePath: "/opt/lurkloot/cycletls" });
  });

  it("defaults to no executablePath under vitest's plain node", async () => {
    await initCycle();
    expect(initCycleTLS).toHaveBeenCalledWith();
  });

  it.skipIf(process.platform === "win32")(
    "fails before spawning when the path cannot be started",
    async () => {
      await expect(initCycle("/home/me/My Apps/cycletls")).rejects.toThrow(/without spaces/);
      expect(initCycleTLS).not.toHaveBeenCalled();
    },
  );
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
