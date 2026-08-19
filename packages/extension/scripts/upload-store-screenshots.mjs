import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { parseRequestedLocales } from "./store-screenshot-config.mjs";
import { validateStoreScreenshotFiles } from "./store-screenshot-files.mjs";
import { ChromeWebStoreDashboard } from "./store-screenshot-dashboard.mjs";
import { uploadStoreScreenshots } from "./store-screenshot-upload.mjs";
import { abandonBrowserSession, finishBrowserSession, startBrowserSession } from "./store-screenshot-browser.mjs";

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateExtensionId(value) {
  required(value, "CWS_EXTENSION_ID");
  if (!/^[a-p]{32}$/.test(value)) throw new Error("CWS_EXTENSION_ID must be a 32-character Chrome extension ID");
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



export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  validateExtensionId(env.CWS_EXTENSION_ID);
  const locales = parseRequestedLocales(args);
  const validateFiles = dependencies.validateFiles ?? validateStoreScreenshotFiles;
  const output = dependencies.output ?? console.log;
  const screenshotRoot = dependencies.screenshotRoot ?? resolve("artifacts/store-screenshots");
  const filesByLocale = await validateFiles({ root: screenshotRoot, locales });
  const imageCount = [...filesByLocale.values()].reduce((total, files) => total + files.length, 0);
  output(`Validated ${imageCount} screenshots for ${locales.length} ${locales.length === 1 ? "locale" : "locales"}.`);
  if (args.includes("--validate-only")) return;
  validatePublisherId(env.CWS_PUBLISHER_ID);

  const openBrowser = dependencies.openBrowser ?? startBrowserSession;
  const createDashboard = dependencies.createDashboard ?? defaultCreateDashboard;
  const session = await openBrowser({ env, output, connect: dependencies.connect ?? connectOverCdp });
  let dashboard;
  try {
    // The signed-in session lives in the browser's existing context; a new one
    // would carry no cookies and land on a signed-out dashboard.
    const page = await session.context.newPage();
    dashboard = createDashboard({ page, env, output });
    await dashboard.openAndWaitForAuthentication();
    await uploadStoreScreenshots({
      locales,
      filesByLocale,
      dashboard,
      onProgress: ({ locale, variant, phase, section }) => {
        const scope = section === "global" ? "global" : locale;
        if (phase === "uploaded") output(`${scope}: uploaded ${variant}`);
        if (phase === "recovered") output(`${scope}: repaired an interrupted four-image draft`);
        if (phase === "saved") output(`${scope}: draft saved`);
      },
    });
    output(`Saved ${imageCount} screenshots across ${locales.length} ${locales.length === 1 ? "locale" : "locales"}. Nothing was submitted for review.`);
    await (dependencies.finishBrowser ?? finishBrowserSession)(session, { output });
  } catch (error) {
    // Any failure keeps the browser: the operator may have signed in already,
    // including while the step that failed was still waiting, and rebuilding
    // that session costs another sign-in and 2FA.
    await (dependencies.abandonBrowser ?? abandonBrowserSession)(session, output, { mutated: Boolean(dashboard?.hasMutated) });
    throw error;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`store screenshots: ${error.message}`);
    process.exitCode = 1;
  });
}
