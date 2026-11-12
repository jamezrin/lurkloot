import { randomUUID } from "node:crypto";
import { chmod, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, type FormattingOptions, type JSONPath } from "jsonc-parser";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import { CURRENT_SETTINGS_SCHEMA_VERSION } from "@lurkloot/shared/settingsSchema";
import { overlaySettingsPatch, type SettingsPatch } from "@lurkloot/shared/settings";
import { errorMessage } from "@lurkloot/shared/errors";
import { parseConfig, parseConfigJsonc, type CliConfig } from "./config";
import {
  CliSettingsValidationError,
  DEFAULT_CLI_SETTINGS,
  parseCliSettingsWithDiagnostics,
  toEngineSettings,
  type CliSettings,
} from "./settings";

// The settings store `lurkloot serve` (#975) hands the controller as
// `storage.loadSettings`/`saveSettings` (#976). It maps engine settings back to
// the CLI's own schema, validates them with the rules `validate-config` uses,
// and edits config.json atomically. `run` never uses it: the run loop reads the
// config once and never writes it. `serve` builds it from the config path
// (serveLoop's configPath), so the settings messages its control plane
// forwards are applied and saved here.
//
// Two rules decide what a save may contain:
// - Every CLI key round-trips: load, change, save, load gives back the change.
// - A field the CLI schema has no key for is accepted only while it still holds
//   the value toEngineSettings pins or defaults it to (tablessMode, the
//   pauseOnManualWatch and autoStartDropFarming invariants, ...). Any other value,
//   or a field the engine contract does not have at all (an extension-only knob
//   such as muteFarmingTabs or twitchExtensions), is rejected with
//   CliSettingsStoreError instead of being dropped.

export type CliSettingsStoreErrorCode =
  // The settings carry a field the CLI config cannot hold, or a value for an
  // engine-only field other than the one the CLI pins.
  | "unrepresentable"
  // The CLI settings rules reject a value, or would cut it down (a watchlist
  // over the engine limit).
  | "invalid"
  // The config file on disk cannot be read or parsed.
  | "config_unreadable"
  // The edited file would not load back as the settings being saved. Nothing
  // was written.
  | "verification_failed";

export class CliSettingsStoreError extends Error {
  readonly code: CliSettingsStoreErrorCode;
  // Dotted settings paths the error is about, e.g. "tablessMode" or
  // "platform.twitch.watchlistChannels". Empty when no single path applies.
  readonly paths: string[];

  constructor(code: CliSettingsStoreErrorCode, message: string, paths: string[] = []) {
    super(message);
    this.name = "CliSettingsStoreError";
    this.code = code;
    this.paths = paths;
  }
}

