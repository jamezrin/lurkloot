#!/usr/bin/env node

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

const scope = "https://www.googleapis.com/auth/chromewebstore";
const apiOrigin = "https://chromewebstore.googleapis.com";

export function revisionVersion(revision) {
  return revision?.distributionChannels?.[0]?.crxVersion;
}

function assertHealthy(status) {
  if (status.takenDown) throw new Error("Chrome Web Store item is taken down");
  if (status.warned) throw new Error("Chrome Web Store item has an unresolved policy warning");
}

export function prereleaseAction(status, version) {
  assertHealthy(status);
  const publishedVersion = revisionVersion(status.publishedItemRevisionStatus);
  const submitted = status.submittedItemRevisionStatus;
  const submittedVersion = revisionVersion(submitted);
  if (!submitted) {
    if (publishedVersion === version) throw new Error(`${version} is already published and cannot be replaced as a pre-release draft`);
    return "upload";
  }
  if (submittedVersion !== version) {
    throw new Error(`Chrome Web Store has ${submittedVersion ?? "an unknown version"} in state ${submitted.state}; expected ${version}`);
  }
  if (submitted.state === "PENDING_REVIEW" || submitted.state === "STAGED") return "frozen";
  throw new Error(`Chrome Web Store submitted revision is ${submitted.state}; resolve it in the Developer Dashboard`);
}

export function stableAction(status, version) {
  assertHealthy(status);
  const publishedVersion = revisionVersion(status.publishedItemRevisionStatus);
  const submitted = status.submittedItemRevisionStatus;
  if (!submitted) {
    if (publishedVersion === version) return "already-published";
    throw new Error(`Chrome Web Store has no approved staged ${version} revision`);
  }
  const submittedVersion = revisionVersion(submitted);
  if (submittedVersion !== version) {
    throw new Error(`Chrome Web Store staged version is ${submittedVersion ?? "unknown"}; expected ${version}`);
  }
  if (submitted.state === "STAGED") return "publish";
  throw new Error(`Chrome Web Store revision ${version} is ${submitted.state}; expected STAGED`);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function serviceAccountToken(credentials, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: credentials.client_email,
    scope,
    aud: credentials.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(credentials.private_key).toString("base64url")}`;
  const response = await fetchImpl(credentials.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Chrome Web Store token request failed (${response.status})`);
  return body.access_token;
}

export class ChromeWebStoreClient {
  constructor({ publisherId, extensionId, accessToken, fetchImpl = fetch }) {
    this.item = `publishers/${publisherId}/items/${extensionId}`;
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
  }

  async request(path, init = {}) {
    const response = await this.fetch(`${apiOrigin}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.accessToken}`, ...init.headers },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Chrome Web Store API failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
    return body;
  }

  status() {
    return this.request(`/v2/${this.item}:fetchStatus`);
  }

  upload(packageBytes, filename) {
    return this.request(`/upload/v2/${this.item}:upload`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-goog-upload-protocol": "raw",
        "x-goog-upload-file-name": filename,
      },
      body: packageBytes,
    });
  }

  publishStaged() {
    return this.request(`/v2/${this.item}:publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishType: "STAGED_PUBLISH", blockOnWarnings: true }),
    });
  }
}

async function waitForUpload(client, initial) {
  if (initial.uploadState === "SUCCEEDED" || initial.uploadState === "SUCCESS") return initial;
  if (initial.uploadState !== "UPLOAD_IN_PROGRESS" && initial.uploadState !== "IN_PROGRESS") return initial;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await client.status();
    const state = current.lastAsyncUploadState;
    if (state === "SUCCEEDED" || state === "SUCCESS") return { ...initial, uploadState: state };
    if (state && state !== "UPLOAD_IN_PROGRESS" && state !== "IN_PROGRESS") return { ...initial, uploadState: state };
  }
  throw new Error("Chrome Web Store upload was still in progress after 60 seconds");
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function output(values) {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_OUTPUT, `${lines}\n`);
}

async function main() {
  const command = process.argv[2];
  if (!command || !["status", "upload-prerelease", "publish-stable"].includes(command)) {
    throw new Error("usage: cws.mjs <status | upload-prerelease | publish-stable>");
  }
  const credentials = JSON.parse(required("CWS_SERVICE_ACCOUNT_JSON"));
  const accessToken = await serviceAccountToken(credentials);
  const client = new ChromeWebStoreClient({
    publisherId: required("CWS_PUBLISHER_ID"),
    extensionId: required("CWS_EXTENSION_ID"),
    accessToken,
  });
  const status = await client.status();
  const version = command === "status" ? process.env.CWS_VERSION : required("CWS_VERSION");
  if (command === "status") {
    await output({
      published_version: revisionVersion(status.publishedItemRevisionStatus) ?? "none",
      submitted_version: revisionVersion(status.submittedItemRevisionStatus) ?? "none",
      submitted_state: status.submittedItemRevisionStatus?.state ?? "none",
    });
    return;
  }
  if (command === "upload-prerelease") {
    const action = prereleaseAction(status, version);
    if (action === "frozen") {
      await output({ action, candidate: "false" });
      return;
    }
    const packagePath = required("CWS_PACKAGE_PATH");
    const result = await waitForUpload(client, await client.upload(await readFile(packagePath), packagePath.split("/").at(-1)));
    if (result.uploadState !== "SUCCEEDED" && result.uploadState !== "SUCCESS") {
      throw new Error(`Chrome Web Store upload did not complete: ${result.uploadState}`);
    }
    if (result.crxVersion && result.crxVersion !== version) throw new Error(`Chrome Web Store accepted ${result.crxVersion}; expected ${version}`);
    const after = await client.status();
    if (after.submittedItemRevisionStatus) throw new Error("Draft upload unexpectedly created a submitted revision");
    await output({ action: "uploaded", candidate: "true" });
    return;
  }
  const action = stableAction(status, version);
  if (action === "publish") {
    const result = await client.publishStaged();
    if (result.state !== "PUBLISHED") throw new Error(`Chrome Web Store publish returned ${result.state}; expected PUBLISHED`);
  }
  await output({ action });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`cws: ${error.message}`);
    process.exitCode = 1;
  });
}
