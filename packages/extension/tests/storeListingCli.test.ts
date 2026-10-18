import { describe, expect, it } from "vitest";
// @ts-expect-error The production utility is an executable JavaScript module.
import { main, parseCommand } from "../scripts/store-listing/cli.mjs";

const env = { CWS_EXTENSION_ID: "aobaackpofkghaejdnnmpmeaiaoibhdn" };
const files = new Map([["ja", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);
const descriptions = new Map([["ja", "Japanese body"]]);

function dependencies(calls: string[]) {
  return {
    output: () => {},
    capture: async (options: { mode: string; locales: string[] }) => {
      calls.push(`capture ${options.mode} ${options.locales.join(",")}`);
    },
    checkProvenance: async () => {},
    validateFiles: async () => {
      calls.push("validate files");
      return files;
    },
    loadDescriptions: async () => {
      calls.push("load descriptions");
      return descriptions;
    },
    openBrowser: async () => {
      calls.push("open browser");
      throw new Error("browser stop");
    },
  };
}

describe("store listing command", () => {
  it("reads a bare invocation or a leading option as a sync", () => {
    expect(parseCommand([])).toEqual({ command: "sync", rest: [] });
    expect(parseCommand(["--locales", "ja"])).toEqual({
      command: "sync",
      rest: ["--locales", "ja"],
    });
    expect(parseCommand(["validate", "--only", "descriptions"])).toEqual({
      command: "validate",
      rest: ["--only", "descriptions"],
    });
  });

  it("captures only the requested locales and needs no dashboard identity", async () => {
    const calls: string[] = [];

    await main(["capture", "promos", "--locales", "ja", "id"], {}, dependencies(calls));

    expect(calls).toEqual(["capture promos ja,id"]);
  });

  it("captures screenshots when no mode is named", async () => {
    const calls: string[] = [];

    await main(["capture", "--locales", "ja"], {}, dependencies(calls));

    expect(calls).toEqual(["capture screenshots ja"]);
  });

  it("rejects an unknown locale in the capture stage instead of skipping it", async () => {
    await expect(main(["capture", "--locales", "ja", "xx"], {}, dependencies([]))).rejects.toThrow(
      /unknown locale xx/i,
    );
  });

  it("validates without touching the browser", async () => {
    const calls: string[] = [];

    await main(["validate", "--locales", "ja"], env, dependencies(calls));

    expect(calls).toEqual(["validate files", "load descriptions"]);
  });

  it("captures first, then validates, when a sync asks for it", async () => {
    const calls: string[] = [];

    await expect(
      main(["sync", "--capture", "--locales", "ja"], env, dependencies(calls)),
    ).rejects.toThrow(/browser stop|publisher/i);

    expect(calls.slice(0, 3)).toEqual([
      "capture screenshots ja",
      "validate files",
      "load descriptions",
    ]);
  });

  it("does not capture for a descriptions-only sync", async () => {
    const calls: string[] = [];

    await expect(
      main(
        ["sync", "--capture", "--only", "descriptions", "--locales", "ja"],
        env,
        dependencies(calls),
      ),
    ).rejects.toThrow();

    expect(calls).not.toContain("capture screenshots ja");
    expect(calls[0]).toBe("load descriptions");
  });

  it("checks screenshot provenance before any browser work and forwards the overrides", async () => {
    const calls: string[] = [];
    const seen: unknown[] = [];

    await main(["validate", "--locales", "ja", "--allow-dirty", "--allow-version-mismatch"], env, {
      ...dependencies(calls),
      checkProvenance: async (options: { flags: unknown }) => {
        calls.push("check provenance");
        seen.push(options.flags);
      },
    });

    expect(calls).toEqual(["validate files", "check provenance", "load descriptions"]);
    expect(seen).toEqual([
      { allowVersionMismatch: true, allowDirty: true, noVerify: false, force: false },
    ]);
  });

  it("stops before a browser opens when provenance fails", async () => {
    const calls: string[] = [];

    await expect(
      main(["sync", "--locales", "ja"], env, {
        ...dependencies(calls),
        checkProvenance: async () => {
          throw new Error("captured from 1.17.2");
        },
      }),
    ).rejects.toThrow(/captured from 1\.17\.2/);

    expect(calls).not.toContain("open browser");
  });
});
