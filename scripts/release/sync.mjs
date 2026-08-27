import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return exec("git", args, { cwd });
}

async function isAncestor(cwd, ancestor, descendant) {
  try {
    await git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

function commandFailure(error) {
  const details = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
  return new Error(details);
}

export async function defaultVerify(cwd, run = execPnpm) {
  try {
    await run(cwd, ["install", "--frozen-lockfile"]);
    // Same Chromium the PR and candidate verify jobs install. storeScreenshotDashboard
    // tests launch it; GitHub-hosted runners do not ship Playwright browsers.
    await run(cwd, ["--filter", "@lurkloot/extension", "exec", "playwright", "install", "chromium"]);
    await run(cwd, ["verify"]);
  } catch (error) {
    throw commandFailure(error);
  }
}

function execPnpm(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `pnpm ${args.join(" ")} killed by ${signal}` : `Command failed: pnpm ${args.join(" ")}`));
    });
  });
}

export async function syncBranches({ cwd = process.cwd(), remote = "origin", verify = defaultVerify }) {
  const main = `refs/remotes/${remote}/main`;
  const develop = `refs/remotes/${remote}/develop`;
  await git(cwd, "fetch", "--prune", remote,
    `refs/heads/main:${main}`,
    `refs/heads/develop:${develop}`);

  if (await isAncestor(cwd, main, develop)) {
    return { mode: "already-contained", sha: (await git(cwd, "rev-parse", develop)).stdout.trim() };
  }

  // Switching branches aborts on modified tracked files, and the publish job that calls this has
  // already run steps that can rewrite the workspace. Fail with the offending paths rather than a
  // bare git abort. Untracked files are ignored: the job leaves downloaded artifacts lying around.
  const dirty = (await git(cwd, "status", "--porcelain", "--untracked-files=no")).stdout.trim();
  if (dirty) throw new Error(`refusing to synchronize with a dirty working tree:\n${dirty}`);

  await git(cwd, "switch", "--detach", develop);
  await git(cwd, "config", "user.name", "Lurkloot Release Sync[bot]");
  await git(cwd, "config", "user.email", "release-sync@lurkloot.invalid");

  let mode;
  if (await isAncestor(cwd, develop, main)) {
    await git(cwd, "merge", "--ff-only", main);
    mode = "fast-forward";
  } else {
    try {
      await git(cwd, "merge", "--no-ff", "--no-edit", main);
    } catch (error) {
      await git(cwd, "merge", "--abort").catch(() => {});
      throw new Error(`main to develop synchronization conflict: ${error.stderr || error.message}`);
    }
    mode = "merge";
  }

  await verify(cwd);
  const sha = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  await git(cwd, "push", remote, "HEAD:refs/heads/develop");
  return { mode, sha };
}
