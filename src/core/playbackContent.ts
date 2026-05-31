import { browser } from "wxt/browser";
import type { PlaybackControl } from "./messages";
import type { Platform } from "./models";

const REPORT_INTERVAL_MS = 5000;
const DEFAULT_VIDEO_VOLUME = 1;
const controlledVideos = new WeakSet<HTMLVideoElement>();
let queuedPlaybackControl = false;

export function startPlaybackTelemetry(platform: Platform): void {
  void controlPlaybackAndReport(platform);
  setInterval(() => {
    void controlPlaybackAndReport(platform);
  }, REPORT_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    queuePlaybackControl(platform);
  });
  window.addEventListener("focus", () => {
    queuePlaybackControl(platform);
  });
  window.addEventListener("pageshow", () => {
    queuePlaybackControl(platform);
  });
  new MutationObserver(() => {
    queuePlaybackControl(platform);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

function queuePlaybackControl(platform: Platform): void {
  if (queuedPlaybackControl) return;
  queuedPlaybackControl = true;
  setTimeout(() => {
    queuedPlaybackControl = false;
    void controlPlaybackAndReport(platform);
  }, 250);
}

async function controlPlaybackAndReport(platform: Platform): Promise<void> {
  const control = await browser.runtime.sendMessage({
    type: "getPlaybackControl",
    platform,
  }).catch((): PlaybackControl => ({ managed: false })) as PlaybackControl | undefined;

  if (!control?.managed) return;

  const videos = [...document.querySelectorAll("video")];
  let blockedPlaybackCount = 0;

  for (const video of videos) {
    controlVideo(video, platform);
    try {
      await video.play();
    } catch {
      blockedPlaybackCount += 1;
    }
  }

  const primary = videos[0];
  await browser.runtime.sendMessage({
    type: "playbackTelemetry",
    platform,
    telemetry: {
      videoCount: videos.length,
      mutedVideoCount: videos.filter((video) => video.muted || video.volume === 0).length,
      unmutedVideoCount: videos.filter((video) => !video.muted && video.volume > 0).length,
      playingVideoCount: videos.filter((video) => !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA).length,
      blockedPlaybackCount,
      documentHidden: document.hidden,
      readyState: primary?.readyState,
      currentTime: primary ? Math.floor(primary.currentTime) : undefined,
      duration: primary && Number.isFinite(primary.duration) ? Math.floor(primary.duration) : undefined,
    },
  }).catch(() => undefined);
}

function controlVideo(video: HTMLVideoElement, platform: Platform): void {
  if (!controlledVideos.has(video)) {
    controlledVideos.add(video);
    video.addEventListener("volumechange", () => {
      if (video.muted || video.volume === 0) {
        queuePlaybackControl(platform);
      }
    });
    video.addEventListener("pause", () => {
      queuePlaybackControl(platform);
    });
  }

  video.defaultMuted = false;
  video.removeAttribute("muted");
  video.muted = false;
  if (video.volume === 0) video.volume = DEFAULT_VIDEO_VOLUME;
}
