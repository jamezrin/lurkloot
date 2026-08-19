import { spawn } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Google rejects interactive sign-in in a browser Playwright launched itself
// ("Couldn't sign you in — this browser or app may not be secure"). The
// operator's Chrome is therefore started as an ordinary browser with no
// automation switches, and Playwright only attaches over CDP afterwards.
const DEFAULT_PORT = 9333;

// The signed-in profile is kept between runs so the operator authenticates
// once rather than on every sync. It holds a live Google session, so it lives
// with the user's other browser state rather than anywhere inside the
// repository, and is never distributed.
const stateHome = process.env.XDG_STATE_HOME
  || (process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".local", "state"));
const DEFAULT_PROFILE_DIR = join(stateHome, "lurkloot", "cws-chrome-profile");

// Chrome channels first: Chromium builds are the ones Google turns away at
// sign-in, so a box carrying both must not silently resolve to Chromium.
const BINARY_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chrome",
  "chromium",
  "chromium-browser",
];

const CHROMIUM_CANDIDATES = new Set(["chromium", "chromium-browser"]);

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveBrowserBinary({ env = process.env, exists = isExecutable } = {}) {
  if (env.CWS_CHROME_BINARY) {
    if (!(await exists(env.CWS_CHROME_BINARY))) {
      throw new Error(`CWS_CHROME_BINARY is not an executable file: ${env.CWS_CHROME_BINARY}`);
    }
    return { path: env.CWS_CHROME_BINARY, name: env.CWS_CHROME_BINARY, isChromium: false };
  }
  const searchPath = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of BINARY_CANDIDATES) {
    for (const directory of searchPath) {
      const candidate = join(directory, name);
      if (await exists(candidate)) {
        return { path: candidate, name, isChromium: CHROMIUM_CANDIDATES.has(name) };
      }
    }
  }
  throw new Error(
    `No Chrome binary found on PATH (looked for ${BINARY_CANDIDATES.join(", ")}). Set CWS_CHROME_BINARY to its full path.`,
  );
}

export function endpointUrl(env = process.env) {
  const port = env.CWS_CDP_PORT ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

export async function probeEndpoint(url, { fetchImpl = fetch, timeoutMs = 1000 } = {}) {
  try {
    const response = await fetchImpl(`${url}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForEndpoint(url, exitState, { probe, deadlineMs }) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const exited = exitState.code;
    if (exited !== undefined) {
      // Chrome forwards to an existing instance holding the same profile and
      // exits at once, so a clean exit here is a failure, not a success.
      throw new Error(
        `Chrome exited (code ${exited}) before the debugging port answered. Another instance may already own this profile.`,
      );
    }
    if (await probe(url)) return;
    await new Promise((settle) => setTimeout(settle, 200));
  }
  throw new Error(`Chrome did not open a debugging endpoint on ${url} within ${deadlineMs}ms.`);
}

export async function startBrowserSession({
  env = process.env,
  output = console.log,
  connect,
  resolveBinary = resolveBrowserBinary,
  spawnBrowser = spawn,
  probe = probeEndpoint,
  makeProfileDir = async () => {
    await mkdir(DEFAULT_PROFILE_DIR, { recursive: true });
    return DEFAULT_PROFILE_DIR;
  },
  readyTimeoutMs = 30000,
} = {}) {
  const url = endpointUrl(env);

  // An endpoint that already answers belongs to the operator; attach to it and
  // never take ownership of its lifetime.
  if (await probe(url)) {
    output(`Attaching to the Chrome already listening on ${url}.`);
    const browser = await connect(url);
    return { browser, context: requireContext(browser, url), ownsBrowser: false, url };
  }

  const binary = await resolveBinary({ env });
  if (binary.isChromium) {
    output(`Warning: only ${binary.name} was found. Google often refuses sign-in on Chromium builds; set CWS_CHROME_BINARY to Google Chrome if sign-in fails.`);
  }
  const profileDir = env.CWS_CHROME_PROFILE ?? (await makeProfileDir());
  const child = spawnBrowser(
    binary.path,
    [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${new URL(url).port}`, "--no-first-run", "--no-default-browser-check"],
    { detached: true, stdio: "ignore" },
  );
  // Attached at spawn time: Chrome forwarding to an existing instance can exit
  // before the readiness loop would have started listening.
  const exitState = {};
  const whenExited = new Promise((settle) => {
    child.once("exit", (code) => {
      exitState.code = code ?? 0;
      settle();
    });
  });
  child.unref();
  output(`Started ${binary.name} with the persistent profile at ${profileDir}.`);
  await waitForEndpoint(url, exitState, { probe, deadlineMs: readyTimeoutMs });
  const browser = await connect(url);
  return {
    browser,
    context: requireContext(browser, url),
    ownsBrowser: true,
    url,
    child,
    whenExited,
    profileDir,
  };
}

function requireContext(browser, url) {
  const [context] = browser.contexts();
  if (!context) {
    throw new Error(`The Chrome at ${url} has no open window to drive. Open a tab in it and run the command again.`);
  }
  return context;
}

export async function finishBrowserSession(session, { output = console.log, exitTimeoutMs = 10000 } = {}) {
  // close() on a CDP-attached browser drops the connection and leaves Chrome
  // running, so a browser we started has to be ended through its own process.
  await session.browser.close();
  if (!session.ownsBrowser) {
    output("Left your Chrome running; only the automation connection was closed.");
    return;
  }
  session.child?.kill();
  await Promise.race([
    session.whenExited ?? Promise.resolve(),
    new Promise((settle) => setTimeout(settle, exitTimeoutMs)),
  ]);
  // The profile deliberately survives so the next run is already signed in.
}

export async function abandonBrowserSession(session, output = console.log, { mutated = true } = {}) {
  // Deliberately leaves Chrome running and the profile on disk. After a
  // mutation the operator needs the half-changed draft on screen; before one
  // the signed-in session itself is worth keeping, because rebuilding it costs
  // another sign-in and 2FA.
  await session.browser.close().catch(() => {});
  const state = mutated
    ? "The draft was partially changed but never submitted."
    : "The listing was not changed.";
  output(
    session.ownsBrowser
      ? `${state} Chrome is still open and signed in; rerun the command to reuse it, or close it yourself when done.`
      : `${state} Inspect it in the Chrome you launched.`,
  );
}
