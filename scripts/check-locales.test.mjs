import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-locales.mjs", import.meta.url));

// A messages directory and a sources directory. By default the sources name
// every key in the English catalog, so only the test that is about references
// has to think about them.
async function fixture(t, catalogs, sources) {
  const root = await mkdtemp(join(tmpdir(), "lurkloot-locales-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const messages = join(root, "messages");
  const source = join(root, "src");
  await mkdir(messages);
  await mkdir(source);
  for (const [locale, catalog] of Object.entries(catalogs)) {
    await writeFile(join(messages, `${locale}.json`), JSON.stringify(catalog));
  }
  const files = sources ?? {
    "ui.ts": Object.keys(catalogs.en ?? {})
      .map((key) => `t("${key}");`)
      .join("\n"),
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), text);
  }
  return { messages, source };
}

function run({ messages, source }) {
  return spawnSync(process.execPath, [checker, messages, source], { encoding: "utf8" });
}

test("accepts catalogs with the same translation keys", async (t) => {
  const directory = await fixture(t, {
    en: { greeting: { message: "Hello" }, goodbye: { message: "Goodbye" } },
    es: { goodbye: { message: "Adiós" }, greeting: { message: "Hola" } },
  });
  const result = run(directory);
  assert.equal(result.status, 0, result.stderr);
});

test("reports missing and extra keys in each locale", async (t) => {
  const directory = await fixture(t, {
    en: { greeting: { message: "Hello" }, goodbye: { message: "Goodbye" } },
    es: { greeting: { message: "Hola" }, surplus: { message: "Extra" } },
    fr: { goodbye: { message: "Au revoir" } },
  });
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /es\.json: missing keys: goodbye/);
  assert.match(result.stderr, /es\.json: extra keys: surplus/);
  assert.match(result.stderr, /fr\.json: missing keys: greeting/);
});

test("fails when the English source catalog is absent", async (t) => {
  const directory = await fixture(t, { es: { greeting: { message: "Hola" } } });
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /en\.json/);
});

test("reports English keys that no source file references", async (t) => {
  const directory = await fixture(
    t,
    {
      en: { greeting: { message: "Hello" }, unused: { message: "Unused" } },
      es: { greeting: { message: "Hola" }, unused: { message: "Sin uso" } },
    },
    { "ui.ts": 't("greeting");' },
  );
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /keys no source references: unused$/m);
});

test("counts manifest placeholders as references", async (t) => {
  const directory = await fixture(
    t,
    { en: { storeName: { message: "Store" } } },
    {
      "wxt.config.ts": 'export default { name: "__MSG_storeName__" };',
    },
  );
  assert.equal(run(directory).status, 0);
});

test("ignores references from tests and build output", async (t) => {
  const directory = await fixture(
    t,
    { en: { stale: { message: "Stale" } } },
    {
      "tests/view.test.ts": 't("stale");',
      "view.test.tsx": 't("stale");',
      "dist/bundle.js": 't("stale");',
      "node_modules/pkg/index.js": 't("stale");',
    },
  );
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /keys no source references: stale$/m);
});

test("does not count a key that only appears inside a longer name", async (t) => {
  const directory = await fixture(
    t,
    { en: { close: { message: "Close" } } },
    {
      "ui.ts": "closeActivityView();",
    },
  );
  assert.equal(run(directory).status, 1);
});