// The two file operations a save performs, injectable so tests can fail either
// one. `writeTempFile` creates `path` (it must not exist), writes `text`, makes
// its permission bits exactly `mode` and flushes it to disk.
export interface SettingsStoreFileSystem {
  writeTempFile(path: string, text: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface CliSettingsStoreOptions {
  fileSystem?: Partial<SettingsStoreFileSystem>;
  // Called once when load keeps the last settings it read because the file
  // stopped loading (a bad hand edit, an editor caught mid-write), and again
  // only after the file has loaded once more.
  onUnreadable?: (error: CliSettingsStoreError) => void;
}

export interface CliSettingsStore {
  // Absolute path of the config file.
  readonly configPath: string;
  // The engine settings the config file currently describes, as toEngineSettings
  // builds them for `run`. Parses the file again only when it changed on disk
  // (another inode, size or modification time), so a save or a hand edit is
  // seen by the next call. Each call returns its own copy. Once it has read the
  // file, a file that stops loading leaves it on the last settings it read, so
  // a broken hand edit does not fail every tick; save still refuses to write
  // over it.
  load(): Promise<EngineSettings>;
  // Writes `settings` to the config file. Resolves once the file is replaced, or
  // at once when the file already describes these settings. Rejects with
  // CliSettingsStoreError, leaving the file untouched, when the settings cannot
  // be represented or validated. Saves are applied one at a time.
  save(settings: EngineSettings): Promise<void>;
  // The controller's applySettingsPatch for this store: layers `patch` over
  // `current` with the shared overlay, then validates the result with the rules
  // save uses. Throws CliSettingsStoreError (unrepresentable or invalid, with
  // the offending paths) instead of dropping or correcting what the patch
  // carries, so a rejected change never reaches save.
  applyPatch(current: EngineSettings, patch: SettingsPatch): EngineSettings;
}

const PLATFORMS: Platform[] = ["twitch", "kick"];
const NESTED_KEYS = ["platform", "compatibility"] as const;
type NestedKey = (typeof NESTED_KEYS)[number];
const SCHEMA_VERSION_KEY = "schemaVersion";

// Key sets derived from the defaults, so a new CLI setting is covered without
// a second list to update.
const TOP_LEVEL_CLI_KEYS = Object.keys(DEFAULT_CLI_SETTINGS).filter(
  (key) => !(NESTED_KEYS as readonly string[]).includes(key),
) as (keyof CliSettings)[];
const NESTED_CLI_KEYS: Record<NestedKey, Record<Platform, string[]>> = {
  platform: {
    twitch: Object.keys(DEFAULT_CLI_SETTINGS.platform.twitch),
    kick: Object.keys(DEFAULT_CLI_SETTINGS.platform.kick),
  },
  compatibility: {
    twitch: Object.keys(DEFAULT_CLI_SETTINGS.compatibility.twitch),
    kick: Object.keys(DEFAULT_CLI_SETTINGS.compatibility.kick),
  },
};

// Every settings path the CLI schema holds, as [key] or [block, platform, key].
export function cliSettingsPaths(): string[][] {
  const paths: string[][] = TOP_LEVEL_CLI_KEYS.map((key) => [key]);
  for (const block of NESTED_KEYS) {
    for (const platform of PLATFORMS) {
      for (const key of NESTED_CLI_KEYS[block][platform]) paths.push([block, platform, key]);
    }
  }
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

// Maps engine settings onto the CLI schema: the inverse of toEngineSettings for
// every CLI key. Throws CliSettingsStoreError when a field outside the CLI
// schema differs from what toEngineSettings would produce, or when the CLI
// rules reject or cut down a value.
export function engineToCliSettings(engine: EngineSettings): CliSettings {
  const input: unknown = engine;
  if (!isRecord(input)) {
    throw new CliSettingsStoreError("invalid", "Settings must be an object");
  }

  const picked: Record<string, unknown> = { [SCHEMA_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION };
  for (const key of TOP_LEVEL_CLI_KEYS) {
    if (Object.hasOwn(input, key)) picked[key] = input[key];
  }
  for (const block of NESTED_KEYS) {
    const source = input[block];
    if (!isRecord(source)) continue;
    const out: Record<string, Record<string, unknown>> = {};
    for (const platform of PLATFORMS) {
      const entry = source[platform];
      if (!isRecord(entry)) continue;
      out[platform] = {};
      for (const key of NESTED_CLI_KEYS[block][platform]) {
        if (Object.hasOwn(entry, key)) out[platform][key] = entry[key];
      }
    }
    picked[block] = out;
  }

  let parsed: ReturnType<typeof parseCliSettingsWithDiagnostics>;
  try {
    parsed = parseCliSettingsWithDiagnostics(picked);
  } catch (error) {
    throw new CliSettingsStoreError(
      "invalid",
      errorMessage(error),
      error instanceof CliSettingsValidationError ? error.paths : [],
    );
  }
  // The migration reports nothing for current-version input, so only a limit
  // can show up here. Saving it would drop part of the value.
  const limited = parsed.diagnostics.filter((diagnostic) => diagnostic.code === "limit_exceeded");
  if (limited.length > 0) {
    throw new CliSettingsStoreError(
      "invalid",
      `Invalid CLI settings:\n  - ${limited.map((diagnostic) => diagnostic.message).join("\n  - ")}`,
      limited.map((diagnostic) => diagnostic.path),
    );
  }

  const expected = toEngineSettings(parsed.settings) as unknown as Record<string, unknown>;
  const offenders: { path: string; message: string }[] = [];
  const check = (path: string[], value: unknown, expectedParent: unknown) => {
    const dotted = path.join(".");
    const key = path[path.length - 1];
    if (value === undefined) return;
    if (!isRecord(expectedParent) || !Object.hasOwn(expectedParent, key)) {
      offenders.push({
        path: dotted,
        message: `"${dotted}" is not a CLI setting and cannot be saved to the config file`,
      });
    } else if (!isDeepStrictEqual(value, expectedParent[key])) {
      offenders.push({
        path: dotted,
        message: `"${dotted}" cannot be changed in the CLI, which always uses ${JSON.stringify(expectedParent[key])}`,
      });
    }
  };
  for (const [key, value] of Object.entries(input)) {
    if (key === SCHEMA_VERSION_KEY) continue;
    if ((TOP_LEVEL_CLI_KEYS as string[]).includes(key)) continue;
    if ((NESTED_KEYS as readonly string[]).includes(key) && isRecord(value)) {
      const block = key as NestedKey;
      for (const [platform, entry] of Object.entries(value)) {
        if (!PLATFORMS.includes(platform as Platform) || !isRecord(entry)) {
          check([block, platform], entry, expected[block]);
          continue;
        }
        for (const [nestedKey, nestedValue] of Object.entries(entry)) {
          if (NESTED_CLI_KEYS[block][platform as Platform].includes(nestedKey)) continue;
          check([block, platform, nestedKey], nestedValue, valueAt(expected, [block, platform]));
        }
      }
      continue;
    }
    check([key], value, expected);
  }
  if (offenders.length > 0) {
    throw new CliSettingsStoreError(
      "unrepresentable",
      `Settings the CLI config cannot hold:\n  - ${offenders.map((offender) => offender.message).join("\n  - ")}`,
      offenders.map((offender) => offender.path),
    );
  }
  return parsed.settings;
}

interface ConfigFile {
  text: string;
  raw: Record<string, unknown>;
  config: CliConfig;
}

async function readConfigFile(configPath: string): Promise<ConfigFile> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    throw new CliSettingsStoreError(
      "config_unreadable",
      `Could not read config at ${configPath}: ${errorMessage(error)}`,
    );
  }
  try {
    const raw = parseConfigJsonc(text, configPath);
    const config = parseConfig(raw, configPath);
    return { text, raw: raw as Record<string, unknown>, config };
  } catch (error) {
    throw new CliSettingsStoreError("config_unreadable", errorMessage(error));
  }
}

function formattingOf(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

// Edits only the values that change, so the file keeps its comments, key order
// and formatting. Safe only when the settings block is already in the current
// schema form: an older schemaVersion would replay migrations over the keys
// written here, and a legacy alias left beside its replacement could win.
//
// A key the file leaves out can be derived from another one: without its own
// `watchSourcePriority`, a platform's order follows `idleWatchlistFallbackOnly`.
// Changing the latter then changes the former on reload, so each pass reloads
// the edited text and also writes any value that still comes back different.
function editChangedValues(file: ConfigFile, target: CliSettings, configPath: string): string {
  const formattingOptions = formattingOf(file.text);
  let text = file.text;
  let current: CliSettings = file.config.settings;
  for (let pass = 0; pass < 3 && !isDeepStrictEqual(current, target); pass += 1) {
    for (const path of cliSettingsPaths()) {
      const next = valueAt(target, path);
      if (isDeepStrictEqual(valueAt(current, path), next)) continue;
      const edits = modify(text, ["settings", ...path] as JSONPath, next, { formattingOptions });
      text = applyEdits(text, edits);
    }
    current = parseConfig(parseConfigJsonc(text, configPath), configPath).settings;
  }
  return text;
}

// Merges `target` into `existing`, keeping the existing key order: keys already
// there keep their place, new ones follow in the schema's order, and keys
// `target` no longer has are dropped unless `keep` says otherwise.
function ordered(
  existing: unknown,
  target: Record<string, unknown>,
  keep: (key: string, value: unknown) => boolean = () => false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isRecord(existing)) {
    for (const [key, value] of Object.entries(existing)) {
      if (Object.hasOwn(target, key)) out[key] = target[key];
      else if (keep(key, value)) out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(target)) {
    if (!Object.hasOwn(out, key)) out[key] = value;
  }
  return out;
}

// Rewrites the whole settings block in the current schema form: schemaVersion
// first when it is new, legacy aliases migrated away, `enabledLogLevels` (still
// accepted, with its deprecation warning) kept as written. The rest of the file,
// including transport, authDir and comments outside the block, is untouched.
function rewriteSettingsBlock(file: ConfigFile, target: CliSettings): string {
  const rawSettings = file.raw.settings;
  const nested = (block: NestedKey) => {
    const existing = valueAt(rawSettings, [block]);
    const out: Record<string, unknown> = {};
    for (const [platform, entry] of Object.entries(
      ordered(existing, target[block] as unknown as Record<string, unknown>),
    )) {
      out[platform] = ordered(valueAt(existing, [platform]), entry as Record<string, unknown>);
    }
    return out;
  };
  const canonical: Record<string, unknown> = {
    [SCHEMA_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION,
    ...target,
    platform: nested("platform"),
    compatibility: nested("compatibility"),
  };
  const settings = ordered(rawSettings, canonical, (key) => key === "enabledLogLevels");
  const edits = modify(file.text, ["settings"], settings, {
    formattingOptions: formattingOf(file.text),
  });
  return applyEdits(file.text, edits);
}

function inCurrentSchemaForm(file: ConfigFile): boolean {
  const rawSettings = file.raw.settings;
  if (!isRecord(rawSettings)) return false;
  if (rawSettings[SCHEMA_VERSION_KEY] !== CURRENT_SETTINGS_SCHEMA_VERSION) return false;
  return parseCliSettingsWithDiagnostics(rawSettings).diagnostics.length === 0;
}

// Renders the config text that holds `target`, or undefined when the file
// already does. The result is parsed back before anything is written.
export function renderConfigWithSettings(
  text: string,
  configPath: string,
  target: CliSettings,
): string | undefined {
  const raw = parseConfigJsonc(text, configPath);
  const config = parseConfig(raw, configPath);
  const file: ConfigFile = { text, raw: raw as Record<string, unknown>, config };
  if (isDeepStrictEqual(config.settings, target)) return undefined;
  let next: string;
  let reloaded: CliConfig;
  try {
    next = inCurrentSchemaForm(file)
      ? editChangedValues(file, target, configPath)
      : rewriteSettingsBlock(file, target);
    reloaded = parseConfig(parseConfigJsonc(next, configPath), configPath);
  } catch (error) {
    throw new CliSettingsStoreError(
      "verification_failed",
      `The edited config would not load: ${errorMessage(error)}`,
    );
  }
  if (
    reloaded.transport !== config.transport
    || reloaded.authDir !== config.authDir
    || !isDeepStrictEqual(reloaded.settings, target)
  ) {
    throw new CliSettingsStoreError(
      "verification_failed",
      "The edited config would not load back as the saved settings",
    );
  }
  return next;
}

function sameKind(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right);
  return typeof left === typeof right;
}

// The CLI rules normalize the values they keep: a number is clamped or
// rounded, an unknown string falls back to its default, a wrong type to the
// default. That is right for a hand-edited file, but a patch is one deliberate
// change, so each value it sets must come back as given. Lists and objects of
// the right kind may still be normalized (channel names lowercased, duplicates
// dropped, a reward filter completed).
function patchOffenders(patch: Record<string, unknown>, result: EngineSettings): string[] {
  const offenders: string[] = [];
  const compare = (path: string[], value: unknown) => {
    const normalized = valueAt(result, path);
    if (value === undefined || normalized === undefined) return;
    if (
      !sameKind(value, normalized)
      || ((typeof value === "number" || typeof value === "string") && value !== normalized)
    ) {
      offenders.push(path.join("."));
    }
  };
  for (const [key, value] of Object.entries(patch)) {
    if (!(NESTED_KEYS as readonly string[]).includes(key)) {
      compare([key], value);
      continue;
    }
    if (value === undefined) continue;
    if (!isRecord(value)) {
      offenders.push(key);
      continue;
    }
    // The overlay keeps only twitch and kick, so name any other key here
    // rather than let it vanish.
    for (const name of Object.keys(value)) {
      if (!PLATFORMS.includes(name as Platform)) offenders.push(`${key}.${name}`);
    }
    for (const platform of PLATFORMS) {
      const entry = value[platform];
      if (entry === undefined) continue;
      if (!isRecord(entry)) {
        offenders.push(`${key}.${platform}`);
        continue;
      }
      for (const [nestedKey, nestedValue] of Object.entries(entry)) {
        compare([key, platform, nestedKey], nestedValue);
      }
    }
  }
  return offenders;
}

// Applies a settings patch for the CLI: the shared overlay, then the rules
// save checks. See CliSettingsStore.applyPatch.
export function applyCliSettingsPatch(
  current: EngineSettings,
  patch: SettingsPatch,
): EngineSettings {
  const input: unknown = patch;
  if (!isRecord(input)) {
    throw new CliSettingsStoreError("invalid", "A settings patch must be a JSON object");
  }
  const result = toEngineSettings(engineToCliSettings(overlaySettingsPatch(current, patch)));
  const offenders = patchOffenders(input, result);
  if (offenders.length > 0) {
    throw new CliSettingsStoreError(
      "invalid",
      `Invalid CLI settings:\n  - ${offenders
        .map((path) => `"${path}" is not a value the CLI accepts here`)
        .join("\n  - ")}`,
      offenders,
    );
  }
  return result;
}

const NODE_FILE_SYSTEM: SettingsStoreFileSystem = {
  async writeTempFile(path, text, mode) {
    const handle = await open(path, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // open() applies the umask; set the original bits exactly.
    await chmod(path, mode);
  },
  rename: (from, to) => rename(from, to),
};

// Replaces `path` with `text` through a temporary file in the same directory,
// so a reader sees the old file or the new one, never a partial write. A
// symlinked config keeps its link: the link's target is replaced.
async function writeAtomically(
  path: string,
  text: string,
  fileSystem: SettingsStoreFileSystem,
): Promise<void> {
  const target = await realpath(path);
  const mode = (await stat(target)).mode & 0o777;
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fileSystem.writeTempFile(temp, text, mode);
    await fileSystem.rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createCliSettingsStore(
  configPath: string,
  options: CliSettingsStoreOptions = {},
): CliSettingsStore {
  const absolute = resolve(process.cwd(), configPath);
  const fileSystem: SettingsStoreFileSystem = { ...NODE_FILE_SYSTEM, ...options.fileSystem };
  let queue: Promise<unknown> = Promise.resolve();
  let cached: { key: string; settings: EngineSettings } | undefined;
  let reportedUnreadable = false;

  // Stat first, then read: a write landing between the two leaves a key older
  // than the text, so the next call reads again rather than keeping stale
  // settings. A save replaces the file by rename, which changes the inode.
  async function load(): Promise<EngineSettings> {
    let key: string | undefined;
    try {
      const info = await stat(absolute, { bigint: true });
      key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    } catch {
      key = undefined;
    }
    if (key === undefined || cached?.key !== key) {
      let settings: EngineSettings;
      try {
        settings = toEngineSettings((await readConfigFile(absolute)).config.settings);
      } catch (error) {
        if (!cached || !(error instanceof CliSettingsStoreError)) throw error;
        // The key stays the last good one, so the next call reads again.
        if (!reportedUnreadable) {
          reportedUnreadable = true;
          options.onUnreadable?.(error);
        }
        return structuredClone(cached.settings);
      }
      reportedUnreadable = false;
      cached = key === undefined ? undefined : { key, settings };
      return structuredClone(settings);
    }
    return structuredClone(cached.settings);
  }

  async function saveNow(settings: EngineSettings): Promise<void> {
    const target = engineToCliSettings(settings);
    const file = await readConfigFile(absolute);
    const next = renderConfigWithSettings(file.text, absolute, target);
    if (next === undefined) return;
    await writeAtomically(absolute, next, fileSystem);
  }

  return {
    configPath: absolute,
    load,
    save(settings) {
      const run = queue.then(() => saveNow(settings));
      queue = run.catch(() => undefined);
      return run;
    },
    applyPatch: applyCliSettingsPatch,
  };
}
