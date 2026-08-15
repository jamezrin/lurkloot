import { readFileSync } from "node:fs";
import * as controllerModule from "@lurkloot/core/controller";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { ExtensionSettings, Platform } from "@lurkloot/shared/models";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createBackgroundController } = vi.hoisted(() => ({
  createBackgroundController: vi.fn(),
}));

vi.mock("@lurkloot/core/controller", async (importOriginal) => ({
  ...await importOriginal(),
  createBackgroundController,
}));

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: { getMessage: vi.fn() },
  },
}));

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: WebSocketMessageEventLike) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }

  message(value: unknown): void {
    for (const listener of this.listeners.message ?? []) {
      listener({ data: typeof value === "string" ? value : JSON.stringify(value) });
    }
  }
}

interface BackgroundAdapterDependencies {
  createAdapter?: (platform: Platform, emit: EventEmitter, settings: ExtensionSettings) => { adapter: PlatformAdapter };
}

afterEach(() => {
  createBackgroundController.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("background integrity alarm wiring", () => {
  const source = readFileSync(
    new URL("../entrypoints/background.ts", import.meta.url),
    "utf8",
  );
  const alarmListener = source.slice(
    source.indexOf("browser.alarms.onAlarm.addListener"),
    source.indexOf("browser.tabs.onRemoved.addListener"),
  );

  it("injects the one-shot alarm and integrity lifecycle dependencies", () => {
    expect(source).toContain("createAlarm: (name, options) => browser.alarms.create(name, options),");
    expect(source).toContain([
      "  getAlarm: async (name) => {",
      "    const alarm = await browser.alarms.get(name);",
      "    return alarm ? { scheduledTime: alarm.scheduledTime } : undefined;",
      "  },",
    ].join("\n"));
    expect(source).toContain("clearAlarm: (name) => browser.alarms.clear(name),");
    expect(source).toContain("ensureTwitchIntegrity: (emit, request) => ensureTwitchIntegrity(emit, request),");
    expect(source).toContain("cancelTwitchIntegrityAcquisition,");
  });

  it("registers the behavioral named-alarm dispatcher", () => {
    expect(alarmListener).toContain(
      "browser.alarms.onAlarm.addListener(createBackgroundAlarmListener(controller));",
    );
  });

  it("behaviorally dispatches named alarms and ignores unrelated alarms", () => {
    const createBackgroundAlarmListener = (
      controllerModule as typeof controllerModule & {
        createBackgroundAlarmListener?: (controller: {
          tickAndHandOff(): Promise<void>;
          runWatchHeartbeat(): Promise<void>;
          runTwitchIntegrityRefresh(): Promise<void>;
        }) => (alarm: { name: string }) => void;
      }
    ).createBackgroundAlarmListener;
    expect(createBackgroundAlarmListener).toBeTypeOf("function");
    if (!createBackgroundAlarmListener) return;
    const controller = {
      tickAndHandOff: vi.fn(async () => undefined),
      runWatchHeartbeat: vi.fn(async () => undefined),
      runTwitchIntegrityRefresh: vi.fn(async () => undefined),
    };
    const listener = createBackgroundAlarmListener(controller);

    listener({ name: "lurkloot.tick.twitch" });
    listener({ name: "lurkloot.tick.kick" });
    listener({ name: "lurkloot.tick" });
    listener({ name: "lurkloot.twitch-integrity" });
    listener({ name: "unrelated.alarm" });

    expect(controller.runTwitchIntegrityRefresh).toHaveBeenCalledOnce();
    expect(controller.tickAndHandOff).toHaveBeenNthCalledWith(1, ["twitch"], "alarm");
    expect(controller.tickAndHandOff).toHaveBeenNthCalledWith(2, ["kick"], "alarm");
    expect(controller.tickAndHandOff).toHaveBeenCalledTimes(2);
    expect(controller.runWatchHeartbeat).not.toHaveBeenCalled();
  });

  it("injects the extension WebSocket into the Kick discovery observer", async () => {
    let deps: BackgroundAdapterDependencies | undefined;
    createBackgroundController.mockImplementation((nextDeps) => {
      deps = nextDeps;
      return {};
    });
    const sockets: FakeSocket[] = [];
    vi.stubGlobal("WebSocket", class {
      constructor(url: string) {
        expect(url).toBe("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false");
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    vi.stubGlobal("defineBackground", vi.fn());

    await import("../entrypoints/background");

    const observer = deps?.createAdapter?.("kick", () => undefined, DEFAULT_SETTINGS).adapter.createDiscoverySignalController?.();
    await observer?.start({
      platform: "kick",
      channel: { platform: "kick", username: "creator", url: "https://kick.com/creator", categoryId: "42" },
    }, () => undefined);
    sockets[0]?.message({ event: "pusher:connection_established", data: {} });

    expect(observer).toBeDefined();
    expect(sockets[0]?.sent).toEqual([
      JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: "drops_category_42" } }),
    ]);
  });
});
