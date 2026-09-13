import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn(async (message: { type: string }) =>
  message.type === "getPlaybackControl" ? { managed: false, keepVideosUnmuted: false } : undefined);
const addListener = vi.fn();
vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage: (...args: unknown[]) => sendMessage(...args as [{ type: string }]),
  onMessage: { addListener: (...args: unknown[]) => addListener(...args) } } } }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("manual playback event reporting", () => {
  it.each(["playing", "pause", "ended"])("reports %s without waiting for the five-second interval", async (event) => {
    vi.resetModules();
    vi.useFakeTimers();
    const { document, window } = parseHTML("<html><body><video></video></body></html>");
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("MutationObserver", window.MutationObserver);
    vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
    const video = document.querySelector("video")!;
    Object.assign(video, { paused: false, ended: false, readyState: 4, muted: false, volume: 1 });
    const { startPlaybackTelemetry } = await import("../src/core/playbackContent");
    startPlaybackTelemetry("twitch");
    await vi.advanceTimersByTimeAsync(0);
    sendMessage.mockClear();
    Object.assign(video, event === "pause" ? { paused: true } : event === "ended" ? { ended: true } : {});
    video.dispatchEvent(new window.Event(event, { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    const report = sendMessage.mock.calls.find(([message]) => message.type === "playbackTelemetry")?.[0];
    expect(report).toMatchObject({ type: "playbackTelemetry", telemetry: {
      playingVideoCount: event === "playing" ? 1 : 0,
    } });
  });
});
