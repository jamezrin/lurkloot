import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  LOCKED_IO_ALLOWLIST,
  LOCKED_IO_ALLOWLIST_SIZE,
  LOCKED_IO_CALLS,
  type LockedIoEntry,
  type LockedIoLock,
} from "./helpers/lockedIo";

// Keeps the locked-I/O allowlist (#584) exact while v1.15.0 removes its
// entries. It reads the source rather than running it:
// - every provider, tab or timer call found inside a lock must be listed, so no
//   new one can appear unnoticed;
// - every listed call must still be inside its lock, so the PR that fixes a
//   site also deletes its entry and lowers LOCKED_IO_ALLOWLIST_SIZE.
const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, "../../core/src");
// Every background controller module (#592 split controller.ts by owner).
const BACKGROUND_FILES = readdirSync(resolve(coreSrc, "background"))
  .filter((name): name is `${string}.ts` => name.endsWith(".ts"))
  .map((name) => `background/${name}` as const);
const LOCKS: readonly Exclude<LockedIoLock, "caller">[] = ["withStateLock", "withPlatformLock", "withSettingsLock", "withHeartbeatLane"];
// Functions whose whole body runs inside a lock their caller holds: Kick
// page-context recovery runs inside runTick's withStateLock. The scheduler
// tick's effects (#599) run with no lock held.
const CALLER_LOCKED: readonly { file: LockedIoEntry["file"]; site: string }[] = [
  { file: "background/kickChallenges.ts", site: "reconcilePageContextRecoveryAfterPersist" },
];

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

const parsed = new Map<LockedIoEntry["file"], Parsed>();
function parse(file: LockedIoEntry["file"]): Parsed {
  let result = parsed.get(file);
  if (!result) {
    const code = codeOnly(readFileSync(resolve(coreSrc, file), "utf8"));
    result = { code, spans: functionSpans(code) };
    parsed.set(file, result);
  }
  return result;
}

interface FoundCall {
  readonly file: LockedIoEntry["file"];
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
  for (const { file, site } of CALLER_LOCKED) {
    const scheduler = parse(file);
    const span = scheduler.spans.find((candidate) => candidate.name === site);
    if (!span) throw new Error(`function ${site} not found in core/src/${file}`);
    for (const match of scheduler.code.slice(span.start, span.end).matchAll(CALL_PATTERN)) found.push({ file, site, call: match[1] });
  }
  return found;
}

// The name a found call is reported under, e.g. "adapter.claimChallenges".
const callName = (call: string): string => call.replace(/\s*!?\s*(?:\?\.)?\($/, "");

describe("locked-I/O allowlist (#584)", () => {
  it("has unique ids", () => {
    const ids = LOCKED_IO_ALLOWLIST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only shrinks: its length matches LOCKED_IO_ALLOWLIST_SIZE", () => {
    expect(
      LOCKED_IO_ALLOWLIST.length,
      "Removing an entry lowers LOCKED_IO_ALLOWLIST_SIZE in the same change. No change may add an entry or raise the size.",
    ).toBe(LOCKED_IO_ALLOWLIST_SIZE);
  });

  it("lists every provider, tab and timer call made while a lock is held", () => {
    const unlisted = lockedCalls().filter((found) => !LOCKED_IO_ALLOWLIST.some((entry) =>
      entry.file === found.file && entry.site === found.site && callName(entry.call) === found.call));
    const described = [...new Set(unlisted.map((found) => `${found.call} in ${found.site} (core/src/${found.file})`))];
    expect(
      described,
      "New I/O inside a lock. Move it out of the lock instead of listing it (#583).",
    ).toEqual([]);
  });

  it.each(LOCKED_IO_ALLOWLIST.map((entry) => [entry.id, entry] as const))("%s is still inside its lock", (_id, entry) => {
    const { code, spans } = parse(entry.file);
    const span = spans.find((candidate) => candidate.name === entry.site);
    expect(span, `function ${entry.site} not found in core/src/${entry.file}`).toBeDefined();
    const body = code.slice(span!.start, span!.end);
    const scopes = entry.lock === "caller" ? [body] : lockBodies(body, entry.lock).map((scope) => scope.body);
    expect(scopes.length, `${entry.site} no longer calls ${entry.lock}`).toBeGreaterThan(0);
    expect(
      scopes.some((scope) => scope.includes(entry.call)),
      `${entry.call} no longer runs inside ${entry.lock} in ${entry.site}. If #${entry.owner} fixed it, delete "${entry.id}" and lower LOCKED_IO_ALLOWLIST_SIZE.`,
    ).toBe(true);
    expect(LOCKED_IO_CALLS as readonly string[], `${entry.id}: add ${callName(entry.call)} to LOCKED_IO_CALLS`).toContain(callName(entry.call));
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
