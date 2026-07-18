import { createSign } from "node:crypto";

const apiOrigin = "https://api.github.com";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  if (!/^\d+$/.test(String(appId ?? ""))) throw new Error("GitHub App ID must be a positive integer");
  if (!String(privateKey ?? "").includes("PRIVATE KEY")) throw new Error("GitHub App private key is required");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: String(appId),
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

async function request(fetchImpl, path, token, init = {}) {
  const response = await fetchImpl(`${apiOrigin}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2026-03-10",
      ...init.headers,
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!response.ok) throw new Error(`GitHub App API failed (${response.status}): ${body?.message ?? body ?? "unknown error"}`);
  return body;
}

export async function createRepositoryToken({
  appId,
  privateKey,
  repository,
  fetchImpl = fetch,
  now,
}) {
  const match = /^([^/]+)\/([^/]+)$/.exec(repository ?? "");
  if (!match) throw new Error("repository must be owner/name");
  const jwt = createAppJwt({ appId, privateKey, now });
  const installation = await request(fetchImpl, `/repos/${repository}/installation`, jwt);
  const token = await request(fetchImpl, `/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({
      repositories: [match[2]],
      permissions: { contents: "write" },
    }),
  });
  if (!token?.token) throw new Error("GitHub App installation token response had no token");
  return token;
}
