import { dirname, join } from "node:path";
import { isSea } from "node:sea";

// The standalone `lurkloot` executable (#1022) is Node's single-executable
// application: one binary with the CLI bundle inside and no node_modules
// beside it. What the bundle would find beside dist/index.mjs, it finds beside
// the executable instead: the app UI in app/, and cycletls's Go binary, which
// cycletls would otherwise start from its own package directory. Everywhere
// else (node dist/index.mjs, Docker, tests) these answer undefined, and the
// callers keep their usual resolution.

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

// What the executable archives name the cycletls binary they ship.
export function cycleTlsBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cycletls.exe" : "cycletls";
}

// The cycletls binary beside the executable, for cycletls's executablePath.
export function standaloneCycleTlsPath(
  runtime: ExecutableRuntime = currentRuntime(),
): string | undefined {
  const dir = standaloneDir(runtime);
  return dir === undefined ? undefined : join(dir, cycleTlsBinaryName(runtime.platform));
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
