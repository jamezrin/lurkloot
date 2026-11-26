import { existsSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin, Module } from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { isSea } from "node:sea";
import type initCycleTLSType from "cycletls";
import type * as ImpitModule from "impit";

// The standalone `lurkloot` executable (#1022) is Node's single-executable
// application: one binary with the CLI bundle inside and no node_modules
// beside it. What the bundle would find beside dist/index.mjs, it finds beside
// the executable instead: the app UI in app/, the impit package in impit/, and
// the cycletls package in cycletls/. impit's native add-on cannot be loaded
// from inside the executable, so its JavaScript and the add-on for this
// platform ship in impit/. cycletls (GPL-3.0) is not compiled into the executable: its
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

/** Locates the running standalone executable's directory when running as a SEA. */
export function standaloneDir(runtime: ExecutableRuntime = currentRuntime()): string | undefined {
  return runtime.isSea() ? dirname(runtime.execPath) : undefined;
}

// The cycletls package folder beside the executable.
const CYCLETLS_DIR = "cycletls";

/** Gives the shipped CycleTLS helper its platform-specific filename. */
export function cycleTlsBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cycletls.exe" : "cycletls";
}

/** Locates the CycleTLS package directory in a standalone install. */
export function standaloneCycleTlsDir(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, CYCLETLS_DIR);
}

/** Locates the Go helper to pass to CycleTLS as its executablePath. */
export function standaloneCycleTlsPath(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneCycleTlsDir(runtime);
  return dir === undefined ? undefined : join(dir, cycleTlsBinaryName(runtime.platform));
}

export class MissingCycleTlsError extends Error {}

/** Tests whether an absolute path refers to the root or a path beneath it. */
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

/**
 * Keeps requires from inside the shipped folder confined to that folder.
 * Node can still resolve built-ins. An external file resolves as MODULE_NOT_FOUND
 * so optional dependencies can use their existing fallback.
 */
function confineRequires(
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

/** Loads the adjacent CycleTLS package and its dependencies from disk in a SEA. */
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

// The impit package folder beside the executable: its package.json and
// JavaScript, with this platform's native add-on beside them, where impit's own
// loader looks first.
const IMPIT_DIR = "impit";

/** Locates the impit package directory in a standalone install. */
function standaloneImpitDir(runtime: ExecutableRuntime = currentRuntime()): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, IMPIT_DIR);
}

class MissingImpitError extends Error {}

/** Loads the adjacent impit package and its native add-on from disk in a SEA. */
export function loadStandaloneImpit(
  dir: string | undefined = standaloneImpitDir(),
  requireFrom: (path: string) => NodeJS.Require = createRequire,
): typeof ImpitModule {
  if (dir === undefined) {
    throw new MissingImpitError("impit is loaded from beside the executable only inside one");
  }
  if (!existsSync(join(dir, "package.json"))) {
    throw new MissingImpitError(
      `The impit folder is missing beside the executable (${dir}); unpack the whole archive and keep impit/ next to lurkloot`,
    );
  }
  const root = realpathSync(dir);
  confineRequires(root);
  return requireFrom(join(root, "package.json"))(root) as typeof ImpitModule;
}

/** Refuses paths the CycleTLS wrapper would split or expand when starting its helper. */
export function assertCycleTlsPathStartable(path: string, platform: NodeJS.Platform): void {
  if (platform === "win32" || !SHELL_UNSAFE.test(path)) return;
  throw new Error(
    `cycletls cannot start from ${path}: move the lurkloot folder to a path without spaces or shell characters`,
  );
}

/** Locates the app UI assets beside the running standalone executable. */
export function standaloneAppRoot(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, "app");
}
