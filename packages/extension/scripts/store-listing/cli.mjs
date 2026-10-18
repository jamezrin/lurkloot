import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { parseLocaleArguments } from "./core/listing.mjs";
import { CAPTURE_MODES, captureStore } from "./capture.mjs";
import { describeVerification, verifyStoreListing } from "./core/verify.mjs";
import { hashFiles, readSyncState, recordSync, syncedGroup } from "./core/syncState.mjs";
import { checkCaptureProvenance, readCaptureManifest } from "./core/provenance.mjs";
import { LISTING, STORE_PATHS } from "./lurkloot.mjs";
import { validateStoreScreenshotFiles } from "./core/files.mjs";
import { ChromeWebStoreDashboard } from "./core/dashboard.mjs";
import { syncStoreListing } from "./core/sync.mjs";
import { loadStoreDescriptions } from "./core/descriptions.mjs";
import {
  abandonBrowserSession,
  finishBrowserSession,
  startBrowserSession,
} from "./core/browser.mjs";

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateExtensionId(value) {
  required(value, "CWS_EXTENSION_ID");
  if (!/^[a-p]{32}$/.test(value))
    throw new Error("CWS_EXTENSION_ID must be a 32-character Chrome extension ID");
}

function validatePublisherId(value) {
  required(value, "CWS_PUBLISHER_ID");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("CWS_PUBLISHER_ID must be the UUID from the Developer Dashboard URL");
  }
}

function connectOverCdp(url) {
  return chromium.connectOverCDP(url);
}

function defaultCreateDashboard({ page, env, output, listing }) {
  return new ChromeWebStoreDashboard({
    page,
    listing,
    extensionId: env.CWS_EXTENSION_ID,
    publisherId: env.CWS_PUBLISHER_ID,
    output,
  });
}

const LISTING_PARTS = Object.freeze(["screenshots", "descriptions"]);

export const COMMANDS = Object.freeze(["capture", "validate", "sync", "verify", "snapshot"]);

// Options that take no value. The locale parser lets these through so each
// command can read the ones it owns.
const FLAGS = Object.freeze([
  "--validate-only",
  "--capture",
  "--allow-version-mismatch",
  "--allow-dirty",
  "--no-verify",
  "--force",
]);

// Takes "--only <part>" out of the arguments before the shared locale parser,
// which rejects options it does not know.
export function parseListingParts(args) {
  const rest = [];
  let only;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--only") {
      rest.push(args[index]);
      continue;
    }
    if (only) throw new Error("Duplicate option --only");
    only = args[index + 1];
    index += 1;
    if (!LISTING_PARTS.includes(only)) {
      throw new Error(`--only expects one of ${LISTING_PARTS.join(", ")}`);
    }
  }
  return { parts: only ? [only] : [...LISTING_PARTS], rest };
}

// A bare invocation, or one that starts with an option, is a sync: that is what
// this command did before it had stages.
export function parseCommand(args) {
  const [first, ...others] = args;
  if (COMMANDS.includes(first)) return { command: first, rest: others };
  return { command: "sync", rest: args };
}

function plural(count, noun) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

// The build the screenshots were captured from has to be the build this
// checkout is at, or the listing would show an older popup than the release.
async function defaultCheckProvenance({ listing, locales, filesByLocale, flags, output }) {
  const manifest = await readCaptureManifest(STORE_PATHS.screenshots);
  const { version } = JSON.parse(
    await readFile(join(STORE_PATHS.packageRoot, "package.json"), "utf8"),
  );
  const { versions } = await checkCaptureProvenance({
    manifest,
    listing,
    locales,
    filesByLocale,
    expectedVersion: version,
    allowVersionMismatch: flags.allowVersionMismatch,
    allowDirty: flags.allowDirty,
  });
  output(`Screenshots were captured from ${versions.join(", ")}.`);
}

