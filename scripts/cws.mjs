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

export function uploadAction(status, version) {
  assertHealthy(status);
  const publishedVersion = revisionVersion(status.publishedItemRevisionStatus);
  const submitted = status.submittedItemRevisionStatus;
  const submittedVersion = revisionVersion(submitted);
  if (!submitted) {
    if (publishedVersion === version) throw new Error(`${version} is already published and cannot be replaced as a pre-release draft`);
    return "upload";
  }
  if (submitted.state === "CANCELLED") return "upload";
  if (submittedVersion !== version) {
    throw new Error(`Chrome Web Store has ${submittedVersion ?? "an unknown version"} in state ${submitted.state}; expected ${version}`);
  }
  if (submitted.state === "PENDING_REVIEW" || submitted.state === "STAGED") return "frozen";
  throw new Error(`Chrome Web Store submitted revision is ${submitted.state}; resolve it in the Developer Dashboard`);
}

export function publishAction(status, version) {
  assertHealthy(status);
  if (revisionVersion(status.publishedItemRevisionStatus) === version) return "already-published";
  const submitted = status.submittedItemRevisionStatus;
  if (submitted && revisionVersion(submitted) === version
    && ["PENDING_REVIEW", "IN_REVIEW"].includes(submitted.state)) return "in-review";
  return "upload";
}

export const prereleaseAction = uploadAction;

