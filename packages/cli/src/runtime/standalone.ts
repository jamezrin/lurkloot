import { existsSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin, Module } from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { isSea } from "node:sea";
import type initCycleTLSType from "cycletls";

// The standalone `lurkloot` executable (#1022) is Node's single-executable
// application: one binary with the CLI bundle inside and no node_modules
// beside it. What the bundle would find beside dist/index.mjs, it finds beside
// the executable instead: the app UI in app/, and the cycletls package in
// cycletls/. cycletls (GPL-3.0) is not compiled into the executable: its
// unmodified JavaScript, its runtime dependencies and its Go binary ship as
// separate files there, as the Docker image keeps them in node_modules, and
// the executable loads them at run time. Everywhere else (node
// dist/index.mjs, Docker, tests) these answer undefined, and the callers keep
// their usual resolution.

export interface ExecutableRuntime {
  isSea: () => boolean;
  execPath: string;
  platform: NodeJS.Platform;
}

function currentRuntime(): ExecutableRuntime {
  return { isSea, execPath: process.execPath, platform: process.platform };
}

// The directory holding the running executable, when this is one.
export function standaloneDir(runtime: ExecutableRuntime = currentRuntime()): string | undefined {
  return runtime.isSea() ? dirname(runtime.execPath) : undefined;
}

// The cycletls package folder beside the executable.
export const CYCLETLS_DIR = "cycletls";

// What the executable archives name the cycletls binary they ship.
export function cycleTlsBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cycletls.exe" : "cycletls";
}

export function standaloneCycleTlsDir(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, CYCLETLS_DIR);
}

// The Go binary in that folder, for cycletls's executablePath.
export function standaloneCycleTlsPath(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneCycleTlsDir(runtime);
  return dir === undefined ? undefined : join(dir, cycleTlsBinaryName(runtime.platform));
}

export class MissingCycleTlsError extends Error {}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface ModuleResolver {
  _resolveFilename: (
    request: string,
    parent: { filename?: string | null } | undefined,
    ...rest: unknown[]
  ) => string;
}

const confinedRoots = new Set<string>();

// Keeps every require made from code inside `root` inside `root`. Node looks
// for a package in each node_modules up the directory tree, so a dependency
// missing from the shipped folder (ws's optional bufferutil, say) would
// otherwise be loaded from whatever node_modules sits above the install, such
// as ~/Downloads/node_modules. A resolution from inside the folder to a file
// outside it fails as MODULE_NOT_FOUND, as if the package were absent, which
// an optional require already handles. Built-in modules are unaffected.
export function confineRequires(
  root: string,
  resolver: ModuleResolver = Module as unknown as ModuleResolver,
): void {
  if (confinedRoots.size === 0) {
    const original = resolver._resolveFilename;
    resolver._resolveFilename = function confined(request, parent, ...rest) {
      const resolved = original.call(this, request, parent, ...rest);
      const from = parent?.filename;
      if (!from || isBuiltin(resolved)) return resolved;
      for (const confinedRoot of confinedRoots) {
        if (isInside(confinedRoot, from) && !isInside(confinedRoot, resolved)) {
          const error = new Error(
            `Cannot find module '${request}' inside ${confinedRoot}`,
          ) as NodeJS.ErrnoException;
          error.code = "MODULE_NOT_FOUND";
          throw error;
        }
      }
      return resolved;
    };
  }
  confinedRoots.add(root);
}

// Loads the cycletls package from its folder beside the executable. A
// single-executable application's own require reaches built-in modules only;
// a require made with createRequire reads files from disk, and resolves the
// package's own dependencies from its node_modules.
export function loadStandaloneCycleTls(
  dir: string | undefined = standaloneCycleTlsDir(),
  requireFrom: (path: string) => NodeJS.Require = createRequire,
): typeof initCycleTLSType {
  if (dir === undefined) {
    throw new MissingCycleTlsError("cycletls is loaded from beside the executable only inside one");
  }
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    throw new MissingCycleTlsError(
      `The cycletls folder is missing beside the executable (${dir}); unpack the whole archive and keep cycletls/ next to lurkloot`,
    );
  }
  // ws's optional native add-ons are not shipped: never look for them.
  process.env.WS_NO_BUFFER_UTIL = "1";
  process.env.WS_NO_UTF_8_VALIDATE = "1";
  const root = realpathSync(dir);
  confineRequires(root);
  const loaded = requireFrom(join(root, "package.json"))(root) as typeof initCycleTLSType & {
    default?: typeof initCycleTLSType;
  };
  return loaded.default ?? loaded;
}

// cycletls starts its binary through `sh -c <path>` on Linux and macOS, and
// strips double quotes from the path, so a path the shell would split or
// expand cannot start it: the CLI would wait on a binary that never ran. Say
// so up front instead. Windows starts it without a shell.
// Letters outside ASCII are fine; whitespace and shell syntax are not.
const SHELL_UNSAFE = /[\s`$&;|<>()*?[\]{}!'"\\]/;

export function assertCycleTlsPathStartable(path: string, platform: NodeJS.Platform): void {
  if (platform === "win32" || !SHELL_UNSAFE.test(path)) return;
  throw new Error(
    `cycletls cannot start from ${path}: move the lurkloot folder to a path without spaces or shell characters`,
  );
}

// The app UI beside the executable.
export function standaloneAppRoot(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, "app");
}