// Everything is read and checked before a browser starts, so a missing image
// or an over-long description never leaves a half-edited listing.
async function loadInputs({ parts, locales, listing, flags, dependencies, output }) {
  let filesByLocale;
  let imageCount = 0;
  if (parts.includes("screenshots")) {
    const validateFiles = dependencies.validateFiles ?? validateStoreScreenshotFiles;
    const screenshotRoot = dependencies.screenshotRoot ?? STORE_PATHS.screenshots;
    filesByLocale = await validateFiles({ root: screenshotRoot, locales, listing });
    imageCount = [...filesByLocale.values()].reduce((total, files) => total + files.length, 0);
    output(
      `Validated ${plural(imageCount, "screenshot")} for ${plural(locales.length, "locale")}.`,
    );
    await (dependencies.checkProvenance ?? defaultCheckProvenance)({
      listing,
      locales,
      filesByLocale,
      flags,
      output,
    });
  }
  let descriptionsByLocale;
  if (parts.includes("descriptions")) {
    const loadDescriptions = dependencies.loadDescriptions ?? loadStoreDescriptions;
    descriptionsByLocale = await loadDescriptions({
      locales,
      dir: dependencies.descriptionsDir ?? STORE_PATHS.descriptions,
      listing,
    });
    output(
      `Validated ${plural(descriptionsByLocale.size, "description")} for ${plural(locales.length, "locale")}.`,
    );
  }
  return { filesByLocale, descriptionsByLocale, imageCount };
}

