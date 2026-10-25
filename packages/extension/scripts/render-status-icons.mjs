// Renders the toolbar status icons (#900) from public/icon/source.svg into
// public/icon/status/<status>-<size>.png. The PNGs are committed; rerun this
// after changing the brand mark. Needs `rsvg-convert` (librsvg) on PATH.
//
//   node scripts/render-status-icons.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/icon/source.svg"), "utf8");
const outDir = join(root, "public/icon/status");
const SIZES = [16, 32];

const PLAY = /<path fill="url\(#rx-fill\)" d="\s*M55 50[\s\S]*?Z"\/>/;

function replaceOnce(svg, pattern, replacement) {
  const next = svg.replace(pattern, replacement);
  if (next === svg) throw new Error(`source.svg no longer matches ${pattern}`);
  return next;
}

// A corner dot, cut out of the mark by a ring so it reads on the gradient and
// on light or dark toolbars alike.
function withDot(svg, color, glyph = "") {
  const dot = `
  <g>
    <circle cx="99" cy="99" r="27" fill="#ffffff"/>
    <circle cx="99" cy="99" r="21" fill="${color}"/>${glyph}
  </g>
</svg>`;
  return replaceOnce(svg, /<\/svg>\s*$/, dot);
}

const EXCLAMATION = `
    <rect x="95" y="83" width="8" height="21" rx="4" fill="#ffffff"/>
    <circle cx="99" cy="112" r="4.5" fill="#ffffff"/>`;

const PAUSE = `<g fill="url(#rx-fill)">
      <rect x="47" y="45" width="13" height="38" rx="4"/>
      <rect x="68" y="45" width="13" height="38" rx="4"/>
    </g>`;

const VARIANTS = {
  off: replaceOnce(
    replaceOnce(
      replaceOnce(source, 'stop-color="#a06bff"', 'stop-color="#a1a1aa"'),
      'stop-color="#7c3aed"',
      'stop-color="#71717a"',
    ),
    'stop-color="#3fbf12"',
    'stop-color="#52525b"',
  ),
  watching: withDot(source, "#22c55e"),
  paused: replaceOnce(source, PLAY, PAUSE),
  problem: withDot(source, "#ef4444", EXCLAMATION),
};

mkdirSync(outDir, { recursive: true });
for (const [status, svg] of Object.entries(VARIANTS)) {
  for (const size of SIZES) {
    const output = join(outDir, `${status}-${size}.png`);
    execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", output], {
      input: svg,
    });
    console.log(output);
  }
}
