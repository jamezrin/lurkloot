#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parseArguments } from "./args.mjs";
import { readBundle, stampBundle } from "./bundle.mjs";
import { abandonBrowserSession, finishBrowserSession, startBrowserSession } from "./browser.mjs";
import { ChromeWebStoreDashboard } from "./dashboard.mjs";
import { checkArtworkSources } from "./provenance.mjs";
import { localesWithContent, resolveScope } from "./scope.mjs";
import { createContext, syncStoreListing } from "./sync.mjs";
import { hashFiles, readSyncState, recordSync } from "./syncState.mjs";
import { describeVerification, verifyStoreListing } from "./verify.mjs";

export const COMMANDS = Object.freeze(["validate", "sync", "verify", "snapshot", "stamp"]);

const OPTIONS = {
  flags: [
    "--no-verify",
    "--force",
    "--global",
    "--dirty",
    "--allow-version-mismatch",
    "--allow-dirty",
  ],
  values: [
    "--bundle",
    "--only",
    "--expect-version",
    "--out",
    "--name",
    "--extension-id",
    "--version",
    "--commit",
  ],
  lists: ["--locales", "--sections", "--forget"],
};

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateExtensionId(value) {
  required(value, "CWS_EXTENSION_ID");
  if (!/^[a-p]{32}$/.test(value)) {
    throw new Error("CWS_EXTENSION_ID must be a 32-character Chrome extension ID");
  }
}

function validatePublisherId(value) {
  required(value, "CWS_PUBLISHER_ID");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("CWS_PUBLISHER_ID must be the UUID from the Developer Dashboard URL");
  }
}

function plural(count, noun) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function connectOverCdp(url) {
  return chromium.connectOverCDP(url);
}

function defaultCreateDashboard({ page, env, output }) {
  return new ChromeWebStoreDashboard({
    page,
    extensionId: env.CWS_EXTENSION_ID,
    publisherId: env.CWS_PUBLISHER_ID,
    output,
  });
}

// Opens the signed-in dashboard, runs the work, and leaves the browser the way
// the outcome calls for.
async function withDashboard({ env, bundle, dependencies, output }, work) {
  validatePublisherId(env.CWS_PUBLISHER_ID);
  const openBrowser = dependencies.openBrowser ?? startBrowserSession;
  const createDashboard = dependencies.createDashboard ?? defaultCreateDashboard;
  const session = await openBrowser({
    env,
    // The signed-in Chrome profile is named for what is being synced, so one
    // bundle keeps one session between runs.
    profileApp: bundle?.name ?? dependencies.profileApp ?? "store-sync",
    output,
    connect: dependencies.connect ?? connectOverCdp,
  });
  let dashboard;
  try {
    // The signed-in session lives in the browser's existing context; a new one
    // would carry no cookies and land on a signed-out dashboard.
    const page = await session.context.newPage();
    dashboard = createDashboard({ page, env, output });
    await dashboard.openAndWaitForAuthentication();
    const result = await work(dashboard);
    // The operator's own Chrome keeps running, so the tab opened for this run
    // must not be left behind in it.
    if (!session.ownsBrowser) await page.close().catch(() => {});
    await (dependencies.finishBrowser ?? finishBrowserSession)(session, { output });
    return result;
  } catch (error) {
    // Any failure keeps the browser: the operator may have signed in already,
    // including while the step that failed was still waiting, and rebuilding
    // that session costs another sign-in and 2FA.
    await (dependencies.abandonBrowser ?? abandonBrowserSession)(session, output, {
      mutated: Boolean(dashboard?.hasMutated),
    });
    throw error;
  }
}

async function loadBundle({ parsed, env, dependencies }) {
  const dir = resolve(parsed.values["--bundle"] ?? dependencies.bundleDir ?? "store-bundle");
  const bundle = await (dependencies.readBundle ?? readBundle)(dir);
  // A bundle made for another item must never be uploaded to this one.
  if (bundle.extensionId && env.CWS_EXTENSION_ID && bundle.extensionId !== env.CWS_EXTENSION_ID) {
    throw new Error(
      `The bundle in ${dir} is for extension ${bundle.extensionId}, but CWS_EXTENSION_ID is ${env.CWS_EXTENSION_ID}`,
    );
  }
  return bundle;
}

function selectScope({ bundle, parsed }) {
  return resolveScope({
    bundle,
    requestedLocales: parsed.lists["--locales"],
    only: parsed.values["--only"],
    withGlobal: parsed.flags.has("--global"),
  });
}

