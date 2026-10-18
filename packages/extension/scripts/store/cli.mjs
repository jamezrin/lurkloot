import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as storeSync } from "@lurkloot/store-sync/cli";
import { DEFAULT_LOCALE, LOCALES, NAME, PATHS, validateLocales } from "./lurkloot.mjs";
import { descriptionSource, generateDescriptions } from "./generate/descriptions.mjs";
import { generatePromo } from "./generate/promo.mjs";
import { generateScreenshots } from "./generate/screenshots.mjs";

// The Lurkloot entry point. `generate` makes the bundle from this repository;
// everything else is @lurkloot/store-sync, given this repository's bundle, the
// command to rerun and the version the checkout is at. Wrapping it adds options
// and nothing else.
export const GENERATORS = Object.freeze(["screenshots", "promo", "descriptions"]);

function parseGenerate(args) {
  const [first, ...others] = args;
  const only = GENERATORS.includes(first) ? first : undefined;
  const rest = only ? others : args;
  let locales;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--") continue;
    if (argument !== "--locales") {
      throw new Error(
        `${argument.startsWith("--") ? "Unknown option" : "Unexpected argument"} ${argument}`,
      );
    }
    if (locales) throw new Error("Duplicate option --locales");
    locales = [];
    while (index + 1 < rest.length && !rest[index + 1].startsWith("--")) {
      locales.push(rest[(index += 1)]);
    }
    if (locales.length === 0) throw new Error("--locales requires at least one locale code");
  }
  return { only, locales: locales ? validateLocales(locales) : [...LOCALES] };
}

export async function generate(args, env = process.env, dependencies = {}) {
  const { only, locales } = parseGenerate(args);
  const output = dependencies.output ?? console.log;
  const paths = dependencies.paths ?? PATHS;
  const run = {
    screenshots: dependencies.generateScreenshots ?? generateScreenshots,
    promo: dependencies.generatePromo ?? generatePromo,
    descriptions: dependencies.generateDescriptions ?? generateDescriptions,
  };
  const steps = only ? [only] : [...GENERATORS];
  // The promo tiles are the default language's, so naming other languages alone
  // leaves nothing for them to do.
  if (only === "promo" && !locales.includes(DEFAULT_LOCALE)) {
    throw new Error(
      `Promo tiles are shared by every language and made from ${DEFAULT_LOCALE}; include it in --locales`,
    );
  }
  for (const step of steps) {
    if (step === "promo" && !locales.includes(DEFAULT_LOCALE)) continue;
    await run[step]({ locales, paths, output, env });
  }
}

// A description in the bundle that no longer matches the file it was copied from
// would upload text nobody just wrote.
export function descriptionsAreFresh(paths = PATHS) {
  return async ({ bundle, locales, parts }) => {
    if (!parts.descriptions) return;
    const stale = [];
    for (const locale of locales) {
      const copy = bundle.scope(locale)?.description;
      if (!copy) continue;
      const source = (await readFile(descriptionSource(paths, locale), "utf8")).trim();
      if (source !== copy.text) stale.push(locale);
    }
    if (stale.length > 0) {
      throw new Error(
        `store-descriptions/ differs from the bundle for ${stale.join(", ")}. Run pnpm store:generate:descriptions first.`,
      );
    }
  };
}

export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  const rest = args[0] === "--" ? args.slice(1) : args;
  const [command, ...others] = rest;
  if (command === "generate") return generate(others, env, dependencies);
  const paths = dependencies.paths ?? PATHS;
  const { version } = JSON.parse(await readFile(join(paths.packageRoot, "package.json"), "utf8"));
  return storeSync(rest, env, {
    bundleDir: paths.bundle,
    // The signed-in Chrome profile every dashboard command shares, whether or not
    // it has a bundle to take the name from.
    profileApp: NAME,
    invocation: "pnpm store:sync",
    expectedVersion: version,
    checks: [descriptionsAreFresh(paths)],
    ...dependencies.sync,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`store: ${error.message}`);
    process.exitCode = 1;
  });
}
