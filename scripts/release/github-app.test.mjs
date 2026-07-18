import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createAppJwt, createRepositoryToken } from "./github-app.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });

function decode(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

test("creates a short-lived GitHub App JWT", () => {
  const token = createAppJwt({ appId: "12345", privateKey: pem, now: 1_700_000_000 });
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(payload), {
    iat: 1_699_999_940,
    exp: 1_700_000_540,
    iss: "12345",
  });
  assert.ok(signature.length > 100);
});

test("creates a repository-scoped contents-write installation token", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/repos/jamezrin/lurkloot/installation")) {
      return { ok: true, status: 200, json: async () => ({ id: 77 }), text: async () => JSON.stringify({ id: 77 }) };
    }
    return {
      ok: true,
      status: 201,
      json: async () => ({ token: "ghs_short", expires_at: "2026-07-18T20:00:00Z" }),
      text: async () => JSON.stringify({ token: "ghs_short", expires_at: "2026-07-18T20:00:00Z" }),
    };
  };
  const result = await createRepositoryToken({
    appId: "12345",
    privateKey: pem,
    repository: "jamezrin/lurkloot",
    fetchImpl,
    now: 1_700_000_000,
  });
  assert.equal(result.token, "ghs_short");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    repositories: ["lurkloot"],
    permissions: { contents: "write" },
  });
  assert.match(calls[0].init.headers.authorization, /^Bearer /);
});

test("rejects missing or invalid App configuration", async () => {
  assert.throws(() => createAppJwt({ appId: "", privateKey: pem }), /App ID/);
  assert.throws(() => createAppJwt({ appId: "0", privateKey: pem }), /positive integer/);
  await assert.rejects(
    createRepositoryToken({ appId: "12345", privateKey: "", repository: "jamezrin/lurkloot" }),
    /private key/,
  );
});
