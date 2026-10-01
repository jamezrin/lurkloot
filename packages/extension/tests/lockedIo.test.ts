import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { LOCKED_IO_CALLS, LOCKS } from "./helpers/lockedIo";

// No provider, tab or timer call runs while a lock is held (#583). This reads
// the source rather than running it, so a call inside a lock fails here even on
// a path no test drives. #584 listed the v1.14.0 sites on an allowlist that the
// v1.15.0 issues emptied; #591 deleted it, so there are no exceptions.
const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, "../../core/src");
// Every background controller module (#592 split controller.ts by owner).
const BACKGROUND_FILES = readdirSync(resolve(coreSrc, "background"))
  .filter((name): name is `${string}.ts` => name.endsWith(".ts"))
  .map((name) => `background/${name}` as const);
type BackgroundFile = (typeof BACKGROUND_FILES)[number];

// Index just past the string, template literal or comment starting at `index`,
// or `index` itself when none starts there. Template substitutions are scanned
// as code, so their own strings and brackets are handled.
function skipLiteral(text: string, index: number): number {
  const char = text[index];
  if (char === "/" && text[index + 1] === "/") {
    const end = text.indexOf("\n", index);
    return end === -1 ? text.length : end;
  }
  if (char === "/" && text[index + 1] === "*") {
    const end = text.indexOf("*/", index + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (char === "\"" || char === "'") {
    let cursor = index + 1;
    while (cursor < text.length && text[cursor] !== char) cursor += text[cursor] === "\\" ? 2 : 1;
    return cursor + 1;
  }
  if (char === "`") {
    let cursor = index + 1;
    while (cursor < text.length && text[cursor] !== "`") {
      if (text[cursor] === "\\") {
        cursor += 2;
      } else if (text[cursor] === "$" && text[cursor + 1] === "{") {
        cursor = skipBalanced(text, cursor + 1, "{", "}");
      } else {
        cursor += 1;
      }
    }
    return cursor + 1;
  }
  return index;
}

// Index just past the bracket that closes the one opening at `index`.
function skipBalanced(text: string, index: number, open: string, close: string): number {
  let depth = 0;
  let cursor = index;
  while (cursor < text.length) {
    const skipped = skipLiteral(text, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }
    if (text[cursor] === open) depth += 1;
    if (text[cursor] === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

// The source with every string, template literal and comment blanked out, at
// the same length, so offsets still line up and only code can match.
function codeOnly(text: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const skipped = skipLiteral(text, cursor);
    if (skipped !== cursor) {
      result += text.slice(cursor, skipped).replace(/[^\n]/g, " ");
      cursor = skipped;
    } else {
      result += text[cursor];
      cursor += 1;
    }
  }
  return result;
}

interface FunctionSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

// Every named function declaration, including nested ones. Functions in these
// files close on a line holding only "}" at the declaration's own indentation.
function functionSpans(text: string): FunctionSpan[] {
  const lines = text.split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const spans: FunctionSpan[] = [];
  lines.forEach((line, start) => {
    const match = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line);
    if (!match) return;
    const end = lines.findIndex((candidate, index) => index > start && candidate === `${match[1]}}`);
    if (end !== -1) spans.push({ name: match[2], start: offsets[start], end: offsets[end + 1] });
  });
  return spans;
}

// The innermost named function containing `offset`.
function enclosingFunction(spans: readonly FunctionSpan[], offset: number): string {
  const containing = spans.filter((span) => span.start <= offset && offset < span.end);
  containing.sort((left, right) => (left.end - left.start) - (right.end - right.start));
  return containing[0]?.name ?? "<top level>";
}

// The argument text of every call to `lock` in `code`: what runs while it is held.
function lockBodies(code: string, lock: string): { offset: number; body: string }[] {
  const bodies: { offset: number; body: string }[] = [];
  const pattern = new RegExp(`\\b${lock}\\(`, "g");
  for (const match of code.matchAll(pattern)) {
    const open = match.index + lock.length;
    bodies.push({ offset: match.index, body: code.slice(open, skipBalanced(code, open, "(", ")")) });
  }
  return bodies;
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CALL_PATTERN = new RegExp(
  `(?<![\\w.])(${[...LOCKED_IO_CALLS].sort((left, right) => right.length - left.length).map(escape).join("|")})\\s*!?\\s*(?:\\?\\.)?\\(`,
  "g",
);

interface Parsed {
  readonly code: string;
  readonly spans: FunctionSpan[];
}

const parsed = new Map<BackgroundFile, Parsed>();
function parse(file: BackgroundFile): Parsed {
  let result = parsed.get(file);
  if (!result) {
    const code = codeOnly(readFileSync(resolve(coreSrc, file), "utf8"));
    result = { code, spans: functionSpans(code) };
    parsed.set(file, result);
  }
  return result;
}

interface FoundCall {
  readonly file: BackgroundFile;
  readonly site: string;
  readonly call: string;
}

// Every listed I/O call made while a lock is held, found in the source.
function lockedCalls(): FoundCall[] {
  const found: FoundCall[] = [];
  for (const file of BACKGROUND_FILES) {
    const { code, spans } = parse(file);
    for (const lock of LOCKS) {
      for (const { offset, body } of lockBodies(code, lock)) {
        const site = enclosingFunction(spans, offset);
        for (const match of body.matchAll(CALL_PATTERN)) found.push({ file, site, call: match[1] });
      }
    }
  }
  return found;
}

// The name a found call is reported under, e.g. "adapter.claimChallenges".
const callName = (call: string): string => call.replace(/\s*!?\s*(?:\?\.)?\($/, "");

describe("locked I/O (#583)", () => {
  it("makes no provider, tab or timer call while a lock is held", () => {
    const locked = [...new Set(lockedCalls().map((found) => `${found.call} in ${found.site} (core/src/${found.file})`))];
    expect(locked, "I/O inside a lock. Move it out of the lock (#583): there is no allowlist.").toEqual([]);
  });

  it("ignores parentheses and calls inside strings, templates and comments", () => {
    const code = codeOnly([
      "function sample() {",
      "  withStateLock(async () => {",
      "    emit(`skipped (trigger=${trigger}`);",
      "    // adapter.claimReward( in a comment, and a stray )",
      "    const note = \"unbalanced ( deps.createAlarm(\";",
      "    await adapter.claimReward(reward);",
      "  });",
      "  adapter.refreshCampaigns();",
      "}",
    ].join("\n"));
    const [{ body }] = lockBodies(code, "withStateLock");
    expect([...body.matchAll(CALL_PATTERN)].map((match) => match[1])).toEqual(["adapter.claimReward"]);
  });
});
