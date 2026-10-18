import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { parseLocaleArguments } from "./core/listing.mjs";
import { CAPTURE_MODES, captureStore } from "./capture.mjs";
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

export const COMMANDS = Object.freeze(["capture", "validate", "sync"]);

// Options that take no value. The locale parser lets these through so each
// command can read the ones it owns.
const FLAGS = Object.freeze(["--validate-only", "--capture"]);

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

// Everything is read and checked before a browser starts, so a missing image
// or an over-long description never leaves a half-edited listing.
async function loadInputs({ parts, locales, listing, dependencies, output }) {
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

  const { filesByLocale, descriptionsByLocale, imageCount } = await loadInputs({
    parts,
    locales,
    listing,
    dependencies,
    output,
  });
  if (validateOnly) return;

  await withDashboard({ env, listing, dependencies, output }, async (dashboard) => {
    await syncStoreListing({
      listing,
      locales,
      filesByLocale,
      descriptionsByLocale,
      dashboard,
      onProgress: ({ locale, variant, phase, section }) => {
        const scope = section === "global" ? "global" : locale;
        if (phase === "uploaded") output(`${scope}: uploaded ${variant}`);
        if (phase === "recovered") output(`${scope}: filled a missing screenshot with ${variant}`);
        if (phase === "saved") output(`${scope}: screenshots saved`);
        if (phase === "description-saved") output(`${scope}: description saved`);
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
  });
}

export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  const { command, rest } = parseCommand(args);
  const listing = dependencies.listing ?? LISTING;
  if (command === "capture") return runCapture({ rest, listing, dependencies });
  validateExtensionId(env.CWS_EXTENSION_ID);
  return runValidateOrSync({ command, rest, env, listing, dependencies });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`cws listing: ${error.message}`);
    process.exitCode = 1;
  });
}
