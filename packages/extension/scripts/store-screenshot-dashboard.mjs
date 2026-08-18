import { localeConfig } from "./store-screenshot-config.mjs";

const LABELS = Object.freeze({
  language: /listing language|language|locale/i,
  screenshots: /localized screenshots|screenshots/i,
  removeScreenshot: /remove screenshot/i,
  uploadScreenshots: /upload screenshots|add screenshots/i,
  saveDraft: /save draft|save changes|save/i,
  saved: /changes saved|saved/i,
  saving: /saving|updating|in progress|please wait/i,
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
  constructor({ page, extensionId, publisherId, timeout = 30_000, authenticationTimeout = 10 * 60_000, output = console.log }) {
    this.page = page;
    this.extensionId = extensionId;
    this.publisherId = publisherId;
    this.timeout = timeout;
    this.authenticationTimeout = authenticationTimeout;
    this.output = output;
    this.hasMutated = false;
  }

  dashboardUrl() {
    const publisherPath = this.publisherId ? `${encodeURIComponent(this.publisherId)}/` : "";
    return `https://chrome.google.com/webstore/devconsole/${publisherPath}${encodeURIComponent(this.extensionId)}/edit?hl=en`;
  }

  languageControl() {
    return this.page.getByRole("combobox", { name: LABELS.language });
  }

  screenshotRegion() {
    return this.page.getByRole("region", { name: LABELS.screenshots });
  }

  screenshotItems() {
    return this.screenshotRegion().getByRole("listitem");
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

  uploadErrors() {
    return this.screenshotRegion().getByRole("alert");
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
    await requireUnique(identity, "configured extension identity");
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
      throw new Error(`Localized screenshots: expected 4 or 5 screenshot items, found ${count}`);
    }
    await this.requirePngUploadControl();
    await requireUnique(this.saveControl(), "draft save button");
    await requireUnique(this.savedIndicator(), "saved-state indicator");
  }

  async requirePngUploadControl() {
    const input = await requireUnique(this.uploadControl(), "screenshot upload input");
    const semantics = await input.evaluate((element) => ({
      accept: element.getAttribute("accept") ?? "",
      tagName: element.tagName,
      type: element.getAttribute("type") ?? "",
    }));
    const acceptsPng = semantics.accept
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .some((value) => value === "image/png" || value === ".png");
    if (semantics.tagName !== "INPUT" || semantics.type.toLowerCase() !== "file" || !acceptsPng) {
      throw new Error("Screenshot upload control must be a PNG-capable file input");
    }
    return input;
  }

  async selectedLocaleName(language, tagName) {
    if (tagName === "SELECT") {
      return (await language.locator("option:checked").textContent())?.trim() ?? "";
    }
    return (await language.textContent())?.trim() ?? "";
  }

  async screenshotMediaFingerprint() {
    return this.screenshotItems().evaluateAll((items) => JSON.stringify(items.map((item) => [
      ...item.querySelectorAll("img, source"),
    ].map((media) => ({
      alt: media.getAttribute("alt") ?? "",
      currentSrc: media.currentSrc ?? "",
      src: media.getAttribute("src") ?? "",
      srcset: media.getAttribute("srcset") ?? "",
    })))));
  }

  async waitForScreenshotPanelChange(before, dashboardLabel) {
    const deadline = Date.now() + this.timeout;
    let candidate = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      const current = await this.screenshotMediaFingerprint();
      const region = await requireUnique(this.screenshotRegion(), "localized screenshot region");
      const busy = (await region.getAttribute("aria-busy")) === "true"
        || await region.getByRole("progressbar").count() > 0;
      if (!busy && current !== before) {
        if (candidate !== current) {
          candidate = current;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 100) {
          return;
        }
      } else {
        candidate = "";
        stableSince = 0;
      }
      await this.page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Screenshot panel did not change to dashboard locale ${dashboardLabel}`);
  }

  async selectLocale(code) {
    const locale = localeConfig(code);
    const { dashboardLabel } = locale;
    const name = localeNamePattern(locale);
    const language = await requireUnique(this.languageControl(), "listing language selector");
    const tagName = await language.evaluate((element) => element.tagName);
    const currentName = await this.selectedLocaleName(language, tagName);
    if (name.test(currentName)) return;
    const previousScreenshots = await this.screenshotMediaFingerprint();
    if (tagName === "SELECT") {
      const option = language.getByRole("option", { name });
      await requireUnique(option, `dashboard locale ${dashboardLabel}`);
      await language.selectOption({ label: (await option.textContent())?.trim() });
    } else {
      await language.click();
      const option = this.page.getByRole("option", { name });
      await requireUnique(option, `dashboard locale ${dashboardLabel}`);
      await option.click();
    }
    const selectedName = await this.selectedLocaleName(language, tagName);
    if (!name.test(selectedName)) {
      throw new Error(`Dashboard locale ${dashboardLabel}: selector did not confirm the requested language`);
    }
    await this.waitForScreenshotPanelChange(previousScreenshots, dashboardLabel);
  }

  async screenshotCount() {
    return this.screenshotItems().count();
  }

  async removeFirstScreenshot() {
    const items = this.screenshotItems();
    const count = await items.count();
    if (count !== 4 && count !== 5) {
      throw new Error(`Screenshot removal expected 4 or 5 items, found ${count}`);
    }
    const remove = await requireUnique(items.first().getByRole("button", { name: LABELS.removeScreenshot }), "first screenshot remove button");
    this.hasMutated = true;
    await remove.click();
  }

  async waitForScreenshotCount(count) {
    const items = this.screenshotItems();
    if (count > 0) await items.nth(count - 1).waitFor({ state: "visible", timeout: this.timeout });
    await items.nth(count).waitFor({ state: "detached", timeout: this.timeout });
    const actual = await items.count();
    if (actual !== count) throw new Error(`Expected ${count} screenshots, found ${actual}`);
    if (this.uploadPending) await this.waitForUploadCompletion();
  }

  async waitForUploadCompletion() {
    if (!this.uploadLifecycle) throw new Error("Screenshot upload lifecycle was not armed before file selection");
    const lifecycle = this.uploadLifecycle;
    await this.page.waitForFunction(
      (element) => element.__lurklootUploadState.started || element.__lurklootUploadState.error,
      lifecycle,
      { timeout: this.timeout },
    );
    await this.page.waitForFunction(
      (element) => element.__lurklootUploadState.error
        || element.__lurklootUploadState.settledAt !== null,
      lifecycle,
      { timeout: this.timeout },
    );
    await this.waitForUploadedThumbnailReady(lifecycle);
    const lifecycleError = await lifecycle.evaluate((element) => element.__lurklootUploadState.error);
    const errors = this.uploadErrors();
    const errorMessages = [];
    for (let index = 0; index < await errors.count(); index += 1) {
      const error = errors.nth(index);
      if (await error.isVisible()) errorMessages.push((await error.textContent())?.trim() ?? "Unknown upload error");
    }
    if (lifecycleError || errorMessages.length > 0) {
      throw new Error(`Screenshot upload failed validation: ${[lifecycleError, ...errorMessages].filter(Boolean).join("; ")}`);
    }
    await lifecycle.evaluate((element) => element.__lurklootUploadObserver?.disconnect());
    this.uploadLifecycle = undefined;
    this.uploadPending = false;
  }

  async screenshotMediaSources() {
    return this.screenshotItems().evaluateAll((items) => items.flatMap((item) => [
      ...item.querySelectorAll("img, source"),
    ].flatMap((media) => [
      media.currentSrc ?? "",
      media.getAttribute("src") ?? "",
      media.getAttribute("srcset") ?? "",
    ].filter(Boolean))));
  }

  async waitForUploadedThumbnailReady(lifecycle) {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      const state = await lifecycle.evaluate((element) => ({ ...element.__lurklootUploadState }));
      if (state.error) throw new Error(`Screenshot upload failed validation: ${state.error}`);
      const readiness = await this.screenshotItems().evaluateAll((items, previousSources) => {
        const previous = new Set(previousSources);
        const candidates = items.flatMap((item) => {
          const images = [...item.querySelectorAll("img")].filter((image) => {
            const sources = [image.currentSrc, image.getAttribute("src"), image.getAttribute("srcset")].filter(Boolean);
            return sources.some((source) => !previous.has(source));
          });
          return images.length > 0 ? [{ images, item }] : [];
        });
        if (candidates.length !== 1) return false;
        const { images, item } = candidates[0];
        const itemBusy = item.getAttribute("aria-busy") === "true"
          || [...item.querySelectorAll('progress, [role="progressbar"]')].some((progress) => {
            const style = getComputedStyle(progress);
            return progress.isConnected
              && !progress.hidden
              && progress.getAttribute("aria-hidden") !== "true"
              && style.display !== "none"
              && style.visibility !== "hidden";
          });
        return !itemBusy && images.some((image) => image.complete && image.naturalWidth > 0);
      }, this.uploadBeforeSources);
      if (state.started && state.settledAt !== null && readiness) return;
      await this.page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    throw new Error("Uploaded screenshot thumbnail never reached a processed, ready state");
  }

  async armUploadLifecycle() {
    const region = await requireUnique(this.screenshotRegion(), "localized screenshot region");
    const handle = await region.elementHandle();
    if (!handle) throw new Error("Localized screenshot region is not attached");
    await handle.evaluate((element) => {
      element.__lurklootUploadObserver?.disconnect();
      const state = { error: "", settledAt: null, started: false };
      const visible = (candidate) => candidate instanceof HTMLElement
        && candidate.isConnected
        && !candidate.hidden
        && candidate.getAttribute("aria-hidden") !== "true"
        && getComputedStyle(candidate).display !== "none"
        && getComputedStyle(candidate).visibility !== "hidden";
      const descendants = (node, selector) => {
        if (!(node instanceof Element)) return [];
        return [node.matches(selector) ? node : null, ...node.querySelectorAll(selector)].filter(Boolean);
      };
      const update = (records = []) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            const addedError = descendants(node, '[role="alert"]').find(visible);
            if (addedError) state.error = addedError.textContent?.trim() || "Unknown upload error";
          }
        }
        const progress = [...element.querySelectorAll('progress, [role="progressbar"]')].filter(visible);
        if (progress.length > 0) {
          state.started = true;
          state.settledAt = null;
        } else if (state.started && state.settledAt === null) {
          state.settledAt = performance.now();
        }
        const currentError = [...element.querySelectorAll('[role="alert"]')].find(visible);
        if (currentError) state.error = currentError.textContent?.trim() || "Unknown upload error";
      };
      const observer = new MutationObserver(update);
      observer.observe(element, { attributes: true, childList: true, characterData: true, subtree: true });
      element.__lurklootUploadState = state;
      element.__lurklootUploadObserver = observer;
      update();
    });
    return handle;
  }

  async uploadScreenshot(path) {
    const input = await this.requirePngUploadControl();
    this.uploadBeforeSources = await this.screenshotMediaSources();
    this.uploadLifecycle = await this.armUploadLifecycle();
    this.hasMutated = true;
    this.uploadPending = true;
    await input.setInputFiles(path);
  }

  async saveDraft() {
    const save = await requireUnique(this.saveControl(), "draft save button");
    const status = await requireUnique(this.savedIndicator(), "saved-state indicator");
    const statusHandle = await status.elementHandle();
    if (!statusHandle) throw new Error("Saved-state indicator is not attached");
    await statusHandle.evaluate((element, patterns) => {
      element.__lurklootSaveObserver?.disconnect();
      const saved = new RegExp(patterns.saved, "i");
      const saving = new RegExp(patterns.saving, "i");
      const normalize = (text) => text.replace(/\s+/g, " ").trim();
      const state = {
        acknowledged: false,
        lastText: normalize(element.textContent ?? ""),
        sawPending: false,
      };
      const observeText = (text) => {
        const normalized = normalize(text);
        if (!normalized || normalized === state.lastText) return;
        state.lastText = normalized;
        if (saving.test(normalized)) state.sawPending = true;
        else if (saved.test(normalized) && state.sawPending) state.acknowledged = true;
      };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) observeText(node.textContent ?? "");
          if (record.type === "characterData") observeText(record.target.textContent ?? "");
        }
        observeText(element.textContent ?? "");
      });
      observer.observe(element, { childList: true, characterData: true, subtree: true });
      element.__lurklootSaveState = state;
      element.__lurklootSaveObserver = observer;
    }, { saved: LABELS.saved.source, saving: LABELS.saving.source });
    this.hasMutated = true;
    await save.click();
    await this.page.waitForFunction(
      (element) => element.__lurklootSaveState.acknowledged === true,
      statusHandle,
      { timeout: this.timeout },
    );
    await statusHandle.evaluate((element) => element.__lurklootSaveObserver?.disconnect());
    const acknowledgement = await requireUnique(this.savedIndicator(), "saved-state indicator");
    await acknowledgement.filter({ hasText: LABELS.saved }).waitFor({ state: "visible", timeout: this.timeout });
  }
}