// What the bundle says, checked before a browser starts, so a stale or
// hand-edited file never leaves a half-edited listing.
async function checkBundle({ bundle, locales, parts, parsed, dependencies, output }) {
  const scopes = [
    ...(parts.screenshots ? locales.filter((code) => bundle.scope(code)?.screenshots) : []),
    ...(parts.global ? ["global"] : []),
  ];
  // Descriptions carry no build, so only artwork has a provenance to check.
  if (scopes.length > 0) {
    const { versions } = checkArtworkSources({
      bundle,
      scopes,
      expectedVersion: parsed.values["--expect-version"] ?? dependencies.expectedVersion,
      allowVersionMismatch: parsed.flags.has("--allow-version-mismatch"),
      allowDirty: parsed.flags.has("--allow-dirty"),
    });
    output(`Artwork was generated from ${versions.join(", ")}.`);
  }
  for (const check of dependencies.checks ?? []) {
    await check({ bundle, locales, parts, output });
  }
  const screenshotCount = [
    ...locales.map((code) =>
      parts.screenshots ? (bundle.scope(code)?.screenshots?.length ?? 0) : 0,
    ),
    parts.global ? bundle.global.screenshots.length : 0,
  ].reduce((total, count) => total + count, 0);
  const descriptionCount = parts.descriptions
    ? locales.filter((code) => bundle.scope(code)?.description).length
    : 0;
  if (parts.screenshots || parts.global) {
    output(
      `Validated ${plural(screenshotCount, "screenshot")} for ${plural(scopes.length, "group")}.`,
    );
  }
  if (parts.descriptions) output(`Validated ${plural(descriptionCount, "description")}.`);
  const promo = scopes.filter(
    (scope) => bundle.scope(scope)?.promo || (scope === "global" && bundle.global?.promo),
  );
  if (promo.length > 0) {
    output(
      `Note: promo tiles for ${promo.join(", ")} are in the bundle but are not uploaded; this tool has no promo upload yet.`,
    );
  }
}

// Reloads the listing and compares it with what was meant to be there, so that
// "no error" is not mistaken for "correct".
async function readBack({ bundle, locales, parts, dashboard, output, record }) {
  const result = await verifyStoreListing({
    bundle,
    locales,
    parts,
    dashboard,
    onProgress: ({ scope, problems }) =>
      output(problems.length === 0 ? `${scope}: verified` : `${scope}: MISMATCH`),
  });
  if (!result.ok) {
    throw new Error(`Readback does not match the bundle:\n  - ${describeVerification(result)}`);
  }
  output(
    `Verified ${plural(result.results.length, "group")} against a fresh load of the dashboard.`,
  );
  const status = await dashboard.listingStatus?.();
  if (status) output(`Listing status: ${status}.`);
  // Only a sync that was confirmed by a fresh load may be trusted later, so the
  // record is written here and nowhere earlier.
  if (record) {
    const entries = [];
    for (const { scope, state } of result.results) {
      const files =
        scope === "global" ? bundle.global.screenshots : bundle.scope(scope)?.screenshots;
      if (!files || !parts[scope === "global" ? "global" : "screenshots"]) continue;
      entries.push([
        scope,
        {
          files: await hashFiles(files),
          thumbnails: scope === "global" ? state.global : state.localized,
        },
      ]);
    }
    if (entries.length > 0) await recordSync({ dir: bundle.dir, entries });
  }
}

async function runValidate({ args, env, dependencies }) {
  const parsed = parseArguments(args, OPTIONS);
  const output = dependencies.output ?? console.log;
  const bundle = await loadBundle({ parsed, env, dependencies });
  const { locales, parts } = selectScope({ bundle, parsed });
  await checkBundle({ bundle, locales, parts, parsed, dependencies, output });
}

