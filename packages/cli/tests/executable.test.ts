import { describe, expect, it } from "vitest";
import { join, sep } from "node:path";
import {
  bundledPackages,
  cycleTlsUpstreamName,
  envWithoutNode,
  executableName,
  nodeLicenseCandidates,
  packageDirOf,
  impitBindingPackages,
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

  it("render a NOTICE naming Node.js, cycletls's source and each bundled package", () => {
    const notice = renderNotice({
      version: "1.25.0",
      nodeVersion: "v24.11.1",
      nodeLicense: "Node license text",
      impit: {
        version: "0.14.9",
        license: "Apache-2.0",
        addons: ["impit-node.linux-x64-gnu.node"],
      },
      cycleTls: { file: "cycletls", version: "2.0.5", license: "GPL text" },
      packages: [{ name: "ws", version: "8.22.1", license: "MIT", text: "ws license" }],
      appLicenses: "## react - 19.2.7 (MIT)\n\nReact license text",
    });
    expect(notice).toContain("Lurkloot CLI 1.25.0");
    expect(notice).toContain("Node.js v24.11.1 runtime");
    expect(notice).toContain(
      "https://github.com/Danny-Dasilva/CycleTLS/tree/28f3d8b9a21470c35269fa24f3907626270ab1dc",
    );
    expect(notice).toContain("  - ws 8.22.1 (MIT)");
    expect(notice).toContain("- cycletls/cycletls is the unmodified Go binary of CycleTLS 2.0.5");
    expect(notice).toContain("It is a separate program");
    expect(notice).toContain("no CycleTLS code is loaded into Lurkloot");
    expect(notice).not.toContain("npm package, under the GNU");
    expect(notice).toContain(
      "impit/ is the unmodified impit 0.14.9 npm package, under the Apache-2.0",
    );
    expect(notice).toContain("(impit-node.linux-x64-gnu.node)");
    expect(notice).toContain("App UI (app/)");
    expect(notice).toContain("React license text");
    for (const text of ["Node license text", "GPL text", "ws license"])
      expect(notice).toContain(text);
  });

  it("rejects a cycletls version without a pinned source revision", () => {
    expect(() =>
      renderNotice({
        version: "1.25.0",
        nodeVersion: "v24.11.1",
        nodeLicense: "Node license text",
        impit: { version: "0.14.9", license: "Apache-2.0", addons: [] },
        cycleTls: { file: "cycletls", version: "2.0.6", license: "GPL text" },
        packages: [],
        appLicenses: "App licenses",
      }),
    ).toThrow(/cycletls 2\.0\.6.*pinned.*2\.0\.5/);
  });

  it("lists impit's binding packages for one platform and architecture, every libc", () => {
    const manifest = {
      optionalDependencies: {
        "impit-darwin-arm64": "0.14.9",
        "impit-linux-x64-gnu": "0.14.9",
        "impit-linux-x64-musl": "0.14.9",
        "impit-linux-arm64-gnu": "0.14.9",
        "impit-win32-x64-msvc": "0.14.9",
      },
    };
    expect(impitBindingPackages(manifest, "linux", "x64")).toEqual([
      "impit-linux-x64-gnu",
      "impit-linux-x64-musl",
    ]);
    expect(impitBindingPackages(manifest, "darwin", "arm64")).toEqual(["impit-darwin-arm64"]);
    expect(impitBindingPackages(manifest, "win32", "x64")).toEqual(["impit-win32-x64-msvc"]);
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