// Opens the signed-in dashboard, runs the work, and leaves the browser the way
// the outcome calls for.
async function withDashboard({ env, listing, dependencies, output }, work) {
  validatePublisherId(env.CWS_PUBLISHER_ID);
  const openBrowser = dependencies.openBrowser ?? startBrowserSession;
  const createDashboard = dependencies.createDashboard ?? defaultCreateDashboard;
  const session = await openBrowser({
    env,
    listing,
    output,
    connect: dependencies.connect ?? connectOverCdp,
  });
  let dashboard;
  try {
    // The signed-in session lives in the browser's existing context; a new one
    // would carry no cookies and land on a signed-out dashboard.
    const page = await session.context.newPage();
    dashboard = createDashboard({ page, env, output, listing });
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

async function runCapture({ rest, listing, dependencies }) {
  const [first, ...others] = rest;
  const mode = CAPTURE_MODES.includes(first) ? first : "screenshots";
  const optionArguments = CAPTURE_MODES.includes(first) ? others : rest;
  const locales = parseLocaleArguments(listing, optionArguments);
  await (dependencies.capture ?? captureStore)({
    mode,
    locales,
    listing,
    output: dependencies.output ?? console.log,
  });
}

async function runValidateOrSync({ command, rest, env, listing, dependencies }) {
  const { parts, rest: optionArguments } = parseListingParts(rest);
  const locales = parseLocaleArguments(listing, optionArguments, { allowedFlags: FLAGS });
  const output = dependencies.output ?? console.log;
  const validateOnly = command === "validate" || optionArguments.includes("--validate-only");

  // A capture stage ahead of the sync keeps one command, so the locale list is
  // forwarded to it once rather than only to the last script in a chain.
  if (
    command === "sync"
    && optionArguments.includes("--capture")
    && parts.includes("screenshots")
  ) {
    await (dependencies.capture ?? captureStore)({
      mode: "screenshots",
      locales,
      listing,
      output,
    });
  }

  const flags = {
    allowVersionMismatch: optionArguments.includes("--allow-version-mismatch"),
    allowDirty: optionArguments.includes("--allow-dirty"),
    noVerify: optionArguments.includes("--no-verify"),
    force: optionArguments.includes("--force"),
  };
  const { filesByLocale, descriptionsByLocale, imageCount } = await loadInputs({
    parts,
    locales,
    listing,
    flags,
    dependencies,
    output,
  });
  if (validateOnly) return;

  await withDashboard({ env, listing, dependencies, output }, async (dashboard) => {
    const stateDir = dependencies.stateDir ?? STORE_PATHS.screenshots;
    await syncStoreListing({
      listing,
      locales,
      filesByLocale,
      descriptionsByLocale,
      dashboard,
      force: flags.force,
      previousState: filesByLocale ? await readSyncState(stateDir, listing) : undefined,
      onProgress: ({ locale, variant, phase, section }) => {
        const scope = section === "global" ? "global" : locale;
        if (phase === "uploaded") output(`${scope}: uploaded ${variant}`);
        if (phase === "recovered") output(`${scope}: filled a missing screenshot with ${variant}`);
        if (phase === "saved") output(`${scope}: screenshots saved`);
        if (phase === "description-saved") output(`${scope}: description saved`);
        if (phase === "screenshots-unchanged") {
          output(`${scope}: screenshots unchanged since the last verified sync`);
        }
        if (phase === "description-unchanged") output(`${scope}: description already current`);
      },
    });
    const updated = [
      filesByLocale && plural(imageCount, "screenshot"),
      descriptionsByLocale && plural(descriptionsByLocale.size, "description"),
    ].filter(Boolean);
    output(
      `Synced ${updated.join(" and ")} across ${plural(locales.length, "locale")}. Nothing was submitted for review.`,
    );
    if (flags.noVerify) {
      output(
        "Skipped the readback (--no-verify); nothing confirmed the dashboard kept the changes.",
      );
      return;
    }
    await readBack({
      parts,
      locales,
      listing,
      descriptionsByLocale,
      filesByLocale,
      stateDir,
      dashboard,
      output,
    });
  });
}

// Reloads the listing and compares it with what was meant to be there, so that
// "no error" is not mistaken for "correct".
async function readBack({
  parts,
  locales,
  listing,
  descriptionsByLocale,
  filesByLocale,
  stateDir,
  dashboard,
  output,
}) {
  const result = await verifyStoreListing({
    listing,
    locales,
    descriptionsByLocale,
    expectedScreenshots: parts.includes("screenshots") ? listing.screenshots.length : undefined,
    dashboard,
    onProgress: ({ locale, problems }) =>
      output(problems.length === 0 ? `${locale}: verified` : `${locale}: MISMATCH`),
  });
  if (!result.ok) {
    throw new Error(
      `Readback does not match the local files:\n  - ${describeVerification(result)}`,
    );
  }
  output(`Verified ${plural(locales.length, "locale")} against a fresh load of the dashboard.`);
  const status = await dashboard.listingStatus?.();
  if (status) output(`Listing status: ${status}.`);
  // Only a sync that was confirmed by a fresh load may be trusted later, so the
  // record is written here and nowhere earlier.
  if (filesByLocale) {
    const entries = [];
    for (const { locale, state } of result.results) {
      entries.push([
        locale,
        {
          files: await hashFiles(filesByLocale.get(locale)),
          thumbnails: syncedGroup(listing, locale) === "global" ? state.global : state.localized,
        },
      ]);
    }
    await recordSync({ dir: stateDir, listing, entries });
  }
}

// Writes sanitized copies of the live dashboard for the locator contract tests.
// It only reads the page, and each locale is named so a run never captures more
// of the signed-in session than was asked for.
async function runSnapshot({ rest, env, listing, dependencies }) {
  if (!rest.includes("--locales")) {
    throw new Error("snapshot needs --locales, for example: snapshot --locales en es");
  }
  const locales = parseLocaleArguments(listing, rest);
  const output = dependencies.output ?? console.log;
  const dir = dependencies.snapshotDir ?? STORE_PATHS.snapshots;
  await withDashboard({ env, listing, dependencies, output }, async (dashboard) => {
    await mkdir(dir, { recursive: true });
    for (const locale of locales) {
      await dashboard.selectLocale(locale);
      const html = await dashboard.snapshotHtml();
      await writeFile(join(dir, `${locale}.html`), html);
      output(`${locale}: wrote ${join(dir, `${locale}.html`)} (${html.length} characters)`);
    }
  });
}

async function runVerify({ rest, env, listing, dependencies }) {
  const { parts, rest: optionArguments } = parseListingParts(rest);
  const locales = parseLocaleArguments(listing, optionArguments);
  const output = dependencies.output ?? console.log;
  // Checking needs the expected text, not the screenshot files, so a listing
  // can be verified on a machine that never captured anything.
  const { descriptionsByLocale } = await loadInputs({
    parts: parts.filter((part) => part === "descriptions"),
    locales,
    listing,
    flags: {},
    dependencies,
    output,
  });
  await withDashboard({ env, listing, dependencies, output }, (dashboard) =>
    readBack({ parts, locales, listing, descriptionsByLocale, dashboard, output }),
  );
}

export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  const { command, rest } = parseCommand(args);
  const listing = dependencies.listing ?? LISTING;
  if (command === "capture") return runCapture({ rest, listing, dependencies });
  validateExtensionId(env.CWS_EXTENSION_ID);
  if (command === "verify") return runVerify({ rest, env, listing, dependencies });
  if (command === "snapshot") return runSnapshot({ rest, env, listing, dependencies });
  return runValidateOrSync({ command, rest, env, listing, dependencies });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`cws listing: ${error.message}`);
    process.exitCode = 1;
  });
}
