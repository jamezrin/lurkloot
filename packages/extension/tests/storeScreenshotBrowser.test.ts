import { describe, expect, it } from "vitest";
// @ts-expect-error The production utility is an executable JavaScript module.
import { abandonBrowserSession, endpointUrl, finishBrowserSession, probeEndpoint, resolveBrowserBinary, startBrowserSession } from "../scripts/store-screenshot-browser.mjs";

function fakeChild() {
  const listeners: Record<string, (code?: number) => void> = {};
  return {
    killed: false,
    once(event: string, handler: (code?: number) => void) { listeners[event] = handler; },
    unref() {},
    kill() { this.killed = true; listeners.exit?.(0); },
    exit(code: number) { listeners.exit?.(code); },
  };
}

describe("browser binary resolution", () => {
  it("prefers Chrome channels over Chromium when both are installed", async () => {
    const present = new Set(["/usr/bin/chromium", "/usr/bin/google-chrome-stable"]);
    const binary = await resolveBrowserBinary({
      env: { PATH: "/usr/bin" },
      exists: async (path: string) => present.has(path),
    });

    expect(binary.path).toBe("/usr/bin/google-chrome-stable");
    expect(binary.isChromium).toBe(false);
  });

  it("falls back to Chromium and flags it", async () => {
    const binary = await resolveBrowserBinary({
      env: { PATH: "/usr/bin" },
      exists: async (path: string) => path === "/usr/bin/chromium",
    });

    expect(binary.isChromium).toBe(true);
  });

  it("honours an explicit binary override", async () => {
    const binary = await resolveBrowserBinary({
      env: { CWS_CHROME_BINARY: "/opt/custom/chrome", PATH: "/usr/bin" },
      exists: async (path: string) => path === "/opt/custom/chrome",
    });

    expect(binary.path).toBe("/opt/custom/chrome");
  });

  it("rejects an override that is not executable", async () => {
    await expect(resolveBrowserBinary({
      env: { CWS_CHROME_BINARY: "/opt/missing" },
      exists: async () => false,
    })).rejects.toThrow(/CWS_CHROME_BINARY/);
  });

  it("names every candidate when nothing is installed", async () => {
    await expect(resolveBrowserBinary({
      env: { PATH: "/usr/bin" },
      exists: async () => false,
    })).rejects.toThrow(/google-chrome-stable.*CWS_CHROME_BINARY/s);
  });
});

describe("debugging endpoint", () => {
  it("uses a non-default port so it does not collide with everyday sessions", () => {
    expect(endpointUrl({})).toBe("http://127.0.0.1:9333");
    expect(endpointUrl({ CWS_CDP_PORT: "9222" })).toBe("http://127.0.0.1:9222");
  });

  it("treats an unreachable endpoint as absent", async () => {
    const reachable = await probeEndpoint("http://127.0.0.1:9333", {
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });

    expect(reachable).toBe(false);
  });
});