async function runSync({ args, env, dependencies }) {
  const parsed = parseArguments(args, OPTIONS);
  const output = dependencies.output ?? console.log;
  validateExtensionId(env.CWS_EXTENSION_ID);
  const bundle = await loadBundle({ parsed, env, dependencies });
  const { locales, parts } = selectScope({ bundle, parsed });
  await checkBundle({ bundle, locales, parts, parsed, dependencies, output });

  await withDashboard({ env, bundle, dependencies, output }, async (dashboard) => {
    await syncStoreListing({
      bundle,
      locales: localesWithContent({ bundle, locales, parts }),
      parts,
      dashboard,
      context: createContext({ command: dependencies.invocation }),
      force: parsed.flags.has("--force"),
      previousState:
        parts.screenshots || parts.global ? await readSyncState(bundle.dir) : undefined,
      onProgress: ({ locale, variant, phase }) => {
        if (phase === "uploaded") output(`${locale}: uploaded ${variant}`);
        if (phase === "recovered") output(`${locale}: filled a missing screenshot with ${variant}`);
        if (phase === "saved") output(`${locale}: screenshots saved`);
        if (phase === "description-saved") output(`${locale}: description saved`);
        if (phase === "screenshots-unchanged") {
          output(`${locale}: screenshots unchanged since the last verified sync`);
        }
        if (phase === "description-unchanged") output(`${locale}: description already current`);
      },
    });
    output("Synced the listing draft. Nothing was submitted for review.");
    if (parsed.flags.has("--no-verify")) {
      output(
        "Skipped the readback (--no-verify); nothing confirmed the dashboard kept the changes.",
      );
      return;
    }
    await readBack({
      bundle,
      locales: localesWithContent({ bundle, locales, parts }),
      parts,
      dashboard,
      output,
      record: true,
    });
  });
}

async function runVerify({ args, env, dependencies }) {
  const parsed = parseArguments(args, OPTIONS);
  const output = dependencies.output ?? console.log;
  validateExtensionId(env.CWS_EXTENSION_ID);
  const bundle = await loadBundle({ parsed, env, dependencies });
  const { locales, parts } = selectScope({ bundle, parsed });
  await withDashboard({ env, bundle, dependencies, output }, (dashboard) =>
    readBack({
      bundle,
      locales: localesWithContent({ bundle, locales, parts }),
      parts,
      dashboard,
      output,
      record: false,
    }),
  );
}

// Writes sanitized copies of the live dashboard for the locator contract tests.
// It only reads the page, and each locale is named so a run never captures more
// of the signed-in session than was asked for.
async function runSnapshot({ args, env, dependencies }) {
  const parsed = parseArguments(args, OPTIONS);
  const output = dependencies.output ?? console.log;
  validateExtensionId(env.CWS_EXTENSION_ID);
  const locales = parsed.lists["--locales"];
  if (!locales) throw new Error("snapshot needs --locales, for example: snapshot --locales en es");
  const dir = resolve(
    parsed.values["--out"]
      ?? dependencies.snapshotDir
      ?? fileURLToPath(new URL("../tests/fixtures/cws-dashboard", import.meta.url)),
  );
  await withDashboard({ env, bundle: undefined, dependencies, output }, async (dashboard) => {
    await mkdir(dir, { recursive: true });
    for (const locale of locales) {
      await dashboard.selectLocale(locale);
      const html = await dashboard.snapshotHtml();
      await writeFile(join(dir, `${locale}.html`), html);
      output(`${locale}: wrote ${join(dir, `${locale}.html`)} (${html.length} characters)`);
    }
  });
}

// For producers that are not JavaScript: record what was written into a bundle.
async function runStamp({ args, dependencies }) {
  const parsed = parseArguments(args, OPTIONS);
  const output = dependencies.output ?? console.log;
  const dir = resolve(required(parsed.values["--bundle"] ?? dependencies.bundleDir, "--bundle"));
  const manifest = await stampBundle({
    dir,
    name: required(parsed.values["--name"], "--name"),
    extensionId: parsed.values["--extension-id"],
    source: {
      version: required(parsed.values["--version"], "--version"),
      commit: parsed.values["--commit"],
      dirty: parsed.flags.has("--dirty"),
    },
    sections: parsed.lists["--sections"] ?? [],
    forget: parsed.lists["--forget"] ?? [],
  });
  output(`Stamped ${plural(Object.keys(manifest.sections).length, "section")} in ${dir}.`);
}

export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  const rest = args[0] === "--" ? args.slice(1) : args;
  const [command, ...others] = rest;
  const handlers = {
    validate: runValidate,
    sync: runSync,
    verify: runVerify,
    snapshot: runSnapshot,
    stamp: runStamp,
  };
  if (!COMMANDS.includes(command)) {
    throw new Error(`Usage: store-sync <${COMMANDS.join("|")}> [options]`);
  }
  return handlers[command]({
    args: others,
    env,
    dependencies: { invocation: "store-sync", ...dependencies },
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`store-sync: ${error.message}`);
    process.exitCode = 1;
  });
}
