#!/usr/bin/env node

import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import { changelogPath, checkWorkspace, prepareWorkspace } from "../release.mjs";
import { latestVersion, nextVersion, parseManifestVersion } from "./version.mjs";
import { releaseNotes } from "./notes.mjs";
import { ChromeWebStoreClient, publishAction, serviceAccountToken, waitForUpload } from "../cws.mjs";
import { releasePolicy } from "./pipeline.mjs";
import {
  GitHubClient,
  reconcilePrerelease,
  retirePrerelease,
  setCandidateStatuses,
  setCommitStatus,
  upsertComment,
} from "./github.mjs";
import { createRepositoryToken } from "./github-app.mjs";
import { syncBranches } from "./sync.mjs";
import { applyRepositoryConfig, repositoryConfiguration } from "./repository-config.mjs";

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--")) throw new Error(`expected a flag, received ${argv[index]}`);
    values[argv[index].slice(2)] = argv[index + 1] ?? "";
  }
  return values;
}

export function resolveVersion({ tags, bump, version }) {
  if (version) {
    // An operator-typed override becomes a manifest version, so reject a tag-style v prefix here
    // rather than letting it fail later once the release branch already exists.
    parseManifestVersion(version);
    return version;
  }
  return nextVersion(latestVersion(tags), bump);
}

export function resolvePolicy({ labels = "", head = "", tags = "" }) {
  return releasePolicy({
    labels: labels.split(",").map((label) => label.trim()).filter(Boolean),
    head,
    tags: tags.split(/\s+/).filter(Boolean),
  });
}

export function candidateStatus({ version, sha = "", state, url = "" }) {
  const lines = [
    `## Release candidate ${version}`,
    "",
    `- State: **${state}**`,
  ];
  if (sha) lines.push(`- Source: \`${sha.slice(0, 7)}\``);
  if (url) lines.push(`- Candidate: ${url}`);
  lines.push("- Site: https://next.lurkloot.pages.dev");
  return lines.join("\n");
}

export function formatAppTokenOutput(token) {
  return `::add-mask::${token}\ntoken=${token}\n`;
}

export function configureApplyRequested({ apply }) {
  if (apply === undefined || apply === "false") return false;
  if (apply === "true") return true;
  throw new Error("--apply must be true or false");
}

function githubClient() {
  return new GitHubClient({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  });
}

async function emit(outputs) {
  const text = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${text}\n`);
  else process.stdout.write(`${text}\n`);
}

const commands = {
  async policy(values) {
    await emit(resolvePolicy(values));
  },
  async "next-version"(values) {
    const tags = (values.tags ?? "").split(/\s+/).filter(Boolean);
    await emit({ version: resolveVersion({ tags, bump: values.bump, version: values.version ?? "" }) });
  },
  async "prepare-workspace"(values) {
    await prepareWorkspace(values.version, values.date);
    await checkWorkspace();
  },
  async notes(values) {
    const changelog = JSON.parse(await readFile(changelogPath, "utf8"));
    await writeFile(values.out, `${releaseNotes(changelog, values.version)}\n`);
  },
  async "publish-candidate"(values) {
    const entries = await readdir(values.assets, { withFileTypes: true });
    const assets = await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({
        name: basename(entry.name),
        bytes: await readFile(join(values.assets, entry.name)),
      })));
    await reconcilePrerelease({
      client: githubClient(),
      pr: Number(values.pr),
      version: values.version,
      sha: values.sha,
      notes: await readFile(values.notes, "utf8"),
      assets,
    });
  },
  async "candidate-comment"(values) {
    await upsertComment({
      client: githubClient(),
      pr: Number(values.pr),
      body: candidateStatus(values),
    });
  },
  async "commit-status"(values) {
    await setCommitStatus({
      client: githubClient(),
      sha: values.sha,
      state: values.state,
      targetUrl: values["target-url"] ?? "",
    });
  },
  async "candidate-checks"(values) {
    await setCandidateStatuses({
      client: githubClient(),
      sha: values.sha,
      state: values.state,
      targetUrl: values["target-url"] ?? "",
    });
  },
  async "retire-candidate"(values) {
    await retirePrerelease({
      client: githubClient(),
      pr: Number(values.pr),
      version: values.version,
    });
  },
  async "app-token"() {
    const result = await createRepositoryToken({
      appId: process.env.RELEASE_SYNC_APP_ID,
      privateKey: process.env.RELEASE_SYNC_APP_PRIVATE_KEY,
      repository: process.env.GITHUB_REPOSITORY,
    });
    process.stdout.write(`::add-mask::${result.token}\n`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `token=${result.token}\n`);
    else process.stdout.write(`token=${result.token}\n`);
  },
  async "sync-branches"(values) {
    const result = await syncBranches({ remote: values.remote || "origin" });
    await emit(result);
  },
  async "configure-repository"(values) {
    const syncAppId = Number(values["sync-app-id"]);
    const configuration = repositoryConfiguration(syncAppId);
    if (!configureApplyRequested(values)) {
      process.stdout.write(`${JSON.stringify(configuration, null, 2)}\n`);
      return;
    }
    await applyRepositoryConfig({ client: githubClient(), syncAppId });
    process.stdout.write("repository release rulesets applied\n");
  },
  async "cws-release"(values) {
    const client = new ChromeWebStoreClient({
      publisherId: process.env.CWS_PUBLISHER_ID,
      extensionId: process.env.CWS_EXTENSION_ID,
      accessToken: await serviceAccountToken(JSON.parse(process.env.CWS_SERVICE_ACCOUNT_JSON)),
    });
    const action = publishAction(await client.status(), values.version);
    if (action !== "upload") {
      process.stdout.write(`chrome web store: ${action}, nothing to do\n`);
      return;
    }
    const bytes = await readFile(values.package);
    await waitForUpload(client, await client.upload(bytes, `lurkloot-${values.version}.zip`));
    await client.publish();
    process.stdout.write(`chrome web store: submitted ${values.version} with immediate publication\n`);
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, ...rest] = process.argv.slice(2);
  const command = commands[name];
  if (!command) {
    process.stderr.write(`usage: cli.mjs <${Object.keys(commands).join(" | ")}>\n`);
    process.exit(1);
  }
  command(parseArgs(rest)).catch((error) => {
    process.stderr.write(`release: ${error.message}\n`);
    process.exit(1);
  });
}
