import { localeConfig } from "./store-screenshot-config.mjs";

export const SECTIONS = Object.freeze({ localized: "localized", global: "global" });

const LABELS = Object.freeze({
  language: /listing language|language|locale/i,
  removeScreenshot: /^remove image screenshot \d+$/i,
  removeConfirmation: /remove image/i,
  confirmRemoval: /^remove$/i,
  saveDraft: /save draft|save changes|save/i,
  saved: /changes saved|saved/i,
  saving: /saving|updating|in progress|please wait/i,
  storeListing: /store listing/i,
  localizedSection: "Localized screenshots",
  globalSection: "Global screenshots",
});

async function requireUnique(locator, description) {
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(`${description}: expected exactly one accessible control, found ${count}`);
  }
  return locator;
}

// The dashboard labels every language option with its own locale code, as in
// "English – en (default)" or "Chinese (China) – zh-CN". Matching that code
// rather than the display name keeps this working when Google renames a
// language or renders the dashboard in another language.
function localeNamePattern(locale) {
  const dashboardCode = locale.code.replace(/_/g, "-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[\\u2013\\u2014-]\\s*${dashboardCode}(?:\\s*\\(default\\))?\\s*$`, "i");
}

export class ChromeWebStoreDashboard {
  constructor({ page, extensionId, publisherId, timeout = 30_000, authenticationTimeout = 10 * 60_000, output = console.log }) {
    this.page = page;
    this.extensionId = extensionId;
    this.publisherId = publisherId;
    this.timeout = timeout;
    this.saveEnableTimeout = 5_000;
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

  // The listing carries two screenshot groups — one per language and one
  // shared — and both label their images "Screenshot N". Neither group has an
  // accessible name, so each is reached from its own visible heading text.
  screenshotRegion(section = SECTIONS.localized) {
    const label = section === SECTIONS.global ? LABELS.globalSection : LABELS.localizedSection;
    // The label sits in its own column, so climbing from it overshoots into a
    // container holding every media group. Instead take the first panel after
    // the label that holds screenshots and an upload input and encloses no
    // smaller panel of the same shape.
    const panel = '*[.//img[starts-with(@alt,"Screenshot")] and .//input[@type="file"] and not(.//*[.//img[starts-with(@alt,"Screenshot")] and .//input[@type="file"]])]';
    return this.page.locator(`xpath=(//*[normalize-space(text())="${label}"])[1]/following::${panel}[1]`);
  }

  screenshotItems(section = SECTIONS.localized) {
    return this.screenshotRegion(section).locator('img[alt^="Screenshot"]');
  }

  removeControls(section = SECTIONS.localized) {
    return this.screenshotRegion(section).getByRole("button", { name: LABELS.removeScreenshot });
  }

  uploadControl(section = SECTIONS.localized) {
    return this.screenshotRegion(section).locator('input[type="file"]');
  }

  saveControl() {
    return this.page.getByRole("button", { name: LABELS.saveDraft });
  }

  uploadErrors(section = SECTIONS.localized) {
    return this.screenshotRegion(section).getByRole("alert");
  }

  async openAndWaitForAuthentication() {
    await this.page.goto(this.dashboardUrl(), { waitUntil: "domcontentloaded" });
    this.output("Chrome opened. If it asks you to sign in, do that and complete 2FA; automation resumes on its own and the session is reused next time.");
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

  // The menu paints its options asynchronously, so counting straight after the
  // click races the dashboard and reports zero matches for every locale.
  async openLanguageMenu(language) {
    if ((await language.getAttribute("aria-expanded")) === "true") return;
    await language.click();
    await this.page.getByRole("option").first().waitFor({ state: "visible", timeout: this.timeout });
  }

  async preflight({ locales }) {
    const identity = this.page.getByText(this.extensionId, { exact: false });
    await requireUnique(identity, "configured extension identity");
    const language = await requireUnique(this.languageControl(), "listing language selector");
    const tagName = await language.evaluate((element) => element.tagName);
    if (tagName !== "SELECT") await this.openLanguageMenu(language);

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
    for (const section of [SECTIONS.localized, SECTIONS.global]) {
      await requireUnique(this.screenshotRegion(section), `${section} screenshot section`);
      const count = await this.screenshotCount(section);
      if (count !== 4 && count !== 5) {
        throw new Error(`${section === SECTIONS.global ? "Global" : "Localized"} screenshots: expected 4 or 5 screenshot items, found ${count}`);
      }
      await this.requirePngUploadControl(section);
    }
    await requireUnique(this.saveControl(), "draft save button");
  }

  async requirePngUploadControl(section = SECTIONS.localized) {
    const input = await requireUnique(this.uploadControl(section), "screenshot upload input");
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

  async screenshotMediaFingerprint(section = SECTIONS.localized) {
    return this.screenshotItems(section).evaluateAll((media) => JSON.stringify(media.map((image) => ({
      alt: image.getAttribute("alt") ?? "",
      currentSrc: image.currentSrc ?? "",
      src: image.getAttribute("src") ?? "",
      srcset: image.getAttribute("srcset") ?? "",
    }))));
  }

  async waitForScreenshotPanelChange(before, dashboardLabel) {
    const deadline = Date.now() + this.timeout;
    let candidate = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      const current = await this.screenshotMediaFingerprint();
      const region = await requireUnique(this.screenshotRegion(), "localized screenshot panel");
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
      await this.openLanguageMenu(language);
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

  async screenshotCount(section = SECTIONS.localized) {
    return this.screenshotItems(section).count();
  }

  async removeFirstScreenshot(section = SECTIONS.localized) {
    const count = await this.screenshotCount(section);
    if (count !== 4 && count !== 5) {
      throw new Error(`Screenshot removal expected 4 or 5 items, found ${count}`);
    }
    // Removal renumbers the remaining labels, so the leading control is taken
    // in DOM order rather than by the number in its name.
    const controls = this.removeControls(section);
    const controlCount = await controls.count();
    if (controlCount !== count) {
      throw new Error(`Screenshot removal expected ${count} remove controls, found ${controlCount}`);
    }
    this.hasMutated = true;
    await controls.first().click();
    await this.confirmRemoval();
  }

  // Removal is destructive and the dashboard asks for confirmation first, so
  // the click alone leaves the screenshot in place.
  async confirmRemoval() {
    const dialog = this.page.getByRole("dialog").filter({ hasText: LABELS.removeConfirmation });
    await dialog.first().waitFor({ state: "visible", timeout: this.timeout });
    const confirm = await requireUnique(dialog.getByRole("button", { name: LABELS.confirmRemoval }), "remove confirmation button");
    await confirm.click();
    await dialog.first().waitFor({ state: "hidden", timeout: this.timeout });
  }

  async waitForScreenshotCount(count, section = SECTIONS.localized) {
    const items = this.screenshotItems(section);
    // Counting tracks attachment, not paint: a freshly inserted thumbnail has
    // no dimensions until its image data arrives, which the upload lifecycle
    // waits for separately.
    if (count > 0) await items.nth(count - 1).waitFor({ state: "attached", timeout: this.timeout });
    await items.nth(count).waitFor({ state: "detached", timeout: this.timeout });
    const actual = await items.count();
    if (actual !== count) throw new Error(`Expected ${count} screenshots, found ${actual}`);
    if (this.uploadPending) await this.waitForUploadCompletion(section);
  }

  async waitForUploadCompletion(section = SECTIONS.localized) {
    if (!this.uploadLifecycle) throw new Error("Screenshot upload lifecycle was not armed before file selection");
    const lifecycle = this.uploadLifecycle;
    // This dashboard never paints a visible progress indicator for a screenshot
    // upload, so completion is taken from the thumbnail itself: a single new
    // image source that has finished decoding. Errors still come from the
    // lifecycle observer's alert watch.
    await this.waitForUploadedThumbnailReady(lifecycle, section);
    const lifecycleError = await lifecycle.evaluate((element) => element.__lurklootUploadState.error);
    const errors = this.uploadErrors(section);
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

  async screenshotMediaSources(section = SECTIONS.localized) {
    return this.screenshotItems(section).evaluateAll((media) => media.flatMap((image) => [
      image.currentSrc ?? "",
      image.getAttribute("src") ?? "",
      image.getAttribute("srcset") ?? "",
    ].filter(Boolean)));
  }

  async waitForUploadedThumbnailReady(lifecycle, section = SECTIONS.localized) {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      const state = await lifecycle.evaluate((element) => ({ ...element.__lurklootUploadState }));
      if (state.error) throw new Error(`Screenshot upload failed validation: ${state.error}`);
      // Thumbnail URLs are re-signed by the dashboard, so a source that was
      // captured earlier cannot identify the new image. Completion is instead
      // every thumbnail having decoded while the panel reports no active work.
      const readiness = await this.screenshotItems(section).evaluateAll((images) => {
        if (images.length === 0) return false;
        let panel = images[0].parentElement;
        while (panel && !panel.querySelector('input[type="file"]')) panel = panel.parentElement;
        const busy = panel?.getAttribute("aria-busy") === "true"
          || [...(panel?.querySelectorAll('progress, [role="progressbar"]') ?? [])].some((progress) => {
            const style = getComputedStyle(progress);
            const box = progress.getBoundingClientRect();
            return progress.isConnected
              && !progress.hidden
              && progress.getAttribute("aria-hidden") !== "true"
              && style.display !== "none"
              && style.visibility !== "hidden"
              && box.height > 0
              && box.width > 0;
          });
        return !busy && images.every((image) => image.complete && image.naturalWidth > 0);
      });
      if (readiness) return;
      await this.page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    throw new Error("Uploaded screenshot thumbnail never reached a processed, ready state");
  }

  async armUploadLifecycle(section = SECTIONS.localized) {
    const region = await requireUnique(this.screenshotRegion(section), "screenshot region");
    const handle = await region.elementHandle();
    if (!handle) throw new Error("Localized screenshot region is not attached");
    await handle.evaluate((element) => {
      element.__lurklootUploadObserver?.disconnect();
      const state = { error: "", settledAt: null, started: false };
      const visible = (candidate) => {
        if (!(candidate instanceof HTMLElement) || !candidate.isConnected) return false;
        if (candidate.hidden || candidate.getAttribute("aria-hidden") === "true") return false;
        const style = getComputedStyle(candidate);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const box = candidate.getBoundingClientRect();
        return box.height > 0 && box.width > 0;
      };
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

  async uploadScreenshot(path, section = SECTIONS.localized) {
    const input = await this.requirePngUploadControl(section);
    this.uploadBeforeSources = await this.screenshotMediaSources(section);
    this.uploadLifecycle = await this.armUploadLifecycle(section);
    this.hasMutated = true;
    this.uploadPending = true;
    await input.setInputFiles(path);
  }

  async saveDraft() {
    const save = await requireUnique(this.saveControl(), "draft save button");
    // Adding and removing images takes effect as it happens, so the control
    // stays disabled when the section left nothing pending. Give it a moment
    // to settle before concluding there is nothing to save.
    const enabledBy = Date.now() + this.saveEnableTimeout;
    while (Date.now() < enabledBy && !(await save.isEnabled())) {
      await this.page.waitForTimeout(100);
    }
    if (!(await save.isEnabled())) {
      this.output("Save draft is inactive; the section reported no pending changes.");
      return;
    }
    // The dashboard creates its live region only when a save first runs, so the
    // announcement is observed at document level rather than bound to an
    // element that may not exist yet.
    await this.page.evaluate((patterns) => {
      window.__lurklootSaveObserver?.disconnect();
      const saved = new RegExp(patterns.saved, "i");
      const saving = new RegExp(patterns.saving, "i");
      const normalize = (text) => text.replace(/\s+/g, " ").trim();
      const state = { acknowledged: false, lastText: "", sawPending: false };
      const observeText = (text) => {
        const normalized = normalize(text);
        if (!normalized || normalized === state.lastText) return;
        state.lastText = normalized;
        if (saving.test(normalized)) state.sawPending = true;
        else if (saved.test(normalized) && state.sawPending) state.acknowledged = true;
      };
      const readRegions = () => {
        for (const region of document.querySelectorAll('[aria-live]:not([role]), [role="status"]')) {
          observeText(region.textContent ?? "");
        }
      };
      const observer = new MutationObserver(readRegions);
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      readRegions();
      window.__lurklootSaveState = state;
      window.__lurklootSaveObserver = observer;
    }, { saved: LABELS.saved.source, saving: LABELS.saving.source });
    this.hasMutated = true;
    await save.click();
    try {
      await this.page.waitForFunction(
        () => window.__lurklootSaveState.acknowledged === true,
        undefined,
        { timeout: this.timeout },
      );
    } finally {
      await this.page.evaluate(() => window.__lurklootSaveObserver?.disconnect());
    }
  }
}
