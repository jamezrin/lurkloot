import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
// @ts-expect-error The production utility is an executable JavaScript module.
import { ChromeWebStoreDashboard } from "../scripts/store-screenshot-dashboard.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { main } from "../scripts/upload-store-screenshots.mjs";

let browser: Browser;
let page: Page;

const extensionId = "aobaackpofkghaejdnnmpmeaiaoibhdn";
const publisherId = "12345678-1234-1234-1234-123456789abc";

const fixture = `
  <main>
    <h1>Store listing for aobaackpofkghaejdnnmpmeaiaoibhdn</h1>
    <label>Listing language
      <select>
        <option>English</option>
        <option>Arabic</option>
      </select>
    </label>
    <section aria-label="Localized screenshots">
      <ol>
        ${[1, 2, 3, 4, 5].map((number) => `<li><img src="en-${number}.png" alt="Screenshot ${number}"><span>Screenshot ${number}</span><button aria-label="Remove screenshot ${number}">Remove</button></li>`).join("")}
      </ol>
      <label>Upload screenshots<input type="file" accept="image/png" hidden></label>
    </section>
    <button type="button" id="save">Save draft</button>
    <p role="status">Changes saved</p>
  </main>
  <script>
    const list = document.querySelector("ol");
    document.querySelectorAll('[aria-label^="Remove screenshot"]').forEach((button) => {
      button.addEventListener("click", () => button.closest("li").remove());
    });
    document.querySelector("select").addEventListener("change", (event) => {
      document.querySelector("section").setAttribute("aria-busy", "true");
      document.querySelector("ol li").classList.add("loading");
      setTimeout(() => {
        document.querySelectorAll("ol span").forEach((span, index) => {
          span.textContent = event.target.value + " screenshot " + (index + 1);
        });
        document.querySelectorAll("ol img").forEach((image, index) => {
          image.src = event.target.value + "-" + (index + 1) + ".png";
        });
        document.querySelector("section").removeAttribute("aria-busy");
        document.querySelector("ol li").classList.remove("loading");
      }, 25);
    });
    document.querySelector('input[type="file"]').addEventListener("change", (event) => {
      const item = document.createElement("li");
      const image = document.createElement("img");
      image.alt = "Uploaded screenshot";
      const button = document.createElement("button");
      button.setAttribute("aria-label", "Remove screenshot uploaded");
      button.textContent = "Remove";
      button.addEventListener("click", () => item.remove());
      item.textContent = event.target.files[0].name;
      item.prepend(image);
      item.append(button);
      list.append(item);
      const finishUpload = () => {
        const mode = document.querySelector("main").dataset.uploadResult;
        const progress = document.createElement("div");
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-label", "Uploading screenshot");
        progress.textContent = "Uploading screenshot";
        if (mode === "hidden-progress") progress.hidden = true;
        document.querySelector("section").append(progress);
        if (mode === "hidden-progress") {
          setTimeout(() => { progress.hidden = false; }, 25);
        }
        setTimeout(() => {
          progress.remove();
          if (["error", "delayed-error"].includes(mode)) {
            const alert = document.createElement("p");
            alert.setAttribute("role", "alert");
            alert.textContent = "Screenshot upload failed validation";
            setTimeout(() => { document.querySelector("section").append(alert); }, mode === "delayed-error" ? 700 : 0);
          } else {
            image.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
          }
        }, mode === "hidden-progress" ? 75 : 25);
      };
      if (document.querySelector("main").dataset.uploadResult === "delayed-error") {
        setTimeout(finishUpload, 25);
      } else {
        finishUpload();
      }
    });
    document.querySelector("#save").addEventListener("click", () => {
      document.querySelector('[role="status"]').textContent = "Saving changes";
      setTimeout(() => {
        document.querySelector('[role="status"]').textContent = "Changes saved";
      }, 25);
    });
  </script>
`;

beforeAll(async () => {
  browser = await chromium.launch();
});

beforeEach(async () => {
  page = await browser.newPage();
});

afterEach(async () => {
  await page.close();
});

afterAll(async () => {
  await browser.close();
});