export function normalizeStatus(status) {
  return {
    publishedVersion: revisionVersion(status.publishedItemRevisionStatus),
    submittedVersion: revisionVersion(status.submittedItemRevisionStatus),
    submittedState: status.submittedItemRevisionStatus?.state,
    warned: Boolean(status.warned),
    takenDown: Boolean(status.takenDown),
  };
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

export function submitAction(status, version) {
  assertHealthy(status);
  if (revisionVersion(status.publishedItemRevisionStatus) === version) {
    throw new Error(`${version} is already published`);
  }
  const submitted = status.submittedItemRevisionStatus;
  if (!submitted) return "submit";
  const submittedVersion = revisionVersion(submitted);
  if (submittedVersion !== version) {
    throw new Error(`Chrome Web Store has ${submittedVersion ?? "an unknown version"} in state ${submitted.state}; expected ${version}`);
  }
  if (submitted.state === "PENDING_REVIEW") return "already-submitted";
  if (submitted.state === "STAGED") return "already-staged";
  throw new Error(`Chrome Web Store revision ${version} is ${submitted.state}; resolve it before submission`);
}

export function submittedAction(action) {
  return action === "submit" ? "submitted" : action;
}

export function cancelAction(status, version) {
  assertHealthy(status);
  const submitted = status.submittedItemRevisionStatus;
  if (!submitted) return "already-cancelled";
  const submittedVersion = revisionVersion(submitted);
  if (submittedVersion !== version) {
    throw new Error(`Chrome Web Store has ${submittedVersion ?? "an unknown version"} in state ${submitted.state}; expected ${version}`);
  }
  if (submitted.state === "PENDING_REVIEW" || submitted.state === "STAGED") return "cancel";
  if (submitted.state === "CANCELLED") return "already-cancelled";
  throw new Error(`Chrome Web Store revision ${version} is ${submitted.state}; resolve it before cancellation`);
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
    const text = typeof response.text === "function" ? await response.text() : undefined;
    let body;
    if (text === undefined) {
      body = await response.json();
    } else if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (response.ok) throw new Error("Chrome Web Store API returned invalid JSON");
        body = { error: { message: text } };
      }
    }
    if (!response.ok) throw new Error(`Chrome Web Store API failed (${response.status}): ${body?.error?.message ?? "unknown error"}`);
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

  // DEFAULT_PUBLISH makes Google publish the item as soon as review passes, so no polling, no
  // deferred-publish gate and no second workflow are required. The v2 PublishType enum accepts only
  // PUBLISH_TYPE_UNSPECIFIED, DEFAULT_PUBLISH and STAGED_PUBLISH — STAGED_PUBLISH is the one that
  // holds the item for a manual release, which is exactly what this pipeline does not want.
  publish() {
    return this.request(`/v2/${this.item}:publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", blockOnWarnings: true }),
    });
  }

  cancelSubmission() {
    return this.request(`/v2/${this.item}:cancelSubmission`, {
      method: "POST",
    });
  }
}

export async function waitForUpload(client, initial) {
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

export async function waitForCancellation(client, version, { attempts = 30, delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await client.status();
    const submitted = status.submittedItemRevisionStatus;
    if (!submitted) return "cancelled";
    const submittedVersion = revisionVersion(submitted);
    if (submittedVersion !== version) throw new Error(`Chrome Web Store switched to ${submittedVersion ?? "an unknown version"} while cancelling ${version}`);
    if (submitted.state === "CANCELLED") return "cancelled";
    await delay(2000);
  }
  throw new Error(`Chrome Web Store did not cancel ${version} within 60 seconds`);
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
  if (!command || !["status", "upload-candidate", "submit-staged", "cancel-submission", "publish-stable"].includes(command)) {
    throw new Error("usage: cws.mjs <status | upload-candidate | submit-staged | cancel-submission | publish-stable>");
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
      warned: String(Boolean(status.warned)),
      taken_down: String(Boolean(status.takenDown)),
    });
    return;
  }
  if (command === "upload-candidate") {
    const action = uploadAction(status, version);
    if (action === "frozen") {
      throw new Error(`Chrome Web Store revision ${version} became ${status.submittedItemRevisionStatus.state} before upload. Cancel review before replacing the candidate`);
    }
    const packagePath = required("CWS_PACKAGE_PATH");
    const result = await waitForUpload(client, await client.upload(await readFile(packagePath), packagePath.split("/").at(-1)));
    if (result.uploadState !== "SUCCEEDED" && result.uploadState !== "SUCCESS") {
      throw new Error(`Chrome Web Store upload did not complete: ${result.uploadState}`);
    }
    if (result.crxVersion && result.crxVersion !== version) throw new Error(`Chrome Web Store accepted ${result.crxVersion}; expected ${version}`);
    const after = await client.status();
    if (after.submittedItemRevisionStatus && after.submittedItemRevisionStatus.state !== "CANCELLED") {
      throw new Error(`Draft upload unexpectedly found submitted state ${after.submittedItemRevisionStatus.state}`);
    }
    await output({ action: "uploaded", candidate: "true" });
    return;
  }
  if (command === "submit-staged") {
    const action = submitAction(status, version);
    if (action === "submit") {
      const result = await client.publish();
      if (result.state !== "PENDING_REVIEW" && result.state !== "STAGED") {
        throw new Error(`Chrome Web Store submission returned ${result.state}; expected PENDING_REVIEW or STAGED`);
      }
    }
    await output({ action: submittedAction(action) });
    return;
  }
  if (command === "cancel-submission") {
    const action = cancelAction(status, version);
    if (action === "cancel") {
      try {
        await client.cancelSubmission();
      } catch (error) {
        throw new Error(`Chrome Web Store could not cancel ${version} from ${status.submittedItemRevisionStatus.state}. Use the Developer Dashboard to resolve it before replacing or abandoning this candidate: ${error.message}`);
      }
      await waitForCancellation(client, version);
    }
    await output({ action });
    return;
  }
  const action = stableAction(status, version);
  if (action === "publish") {
    const result = await client.publish();
    if (result.state !== "PUBLISHED" && result.state !== "PENDING_REVIEW" && result.state !== "STAGED") {
      throw new Error(`Chrome Web Store publish returned ${result.state}; expected PUBLISHED, PENDING_REVIEW or STAGED`);
    }
  }
  await output({ action });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`cws: ${error.message}`);
    process.exitCode = 1;
  });
}
