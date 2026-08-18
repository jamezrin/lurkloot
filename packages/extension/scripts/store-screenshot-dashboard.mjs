import { localeConfig } from "./store-screenshot-config.mjs";

const LABELS = Object.freeze({
  language: /listing language|language|locale/i,
  screenshots: /localized screenshots|screenshots/i,
  removeScreenshot: /remove screenshot/i,
  uploadScreenshots: /upload screenshots|add screenshots/i,
  saveDraft: /save draft|save changes|save/i,
  saved: /changes saved|saved/i,
  storeListing: /store listing/i,
});

async function requireUnique(locator, description) {
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(`${description}: expected exactly one accessible control, found ${count}`);
  }
  return locator;
}

function localeNamePattern(locale) {
  const alternatives = locale.dashboardNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^(?:${alternatives.join("|")})$`, "i");
}

export class ChromeWebStoreDashboard {
  constructor({ page, extensionId, publisherId, baseUrl, timeout = 30_000, authenticationTimeout = 10 * 60_000, output = console.log }) {
    this.page = page;
    this.extensionId = extensionId;
    this.publisherId = publisherId;
    this.baseUrl = baseUrl;
    this.timeout = timeout;
    this.authenticationTimeout = authenticationTimeout;
    this.output = output;
    this.hasMutated = false;
  }

  dashboardUrl() {
    if (this.baseUrl) return this.baseUrl;
    const publisherPath = this.publisherId ? `${this.publisherId}/` : "";
    return `https://chrome.google.com/webstore/devconsole/${publisherPath}${this.extensionId}?hl=en`;
  }

  languageControl() {
    return this.page.getByRole("combobox", { name: LABELS.language });
  }

  screenshotRegion() {
    return this.page.getByRole("region", { name: LABELS.screenshots });
  }

  removeControls() {
    return this.screenshotRegion().getByRole("button", { name: LABELS.removeScreenshot });
  }

  uploadControl() {
    return this.screenshotRegion().getByLabel(LABELS.uploadScreenshots);
  }

  saveControl() {
    return this.page.getByRole("button", { name: LABELS.saveDraft });
  }

  savedIndicator() {
    return this.page.getByRole("status");
  }

  async openAndWaitForAuthentication() {
    await this.page.goto(this.dashboardUrl(), { waitUntil: "domcontentloaded" });
    this.output("Chrome opened. Sign in to the Chrome Web Store Developer Dashboard and complete 2FA; automation will resume automatically.");
    await this.page.waitForURL((url) => url.toString().includes(this.extensionId), { timeout: this.authenticationTimeout });

    const listingHeading = this.page.getByRole("heading", { name: LABELS.storeListing });
    if (await listingHeading.count() === 0) {
      const navigation = this.page.getByRole("link", { name: LABELS.storeListing })
        .or(this.page.getByRole("tab", { name: LABELS.storeListing }))
        .or(this.page.getByRole("button", { name: LABELS.storeListing }));
      await navigation.first().waitFor({ state: "visible", timeout: this.authenticationTimeout });
      await requireUnique(navigation, "Store listing navigation");
      await navigation.click();
    }
    await listingHeading.first().waitFor({ state: "visible", timeout: this.timeout });
  }

  async preflight({ locales }) {
    const identity = this.page.getByText(this.extensionId, { exact: false });
    if (!this.page.url().includes(this.extensionId)) {
      await requireUnique(identity, "configured extension identity");
    }
    const language = await requireUnique(this.languageControl(), "listing language selector");
    const tagName = await language.evaluate((element) => element.tagName);
    if (tagName !== "SELECT") await language.click();

    for (const code of locales) {
      const locale = localeConfig(code);
      const { dashboardLabel } = locale;
      const name = localeNamePattern(locale);
      const options = tagName === "SELECT"
        ? language.getByRole("option", { name })
        : this.page.getByRole("option", { name });
      const optionCount = await options.count();
      if (optionCount !== 1) throw new Error(`Dashboard locale ${dashboardLabel}: expected exactly one option, found ${optionCount}`);
    }
    if (tagName !== "SELECT") await this.page.keyboard.press("Escape");

    await this.selectLocale(locales[0]);
    const count = await this.screenshotCount();
    if (count !== 4 && count !== 5) {
      throw new Error(`Localized screenshots: expected 4 or 5 remove controls, found ${count}`);
    }
    await requireUnique(this.uploadControl(), "screenshot upload input");
    await requireUnique(this.saveControl(), "draft save button");
    await requireUnique(this.savedIndicator(), "saved-state indicator");
  }

  async selectLocale(code) {
    const locale = localeConfig(code);
    const { dashboardLabel } = locale;
    const name = localeNamePattern(locale);
    const language = await requireUnique(this.languageControl(), "listing language selector");
    const tagName = await language.evaluate((element) => element.tagName);
    if (tagName === "SELECT") {
      const option = language.getByRole("option", { name });
      await requireUnique(option, `dashboard locale ${dashboardLabel}`);
      await language.selectOption({ label: (await option.textContent())?.trim() });
      return;
    }
    await language.click();
    const option = this.page.getByRole("option", { name });
    await requireUnique(option, `dashboard locale ${dashboardLabel}`);
    await option.click();
  }

  async screenshotCount() {
    return this.removeControls().count();
  }

  async removeFirstScreenshot() {
    const controls = this.removeControls();
    const count = await controls.count();
    if (count !== 4 && count !== 5) {
      throw new Error(`Screenshot removal expected 4 or 5 controls, found ${count}`);
    }
    this.hasMutated = true;
    await controls.first().click();
  }

  async waitForScreenshotCount(count) {
    const controls = this.removeControls();
    if (count > 0) await controls.nth(count - 1).waitFor({ state: "visible", timeout: this.timeout });
    await controls.nth(count).waitFor({ state: "detached", timeout: this.timeout });
    const actual = await controls.count();
    if (actual !== count) throw new Error(`Expected ${count} screenshots, found ${actual}`);
  }

  async uploadScreenshot(path) {
    const input = await requireUnique(this.uploadControl(), "screenshot upload input");
    this.hasMutated = true;
    await input.setInputFiles(path);
  }

  async saveDraft() {
    const save = await requireUnique(this.saveControl(), "draft save button");
    this.hasMutated = true;
    await save.click();
    const status = await requireUnique(this.savedIndicator(), "saved-state indicator");
    await status.filter({ hasText: LABELS.saved }).waitFor({ state: "visible", timeout: this.timeout });
  }
}
