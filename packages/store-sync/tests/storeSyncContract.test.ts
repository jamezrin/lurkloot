import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ChromeWebStoreDashboard as Dashboard,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/dashboard.mjs";
import {
  sanitizeInPage,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/snapshot.mjs";

// Sanitized copies of the real Chrome Web Store listing page, written by
// `pnpm store:snapshot --locales en es`. The behaviour fixtures in
// storeSyncDashboard.test.ts are hand-built, so they can only prove the
// driver handles the page its author imagined. These prove its locators still
// find things in the page Google actually serves; when the dashboard changes,
// take new snapshots, and the failure points at the locator that broke.
const fixtureDir = join(import.meta.dirname, "fixtures", "cws-dashboard");

const dashboardFor = (page: Page): any =>
  new Dashboard({
    page,
    extensionId: "aobaackpofkghaejdnnmpmeaiaoibhdn",
    timeout: 400,
  });

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});
beforeEach(async () => {
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
});

function load(name: string) {
  return page.setContent(readFileSync(join(fixtureDir, `${name}.html`), "utf8"));
}

describe("dashboard locators against real page snapshots", () => {
  it("finds the listing language and what it is set to", async () => {
    await load("en");
    const english = dashboardFor(page);
    const language = await english.languageControl();
    expect(await language.count()).toBe(1);
    expect(
      await english.selectedLocaleName(
        language,
        await language.evaluate((e: Element) => e.tagName),
      ),
    ).toMatch(/– en \(default\)$/);

    await load("es");
    const spanish = dashboardFor(page);
    const state = await spanish.readLocaleState("es");
    expect(state.language).toMatch(/– es$/);
  });

  it("finds one description field holding the language's text", async () => {
    await load("es");
    const field = dashboardFor(page).descriptionControl();

    expect(await field.count()).toBe(1);
    expect(await field.inputValue()).toMatch(/^Lurkloot /);
  });

  // These snapshots were taken while the item was in review, which is what the
  // dashboard looks like most of the time after a release.
  it("reads the listing status, and refuses to edit a locked listing by naming it", async () => {
    await load("en");
    const dashboard = dashboardFor(page);

    expect(await dashboard.listingStatus()).toBe("Pending review");
    await expect(dashboard.requireEditableListing()).rejects.toThrow(
      /cannot be edited \(Status: Pending review\).*nothing was changed/i,
    );
  });

  it("reads the package title and summary the dashboard shows beside the description", async () => {
    await load("es");
    const dashboard = dashboardFor(page);

    expect(await dashboard.packageText("Title from package")).toMatch(/Lurkloot/);
    expect(await dashboard.packageText("Summary from package")).not.toBe("");
  });

  it("tells an empty localized group from a populated one, and keeps the shared group apart", async () => {
    await load("en");
    const english = dashboardFor(page);
    await english.requireDistinctScreenshotSections();
    expect(await english.screenshotCount("localized")).toBe(0);
    expect(await english.screenshotCount("global")).toBe(5);

    await load("es");
    const spanish = dashboardFor(page);
    await spanish.requireDistinctScreenshotSections();
    expect(await spanish.screenshotCount("localized")).toBe(5);
    expect(await spanish.screenshotCount("global")).toBe(5);
  });

  it("finds a PNG upload control and a save control", async () => {
    await load("en");
    const dashboard = dashboardFor(page);

    await dashboard.requirePngUploadControl("localized");
    await dashboard.requirePngUploadControl("global");
    expect(await dashboard.saveControl().count()).toBe(1);
  });

  it("lets every thumbnail be told apart from the others in its group", async () => {
    await load("es");
    const ids: string[] = await dashboardFor(page).thumbnailIds("localized");

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("dashboard snapshots stay safe to commit", () => {
  const files = readdirSync(fixtureDir).filter((name) => name.endsWith(".html"));

  it("has a snapshot of an empty and a populated language", () => {
    expect(files.sort()).toEqual(expect.arrayContaining(["en.html", "es.html"]));
  });

  for (const file of files) {
    const html = readFileSync(join(fixtureDir, file), "utf8");

    it(`${file} carries no script, style, link or hidden input`, () => {
      expect(html).not.toMatch(/<(script|style|link|meta|iframe|noscript)\b/i);
      expect(html).not.toMatch(/type="hidden"/i);
    });

    it(`${file} carries no email address, id or address of the real session`, () => {
      const emails = html.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
      expect(emails.filter((email) => email !== "user@example.invalid")).toEqual([]);
      const uuids =
        html.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
      expect(uuids.filter((uuid) => !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(uuid))).toEqual([]);
      expect(html).not.toMatch(/googleusercontent|gstatic|accounts\.google/i);
      expect(html).not.toMatch(/<[^>]+\s(href|style|data-[\w-]+|js\w+)=/i);
    });

    it(`${file} lists no account, site or language options`, () => {
      expect(html).not.toMatch(/role="option"/);
    });

    it(`${file} keeps images only as stand-in addresses`, () => {
      const sources = html.match(/<img[^>]*\ssrc="([^"]*)"/g) ?? [];
      for (const source of sources) {
        expect(source).toMatch(/src="https:\/\/images\.example\.invalid\/image-\d+=s1280"/);
      }
    });
  }
});

describe("snapshot sanitizer", () => {
  const dirty = `
    <html><head><title>t</title><script>window.token = "XSRF123"</script><style>p{}</style></head>
    <body>
      <header><div>Google Account</div><div>Pat Example pat@corp.example</div></header>
      <main>
        <h1>Listing 12345678-aaaa-bbbb-cccc-1234567890ab</h1>
        <a href="https://accounts.google.com/x?token=secret" data-token="abc" style="color:red" class="k" jsaction="x" jsdata="y">link</a>
        <input type="hidden" name="xsrf" value="SECRET">
        <input type="text" aria-label="Homepage pat@corp.example" value="https://site.example/pat">
        <textarea>placeholder</textarea>
        <ul role="listbox"><li role="option">Pat Example</li><li role="option">Japanese – ja</li></ul>
        <img src="https://lh3.googleusercontent.com/AAA=s300" alt="Screenshot 1">
        <img src="https://lh3.googleusercontent.com/BBB=s300" alt="Screenshot 2">
        <img src="https://lh3.googleusercontent.com/AAA=s800" alt="Screenshot 3">
        <!-- internal note -->
        <svg><path d="M0 0"/></svg>
      </main>
    </body></html>`;

  async function sanitize(html: string): Promise<string> {
    // The sample points at hosts that must never be contacted from a test.
    await page.route(/^https?:/, (route) => route.abort());
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      document.querySelector("textarea")!.value = "edited description";
    });
    return page.evaluate(sanitizeInPage);
  }

  it("keeps only the form, with nothing that identifies the person or the session", async () => {
    const out = await sanitize(dirty);

    expect(out).toContain("<h1");
    expect(out).not.toMatch(/Pat Example|corp\.example|google|token|secret|XSRF|12345678-aaaa/i);
    expect(out).not.toMatch(
      /<(script|style|header|path)\b|<!--|href=|style=|class=|data-|jsaction|jsdata/i,
    );
    expect(out).not.toMatch(/type="hidden"|role="option"/);
  });

  it("keeps what the locators read: labels, roles, ids and what a field holds", async () => {
    const out = await sanitize(dirty);

    expect(out).toContain('aria-label="Homepage user@example.invalid"');
    expect(out).toContain('role="listbox"');
    expect(out).toContain("edited description");
    expect(out).toContain('value="https://site.example/pat"');
  });

  it("replaces image addresses with stand-ins that keep equal images equal", async () => {
    const out = await sanitize(dirty);
    const sources = [...out.matchAll(/<img[^>]*src="([^"]+)"/g)].map((match) => match[1]);

    expect(sources).toHaveLength(3);
    expect(sources.every((source) => source.startsWith("https://images.example.invalid/"))).toBe(
      true,
    );
    expect(sources[0]).toBe(sources[2]);
    expect(sources[0]).not.toBe(sources[1]);
  });
});
