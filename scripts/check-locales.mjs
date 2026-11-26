import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Usage: check-locales.mjs [messages directory] [sources directory]
// The sources directory defaults to the repository's packages/. Every key in
// en.json must appear by name in a source file there, so unused copy cannot
// build up in every catalog. Keys are looked up by literal name only: a key
// built at runtime would be reported, so pass the whole key as a literal.
const directory = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../packages/locales/messages/", import.meta.url)),
);
const sourcesRoot = resolve(
  process.argv[3] ?? fileURLToPath(new URL("../packages/", import.meta.url)),
);

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|astro|html|mdx)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".output", ".wxt", ".astro", "tests"]);

async function readCatalog(filename) {
  const catalog = JSON.parse(await readFile(join(directory, filename), "utf8"));
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`${filename} must contain a JSON object`);
  }
  return Object.keys(catalog);
}

// Tracked files when the sources are in a git checkout, so build outputs that
// bundle the catalogs never count as references; a plain walk otherwise.
async function listSources(root) {
  let files;
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map((file) => join(root, file));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(join(dir, entry.name));
        } else files.push(join(dir, entry.name));
      }
    };
    await walk(root);
  }
  return files.filter((file) => {
    const parts = relative(root, file).split(sep);
    return (
      SOURCE_EXTENSIONS.test(file)
      && !file.startsWith(directory + sep)
      && !parts.some((part) => SKIPPED_DIRECTORIES.has(part))
      && !/\.test\.[^.]+$/.test(file)
    );
  });
}

async function referencedNames(root) {
  const names = new Set();
  for (const file of await listSources(root)) {
    for (const name of (await readFile(file, "utf8")).match(/[A-Za-z0-9]+/g) ?? []) {
      names.add(name);
    }
  }
  return names;
}

try {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  if (!files.includes("en.json")) throw new Error("en.json is missing");

  const referenceKeys = new Set(await readCatalog("en.json"));
  let errors = 0;

  for (const file of files) {
    if (file === "en.json") continue;
    const keys = new Set(await readCatalog(file));
    const missing = [...referenceKeys].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !referenceKeys.has(key));
    if (missing.length) {
      console.error(`${file}: missing keys: ${missing.join(", ")}`);
      errors += 1;
    }
    if (extra.length) {
      console.error(`${file}: extra keys: ${extra.join(", ")}`);
      errors += 1;
    }
  }

  const names = await referencedNames(sourcesRoot);
  const unreferenced = [...referenceKeys].filter((key) => !names.has(key));
  if (unreferenced.length) {
    console.error(`en.json: keys no source references: ${unreferenced.join(", ")}`);
    errors += 1;
  }

  if (errors) process.exitCode = 1;
  else console.log(`Locale keys match en.json in ${files.length} catalogs, all referenced.`);
} catch (error) {
  console.error(`Locale key check failed: ${error.message}`);
  process.exitCode = 1;
}
