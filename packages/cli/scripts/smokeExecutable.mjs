// Smoke-tests a standalone `lurkloot` archive or directory (#1022): unpacks
// it into a fresh directory, then runs the executable with no Node on its PATH
// and no node_modules anywhere near it.
//
//   node scripts/smokeExecutable.mjs <archive or directory> [--require-kick]
//
// - `serve` on a free loopback port must answer 200 on /v1/session and serve
//   the app at /. Its default transport starts cycletls, loaded from the
//   cycletls/ folder beside the executable.
// - `discover` with only Kick enabled and no credentials then makes a Kick
//   request through cycletls. Kick's WAF may challenge a datacenter address,
//   so a failure is a warning unless --require-kick is given.
// - With cycletls/ moved away, `serve` must stop with the error naming it,
//   not hang or fall back to a copy elsewhere.
import { spawn } from "node:child_process";
import {
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

function runCommand(command, args) {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", rejectExit);
    child.on("exit", (code) =>
      code === 0 ? resolveExit() : rejectExit(new Error(`${command} exited ${code}`)),
    );
  });
}

// The directory holding the executable: the archive's single top-level
// directory, or the given directory itself.
async function unpack(path, into) {
  if (statSync(path).isDirectory()) return resolve(path);
  const tar = windows
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  await runCommand(tar, ["-xf", path, "-C", into]);
  const [top] = readdirSync(into);
  return join(into, top);
}

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
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
  return { child, exited, output: () => output };
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return { status: response.status, type: response.headers.get("content-type") ?? "" };
}

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
    await new Promise((wait) => setTimeout(wait, 500));
  }
  throw new Error(stopped ? "the executable exited early" : `timed out: ${last?.message ?? last}`);
}

async function stop(run) {
  if (run.child.exitCode !== null) return;
  run.child.kill(windows ? undefined : "SIGTERM");
  const timeout = new Promise((resolveTimeout) =>
    setTimeout(() => resolveTimeout("timeout"), 15_000),
  );
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

  const port = await freePort();
  const serve = start(
    executable,
    ["serve", "--port", String(port), "--config", "config.json"],
    work,
    env,
  );
  try {
    const base = `http://127.0.0.1:${port}`;
    const session = await waitFor(() => get(`${base}/v1/session`), {
      timeoutMs: 60_000,
      exited: serve.exited,
    });
    if (session.status !== 200) fail(`/v1/session answered ${session.status}`);
    const app = await get(`${base}/`);
    if (app.status !== 200 || !app.type.startsWith("text/html"))
      fail(`/ answered ${app.status} ${app.type}`);
    process.stdout.write(`smoke: /v1/session ${session.status}, / ${app.status} ${app.type}\n`);
  } finally {
    await stop(serve);
  }

  const discover = start(
    executable,
    ["discover", "--config", "config.json", "--log", "debug"],
    work,
    env,
  );
  const code = await Promise.race([
    discover.exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 90_000)),
  ]);
  if (code === "timeout") discover.child.kill("SIGKILL");
  if (/Kick fetch \S+ → background transport OK/.test(discover.output())) {
    process.stdout.write("smoke: a Kick request through cycletls succeeded\n");
  } else if (requireKick) {
    fail(`no Kick request through cycletls succeeded (discover ${code})`);
  } else {
    process.stdout.write(
      `::warning::No Kick request through cycletls succeeded from this runner (discover ${code})\n`,
    );
  }

  renameSync(join(dir, "cycletls"), join(dir, "cycletls-moved"));
  const missing = start(
    executable,
    ["serve", "--port", String(await freePort()), "--config", "config.json"],
    work,
    env,
  );
  const missingCode = await Promise.race([
    missing.exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 30_000)),
  ]);
  if (missingCode === "timeout") missing.child.kill("SIGKILL");
  if (missingCode === 0 || missingCode === "timeout") {
    fail(`serve without cycletls/ did not fail (${missingCode})`);
  } else if (!/The cycletls folder is missing beside the executable/.test(missing.output())) {
    fail("serve without cycletls/ failed without naming the missing folder");
  } else {
    process.stdout.write("smoke: without cycletls/, serve stops and names the missing folder\n");
  }
} catch (error) {
  fail(error.message);
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