describe("Chrome Web Store dashboard adapter", () => {
  it("uses accessible controls to replace and save a screenshot", async () => {
    await page.setContent(fixture);
    const dashboard = new ChromeWebStoreDashboard({
      page,
      extensionId,
      timeout: 1_000,
    });
    const directory = mkdtempSync(join(tmpdir(), "lurkloot-dashboard-fixture-"));
    const image = join(directory, "lurkloot-01-drops-1280x800.png");
    writeFileSync(image, Buffer.from("fixture"));

    try {
      await dashboard.preflight({ locales: ["en", "ar"] });
      await dashboard.selectLocale("ar");
      expect(await page.getByRole("listitem").first().textContent()).toMatch(/Arabic screenshot 1/);
      expect(await dashboard.screenshotCount()).toBe(5);
      await dashboard.removeFirstScreenshot();
      await dashboard.waitForScreenshotCount(4);
      await dashboard.uploadScreenshot(image);
      await dashboard.waitForScreenshotCount(5);
      expect(await page.locator('[role="progressbar"]').count()).toBe(0);
      await dashboard.saveDraft();

      expect(await page.getByRole("status").textContent()).toBe("Changes saved");
      expect(dashboard.hasMutated).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a mutation control is ambiguous", async () => {
    await page.setContent(fixture.replace("</section>", '<label>Upload screenshots<input type="file" accept="image/png"></label></section>'));
    const dashboard = new ChromeWebStoreDashboard({
      page,
      extensionId,
      timeout: 1_000,
    });

    await expect(dashboard.preflight({ locales: ["en"] })).rejects.toThrow(/upload.*expected exactly one.*found 2/i);
    expect(dashboard.hasMutated).toBe(false);
  });

  it("fails preflight when a requested custom-combobox locale is unavailable", async () => {
    await page.setContent(`
      <h1>Store listing for aobaackpofkghaejdnnmpmeaiaoibhdn</h1>
      <button role="combobox" aria-label="Listing language" aria-expanded="false">English</button>
      <div role="listbox" hidden><button role="option">English</button></div>
      <section aria-label="Localized screenshots">
        <ol>${[1, 2, 3, 4, 5].map((number) => `<li><button aria-label="Remove screenshot ${number}">Remove</button></li>`).join("")}</ol>
        <label>Upload screenshots<input type="file" accept="image/png"></label>
      </section>
      <button>Save draft</button><p role="status">Draft ready</p>
      <script>
        const selector = document.querySelector('[role="combobox"]');
        const listbox = document.querySelector('[role="listbox"]');
        selector.addEventListener("click", () => {
          selector.setAttribute("aria-expanded", "true");
          listbox.hidden = false;
        });
      </script>
    `);
    const dashboard = new ChromeWebStoreDashboard({
      page,
      extensionId,
      timeout: 1_000,
    });

    await expect(dashboard.preflight({ locales: ["en", "ar"] })).rejects.toThrow(/Arabic.*expected exactly one option.*found 0/i);
    expect(dashboard.hasMutated).toBe(false);
  });

  it("accepts the dashboard's native locale names", async () => {
    await page.setContent(fixture.replace("<option>Arabic</option>", "<option>Türkçe</option>"));
    const dashboard = new ChromeWebStoreDashboard({
      page,
      extensionId,
      timeout: 1_000,
    });

    await dashboard.preflight({ locales: ["tr"] });

    expect(await page.getByRole("combobox", { name: /listing language/i }).inputValue()).toBe("Türkçe");
  });

  it("does not expose submission or publication operations", () => {
    const methods = Object.getOwnPropertyNames(ChromeWebStoreDashboard.prototype);
    expect(methods).not.toContain("submit");
    expect(methods).not.toContain("publish");
    expect(methods).not.toContain("submitForReview");
  });

  it("constructs only the configured item's Chrome Web Store edit route", () => {
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, publisherId });

    expect(dashboard.dashboardUrl()).toBe(
      `https://chrome.google.com/webstore/devconsole/${publisherId}/${extensionId}/edit?hl=en`,
    );
  });

  it("requires the configured extension identity to be visible during preflight", async () => {
    await page.setContent(fixture.replaceAll(extensionId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await expect(dashboard.preflight({ locales: ["en"] })).rejects.toThrow(/configured extension identity/i);
    expect(dashboard.hasMutated).toBe(false);
  });

  it("rejects a file input that does not explicitly accept PNG files", async () => {
    await page.setContent(fixture.replace('accept="image/png"', 'accept="image/jpeg"'));
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await expect(dashboard.preflight({ locales: ["en"] })).rejects.toThrow(/PNG.*file input/i);
    expect(dashboard.hasMutated).toBe(false);
  });

  it("waits for upload processing and reports a validation error after thumbnail insertion", async () => {
    await page.setContent(fixture.replace("<main>", '<main data-upload-result="delayed-error">'));
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });
    const directory = mkdtempSync(join(tmpdir(), "lurkloot-dashboard-error-"));
    const image = join(directory, "lurkloot-01-drops-1280x800.png");
    writeFileSync(image, Buffer.from("fixture"));

    try {
      await dashboard.preflight({ locales: ["en"] });
      await dashboard.removeFirstScreenshot();
      await dashboard.waitForScreenshotCount(4);
      await dashboard.uploadScreenshot(image);
      await expect(dashboard.waitForScreenshotCount(5)).rejects.toThrow(/upload failed validation/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat a hidden progress element as a completed upload", async () => {
    await page.setContent(fixture.replace("<main>", '<main data-upload-result="hidden-progress">'));
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });
    const directory = mkdtempSync(join(tmpdir(), "lurkloot-dashboard-hidden-progress-"));
    const image = join(directory, "lurkloot-01-drops-1280x800.png");
    writeFileSync(image, Buffer.from("fixture"));

    try {
      await dashboard.preflight({ locales: ["en"] });
      await dashboard.removeFirstScreenshot();
      await dashboard.waitForScreenshotCount(4);
      await dashboard.uploadScreenshot(image);
      await dashboard.waitForScreenshotCount(5);
      expect(await page.locator('[role="progressbar"]').count()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a fresh save acknowledgement instead of accepting stale saved text", async () => {
    await page.setContent(fixture.replace(/<script>[\s\S]*<\/script>/, ""));
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 100 });

    await expect(dashboard.saveDraft()).rejects.toThrow();
  });

  it("does not treat an unrelated sibling mutation as a fresh save acknowledgement", async () => {
    await page.setContent(fixture.replace(
      'document.querySelector("#save").addEventListener("click", () => {',
      'document.querySelector("#save").addEventListener("click", () => { document.querySelector("h1").textContent += "."; return;',
    ));
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 100 });

    await expect(dashboard.saveDraft()).rejects.toThrow();
  });

  it("does not treat an empty decorative status child as a pending save state", async () => {
    await page.setContent(fixture.replace(
      'document.querySelector("#save").addEventListener("click", () => {',
      'document.querySelector("#save").addEventListener("click", () => { document.querySelector(\'[role="status"]\').append(document.createElement("span")); return;',
    ));
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 100 });

    await expect(dashboard.saveDraft()).rejects.toThrow();
  });

  it("does not accept selector animation when the screenshot panel stays on the old locale", async () => {
    await page.setContent(`
      <label>Listing language<select><option>English</option><option>Arabic</option></select></label>
      <div id="selector-animation">open</div>
      <section aria-label="Localized screenshots">
        <ol>${[1, 2, 3, 4, 5].map((number) => `<li>English screenshot ${number}<button aria-label="Remove screenshot ${number}">Remove</button></li>`).join("")}</ol>
        <label>Upload screenshots<input type="file" accept="image/png"></label>
      </section>
      <script>
        document.querySelector("select").addEventListener("change", () => {
          setTimeout(() => { document.querySelector("#selector-animation").textContent = "closed"; }, 10);
        });
      </script>
    `);
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 100 });

    await expect(dashboard.selectLocale("ar")).rejects.toThrow(/screenshot panel.*Arabic/i);
    expect(await page.getByRole("listitem").first().textContent()).toMatch(/English screenshot 1/);
  });

  it("scopes removal to the first screenshot item", async () => {
    await page.setContent(fixture.replace("<ol>", '<button aria-label="Remove screenshot decoration">Remove decoration</button><ol>'));
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await dashboard.removeFirstScreenshot();

    expect(await page.getByRole("listitem").count()).toBe(4);
    expect(await page.getByRole("button", { name: /remove screenshot decoration/i }).count()).toBe(1);
  });
});

