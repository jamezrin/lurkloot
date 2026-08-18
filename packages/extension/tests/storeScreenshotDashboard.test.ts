import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
        ${[1, 2, 3, 4, 5].map((number) => `<li><span>Screenshot ${number}</span><button aria-label="Remove screenshot ${number}">Remove</button></li>`).join("")}
      </ol>
      <label>Upload screenshots<input type="file" accept="image/png" hidden></label>
    </section>
    <button type="button" id="save">Save draft</button>
    <p role="status">Draft ready</p>
  </main>
  <script>
    const list = document.querySelector("ol");
    document.querySelectorAll('[aria-label^="Remove screenshot"]').forEach((button) => {
      button.addEventListener("click", () => button.closest("li").remove());
    });
    document.querySelector('input[type="file"]').addEventListener("change", (event) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.setAttribute("aria-label", "Remove screenshot uploaded");
      button.textContent = "Remove";
      button.addEventListener("click", () => item.remove());
      item.textContent = event.target.files[0].name;
      item.append(button);
      list.append(item);
    });
    document.querySelector("#save").addEventListener("click", () => {
      document.querySelector('[role="status"]').textContent = "Changes saved";
    });
  </script>
`;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("Chrome Web Store dashboard adapter", () => {
  it("uses accessible controls to replace and save a screenshot", async () => {
    await page.setContent(fixture);
    const dashboard = new ChromeWebStoreDashboard({
      page,
      extensionId: "aobaackpofkghaejdnnmpmeaiaoibhdn",
      timeout: 1_000,
    });
    const directory = mkdtempSync(join(tmpdir(), "lurkloot-dashboard-fixture-"));
    const image = join(directory, "lurkloot-01-drops-1280x800.png");
    writeFileSync(image, Buffer.from("fixture"));

    try {
      await dashboard.preflight({ locales: ["en", "ar"] });
      await dashboard.selectLocale("ar");
      expect(await dashboard.screenshotCount()).toBe(5);
      await dashboard.removeFirstScreenshot();
      await dashboard.waitForScreenshotCount(4);
      await dashboard.uploadScreenshot(image);
      await dashboard.waitForScreenshotCount(5);
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
      extensionId: "aobaackpofkghaejdnnmpmeaiaoibhdn",
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
        ${[1, 2, 3, 4, 5].map((number) => `<button aria-label="Remove screenshot ${number}">Remove</button>`).join("")}
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
      extensionId: "aobaackpofkghaejdnnmpmeaiaoibhdn",
      timeout: 1_000,
    });

    await expect(dashboard.preflight({ locales: ["en", "ar"] })).rejects.toThrow(/Arabic.*expected exactly one option.*found 0/i);
    expect(dashboard.hasMutated).toBe(false);
  });

  it("accepts the dashboard's native locale names", async () => {
    await page.setContent(fixture.replace("<option>Arabic</option>", "<option>Türkçe</option>"));
    const dashboard = new ChromeWebStoreDashboard({
      page,
      extensionId: "aobaackpofkghaejdnnmpmeaiaoibhdn",
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
});

describe("store screenshot upload CLI", () => {
  it("validates files before launching a browser", async () => {
    let launches = 0;

    await expect(main([], { CWS_EXTENSION_ID: "extension" }, {
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

    await main(["--locales", "en", "--validate-only"], { CWS_EXTENSION_ID: "extension" }, {
      validateFiles: async () => files,
      launchBrowser: async () => { launches += 1; throw new Error("must not launch"); },
      output: (message: string) => output.push(message),
    });

    expect(launches).toBe(0);
    expect(output.join("\n")).toMatch(/validated 1 screenshot.*1 locale/i);
  });

  it("requires a publisher path or explicit dashboard URL before browser launch", async () => {
    let launches = 0;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);

    await expect(main(["--locales", "en"], { CWS_EXTENSION_ID: "extension" }, {
      validateFiles: async () => files,
      launchBrowser: async () => { launches += 1; throw new Error("must not launch"); },
      output: () => {},
    })).rejects.toThrow(/CWS_PUBLISHER_ID.*CWS_DASHBOARD_URL/i);

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

    await main(["--locales", "en"], { CWS_EXTENSION_ID: "extension", CWS_DASHBOARD_URL: "https://example.test/dashboard" }, {
      validateFiles: async () => files,
      launchBrowser: async () => fakeBrowser,
      createDashboard: () => dashboard,
      output: () => {},
    });

    expect(contextOptions).toEqual([{}]);
    expect(calls).toEqual(["authenticated", "preflight", "saved"]);
    expect(browserClosed).toBe(true);
  });
});