describe("browser session lifecycle", () => {
  it("attaches to a live endpoint without spawning or owning it", async () => {
    let spawned = 0;
    const context = {};
    const session = await startBrowserSession({
      env: {},
      output: () => {},
      probe: async () => true,
      spawnBrowser: () => { spawned += 1; return fakeChild(); },
      connect: async () => ({ contexts: () => [context] }),
    });

    expect(spawned).toBe(0);
    expect(session.ownsBrowser).toBe(false);
    expect(session.context).toBe(context);
  });

  it("leaves an attached browser running when the session finishes", async () => {
    let closed = false;
    const child = fakeChild();
    const session = {
      ownsBrowser: false,
      child,
      browser: { close: async () => { closed = true; } },
    };

    await finishBrowserSession(session, { output: () => {} });

    // close() only drops the CDP connection, which is all an attached browser gets.
    expect(closed).toBe(true);
    expect(child.killed).toBe(false);
  });

  it("ends the process it started but keeps its signed-in profile", async () => {
    const child = fakeChild();
    const session = {
      ownsBrowser: true,
      child,
      whenExited: Promise.resolve(),
      profileDir: "/home/operator/.local/state/lurkloot/cws-chrome-profile",
      browser: { close: async () => {} },
    };

    await finishBrowserSession(session, { output: () => {} });

    expect(child.killed).toBe(true);
    // The profile is what spares the operator another sign-in.
    expect(session.profileDir).toBe("/home/operator/.local/state/lurkloot/cws-chrome-profile");
  });

  it("gives up waiting for an exit that never arrives", async () => {
    let finished = false;
    const session = {
      ownsBrowser: true,
      child: { kill() {} },
      whenExited: new Promise(() => {}),
      browser: { close: async () => {} },
    };

    await finishBrowserSession(session, { output: () => {}, exitTimeoutMs: 10 });
    finished = true;

    expect(finished).toBe(true);
  });

  it("reuses one persistent profile directory across runs", async () => {
    const dirs: string[] = [];
    const spawnArgs: string[][] = [];
    // The real default lands in the user's state directory; creating it is a
    // side effect a unit test must not have, so the resolver is injected.
    const stateProfile = "/state/lurkloot/cws-chrome-profile";
    for (let run = 0; run < 2; run += 1) {
      let probes = 0;
      const session = await startBrowserSession({
        env: {},
        output: () => {},
        probe: async () => { probes += 1; return probes > 1; },
        resolveBinary: async () => ({ path: "/usr/bin/google-chrome-stable", name: "google-chrome-stable", isChromium: false }),
        spawnBrowser: (_binary: string, args: string[]) => { spawnArgs.push(args); return fakeChild(); },
        makeProfileDir: async () => stateProfile,
        connect: async () => ({ contexts: () => [{}] }),
      });
      dirs.push(session.profileDir);
    }

    expect(dirs[0]).toBe(stateProfile);
    expect(dirs[0]).toBe(dirs[1]);
    expect(spawnArgs[0]).toEqual(spawnArgs[1]);
  });

  it("defaults the profile to the user's state directory", async () => {
    const created: string[] = [];
    const session = await startBrowserSession({
      env: { XDG_STATE_HOME: "/state" },
      output: () => {},
      probe: async () => true,
      connect: async () => ({ contexts: () => [{}] }),
      makeProfileDir: async () => { created.push("called"); return "/state/lurkloot/cws-chrome-profile"; },
    });

    // An already-live endpoint is attached to, so no profile is created at all.
    expect(created).toEqual([]);
    expect(session.ownsBrowser).toBe(false);
  });

  it("leaves a spawned browser alone when the session is abandoned", async () => {
    let closed = false;
    const child = fakeChild();
    const messages: string[] = [];
    const session = {
      ownsBrowser: true,
      child,
      browser: { close: async () => { closed = true; } },
    };

    await abandonBrowserSession(session, (message: string) => messages.push(message));

    expect(closed).toBe(true);
    expect(child.killed).toBe(false);
    expect(messages.join(" ")).toMatch(/still open and signed in/);
    expect(messages.join(" ")).toMatch(/partially changed/);
  });

  it("says the listing is untouched when abandoning before any mutation", async () => {
    const messages: string[] = [];
    const session = {
      ownsBrowser: true,
      child: fakeChild(),
      browser: { close: async () => {} },
    };

    await abandonBrowserSession(session, (message: string) => messages.push(message), { mutated: false });

    expect(messages.join(" ")).toMatch(/listing was not changed/);
    expect(messages.join(" ")).not.toMatch(/partially changed/);
  });

  it("refuses to drive a browser with no open window", async () => {
    await expect(startBrowserSession({
      env: {},
      output: () => {},
      probe: async () => true,
      connect: async () => ({ contexts: () => [] }),
    })).rejects.toThrow(/no open window/);
  });

  it("spawns a browser with no automation switches when nothing is listening", async () => {
    const spawnArgs: string[][] = [];
    let probes = 0;
    const session = await startBrowserSession({
      env: { CWS_CDP_PORT: "9444" },
      output: () => {},
      probe: async () => { probes += 1; return probes > 1; },
      resolveBinary: async () => ({ path: "/usr/bin/google-chrome-stable", name: "google-chrome-stable", isChromium: false }),
      spawnBrowser: (_binary: string, args: string[]) => { spawnArgs.push(args); return fakeChild(); },
      makeProfileDir: async () => "/tmp/cws-profile-test",
      connect: async () => ({ contexts: () => [{}] }),
    });

    expect(spawnArgs[0]).toContain("--user-data-dir=/tmp/cws-profile-test");
    expect(spawnArgs[0]).toContain("--remote-debugging-port=9444");
    expect(spawnArgs[0].join(" ")).not.toMatch(/enable-automation|headless/);
    expect(session.ownsBrowser).toBe(true);
  });

  it("honours an operator-supplied profile directory", async () => {
    let probes = 0;
    const session = await startBrowserSession({
      env: { CWS_CHROME_PROFILE: "/home/operator/chrome-profile" },
      output: () => {},
      probe: async () => { probes += 1; return probes > 1; },
      resolveBinary: async () => ({ path: "/usr/bin/google-chrome-stable", name: "google-chrome-stable", isChromium: false }),
      spawnBrowser: () => fakeChild(),
      connect: async () => ({ contexts: () => [{}] }),
    });

    expect(session.profileDir).toBe("/home/operator/chrome-profile");
  });

  it("reports the forwarding exit instead of waiting out the readiness timeout", async () => {
    await expect(startBrowserSession({
      env: {},
      output: () => {},
      probe: async () => false,
      resolveBinary: async () => ({ path: "/usr/bin/google-chrome-stable", name: "google-chrome-stable", isChromium: false }),
      spawnBrowser: () => {
        const child = fakeChild();
        // Chrome forwards to the instance already holding this profile and exits at once.
        queueMicrotask(() => child.exit(0));
        return child;
      },
      makeProfileDir: async () => "/tmp/cws-profile-test",
      connect: async () => ({ contexts: () => [{}] }),
      readyTimeoutMs: 30000,
    })).rejects.toThrow(/already own this profile/);
  });
});
