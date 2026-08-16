import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SCOUT_MODEL, ScoutTranslator, translationSystemPrompt } from "../src/i18n/translator.ts";
import { translateAll } from "../src/i18n/translateAll.ts";
import { resolveLeaves } from "../src/i18n/resolve.ts";
import { hashEnglish } from "../src/i18n/hash.ts";

test("prompt keeps brand names and farm loanword rules", () => {
  const prompt = translationSystemPrompt("es");
  assert.match(prompt, /Spanish|es/);
  assert.match(prompt, /Lurkloot/);
  assert.match(prompt, /Twitch/);
  assert.match(prompt, /Kick/);
  assert.match(prompt, /farm/);
  assert.match(prompt, /grad-text/);
});

test("ScoutTranslator posts one batched chat request with a high max_tokens", async () => {
  /** @type {unknown} */
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(String(init.body));
    assert.match(String(url), /llama-4-scout-17b-16e-instruct/);
    assert.equal(init.headers.Authorization, "Bearer test-token");
    return new Response(JSON.stringify({
      success: true,
      result: { response: JSON.stringify([{ id: "aa", text: "Hola" }]) },
    }), { status: 200 });
  };
  const translator = new ScoutTranslator({
    accountId: "acct",
    apiToken: "test-token",
    fetchImpl,
  });
  const out = await translator.translate({ locale: "es", items: [{ id: "aa", text: "Hello" }] });
  assert.deepEqual(out, [{ id: "aa", text: "Hola" }]);
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.messages[0].role, "system");
  assert.equal(SCOUT_MODEL, "@cf/meta/llama-4-scout-17b-16e-instruct");
});

test("translateAll writes only cache misses and resolveLeaves falls back to English", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lurkloot-i18n-"));
  try {
    const helloId = hashEnglish("Hello");
    const calls = [];
    await translateAll({
      cacheDir: dir,
      english: ["Hello", "World"],
      locales: ["es"],
      translator: {
        async translate(input) {
          calls.push(input.items.map((item) => item.text));
          return input.items.map((item) => ({ id: item.id, text: `${item.text} ES` }));
        },
      },
    });
    assert.deepEqual(calls, [["Hello", "World"]]);
    const resolved = await resolveLeaves({ cacheDir: dir, locale: "es", english: ["Hello", "World"] });
    assert.deepEqual(resolved, ["Hello ES", "World ES"]);
    calls.length = 0;
    await translateAll({
      cacheDir: dir,
      english: ["Hello", "World"],
      locales: ["es"],
      translator: {
        async translate(input) {
          calls.push(input.items.map((item) => item.text));
          return input.items;
        },
      },
    });
    assert.deepEqual(calls, []);
    const mixed = await resolveLeaves({
      cacheDir: dir,
      locale: "es",
      english: ["Hello", "New line"],
    });
    assert.deepEqual(mixed, ["Hello ES", "New line"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
