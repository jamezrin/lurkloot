import { existsSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin, Module } from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import type * as ImpitModule from "impit";

// The standalone `lurkloot` executable (#1022) is Node's single-executable
// application: one binary with the CLI bundle inside and no node_modules
// beside it. What the bundle would find beside dist/index.mjs, it finds beside
// the executable instead: the app UI in app/, the impit package in impit/, and
// CycleTLS's Go binary in cycletls/. impit's native add-on cannot be loaded
// from inside the executable, so its JavaScript and the add-on for this
// platform ship in impit/. CycleTLS (GPL-3.0) is a separate program: only its
// Go binary ships, with its license, and the CLI starts it and talks to it
// over a local socket (src/transport/cycleTlsClient.ts). Everywhere else (node
// dist/index.mjs, Docker) the binary sits in dist/cycletls/ beside the bundle.

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

// The folder CycleTLS's Go binary ships in: beside the executable, or beside
// dist/index.mjs (scripts/copyCycleTls.mjs puts it there at build time).
export const CYCLETLS_DIR = "cycletls";

/** Gives the shipped CycleTLS binary its platform-specific filename. */
export function cycleTlsBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cycletls.exe" : "cycletls";
}

/** Locates the CycleTLS binary folder in a standalone install. */
export function standaloneCycleTlsDir(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, CYCLETLS_DIR);
}

export class MissingCycleTlsError extends Error {}

/**
 * Locates CycleTLS's Go binary: beside the executable in a standalone install,
 * otherwise in cycletls/ beside the running bundle (dist/index.mjs).
 */
export function cycleTlsBinaryPath(
  runtime: ExecutableRuntime = currentRuntime(),
  moduleUrl: string = import.meta.url,
): string {
  const dir =
    standaloneCycleTlsDir(runtime) ?? join(dirname(fileURLToPath(moduleUrl)), CYCLETLS_DIR);
  return join(dir, cycleTlsBinaryName(runtime.platform));
}

/** Refuses to start when the CycleTLS binary is not where the install puts it. */
export function assertCycleTlsBinary(
  path: string,
  exists: (path: string) => boolean = existsSync,
): void {
  if (exists(path)) return;
  throw new MissingCycleTlsError(
    `The cycletls binary is missing (${path}); keep the cycletls/ folder next to lurkloot (or rebuild the CLI with pnpm build)`,
  );
}

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

// The impit package folder beside the executable: its package.json and
// JavaScript, with this platform's native add-on beside them, where impit's own
// loader looks first.
export const IMPIT_DIR = "impit";

/** Locates the impit package directory in a standalone install. */
export function standaloneImpitDir(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, IMPIT_DIR);
}

export class MissingImpitError extends Error {}

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

/** Locates the app UI assets beside the running standalone executable. */
export function standaloneAppRoot(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, "app");
}
