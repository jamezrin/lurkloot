import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gplInputsIn, gplPackagesIn, isGplLicense } from "../scripts/checkNoGplJavaScript.mjs";

describe("the GPL JavaScript check", () => {
  let root: string;

  function pkg(dir: string, manifest: object): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lurkloot-gpl-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("tells GPL licenses from others", () => {
    for (const license of [
      "GPL3",
      "GPL-3.0-only",
      "AGPL-3.0",
      "MIT OR GPL-2.0",
      { type: "GPL" },
      "GNU General Public License v3.0",
      "GNU Affero General Public License",
    ])
      expect(isGplLicense(license)).toBe(true);
    for (const license of [
      "MIT",
      "Apache-2.0",
      "LGPL-3.0",
      "GNU Lesser General Public License",
      "ISC",
      undefined,
    ])
      expect(isGplLicense(license)).toBe(false);
  });

  it("finds a GPL package anywhere in a node_modules tree, pnpm's store and scopes included", () => {
    const nm = join(root, "a", "node_modules");
    pkg(join(nm, "ws"), { name: "ws", version: "8.0.0", license: "MIT" });
    pkg(join(nm, "@scope", "ok"), { name: "@scope/ok", version: "1.0.0", license: "ISC" });
    pkg(join(nm, ".pnpm", "x@1", "node_modules", "x"), {
      name: "x",
      version: "1",
      license: "GPL-3.0",
    });
    pkg(join(nm, "ws", "node_modules", "nested"), {
      name: "nested",
      version: "2",
      license: "AGPL-3.0",
    });
    expect(gplPackagesIn(nm).map((line) => line.split(" ")[0])).toEqual(["nested@2", "x@1"]);
    expect(gplPackagesIn(join(root, "missing"))).toEqual([]);
  });

  it("follows pnpm's links into a store outside the tree", () => {
    const store = join(root, "store", "cycletls");
    pkg(store, { name: "cycletls", version: "2.0.5", license: "GPL3" });
    const nm = join(root, "linked", "node_modules");
    mkdirSync(nm, { recursive: true });
    symlinkSync(store, join(nm, "cycletls"), "junction");
    symlinkSync(nm, join(nm, "loop"), "junction");
    expect(gplPackagesIn(nm)).toHaveLength(1);
  });

  it("flags the cycletls wrapper by name, whatever its manifest says", () => {
    const nm = join(root, "b", "node_modules");
    pkg(join(nm, "cycletls"), { name: "cycletls", version: "2.0.5", license: "see LICENSE" });
    expect(gplPackagesIn(nm)).toHaveLength(1);
  });

  it("finds GPL package code a bundle's metafile lists", () => {
    const manifests: Record<string, string> = {
      [join("/r", "node_modules", "ws", "package.json")]:
        '{"name":"ws","version":"8","license":"MIT"}',
      [join("/r", "node_modules", "cycletls", "package.json")]:
        '{"name":"cycletls","version":"2.0.5","license":"GPL3"}',
    };
    const read = (path: string) => {
      const text = manifests[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    };
    const inputs = {
      "src/index.ts": {},
      "node_modules/ws/index.js": {},
      "node_modules/cycletls/dist/index.js": {},
    };
    expect(gplInputsIn({ inputs }, { root: "/r", read })).toEqual([
      `cycletls@2.0.5 (${join("node_modules", "cycletls")})`,
    ]);
    expect(gplInputsIn({ inputs: { "src/index.ts": {} } }, { root: "/r", read })).toEqual([]);
  });
});
