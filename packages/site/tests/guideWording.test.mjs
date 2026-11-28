// The guide names what people see on screen in **bold**, exactly as the popup
// shows it. This test reads every bold phrase in the guide and checks it
// against the popup's English text (packages/locales/messages/en.json), so a
// renamed button or setting fails here until the guide is updated.
//
// Not checked:
// - lead-ins that end in punctuation, such as "**Signed out.**" or
//   "**From the web app:**", which start a sentence rather than name a label;
// - bold text with a link or code in it;
// - names of other products' screens, listed in NOT_LURKLOOT_UI.
// "**Settings → Export credentials**" is checked one step at a time.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const NOT_LURKLOOT_UI = new Set([
  // Browsers and operating systems
  "Brave",
  "Edge",
  "Opera",
  "Vivaldi",
  "Linux",
  "macOS",
  "Windows",
  "Twitch",
  "Kick",
  // Chrome Web Store and the browser's extensions page
  "Add to Chrome",
  "Developer mode",
  "Update",
  // Windows SmartScreen
  "More info",
  "Run anyway",
  // Browser developer tools
  "Network",
  "Preserve log",
]);

const normalize = (text) =>
  text.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase().replace(/\.$/, "");

async function guideFiles() {
  const root = new URL("../src/content/docs/guide/", import.meta.url);
  const files = await readdir(root, { recursive: true });
  return Promise.all(
    files
      .filter((file) => /\.mdx?$/.test(file))
      .map(async (file) => ({ file, text: await readFile(new URL(file, root), "utf8") })),
  );
}

test("names popup labels in the guide exactly as the popup does", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../../locales/messages/en.json", import.meta.url), "utf8"),
  );
  const messages = Object.values(catalog).map((entry) => normalize(entry.message));
  // A label matches a message that is exactly it, or that starts with it and
  // goes on to a placeholder or more words ("Unpin all ($1)", "Maintain watch
  // streak on $1").
  const isLabel = (label) =>
    messages.some(
      (message) =>
        message === label
        || (message.startsWith(label) && /^[\s(:]/.test(message.slice(label.length))),
    );

  const problems = [];
  for (const { file, text } of await guideFiles()) {
    for (const [, bold] of text.matchAll(/\*\*([^*]+)\*\*/g)) {
      if (/[.:,?!]$/.test(bold) || /[[`]/.test(bold)) continue;
      for (const part of bold.split("→").map((step) => step.trim())) {
        if (NOT_LURKLOOT_UI.has(part)) continue;
        if (!isLabel(normalize(part))) problems.push(`${file}: **${part}**`);
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    "These bold phrases are not popup labels. Use the popup's wording from en.json, "
      + "end a lead-in with punctuation, use *italics* for emphasis, or add another "
      + "product's label to NOT_LURKLOOT_UI.",
  );
});