describe("store screenshot upload CLI", () => {
  it("rejects an invalid extension ID before reading screenshot files", async () => {
    let validations = 0;

    await expect(main([], { CWS_EXTENSION_ID: "../../another-item" }, {
      validateFiles: async () => { validations += 1; return new Map(); },
      output: () => {},
    })).rejects.toThrow(/32-character Chrome extension ID/i);

    expect(validations).toBe(0);
  });

  it("validates files before launching a browser", async () => {
    let launches = 0;

    await expect(main([], { CWS_EXTENSION_ID: extensionId }, {
      validateFiles: async () => { throw new Error("missing screenshot"); },
      launchBrowser: async () => { launches += 1; throw new Error("must not launch"); },
      output: () => {},
    })).rejects.toThrow(/missing screenshot/);

    expect(launches).toBe(0);
  });

  it("supports validation-only operation without browser access", async () => {
    let launches = 0;
    const output: string[] = [];
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);

    await main(["--locales", "en", "--validate-only"], { CWS_EXTENSION_ID: extensionId }, {
      validateFiles: async () => files,
      launchBrowser: async () => { launches += 1; throw new Error("must not launch"); },
      output: (message: string) => output.push(message),
    });

    expect(launches).toBe(0);
    expect(output.join("\n")).toMatch(/validated 1 screenshot.*1 locale/i);
  });

  it("requires a publisher ID before browser launch", async () => {
    let launches = 0;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);

    await expect(main(["--locales", "en"], { CWS_EXTENSION_ID: extensionId, CWS_DASHBOARD_URL: "https://example.test/redirect" }, {
      validateFiles: async () => files,
      launchBrowser: async () => { launches += 1; throw new Error("must not launch"); },
      output: () => {},
    })).rejects.toThrow(/CWS_PUBLISHER_ID/i);

    expect(launches).toBe(0);
  });

  it("rejects an invalid publisher path before browser launch", async () => {
    let launches = 0;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);

    await expect(main(["--locales", "en"], { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: "../../other-publisher" }, {
      validateFiles: async () => files,
      launchBrowser: async () => { launches += 1; throw new Error("must not launch"); },
      output: () => {},
    })).rejects.toThrow(/publisher.*UUID/i);

    expect(launches).toBe(0);
  });

  it("creates a non-persistent context and closes it after a complete draft save", async () => {
    const contextOptions: unknown[] = [];
    let browserClosed = false;
    const calls: string[] = [];
    const files = new Map([["en", ["01", "02", "03", "04", "05"].map((number) => ({
      variant: { file: `${number}-new` },
      path: `/${number}.png`,
    }))]]);
    const dashboard = {
      images: ["a", "b", "c", "d", "e"],
      async openAndWaitForAuthentication() { calls.push("authenticated"); },
      async preflight() { calls.push("preflight"); },
      async selectLocale() {},
      async screenshotCount() { return this.images.length; },
      async removeFirstScreenshot() { this.images.shift(); },
      async waitForScreenshotCount(count: number) { expect(this.images).toHaveLength(count); },
      async uploadScreenshot(path: string) { this.images.push(path); },
      async saveDraft() { calls.push("saved"); },
    };
    const fakeBrowser = {
      async newContext(options: unknown) {
        contextOptions.push(options);
        return { newPage: async () => ({}), close: async () => {} };
      },
      async close() { browserClosed = true; },
    };

    await main(["--locales", "en"], { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: publisherId }, {
      validateFiles: async () => files,
      launchBrowser: async () => fakeBrowser,
      createDashboard: () => dashboard,
      output: () => {},
    });

    expect(contextOptions).toEqual([{}]);
    expect(calls).toEqual(["authenticated", "preflight", "saved"]);
    expect(browserClosed).toBe(true);
  });

  it("closes the browser when preflight fails before mutation", async () => {
    let browserClosed = false;
    let contextClosed = false;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);
    const fakeBrowser = {
      async newContext() {
        return { newPage: async () => ({}), close: async () => { contextClosed = true; } };
      },
      async close() { browserClosed = true; },
    };
    const dashboard = {
      hasMutated: false,
      async openAndWaitForAuthentication() {},
      async preflight() { throw new Error("preflight failed"); },
    };

    await expect(main(["--locales", "en"], { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: publisherId }, {
      validateFiles: async () => files,
      launchBrowser: async () => fakeBrowser,
      createDashboard: () => dashboard,
      output: () => {},
    })).rejects.toThrow(/preflight failed/);

    expect(contextClosed).toBe(true);
    expect(browserClosed).toBe(true);
  });

  it("leaves a partially changed draft open for inspection after mutation failure", async () => {
    let inspected = false;
    let browserClosed = false;
    let contextClosed = false;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);
    const dashboard = {
      hasMutated: false,
      async openAndWaitForAuthentication() {},
      async preflight() {},
      async selectLocale() {},
      async screenshotCount() { return 5; },
      async removeFirstScreenshot() {
        this.hasMutated = true;
        throw new Error("remove failed after click");
      },
    };
    const fakeBrowser = {
      async newContext() {
        return { newPage: async () => ({}), close: async () => { contextClosed = true; } };
      },
      async close() { browserClosed = true; },
    };

    await expect(main(["--locales", "en"], { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: publisherId }, {
      validateFiles: async () => files,
      launchBrowser: async () => fakeBrowser,
      createDashboard: () => dashboard,
      waitForInspection: async () => { inspected = true; },
      output: () => {},
    })).rejects.toThrow(/remove failed after click/);

    expect(inspected).toBe(true);
    expect(contextClosed).toBe(false);
    expect(browserClosed).toBe(false);
  });
});
