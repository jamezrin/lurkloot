#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { changelogPath, checkWorkspace, prepareWorkspace } from "../release.mjs";
import { latestVersion, nextVersion, parseVersion } from "./version.mjs";
import { releaseNotes } from "./notes.mjs";
import { ChromeWebStoreClient, publishAction, serviceAccountToken, waitForUpload } from "../cws.mjs";

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
    parseVersion(version);
    return version;
  }
  return nextVersion(latestVersion(tags), bump);
}

async function emit(outputs) {
  const text = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${text}\n`);
  else process.stdout.write(`${text}\n`);
}

const commands = {
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
