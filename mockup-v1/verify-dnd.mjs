import { chromium } from "playwright-core";

const URL = "http://localhost:5199/";

async function dragHandleToHandle(page, fromIdx, toIdx) {
  const handles = page.locator('button[aria-label^="Reorder"]');
  const from = await handles.nth(fromIdx).boundingBox();
  const to = await handles.nth(toIdx).boundingBox();
  const cx = (b) => b.x + b.width / 2;
  const cy = (b) => b.y + b.height / 2;
  await page.mouse.move(cx(from), cy(from));
  await page.mouse.down();
  // pass the 5px activation constraint
  await page.mouse.move(cx(from), cy(from) + 12, { steps: 4 });
  await page.mouse.move(cx(to), cy(to), { steps: 18 });
  // nudge past target center so the swap settles
  await page.mouse.move(cx(to), cy(to) + (toIdx > fromIdx ? 16 : -16), { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(450);
}

async function order(page) {
  return page
    .locator('button[aria-label^="Reorder"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").replace("Reorder ", "")));
}

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable" });
const results = [];

for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 760 },
    colorScheme: scheme,
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector('button[aria-label^="Reorder"]');

  // ── Campaign drag: move #1 down to #3 ──
  const before = await order(page);
  await dragHandleToHandle(page, 0, 2);
  const after = await order(page);
  results.push({ scheme, test: "campaign reorder", before, after, passed: JSON.stringify(before) !== JSON.stringify(after) });

  // ── Permawatch drag ──
  await page.getByRole("button", { name: /Permawatch/ }).click();
  await page.waitForTimeout(300);
  const pBefore = await order(page);
  await dragHandleToHandle(page, 0, 3);
  const pAfter = await order(page);
  results.push({ scheme, test: "permawatch reorder", before: pBefore, after: pAfter, passed: JSON.stringify(pBefore) !== JSON.stringify(pAfter) });

  results.push({ scheme, test: "no console errors", errors, passed: errors.length === 0 });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
const allPassed = results.every((r) => r.passed);
console.log(allPassed ? "\nALL PASSED ✅" : "\nFAILURES ❌");
process.exit(allPassed ? 0 : 1);
