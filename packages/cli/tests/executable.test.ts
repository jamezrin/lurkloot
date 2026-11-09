import { describe, expect, it } from "vitest";
import { join, sep } from "node:path";
import {
  bundledPackages,
  cycleTlsUpstreamName,
  dependencyClosure,
  envWithoutNode,
  executableName,
  nodeLicenseCandidates,
  packageDirOf,
  renderNotice,
} from "../scripts/executable.mjs";

describe("executable build helpers", () => {
  it("pick cycletls's upstream binary for each shipped target", () => {
    expect(cycleTlsUpstreamName("linux", "x64")).toBe("index");
    expect(cycleTlsUpstreamName("linux", "arm64")).toBe("index-arm64");
    expect(cycleTlsUpstreamName("darwin", "arm64")).toBe("index-mac-arm64");
    expect(cycleTlsUpstreamName("darwin", "x64")).toBe("index-mac");
    expect(cycleTlsUpstreamName("win32", "x64")).toBe("index.exe");
    expect(() => cycleTlsUpstreamName("linux", "arm")).toThrow(/no binary for linux-arm/);
  });

  it("name the executable per platform", () => {
    expect(executableName("win32")).toBe("lurkloot.exe");
    expect(executableName("linux")).toBe("lurkloot");
  });

  it("find the package of a bundled file, scoped or not, through pnpm's store", () => {
    expect(
      packageDirOf("../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/websocket.js"),
    ).toBe(["..", "..", "node_modules", ".pnpm", "ws@8.22.1", "node_modules", "ws"].join(sep));
    expect(packageDirOf("node_modules/@scope/pkg/index.js")).toBe(
      ["node_modules", "@scope", "pkg"].join(sep),
    );
    expect(packageDirOf("src/index.ts")).toBeUndefined();
    expect(packageDirOf("../core/src/core/scheduler.ts")).toBeUndefined();
  });

  it("collect each bundled package once, with its license text", () => {
    const files: Record<string, string> = {
      [join("/r", "node_modules", "ws", "package.json")]:
        '{"name":"ws","version":"8.22.1","license":"MIT"}',
      [join("/r", "node_modules", "ws", "LICENSE")]: "ws license",
      [join("/r", "node_modules", "@a", "b", "package.json")]: '{"name":"@a/b","version":"1.0.0"}',
    };
    const read = (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    };
    const packages = bundledPackages(
      [
        "node_modules/ws/index.js",
        "node_modules/ws/lib/x.js",
        "node_modules/@a/b/i.js",
        "src/index.ts",
      ],
      { root: "/r", read },
    );
    expect(packages).toEqual([
      { name: "@a/b", version: "1.0.0", license: "see below", text: undefined },
      { name: "ws", version: "8.22.1", license: "MIT", text: "ws license" },
    ]);
  });

  it("collect a package's runtime dependency closure once, without type packages", () => {
    const manifests: Record<string, string> = {
      "/c": '{"name":"cycletls","dependencies":{"ws":"^8","form-data":"^4","@types/node":"^20"}}',
      "/n/ws": '{"name":"ws","version":"8.22.1","license":"MIT"}',
      "/n/form-data":
        '{"name":"form-data","version":"4.0.6","license":"MIT","dependencies":{"mime-types":"^2"}}',
      "/n/mime-types":
        '{"name":"mime-types","version":"2.1.35","license":"MIT","dependencies":{"ws":"^8"}}',
    };
    const read = (path: string) => {
      const dir = path.replace(/[\\/]package\.json$/, "").replaceAll("\\", "/");
      const text = manifests[dir];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    };
    const closure = dependencyClosure("/c", { resolve: (_from, name) => `/n/${name}`, read });
    expect(closure.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      "form-data@4.0.6",
      "mime-types@2.1.35",
      "ws@8.22.1",
    ]);
    expect(closure[0]?.dir).toBe("/n/form-data");
  });

  it("refuse a dependency closure that needs two versions of one package", () => {
    const manifests: Record<string, string> = {
      "/c": '{"dependencies":{"a":"1","b":"1"}}',
      "/a": '{"name":"a","version":"1.0.0","dependencies":{"b":"2"}}',
      "/b1": '{"name":"b","version":"1.0.0"}',
      "/b2": '{"name":"b","version":"2.0.0"}',
    };
    const read = (path: string) => {
      const text = manifests[path.replace(/[\\/]package\.json$/, "").replaceAll("\\", "/")];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    };
    const resolve = (from: string, name: string) =>
      name === "a" ? "/a" : from === "/a" ? "/b2" : "/b1";
    expect(() => dependencyClosure("/c", { resolve, read })).toThrow(/b is needed at/);
  });

  it("render a NOTICE naming Node.js, cycletls's source and each bundled package", () => {
    const notice = renderNotice({
      version: "1.25.0",
      nodeVersion: "v24.11.1",
      nodeLicense: "Node license text",
      cycleTls: {
        file: "cycletls",
        version: "2.0.5",
        license: "GPL text",
        dependencies: [{ name: "form-data", version: "4.0.6", license: "MIT", text: "fd license" }],
      },
      packages: [{ name: "ws", version: "8.22.1", license: "MIT", text: "ws license" }],
    });
    expect(notice).toContain("Lurkloot CLI 1.25.0");
    expect(notice).toContain("Node.js v24.11.1 runtime");
    expect(notice).toContain("https://github.com/Danny-Dasilva/CycleTLS");
    expect(notice).toContain("  - ws 8.22.1 (MIT)");
    expect(notice).toContain("cycletls/ is the unmodified cycletls 2.0.5 npm package");
    expect(notice).toContain("it is not compiled in");
    expect(notice).toContain("  - form-data 4.0.6 (MIT)");
    for (const text of ["Node license text", "GPL text", "ws license", "fd license"])
      expect(notice).toContain(text);
  });

  it("strip every directory holding node from the child's PATH", () => {
    const env = envWithoutNode(
      { PATH: "/usr/local/bin:/opt/node/bin:/usr/bin", HOME: "/home/me" },
      { platform: "linux", hasNode: (path) => path === join("/opt/node/bin", "node") },
    );
    expect(env).toEqual({ PATH: "/usr/local/bin:/usr/bin", HOME: "/home/me" });
    const windows = envWithoutNode(
      { Path: "C:\\Windows;C:\\nodejs" },
      { platform: "win32", hasNode: (path) => path.startsWith("C:\\nodejs") },
    );
    expect(windows.Path).toBe("C:\\Windows");
  });

  it("look for Node's LICENSE beside the binary and beside its bin directory", () => {
    expect(nodeLicenseCandidates("/opt/node/bin/node")).toEqual([
      join("/opt/node/bin", "LICENSE"),
      join("/opt/node", "LICENSE"),
    ]);
  });
});
