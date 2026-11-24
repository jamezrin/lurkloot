// Smoke-tests a standalone `lurkloot` archive or directory (#1022): extracts
// or copies it into scratch space, then runs the executable with no Node on its PATH
// and away from the workspace's node_modules.
//
//   node scripts/smokeExecutable.mjs <archive or directory> [--require-kick]
//
// - `serve` on a free loopback port must answer 200 on /v1/session and serve
//   the app at /. Its default transport (impersonate) loads impit from the
//   impit/ folder beside the executable.
// - `discover` with only Kick enabled and no credentials then makes a Kick
//   request through each impersonating library, impit and cycletls. Kick's WAF
//   may challenge a datacenter address, so a failure is a warning unless
//   --require-kick is given.
// - With either library's folder moved away, `serve` on that library must stop
//   with the error naming it, not hang or fall back to a copy elsewhere, and
//   `serve` on the other library must still start.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { envWithoutNode, executableName } from "./executable.mjs";

const [source, ...flags] = process.argv.slice(2);
if (!source) {
  process.stderr.write("usage: smokeExecutable.mjs <archive or directory> [--require-kick]\n");
  process.exit(2);
}
const requireKick = flags.includes("--require-kick");
const windows = process.platform === "win32";

function fail(message) {
  process.stderr.write(`smoke: ${message}\n`);
  process.exitCode = 1;
}

/** Runs the archive extractor and reports its exit status on failure. */
function runCommand(command, args) {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", rejectExit);
    child.on("exit", (code) =>
      code === 0 ? resolveExit() : rejectExit(new Error(`${command} exited ${code}`)),
    );
  });
}

/** Stages the executable in scratch space so the missing-folder probe can rename its files. */
async function unpack(path, into) {
  if (statSync(path).isDirectory()) {
    const staged = join(into, "executable");
    cpSync(path, staged, { recursive: true });
    return staged;
  }
  const tar = windows
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  await runCommand(tar, ["-xf", path, "-C", into]);
  const [top] = readdirSync(into);
  if (!top) throw new Error(`${basename(path)} unpacked to nothing`);
  return join(into, top);
}

/** Asks the OS for an available loopback port for the next serve process. */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Streams the executable's output and captures it for the smoke assertions. */
function start(executable, args, cwd, env) {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });
  const exited = new Promise((resolveExit) => {
    child.once("error", (error) => fail(`could not run ${executable}: ${error.message}`));
    child.once("close", resolveExit);
  });
  return { child, exited, output: () => output };
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return { status: response.status, type: response.headers.get("content-type") ?? "" };
}

