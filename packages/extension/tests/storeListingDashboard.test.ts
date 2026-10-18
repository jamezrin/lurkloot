import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  ChromeWebStoreDashboard as Dashboard,
  thumbnailId,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../scripts/store-listing/core/dashboard.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { main as runMain, parseListingParts } from "../scripts/store-listing/cli.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { LISTING } from "../scripts/store-listing/lurkloot.mjs";

// These tests inject their own screenshot files and fake dashboards, so they
// inject provenance too and leave the readback to storeListingVerify.test.ts.
const main = (args: string[], env: Record<string, string>, dependencies: Record<string, unknown>) =>
  runMain(args[0] === "verify" ? args : [...args, "--no-verify"], env, {
    checkProvenance: async () => {},
    ...dependencies,
  });

// The driver is generic; these tests exercise it with the Lurkloot profile.
type DashboardInstance = any;
const ChromeWebStoreDashboard = class {
  constructor(options: Record<string, unknown>) {
    return new Dashboard({ listing: LISTING, ...options });
  }
} as unknown as new (
  options: Record<string, unknown>,
) => DashboardInstance;

let browser: Browser;
let page: Page;

const extensionId = "aobaackpofkghaejdnnmpmeaiaoibhdn";
const descriptions = new Map([["en", "English body"]]);
const publisherId = "12345678-1234-1234-1234-123456789abc";

