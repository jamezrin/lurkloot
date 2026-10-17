import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { parseRequestedLocales } from "./store-screenshot-config.mjs";
import { validateStoreScreenshotFiles } from "./store-screenshot-files.mjs";
import { ChromeWebStoreDashboard } from "./store-screenshot-dashboard.mjs";
import { syncStoreListing } from "./store-listing-sync.mjs";
import { loadStoreDescriptions } from "./store-listing-descriptions.mjs";
import {
  abandonBrowserSession,
  finishBrowserSession,
  startBrowserSession,
} from "./store-screenshot-browser.mjs";

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

function defaultCreateDashboard({ page, env, output }) {
  return new ChromeWebStoreDashboard({
    page,
    extensionId: env.CWS_EXTENSION_ID,
    publisherId: env.CWS_PUBLISHER_ID,
    output,
  });
}

const LISTING_PARTS = Object.freeze(["screenshots", "descriptions"]);

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

function plural(count, noun) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  validateExtensionId(env.CWS_EXTENSION_ID);
  const { parts, rest } = parseListingParts(args);
  const locales = parseRequestedLocales(rest);
  const output = dependencies.output ?? console.log;

  // Everything is read and checked before a browser starts, so a missing image
  // or an over-long description never leaves a half-edited listing.
  let filesByLocale;
  let imageCount = 0;
  if (parts.includes("screenshots")) {
    const validateFiles = dependencies.validateFiles ?? validateStoreScreenshotFiles;
    const screenshotRoot = dependencies.screenshotRoot ?? resolve("artifacts/store-screenshots");
    filesByLocale = await validateFiles({ root: screenshotRoot, locales });
    imageCount = [...filesByLocale.values()].reduce((total, files) => total + files.length, 0);
    output(
      `Validated ${plural(imageCount, "screenshot")} for ${plural(locales.length, "locale")}.`,
    );
  }
  let descriptionsByLocale;
  if (parts.includes("descriptions")) {
    const loadDescriptions = dependencies.loadDescriptions ?? loadStoreDescriptions;
    descriptionsByLocale = await loadDescriptions({ locales });
    output(
      `Validated ${plural(descriptionsByLocale.size, "description")} for ${plural(locales.length, "locale")}.`,
    );
  }
  if (rest.includes("--validate-only")) return;
  validatePublisherId(env.CWS_PUBLISHER_ID);

  const openBrowser = dependencies.openBrowser ?? startBrowserSession;
  const createDashboard = dependencies.createDashboard ?? defaultCreateDashboard;
  const session = await openBrowser({
    env,
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
    await syncStoreListing({
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
    await (dependencies.finishBrowser ?? finishBrowserSession)(session, { output });
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`cws listing: ${error.message}`);
    process.exitCode = 1;
  });
}
