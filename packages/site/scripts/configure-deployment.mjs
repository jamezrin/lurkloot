import { appendFile, writeFile } from "node:fs/promises";

const channel = process.env.SITE_DEPLOYMENT_CHANNEL ?? "production";

if (!new Set(["prerelease", "production"]).has(channel)) {
  throw new Error(`Unsupported site deployment channel: ${channel}`);
}

if (channel === "prerelease") {
  await writeFile(
    new URL("../dist/robots.txt", import.meta.url),
    "User-agent: *\nDisallow: /\n",
  );
  await appendFile(
    new URL("../dist/_headers", import.meta.url),
    "\n/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n",
  );
}