/** Waits for the session endpoint until the server exits or startup times out. */
async function waitFor(check, { timeoutMs, exited }) {
  const deadline = Date.now() + timeoutMs;
  let stopped = false;
  exited.then(() => {
    stopped = true;
  });
  let last;
  while (Date.now() < deadline && !stopped) {
    try {
      return await check();
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  throw new Error(stopped ? "the executable exited early" : `timed out: ${last?.message ?? last}`);
}

/** Stops serve before the next command (CycleTLS uses a fixed default port). */
async function stop(run) {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return;
  run.child.kill(windows ? undefined : "SIGTERM");
  const timeout = delay(15_000, "timeout", { ref: false });
  if ((await Promise.race([run.exited, timeout])) === "timeout") {
    run.child.kill("SIGKILL");
    fail("serve did not stop within 15 s of SIGTERM");
  }
}

const scratch = mkdtempSync(join(tmpdir(), "lurkloot-smoke-"));
try {
  const dir = await unpack(resolve(source), scratch);
  const executable = join(dir, executableName(process.platform));
  for (const file of [
    executable,
    join(dir, "cycletls", "package.json"),
    join(dir, "cycletls", "dist", "index.js"),
    join(dir, "cycletls", "LICENSE"),
    join(dir, "cycletls", "node_modules", "ws", "package.json"),
    join(dir, "cycletls", windows ? "cycletls.exe" : "cycletls"),
    join(dir, "impit", "package.json"),
    join(dir, "impit", "index.js"),
    join(dir, "app", "index.html"),
    join(dir, "LICENSE"),
    join(dir, "NOTICE"),
  ]) {
    if (!existsSync(file)) throw new Error(`${basename(file)} is missing from ${dir}`);
  }
  const work = mkdtempSync(join(scratch, "data-"));
  writeFileSync(
    join(work, "config.json"),
    JSON.stringify({
      transport: "impersonate",
      authDir: "auth",
      settings: { platform: { twitch: { enabled: false }, kick: { enabled: true } } },
    }),
  );
  const env = envWithoutNode(process.env, { hasNode: existsSync });
  delete env.LURKLOOT_SERVE_TOKEN;
  delete env.NODE_OPTIONS;

  /** Starts serve on one transport and reports whether its session endpoint answered. */
  async function serveAnswers(transport) {
    const port = await freePort();
    const serve = start(
      executable,
      ["serve", "--port", String(port), "--config", "config.json", "--transport", transport],
      work,
      env,
    );
    try {
      const base = `http://127.0.0.1:${port}`;
      const session = await waitFor(() => get(`${base}/v1/session`), {
        timeoutMs: 60_000,
        exited: serve.exited,
      });
      if (session.status !== 200) fail(`/v1/session answered ${session.status} on ${transport}`);
      const app = await get(`${base}/`);
      if (app.status !== 200 || !app.type.startsWith("text/html"))
        fail(`/ answered ${app.status} ${app.type} on ${transport}`);
      process.stdout.write(
        `smoke: ${transport}: /v1/session ${session.status}, / ${app.status} ${app.type}\n`,
      );
    } catch (error) {
      fail(`serve on ${transport}: ${error.message}`);
    } finally {
      await stop(serve);
    }
  }

  await serveAnswers("impersonate");

  const libraries = ["impit", "cycletls"];
  for (const library of libraries) {
    const discover = start(
      executable,
      ["discover", "--config", "config.json", "--log", "debug", "--transport", library],
      work,
      env,
    );
    const code = await Promise.race([discover.exited, delay(90_000, "timeout", { ref: false })]);
    if (code === "timeout") discover.child.kill("SIGKILL");
    if (/Kick fetch \S+ → background transport OK/.test(discover.output())) {
      process.stdout.write(`smoke: a Kick request through ${library} succeeded\n`);
    } else if (requireKick) {
      fail(`no Kick request through ${library} succeeded (discover ${code})`);
    } else {
      process.stdout.write(
        `::warning::No Kick request through ${library} succeeded from this runner (discover ${code})\n`,
      );
    }
  }

  for (const library of libraries) {
    const other = libraries.find((name) => name !== library);
    renameSync(join(dir, library), join(dir, `${library}-moved`));
    try {
      const missing = start(
        executable,
        [
          "serve",
          "--port",
          String(await freePort()),
          "--config",
          "config.json",
          "--transport",
          library,
        ],
        work,
        env,
      );
      const missingCode = await Promise.race([
        missing.exited,
        delay(30_000, "timeout", { ref: false }),
      ]);
      if (missingCode === "timeout") missing.child.kill("SIGKILL");
      if (missingCode === 0 || missingCode === "timeout") {
        fail(`serve without ${library}/ did not fail (${missingCode})`);
      } else if (
        !new RegExp(`The ${library} folder is missing beside the executable`).test(missing.output())
      ) {
        fail(`serve without ${library}/ failed without naming the missing folder`);
      } else {
        process.stdout.write(
          `smoke: without ${library}/, serve stops and names the missing folder\n`,
        );
      }
      // Each library loads only when its transport is used.
      await serveAnswers(other);
    } finally {
      renameSync(join(dir, `${library}-moved`), join(dir, library));
    }
  }
} catch (error) {
  fail(error.message);
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
