import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isLocaleCode } from "./locales.mjs";

// A bundle is a directory holding what a store listing should say, laid out so
// that anything can produce it and this package can read it without being told
// what the product is:
//
//   <bundle>/bundle.json                    written by stampBundle, never by hand
//   <bundle>/<locale>/description.txt       the detailed description
//   <bundle>/<locale>/screenshots/NN-*.png  uploaded in filename order
//   <bundle>/global/screenshots/NN-*.png    the group shared by every language
//   <bundle>/global/promo/small.png         440x280
//   <bundle>/global/promo/marquee.png       1400x560
//
// The dashboard keeps promo tiles under "Global assets", one pair for the whole
// listing, so they live under global/ and nowhere else.
//
// A locale directory is named with the extension package's own code, such as
// pt_BR. bundle.json records, for each section a producer finished, where it
// came from and a hash of every file, so a consumer refuses files nobody stamped.

export const BUNDLE_MANIFEST = "bundle.json";
export const GLOBAL = "global";
export const PARTS = Object.freeze(["description", "screenshots", "promo"]);
export const MAX_SCREENSHOTS = 5;
export const DESCRIPTION_MAX_LENGTH = 16_000;
export const SCREENSHOT_SIZES = Object.freeze([
  Object.freeze({ width: 1280, height: 800 }),
  Object.freeze({ width: 640, height: 400 }),
]);
export const PROMO_TILES = Object.freeze({
  small: Object.freeze({ width: 440, height: 280 }),
  marquee: Object.freeze({ width: 1400, height: 560 }),
});

