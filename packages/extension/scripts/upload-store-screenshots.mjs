import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { parseRequestedLocales } from "./store-screenshot-config.mjs";
import { validateStoreScreenshotFiles } from "./store-screenshot-files.mjs";
import { ChromeWebStoreDashboard } from "./store-screenshot-dashboard.mjs";
import { uploadStoreScreenshots } from "./store-screenshot-upload.mjs";

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function defaultLaunchBrowser(env) {
  return chromium.launch({
    channel: env.CWS_BROWSER_CHANNEL ?? "chrome",
    headless: false,
  });
}

function defaultCreateDashboard({ page, env, output }) {
  return new ChromeWebStoreDashboard({
    page,
    extensionId: env.CWS_EXTENSION_ID,
    publisherId: env.CWS_PUBLISHER_ID,
    baseUrl: env.CWS_DASHBOARD_URL,
    output,
  });
}

async function waitForInspection(browser, output) {
  output("The draft was partially changed but never submitted. Inspect it in Chrome, then close the browser to finish the command.");
  if (!browser.isConnected()) return;
  await new Promise((resolveDisconnected) => browser.once("disconnected", resolveDisconnected));
}

export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  required(env.CWS_EXTENSION_ID, "CWS_EXTENSION_ID");
  const locales = parseRequestedLocales(args);
  const validateFiles = dependencies.validateFiles ?? validateStoreScreenshotFiles;
  const output = dependencies.output ?? console.log;
  const screenshotRoot = dependencies.screenshotRoot ?? resolve("artifacts/store-screenshots");
  const filesByLocale = await validateFiles({ root: screenshotRoot, locales });
  const imageCount = [...filesByLocale.values()].reduce((total, files) => total + files.length, 0);
  output(`Validated ${imageCount} screenshots for ${locales.length} ${locales.length === 1 ? "locale" : "locales"}.`);
  if (args.includes("--validate-only")) return;
  if (!env.CWS_PUBLISHER_ID && !env.CWS_DASHBOARD_URL) {
    throw new Error("CWS_PUBLISHER_ID is required unless CWS_DASHBOARD_URL is provided");
  }

  const launchBrowser = dependencies.launchBrowser ?? (() => defaultLaunchBrowser(env));
  const createDashboard = dependencies.createDashboard ?? defaultCreateDashboard;
  const browser = await launchBrowser();
  let context;
  let dashboard;
  try {
    context = await browser.newContext({});
    const page = await context.newPage();
    dashboard = createDashboard({ page, env, output });
    await dashboard.openAndWaitForAuthentication();
    await uploadStoreScreenshots({
      locales,
      filesByLocale,
      dashboard,
      onProgress: ({ locale, variant, phase }) => {
        if (phase === "uploaded") output(`${locale}: uploaded ${variant}`);
        if (phase === "recovered") output(`${locale}: repaired an interrupted four-image draft`);
        if (phase === "saved") output(`${locale}: draft saved`);
      },
    });
    output(`Saved ${imageCount} screenshots across ${locales.length} ${locales.length === 1 ? "locale" : "locales"}. Nothing was submitted for review.`);
    await context.close();
    await browser.close();
  } catch (error) {
    if (dashboard?.hasMutated) {
      const inspect = dependencies.waitForInspection ?? waitForInspection;
      await inspect(browser, output);
    } else {
      await context?.close();
      await browser.close();
    }
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
