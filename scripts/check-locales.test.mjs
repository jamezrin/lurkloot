import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-locales.mjs", import.meta.url));

async function fixture(t, catalogs) {
  const directory = await mkdtemp(join(tmpdir(), "lurkloot-locales-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [locale, catalog] of Object.entries(catalogs)) {
    await writeFile(join(directory, `${locale}.json`), JSON.stringify(catalog));
  }
  return directory;
}

function run(directory) {
  return spawnSync(process.execPath, [checker, directory], { encoding: "utf8" });
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
