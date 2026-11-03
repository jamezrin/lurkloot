// Firefox Add-ons (addons.mozilla.org) publication through its v5 API, using only Node built-ins
// so the release job needs no install. Mirrors scripts/cws.mjs: pure decision functions that the
// tests pin, and a thin client whose fetch is injectable.
//
// https://mozilla.github.io/addons-server/topics/api/addons.html

import { createHmac, randomUUID } from "node:crypto";

export const apiOrigin = "https://addons.mozilla.org";

// AMO refuses a token that lives longer than five minutes, and upload validation can take longer
// than that, so every request mints its own short-lived token.
const tokenLifetimeSeconds = 60;

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function addonsToken({ issuer, secret, now = Date.now(), nonce = randomUUID() }) {
  const iat = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: issuer,
    jti: nonce,
    iat,
    exp: iat + tokenLifetimeSeconds,
  })}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export class AddonsApiError extends Error {
  constructor(status, body) {
    super(formatApiError(status, body));
    this.status = status;
  }
}

export function formatApiError(status, body) {
  if (body && typeof body === "object") {
    const detail = body.detail ?? body.error;
    if (typeof detail === "string") return `Firefox Add-ons API failed (${status}): ${detail}`;
    return `Firefox Add-ons API failed (${status}): ${JSON.stringify(body)}`;
  }
  return `Firefox Add-ons API failed (${status})${body ? `: ${body}` : ""}`;
}

// A version number is unique across every channel of an add-on, so a number taken by an unlisted
// upload can never be published on the listing.
export function versionAction(existing) {
  if (!existing) return "upload";
  if (existing.channel !== "listed") {
    throw new Error(
      `version ${existing.version} already exists on the ${existing.channel} channel and cannot be listed`,
    );
  }
  return "already-submitted";
}

export function validationErrors(validation) {
  const messages = Array.isArray(validation?.messages) ? validation.messages : [];
  return messages
    .filter((message) => message.type === "error")
    .map((message) => {
      const where = message.file
        ? ` (${message.file}${message.line ? `:${message.line}` : ""})`
        : "";
      return `${message.message}${where}`;
    });
}

export function uploadState(upload) {
  if (!upload.processed) return "processing";
  if (upload.valid) return "valid";
  const errors = validationErrors(upload.validation);
  throw new Error(
    `Firefox Add-ons rejected the upload${errors.length ? `: ${errors.join("; ")}` : ""}`,
  );
}

// The changelog notes are Markdown with `## Heading` sections; AMO shows release notes as plain
// text, so keep the headings as plain lines.
export function plainReleaseNotes(markdown) {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^#+\s+/, ""))
    .join("\n")
    .trim();
}

export class AddonsClient {
  constructor({ issuer, secret, addonId, fetchImpl = fetch, origin = apiOrigin, now }) {
    this.issuer = issuer;
    this.secret = secret;
    this.addon = encodeURIComponent(addonId);
    this.fetch = fetchImpl;
    this.origin = origin;
    this.now = now;
  }

  async request(path, init = {}) {
    const token = addonsToken({
      issuer: this.issuer,
      secret: this.secret,
      ...(this.now ? { now: this.now() } : {}),
    });
    const response = await this.fetch(`${this.origin}${path}`, {
      ...init,
      headers: { authorization: `JWT ${token}`, ...init.headers },
    });
    const text = await response.text();
    let body;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (response.ok) throw new Error("Firefox Add-ons API returned invalid JSON");
        body = text;
      }
    }
    if (!response.ok) throw new AddonsApiError(response.status, body);
    return body;
  }

  async listing() {
    try {
      return await this.request(`/api/v5/addons/addon/${this.addon}/`);
    } catch (error) {
      if (error instanceof AddonsApiError && [401, 403, 404].includes(error.status)) {
        throw new Error(
          `Firefox Add-ons has no listing this API key can publish to (${error.status}). Submit the first version by hand (docs/store-readiness.md, "First submission") and check the key belongs to an author of it`,
        );
      }
      throw error;
    }
  }

  async version(version) {
    try {
      return await this.request(`/api/v5/addons/addon/${this.addon}/versions/v${version}/`);
    } catch (error) {
      if (error instanceof AddonsApiError && error.status === 404) return null;
      throw error;
    }
  }

  upload(packageBytes, filename) {
    const form = new FormData();
    form.append("upload", new Blob([packageBytes], { type: "application/zip" }), filename);
    form.append("channel", "listed");
    return this.request("/api/v5/addons/upload/", { method: "POST", body: form });
  }

  uploadDetail(uuid) {
    return this.request(`/api/v5/addons/upload/${uuid}/`);
  }

  // The source archive goes in the same request that creates the version, so a listed version
  // never exists without the source its reviewers need.
  createVersion({ uploadUuid, sourceBytes, sourceName }) {
    const form = new FormData();
    form.append("upload", uploadUuid);
    form.append("source", new Blob([sourceBytes], { type: "application/zip" }), sourceName);
    return this.request(`/api/v5/addons/addon/${this.addon}/versions/`, {
      method: "POST",
      body: form,
    });
  }

  updateVersion(id, fields) {
    return this.request(`/api/v5/addons/addon/${this.addon}/versions/${id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  }
}

export async function waitForValidation(
  client,
  upload,
  {
    attempts = 60,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  let current = upload;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (uploadState(current) === "valid") return current;
    await delay(5000);
    current = await client.uploadDetail(upload.uuid);
  }
  if (uploadState(current) === "valid") return current;
  throw new Error("Firefox Add-ons was still validating the upload after five minutes");
}

// Uploads `version` to the listing with its source archive, the notes for reviewers and the
// release notes, desktop Firefox only. Safe to rerun: a version that exists is left alone.
export async function publishVersion({
  client,
  version,
  packageBytes,
  packageName,
  sourceBytes,
  sourceName,
  approvalNotes,
  releaseNotes,
  delay,
}) {
  // Setting these is idempotent, so a rerun after a failure between creating the version and
  // describing it finishes the job instead of leaving the version without notes.
  const details = {
    approval_notes: approvalNotes,
    release_notes: { "en-US": releaseNotes },
    compatibility: ["firefox"],
  };
  await client.listing();
  const existing = await client.version(version);
  if (versionAction(existing) === "already-submitted") {
    await client.updateVersion(existing.id, details);
    return { action: "already-submitted", status: existing.file?.status ?? "unknown" };
  }
  const upload = await waitForValidation(client, await client.upload(packageBytes, packageName), {
    ...(delay ? { delay } : {}),
  });
  if (upload.version && upload.version !== version) {
    throw new Error(
      `Firefox Add-ons read version ${upload.version} from the package; expected ${version}`,
    );
  }
  const created = await client.createVersion({ uploadUuid: upload.uuid, sourceBytes, sourceName });
  await client.updateVersion(created.id, details);
  return { action: "submitted", status: created.file?.status ?? "unknown" };
}