const fixture = `
  <main>
    <h1>Store listing for aobaackpofkghaejdnnmpmeaiaoibhdn</h1>
    <label>Listing language
      <select>
        <option>English – en (default)</option>
        <option>Arabic – ar</option>
      </select>
    </label>
    <span>Localized screenshots</span>
    <div id="panel">
      <ol>
        ${[1, 2, 3, 4, 5].map((number) => `<li><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=#en-${number}" alt="Screenshot ${number}"><span>Screenshot ${number}</span><div role="button" aria-label="Remove image Screenshot ${number}">Remove</div></li>`).join("")}
      </ol>
      <input type="file" accept="image/png">
    </div>
    <span>Global screenshots</span>
      <div id="global-panel">
        <ol>${[1, 2, 3, 4, 5].map((number) => `<li><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=#g-${number}" alt="Screenshot ${number}"><div role="button" aria-label="Remove image Screenshot ${number}">Remove</div></li>`).join("")}</ol>
        <input type="file" accept="image/png">
      </div>
    </div>
    <div role="dialog" aria-label="Remove Image" id="confirm" hidden>
      <p>Remove Image. Are you sure you want to remove this image? This cannot be undone.</p>
      <button type="button" id="cancel">Cancel</button>
      <button type="button" id="confirm-remove">Remove</button>
    </div>
    <button type="button" id="save">Save draft</button>
    <p aria-live="polite"></p>
  </main>
  <script>
    const list = document.querySelector("ol");
    const renumber = () => {
      document.querySelectorAll("ol li").forEach((item, index) => {
        item.querySelector("img").alt = "Screenshot " + (index + 1);
        item.querySelector('[role="button"]').setAttribute("aria-label", "Remove image Screenshot " + (index + 1));
      });
    };
    let pendingRemoval = null;
    document.addEventListener("click", (event) => {
      const control = event.target.closest('[aria-label^="Remove image Screenshot"]');
      if (!control) return;
      pendingRemoval = control.closest("li");
      document.querySelector("#confirm").hidden = false;
    });
    document.querySelector("#confirm-remove").addEventListener("click", () => {
      document.querySelector("#confirm").hidden = true;
      pendingRemoval?.remove();
      pendingRemoval = null;
      renumber();
    });
    document.querySelector("select").addEventListener("change", (event) => {
      document.querySelector("#panel").setAttribute("aria-busy", "true");
      document.querySelector("ol li").classList.add("loading");
      setTimeout(() => {
        document.querySelectorAll("ol span").forEach((span, index) => {
          span.textContent = event.target.value + " screenshot " + (index + 1);
        });
        document.querySelectorAll("ol img").forEach((image, index) => {
          image.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=#" + event.target.value + "-" + (index + 1);
        });
        document.querySelector("#panel").removeAttribute("aria-busy");
        document.querySelector("ol li").classList.remove("loading");
      }, 25);
    });
    document.querySelector('input[type="file"]').addEventListener("change", (event) => {
      const item = document.createElement("li");
      const image = document.createElement("img");
      const button = document.createElement("div");
      button.setAttribute("role", "button");
      button.textContent = "Remove";
      item.textContent = event.target.files[0].name;
      item.prepend(image);
      item.append(button);
      list.append(item);
      renumber();
      const finishUpload = () => {
        const mode = document.querySelector("main").dataset.uploadResult;
        const progress = document.createElement("div");
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-label", "Uploading screenshot");
        progress.textContent = "Uploading screenshot";
        if (mode === "hidden-progress") progress.hidden = true;
        document.querySelector("#panel").append(progress);
        if (mode === "hidden-progress") {
          setTimeout(() => { progress.hidden = false; }, 25);
        }
        setTimeout(() => {
          progress.remove();
          if (["error", "delayed-error"].includes(mode)) {
            const alert = document.createElement("p");
            alert.setAttribute("role", "alert");
            alert.textContent = "Screenshot upload failed validation";
            setTimeout(() => { document.querySelector("#panel").append(alert); }, mode === "delayed-error" ? 700 : 0);
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
      document.querySelector('[aria-live="polite"]').textContent = "Saving item...";
      setTimeout(() => {
        document.querySelector('[aria-live="polite"]').textContent = "Item saved.";
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
      expect(await page.getByRole("listitem").first().textContent()).toMatch(
        /Arabic – ar screenshot 1/,
      );
      expect(await dashboard.screenshotCount()).toBe(5);
      await dashboard.removeFirstScreenshot();
      await dashboard.waitForScreenshotCount(4);
      await dashboard.uploadScreenshot(image);
      await dashboard.waitForScreenshotCount(5);
      expect(await page.locator('[role="progressbar"]').count()).toBe(0);
      await dashboard.saveDraft();

      expect(await page.locator('[aria-live="polite"]').textContent()).toBe("Item saved.");
      expect(dashboard.hasMutated).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a mutation control is ambiguous", async () => {
    await page.setContent(
      fixture.replace(
        '<input type="file" accept="image/png">',
        '<input type="file" accept="image/png"><input type="file" accept="image/png">',
      ),
    );
    const dashboard = new ChromeWebStoreDashboard({
      page,
      extensionId,
      timeout: 1_000,
    });

    await expect(dashboard.preflight({ locales: ["en"] })).rejects.toThrow(
      /upload.*expected exactly one.*found 2/i,
    );
    expect(dashboard.hasMutated).toBe(false);
  });

  it("fails preflight when a requested custom-combobox locale is unavailable", async () => {
    await page.setContent(`
      <h1>Store listing for aobaackpofkghaejdnnmpmeaiaoibhdn</h1>
      <button role="combobox" aria-label="Listing language" aria-expanded="false">English – en (default)</button>
      <div role="listbox" hidden><button role="option">English – en (default)</button></div>
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

    await expect(dashboard.preflight({ locales: ["en", "ar"] })).rejects.toThrow(
      /Arabic.*expected exactly one option.*found 0/i,
    );
    expect(dashboard.hasMutated).toBe(false);
  });

  it("identifies a locale by its code even when the dashboard renders a translated name", async () => {
    await page.setContent(
      fixture.replace("<option>Arabic – ar</option>", "<option>Türkçe – tr</option>"),
    );
    const dashboard = new ChromeWebStoreDashboard({
      page,
      extensionId,
      timeout: 1_000,
    });

    await dashboard.preflight({ locales: ["tr"] });

    expect(await page.getByRole("combobox", { name: /listing language/i }).inputValue()).toBe(
      "Türkçe – tr",
    );
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

    await expect(dashboard.preflight({ locales: ["en"] })).rejects.toThrow(
      /configured extension identity/i,
    );
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
      await expect(dashboard.waitForScreenshotCount(5)).rejects.toThrow(
        /upload failed validation/i,
      );
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
    await page.setContent(
      fixture.replace(
        'document.querySelector("#save").addEventListener("click", () => {',
        'document.querySelector("#save").addEventListener("click", () => { document.querySelector("h1").textContent += "."; return;',
      ),
    );
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 100 });

    await expect(dashboard.saveDraft()).rejects.toThrow();
  });

  it("does not treat an empty decorative status child as a pending save state", async () => {
    await page.setContent(
      fixture.replace(
        'document.querySelector("#save").addEventListener("click", () => {',
        'document.querySelector("#save").addEventListener("click", () => { document.querySelector(\'[aria-live="polite"]\').append(document.createElement("span")); return;',
      ),
    );
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 100 });

    await expect(dashboard.saveDraft()).rejects.toThrow();
  });

  it("does not accept selector animation when the screenshot panel stays on the old locale", async () => {
    await page.setContent(`
      <label>Listing language<select><option>English – en (default)</option><option>Arabic – ar</option></select></label>
      <div id="selector-animation">open</div>
      <span>Localized screenshots</span>
      <div id="panel">
        <ol>${[1, 2, 3, 4, 5].map((number) => `<li><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=#en-${number}" alt="Screenshot ${number}">English screenshot ${number}<div role="button" aria-label="Remove image Screenshot ${number}">Remove</div></li>`).join("")}</ol>
        <input type="file" accept="image/png">
      </div>
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

  it("ignores remove controls belonging to other images", async () => {
    await page.setContent(
      fixture.replace(
        "<ol>",
        '<div role="button" aria-label="Remove image Store icon">Remove decoration</div><ol>',
      ),
    );
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await dashboard.removeFirstScreenshot();

    expect(await page.locator("#panel li").count()).toBe(4);
    expect(await page.getByRole("button", { name: "Remove image Store icon" }).count()).toBe(1);
  });
});

describe("Chrome Web Store dashboard readback", () => {
  it("names a hosted thumbnail by the path segment before its size suffix", () => {
    expect(thumbnailId("https://lh3.googleusercontent.com/AbC-123_x=s1280-w1280")).toBe(
      "AbC-123_x",
    );
    expect(thumbnailId("https://lh3.googleusercontent.com/AbC-123_x")).toBe("AbC-123_x");
    expect(thumbnailId("data:image/png;base64,AAAA#ar-1")).toBe("data:image/png;base64,AAAA#ar-1");
    expect(thumbnailId("")).toBe("");
  });

  it("reads one language's description and both screenshot groups without changing anything", async () => {
    await page.setContent(
      fixture.replace(
        "<span>Localized screenshots</span>",
        "<label>Description<textarea>Body</textarea></label><span>Localized screenshots</span>",
      ),
    );
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    const state = await dashboard.readLocaleState("ar");

    expect(state.language).toBe("Arabic – ar");
    expect(state.description).toBe("Body");
    expect(state.localized).toHaveLength(5);
    expect(state.global).toHaveLength(5);
    expect(new Set(state.localized).size).toBe(5);
    expect(dashboard.hasMutated).toBe(false);
  });

  it("reloads the listing from the server, discarding edits the page only holds locally", async () => {
    let requests = 0;
    await page.route("https://dashboard.test/**", (route) => {
      requests += 1;
      return route.fulfill({ contentType: "text/html", body: fixture });
    });
    await page.goto("https://dashboard.test/listing");
    await page.evaluate(() => {
      document.querySelector("h1")!.textContent = "edited locally";
    });
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await dashboard.reload();

    expect(requests).toBe(2);
    expect(await page.locator("h1").textContent()).toMatch(/Store listing for/);
  });
});

describe("Chrome Web Store dashboard adapter for new languages", () => {
  // A language added since the last run has an empty localized group.
  const emptyLocalizedFixture = fixture.replace(
    /(<div id="panel">\s*<ol>)[\s\S]*?(<\/ol>)/,
    "$1$2",
  );

  it("finds an empty localized group instead of the shared one and fills it", async () => {
    await page.setContent(emptyLocalizedFixture);
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });
    const directory = mkdtempSync(join(tmpdir(), "lurkloot-dashboard-fixture-"));
    const image = join(directory, "lurkloot-01-drops-1280x800.png");
    writeFileSync(image, Buffer.from("fixture"));

    try {
      await dashboard.preflight({ locales: ["en"] });
      expect(await dashboard.screenshotCount("localized")).toBe(0);
      expect(await dashboard.screenshotCount("global")).toBe(5);

      await dashboard.uploadScreenshot(image);
      await dashboard.waitForScreenshotCount(1);

      expect(await dashboard.screenshotCount("localized")).toBe(1);
      expect(await page.locator("#global-panel img").count()).toBe(5);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // Switching from English, whose images sit only in the shared group, to a new
  // language changes neither the empty localized group nor the description the
  // dashboard pre-fills from English. Only the package title and summary differ.
  it("accepts a switch between two empty localized groups once the package summary changes", async () => {
    await page.setContent(`
      <label>Listing language<select><option>English – en (default)</option><option>Japanese – ja</option></select></label>
      <div><p>Title from package</p><p id="title">Lurkloot - Twitch &amp; Kick Drop Farmer</p></div>
      <div><p>Summary from package</p><p id="summary">Farm Twitch and Kick drops.</p></div>
      <label>Description<textarea>English body</textarea></label>
      <span>Localized screenshots</span>
      <div id="panel"><ol></ol><input type="file" accept="image/png"></div>
      <span>Global screenshots</span>
      <div id="global-panel">
        <ol>${[1, 2, 3, 4, 5].map((number) => `<li><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=#g-${number}" alt="Screenshot ${number}"></li>`).join("")}</ol>
        <input type="file" accept="image/png">
      </div>
      <script>
        document.querySelector("select").addEventListener("change", () => {
          setTimeout(() => {
            document.querySelector("#title").textContent = "Lurkloot - Twitch & Kick ドロップファーマー";
            document.querySelector("#summary").textContent = "Twitch と Kick のドロップをファームします。";
          }, 25);
        });
      </script>
    `);
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await dashboard.selectLocale("ja");

    expect(await dashboard.screenshotCount("localized")).toBe(0);
    expect(await page.locator("#summary").textContent()).toMatch(/ドロップ/);
  });

  it("fails closed when both groups resolve to the same panel", async () => {
    await page.setContent(
      fixture
        .replace("<span>Global screenshots</span>", "")
        .replace(
          "<span>Localized screenshots</span>",
          "<span>Localized screenshots</span><span>Global screenshots</span>",
        ),
    );
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await expect(dashboard.preflight({ locales: ["en"] })).rejects.toThrow(/same panel/i);
    expect(dashboard.hasMutated).toBe(false);
  });

  it("sets the detailed description and reports an unchanged one", async () => {
    await page.setContent(
      fixture.replace(
        "<span>Localized screenshots</span>",
        "<label>Description<textarea>Old body</textarea></label><span>Localized screenshots</span>",
      ),
    );
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await dashboard.preflight({ locales: ["en"], screenshots: false, descriptions: true });
    expect(await dashboard.setDescription("New body\n\nSecond paragraph")).toBe(true);
    expect(await page.locator("textarea").inputValue()).toBe("New body\n\nSecond paragraph");
    expect(await dashboard.setDescription("New body\n\nSecond paragraph")).toBe(false);
    expect(dashboard.hasMutated).toBe(true);
  });

  it("requires a single description field when descriptions are synced", async () => {
    await page.setContent(fixture);
    const dashboard = new ChromeWebStoreDashboard({ page, extensionId, timeout: 1_000 });

    await expect(
      dashboard.preflight({ locales: ["en"], screenshots: false, descriptions: true }),
    ).rejects.toThrow(/detailed description field.*found 0/i);
  });
});

describe("store listing CLI", () => {
  it("rejects an invalid extension ID before reading screenshot files", async () => {
    let validations = 0;

    await expect(
      main(
        [],
        { CWS_EXTENSION_ID: "../../another-item" },
        {
          validateFiles: async () => {
            validations += 1;
            return new Map();
          },
          output: () => {},
        },
      ),
    ).rejects.toThrow(/32-character Chrome extension ID/i);

    expect(validations).toBe(0);
  });

  it("validates files before launching a browser", async () => {
    let launches = 0;

    await expect(
      main(
        [],
        { CWS_EXTENSION_ID: extensionId },
        {
          validateFiles: async () => {
            throw new Error("missing screenshot");
          },
          openBrowser: async () => {
            launches += 1;
            throw new Error("must not launch");
          },
          output: () => {},
        },
      ),
    ).rejects.toThrow(/missing screenshot/);

    expect(launches).toBe(0);
  });

  it("supports validation-only operation without browser access", async () => {
    let launches = 0;
    const output: string[] = [];
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);

    await main(
      ["--locales", "en", "--validate-only"],
      { CWS_EXTENSION_ID: extensionId },
      {
        validateFiles: async () => files,
        loadDescriptions: async () => descriptions,
        openBrowser: async () => {
          launches += 1;
          throw new Error("must not launch");
        },
        output: (message: string) => output.push(message),
      },
    );

    expect(launches).toBe(0);
    expect(output.join("\n")).toMatch(/validated 1 screenshot.*1 locale/i);
    expect(output.join("\n")).toMatch(/validated 1 description.*1 locale/i);
  });

  it("requires a publisher ID before browser launch", async () => {
    let launches = 0;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);

    await expect(
      main(
        ["--locales", "en"],
        { CWS_EXTENSION_ID: extensionId, CWS_DASHBOARD_URL: "https://example.test/redirect" },
        {
          validateFiles: async () => files,
          loadDescriptions: async () => descriptions,
          openBrowser: async () => {
            launches += 1;
            throw new Error("must not launch");
          },
          output: () => {},
        },
      ),
    ).rejects.toThrow(/CWS_PUBLISHER_ID/i);

    expect(launches).toBe(0);
  });

  it("rejects an invalid publisher path before browser launch", async () => {
    let launches = 0;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);

    await expect(
      main(
        ["--locales", "en"],
        { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: "../../other-publisher" },
        {
          validateFiles: async () => files,
          loadDescriptions: async () => descriptions,
          openBrowser: async () => {
            launches += 1;
            throw new Error("must not launch");
          },
          output: () => {},
        },
      ),
    ).rejects.toThrow(/publisher.*UUID/i);

    expect(launches).toBe(0);
  });

  it("reuses the attached browser's existing context and finishes the session after a complete draft save", async () => {
    let finished = false;
    let newContextCalls = 0;
    const calls: string[] = [];
    const files = new Map([
      [
        "en",
        ["01", "02", "03", "04", "05"].map((number) => ({
          variant: { file: `${number}-new` },
          path: `/${number}.png`,
        })),
      ],
    ]);
    const dashboard = {
      images: ["a", "b", "c", "d", "e"],
      async openAndWaitForAuthentication() {
        calls.push("authenticated");
      },
      async preflight() {
        calls.push("preflight");
      },
      async selectLocale() {},
      async setDescription() {
        calls.push("description");
        return true;
      },
      async requireDistinctScreenshotSections() {},
      async screenshotCount() {
        return this.images.length;
      },
      async removeFirstScreenshot() {
        this.images.shift();
      },
      async waitForScreenshotCount(count: number) {
        expect(this.images).toHaveLength(count);
      },
      async uploadScreenshot(path: string) {
        this.images.push(path);
      },
      async saveDraft() {
        calls.push("saved");
      },
    };
    const session = {
      ownsBrowser: true,
      context: { newPage: async () => ({}) },
      browser: {
        newContext: async () => {
          newContextCalls += 1;
          return {};
        },
      },
    };

    await main(
      ["--locales", "en"],
      { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: publisherId },
      {
        validateFiles: async () => files,
        loadDescriptions: async () => descriptions,
        openBrowser: async () => session,
        finishBrowser: async () => {
          finished = true;
        },
        createDashboard: () => dashboard,
        output: () => {},
      },
    );

    // One save each for the description, the locale's own screenshots and the
    // shared global set.
    expect(calls).toEqual(["authenticated", "preflight", "description", "saved", "saved", "saved"]);
    expect(newContextCalls).toBe(0);
    expect(finished).toBe(true);
  });

  it("keeps the signed-in browser when preflight fails before mutation", async () => {
    let finished = false;
    let abandoned: { mutated: boolean } | undefined;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);
    const dashboard = {
      hasMutated: false,
      async openAndWaitForAuthentication() {},
      async preflight() {
        throw new Error("preflight failed");
      },
    };

    await expect(
      main(
        ["--locales", "en"],
        { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: publisherId },
        {
          validateFiles: async () => files,
          loadDescriptions: async () => descriptions,
          openBrowser: async () => ({ ownsBrowser: true, context: { newPage: async () => ({}) } }),
          finishBrowser: async () => {
            finished = true;
          },
          abandonBrowser: async (
            _session: unknown,
            _output: unknown,
            options: { mutated: boolean },
          ) => {
            abandoned = options;
          },
          createDashboard: () => dashboard,
          output: () => {},
        },
      ),
    ).rejects.toThrow(/preflight failed/);

    // Rebuilding the session costs another sign-in and 2FA, so it is kept.
    expect(abandoned).toEqual({ mutated: false });
    expect(finished).toBe(false);
  });

  it("keeps the browser when the sign-in wait itself fails", async () => {
    let finished = false;
    let abandoned = false;
    const files = new Map([["en", [{ variant: { file: "01-drops" }, path: "/one.png" }]]]);
    const dashboard = {
      hasMutated: false,
      async openAndWaitForAuthentication() {
        throw new Error("never signed in");
      },
    };

    await expect(
      main(
        ["--locales", "en"],
        { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: publisherId },
        {
          validateFiles: async () => files,
          loadDescriptions: async () => descriptions,
          openBrowser: async () => ({ ownsBrowser: true, context: { newPage: async () => ({}) } }),
          finishBrowser: async () => {
            finished = true;
          },
          abandonBrowser: async () => {
            abandoned = true;
          },
          createDashboard: () => dashboard,
          output: () => {},
        },
      ),
    ).rejects.toThrow(/never signed in/);

    // The operator may have signed in while this very step was still waiting.
    expect(abandoned).toBe(true);
    expect(finished).toBe(false);
  });

  it("abandons the session so a partially changed draft stays open after mutation failure", async () => {
    let finished = false;
    let abandoned = false;
    const files = new Map([
      [
        "en",
        ["01", "02", "03", "04", "05"].map((number) => ({
          variant: { file: `${number}-new` },
          path: `/${number}.png`,
        })),
      ],
    ]);
    const dashboard = {
      hasMutated: false,
      async openAndWaitForAuthentication() {},
      async preflight() {},
      async selectLocale() {},
      async setDescription() {
        return false;
      },
      async requireDistinctScreenshotSections() {},
      async screenshotCount() {
        return 5;
      },
      async removeFirstScreenshot() {
        this.hasMutated = true;
        throw new Error("remove failed after click");
      },
    };

    await expect(
      main(
        ["--locales", "en"],
        { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: publisherId },
        {
          validateFiles: async () => files,
          loadDescriptions: async () => descriptions,
          openBrowser: async () => ({ ownsBrowser: true, context: { newPage: async () => ({}) } }),
          finishBrowser: async () => {
            finished = true;
          },
          abandonBrowser: async (
            _session: unknown,
            _output: unknown,
            options: { mutated: boolean },
          ) => {
            abandoned = options.mutated;
          },
          createDashboard: () => dashboard,
          output: () => {},
        },
      ),
    ).rejects.toThrow(/remove failed after click/);

    expect(abandoned).toBe(true);
    expect(finished).toBe(false);
  });

  it("syncs descriptions without reading screenshot files", async () => {
    let validations = 0;
    const output: string[] = [];

    await main(
      ["--only", "descriptions", "--locales", "en", "--validate-only"],
      { CWS_EXTENSION_ID: extensionId },
      {
        validateFiles: async () => {
          validations += 1;
          throw new Error("must not read screenshots");
        },
        loadDescriptions: async () => descriptions,
        output: (message: string) => output.push(message),
      },
    );

    expect(validations).toBe(0);
    expect(output.join("\n")).not.toMatch(/screenshot/i);
  });

  it("validates descriptions before launching a browser", async () => {
    let launches = 0;

    await expect(
      main(
        ["--only", "descriptions"],
        { CWS_EXTENSION_ID: extensionId, CWS_PUBLISHER_ID: publisherId },
        {
          loadDescriptions: async () => {
            throw new Error("description too long");
          },
          openBrowser: async () => {
            launches += 1;
            throw new Error("must not launch");
          },
          output: () => {},
        },
      ),
    ).rejects.toThrow(/description too long/);

    expect(launches).toBe(0);
  });

  it("parses the listing part selector", () => {
    expect(parseListingParts(["--locales", "en"])).toEqual({
      parts: ["screenshots", "descriptions"],
      rest: ["--locales", "en"],
    });
    expect(parseListingParts(["--", "--only", "screenshots", "--locales", "ar"])).toEqual({
      parts: ["screenshots"],
      rest: ["--", "--locales", "ar"],
    });
    expect(() => parseListingParts(["--only", "summary"])).toThrow(/--only expects one of/);
    expect(() => parseListingParts(["--only"])).toThrow(/--only expects one of/);
    expect(() => parseListingParts(["--only", "screenshots", "--only", "descriptions"])).toThrow(
      /Duplicate option --only/,
    );
  });
});
