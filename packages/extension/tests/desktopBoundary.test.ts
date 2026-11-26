import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

// The desktop app (#1024) is packaging only: a Tauri shell that starts the
// bundled `lurkloot serve` and shows its app UI. It never farms itself, so
// it must not load the farming engine (@lurkloot/core), shared runtime code
// (@lurkloot/shared, the CLI's sources) or cycletls, whose GPL-3.0 code stays a
// separate program. The CLI executable it bundles is built by running the
// CLI's own build script, never by importing it.
const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../..");
const desktop = join(packages, "desktop");

// What the shell's build leaves in its tree, none of it source.
const SKIPPED = new Set(["node_modules", "target", "sidecar", "gen", "icons"]);

function files(dir: string, extensions: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIPPED.has(entry)) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return files(full, extensions);
    return extensions.test(entry) ? [full] : [];
  });
}

const FORBIDDEN_PACKAGE =
  /^(?:@lurkloot\/(?:core|shared|cli|popup-ui|app-ui|locales)|cycletls)(?:\/|$)/;
// import/export … from, import(), require() and plain `import "x"`.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
// A relative path out of packages/desktop into another package's sources.
const OTHER_PACKAGE_SOURCE = /(?:^|\/)(?:core|shared|cli|popup-ui|app-ui|locales)\/src(?:\/|$)/;

describe("@lurkloot/desktop packaging-only boundary", () => {
  it("exists where this guard looks", () => {
    expect(existsSync(join(desktop, "package.json"))).toBe(true);
    expect(existsSync(join(desktop, "src-tauri", "Cargo.toml"))).toBe(true);
  });

  it("declares no dependency on the engine, shared runtime code or cycletls", () => {
    const manifest = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ].flatMap((field) => Object.keys(manifest[field] ?? {}));
    expect(declared.filter((name) => FORBIDDEN_PACKAGE.test(name))).toEqual([]);
  });

  it("never imports them from its scripts or pages", () => {
    const offenders = files(desktop, /\.(?:[cm]?[jt]sx?)$/).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(SPECIFIER)]
        .map((match) => match[1])
        .filter(
          (specifier) =>
            FORBIDDEN_PACKAGE.test(specifier)
            || (specifier.startsWith(".") && OTHER_PACKAGE_SOURCE.test(specifier)),
        )
        .map((specifier) => `${relative(packages, file)}: ${specifier}`);
    });
    expect(offenders, `the desktop shell must farm only through serve`).toEqual([]);
  });

  it("links no cycletls or Node code into the Rust shell", () => {
    const cargo = readFileSync(join(desktop, "src-tauri", "Cargo.toml"), "utf8");
    expect(cargo).not.toMatch(/cycletls|node-?bindgen|napi|neon/i);
    const rust = files(join(desktop, "src-tauri", "src"), /\.rs$/)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    // The shell may name cycletls's port variable for serve's environment;
    // it never loads or starts cycletls itself.
    expect(rust).not.toMatch(/Command::new\([^)]*cycletls/i);
  });

  it("the guard sees the shell's own files", () => {
    const scripts = files(desktop, /\.(?:[cm]?[jt]sx?)$/).map((file) => relative(desktop, file));
    expect(scripts).toEqual(
      expect.arrayContaining(["scripts/prepareSidecar.mjs", "shell/status.js"]),
    );
  });
});

// The Rust shell repeats a few names that TypeScript owns. Its own CI runs
// only when packages/desktop changes, so a rename on the TypeScript side would
// break the app with every check green; this keeps them in step.
describe("@lurkloot/desktop contract with serve and the app UI", () => {
  const rust = (file: string) => readFileSync(join(desktop, "src-tauri", "src", file), "utf8");
  const ts = (file: string) => readFileSync(join(packages, file), "utf8");
  const rustConst = (source: string, name: string) =>
    new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(source)?.[1];
  const tsConst = (source: string, name: string) =>
    new RegExp(`export const ${name} = "([^"]+)";`).exec(source)?.[1];

  it("names the same sessionStorage key and token variable", () => {
    const pairs = [
      [
        rustConst(rust("token.rs"), "TOKEN_STORAGE_KEY"),
        tsConst(ts("app-ui/src/api.ts"), "TOKEN_STORAGE_KEY"),
      ],
      [
        rustConst(rust("token.rs"), "SERVE_TOKEN_ENV"),
        tsConst(ts("cli/src/runtime/controlPlane.ts"), "SERVE_TOKEN_ENV"),
      ],
    ];
    for (const [shell, owner] of pairs) {
      expect(shell).toBeTruthy();
      expect(shell).toBe(owner);
    }
  });

  it("starts serve only with options the CLI declares", () => {
    const args = /pub fn serve_args[\s\S]*?\[([^\]]*)\]/.exec(rust("sidecar.rs"))?.[1] ?? "";
    const flags = [...args.matchAll(/"--([a-z-]+)"/g)].map((match) => match[1]);
    expect(flags).toEqual(["port", "ready-json", "exit-with-stdin", "config"]);
    expect(args).toContain('"serve"');
    const cli = ts("cli/src/index.ts");
    expect(cli).toContain('command: "serve"');
    for (const flag of flags) expect(cli).toContain(`.option("${flag}"`);
  });

  it("reads the ready line serve prints", () => {
    expect(ts("cli/src/runtime/serve.ts")).toContain('JSON.stringify({ event: "ready", url })');
    expect(rust("ready.rs")).toContain('ready.event != "ready"');
  });
});