const SCHEMA = 1;
// Written by the sync itself, so a producer replacing its sections must not
// touch them and the layout check must not call them stray.
const OWN_FILES = new Set([BUNDLE_MANIFEST, "sync-state.json"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sectionId(scope, part) {
  return `${scope}/${part}`;
}

export function parseSectionId(id) {
  const [scope, part, ...rest] = id.split("/");
  if (rest.length > 0 || !part) throw new Error(`Section ${id} is not <scope>/<part>`);
  if (scope !== GLOBAL && !isLocaleCode(scope))
    throw new Error(`Section ${id}: ${scope} is not a locale code or "global"`);
  if (!PARTS.includes(part))
    throw new Error(`Section ${id}: part must be one of ${PARTS.join(", ")}`);
  if (scope === GLOBAL && part === "description") {
    throw new Error("The global group has screenshots and promo tiles, not a description");
  }
  if (scope !== GLOBAL && part === "promo") {
    throw new Error(
      `Section ${id}: promo tiles are shared by every language, so they belong in global/promo`,
    );
  }
  return { scope, part };
}

export function sectionPath(dir, scope, part) {
  return part === "description" ? join(dir, scope, "description.txt") : join(dir, scope, part);
}

async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function pngSize(bytes, path) {
  if (
    bytes.length < 24
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error(`${path} is not a PNG with an IHDR header`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function listDirectory(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

// What a section holds right now, validated: the files, and for a description its text.
async function collectSection(dir, scope, part) {
  const id = sectionId(scope, part);
  if (part === "description") {
    const path = sectionPath(dir, scope, part);
    let text;
    try {
      text = (await readFile(path, "utf8")).trim();
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`${id}: ${path} does not exist`);
      throw error;
    }
    if (!text) throw new Error(`${id}: the description is empty`);
    const length = [...text].length;
    if (length > DESCRIPTION_MAX_LENGTH) {
      throw new Error(
        `${id}: the description is ${length} characters; the limit is ${DESCRIPTION_MAX_LENGTH}`,
      );
    }
    return { text, files: [{ rel: `${scope}/description.txt`, abs: path }] };
  }

  const directory = sectionPath(dir, scope, part);
  const entries = await listDirectory(directory);
  if (!entries) throw new Error(`${id}: ${directory} does not exist`);
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const others = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (others.length > 0) throw new Error(`${id}: unexpected entries ${others.join(", ")}`);
  if (files.length === 0) throw new Error(`${id}: no files`);

  const checked = [];
  for (const name of files) {
    const abs = join(directory, name);
    const rel = `${scope}/${part}/${name}`;
    if (part === "screenshots") {
      if (!/\.png$/i.test(name)) throw new Error(`${id}: ${name} is not a .png file`);
      const size = pngSize(await readFile(abs), rel);
      if (
        !SCREENSHOT_SIZES.some(
          ({ width, height }) => width === size.width && height === size.height,
        )
      ) {
        const allowed = SCREENSHOT_SIZES.map(({ width, height }) => `${width}x${height}`).join(
          " or ",
        );
        throw new Error(`${rel} is ${size.width}x${size.height}; screenshots must be ${allowed}`);
      }
    } else {
      const tile = PROMO_TILES[name.replace(/\.png$/i, "")];
      if (!tile || !/\.png$/i.test(name)) {
        throw new Error(
          `${id}: ${name} is not one of ${Object.keys(PROMO_TILES)
            .map((key) => `${key}.png`)
            .join(", ")}`,
        );
      }
      const size = pngSize(await readFile(abs), rel);
      if (size.width !== tile.width || size.height !== tile.height) {
        throw new Error(
          `${rel} is ${size.width}x${size.height}; expected ${tile.width}x${tile.height}`,
        );
      }
    }
    checked.push({ rel, abs });
  }
  if (part === "screenshots" && checked.length > MAX_SCREENSHOTS) {
    throw new Error(
      `${id}: ${checked.length} screenshots; the store takes at most ${MAX_SCREENSHOTS}`,
    );
  }
  return { files: checked };
}

async function hashes(files) {
  const out = {};
  for (const { rel, abs } of files) out[rel] = await hashFile(abs);
  return out;
}

async function readManifest(dir) {
  let text;
  try {
    text = await readFile(join(dir, BUNDLE_MANIFEST), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const manifest = JSON.parse(text);
  if (manifest.schema !== SCHEMA) {
    throw new Error(
      `${BUNDLE_MANIFEST} has schema ${manifest.schema}; this version reads ${SCHEMA}`,
    );
  }
  return manifest;
}

// Records the sections a producer has just written: what they hold now, a hash
// of each file, and where they came from. Sections not named are left as they
// were, so a producer that regenerates some languages cannot erase the rest;
// `forget` drops the record of a section the producer removed.
export async function stampBundle({
  dir,
  name,
  extensionId,
  source,
  sections = [],
  forget = [],
  now = () => new Date(),
}) {
  if (!name) throw new Error("stampBundle needs a name");
  if (!source?.version) throw new Error("stampBundle needs source.version");
  const existing = await readManifest(dir);
  if (existing && existing.name !== name) {
    throw new Error(`${dir} holds the bundle for ${existing.name}, not ${name}`);
  }
  if (existing?.extensionId && extensionId && existing.extensionId !== extensionId) {
    throw new Error(`${dir} was stamped for extension ${existing.extensionId}, not ${extensionId}`);
  }
  const manifest = existing ?? { schema: SCHEMA, name, sections: {} };
  const resolvedId = extensionId ?? manifest.extensionId;
  if (resolvedId) manifest.extensionId = resolvedId;
  const generatedAt = now().toISOString();

  for (const id of forget) {
    parseSectionId(id);
    delete manifest.sections[id];
  }
  for (const id of sections) {
    const { scope, part } = parseSectionId(id);
    const { files } = await collectSection(dir, scope, part);
    manifest.sections[id] = {
      source: {
        version: source.version,
        commit: source.commit ?? null,
        dirty: Boolean(source.dirty),
        generatedAt,
      },
      files: await hashes(files),
    };
  }
  manifest.sections = Object.fromEntries(
    Object.entries(manifest.sections).sort(([a], [b]) => a.localeCompare(b)),
  );
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Every directory entry of the bundle that is not a stamped section.
async function strayEntries(dir, manifest) {
  const problems = [];
  const top = (await listDirectory(dir)) ?? [];
  for (const entry of top) {
    if (OWN_FILES.has(entry.name) || entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) {
      problems.push(`${entry.name}: stray file at the top of the bundle`);
      continue;
    }
    const scope = entry.name;
    if (scope !== GLOBAL && !isLocaleCode(scope)) {
      problems.push(`${scope}/: not a locale code or "global"`);
      continue;
    }
    for (const inner of (await listDirectory(join(dir, scope))) ?? []) {
      const part = inner.name === "description.txt" ? "description" : inner.name;
      const known =
        PARTS.includes(part)
        && !(scope === GLOBAL && part === "description")
        && !(scope !== GLOBAL && part === "promo");
      if (!known) {
        problems.push(`${scope}/${inner.name}: not part of the layout`);
        continue;
      }
      if (!manifest.sections[sectionId(scope, part)]) {
        problems.push(`${sectionId(scope, part)}: present but never stamped`);
      }
    }
  }
  return problems;
}

// Reads the bundle for a consumer, refusing it unless every file is exactly
// what was stamped. That is what makes the stamp one source of truth: files a
// producer hand-edited or forgot to stamp are never uploaded.
export async function readBundle(dir) {
  const manifest = await readManifest(dir);
  if (!manifest) {
    throw new Error(
      `No ${BUNDLE_MANIFEST} in ${dir}. Generate the bundle, or stamp what a producer wrote with store-sync stamp.`,
    );
  }

  const problems = await strayEntries(dir, manifest);
  const scopes = new Map();
  const scopeFor = (scope) => {
    if (!scopes.has(scope)) scopes.set(scope, { scope, sources: {} });
    return scopes.get(scope);
  };

  for (const [id, recorded] of Object.entries(manifest.sections)) {
    const { scope, part } = parseSectionId(id);
    let current;
    try {
      current = await collectSection(dir, scope, part);
    } catch (error) {
      problems.push(`${id}: ${error.message}`);
      continue;
    }
    const now = await hashes(current.files);
    for (const rel of Object.keys(recorded.files)) {
      if (!(rel in now)) problems.push(`${rel}: stamped but missing`);
      else if (now[rel] !== recorded.files[rel])
        problems.push(`${rel}: changed since it was stamped`);
    }
    for (const rel of Object.keys(now)) {
      if (!(rel in recorded.files)) problems.push(`${rel}: not in the stamp`);
    }
    const holder = scopeFor(scope);
    holder.sources[part] = recorded.source;
    if (part === "description")
      holder.description = { path: current.files[0].abs, text: current.text };
    else if (part === "screenshots") {
      holder.screenshots = current.files.map(({ rel, abs }) => ({
        rel,
        path: abs,
        name: basename(abs),
      }));
    } else {
      holder.promo = Object.fromEntries(
        current.files.map(({ rel, abs }) => [basename(abs, ".png"), { rel, path: abs }]),
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `The bundle in ${dir} does not match its stamp:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }

  return {
    dir,
    name: manifest.name,
    extensionId: manifest.extensionId,
    sections: manifest.sections,
    locales: [...scopes.keys()].filter((scope) => scope !== GLOBAL).sort(),
    scope: (code) => scopes.get(code),
    global: scopes.get(GLOBAL),
  };
}
