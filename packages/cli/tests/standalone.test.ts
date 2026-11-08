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
  standaloneAppRoot,
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
    expect(standaloneCycleTlsPath(posixExecutable)).toBe(join("/opt/lurkloot", "cycletls"));
    expect(standaloneAppRoot(posixExecutable)).toBe(join("/opt/lurkloot", "app"));
    expect(standaloneCycleTlsPath(windowsExecutable)).toBe(join("C:", "Lurkloot", "cycletls.exe"));
  });

  it("are absent under plain node, never the node binary's directory", () => {
    expect(standaloneDir(plainNode)).toBeUndefined();
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
