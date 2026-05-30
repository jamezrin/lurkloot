// Renders public/logo.svg to crisp PNG icons for the web extension.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";

const svg = readFileSync("public/logo.svg", "utf8");
const enc = encodeURIComponent(svg);
const sizes = [16, 32, 48, 96, 128];
mkdirSync("public/icon", { recursive: true });

const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable" });
for (const sz of sizes) {
  const p = await b.newPage({ viewport: { width: sz, height: sz }, deviceScaleFactor: 1 });
  await p.setContent(
    `<!doctype html><html><body style="margin:0">
     <img src="data:image/svg+xml;utf8,${enc}" width="${sz}" height="${sz}" style="display:block"/>
     </body></html>`
  );
  await p.waitForTimeout(120);
  await p.screenshot({ path: `public/icon/${sz}.png`, omitBackground: true });
  await p.close();
  console.log(`icon ${sz}x${sz} -> public/icon/${sz}.png`);
}
await b.close();
