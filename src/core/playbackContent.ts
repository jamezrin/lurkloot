import { browser } from "wxt/browser";
import type { Platform } from "./models";

const REPORT_INTERVAL_MS = 5000;

export function startPlaybackTelemetry(platform: Platform): void {
  void muteAndReport(platform);
  setInterval(() => {
    void muteAndReport(platform);
  }, REPORT_INTERVAL_MS);
}

async function muteAndReport(platform: Platform): Promise<void> {
  const videos = [...document.querySelectorAll("video")];
  let blockedPlaybackCount = 0;

  for (const video of videos) {
    video.muted = true;
    video.volume = 0;
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
      playingVideoCount: videos.filter((video) => !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA).length,
      blockedPlaybackCount,
      documentHidden: document.hidden,
      readyState: primary?.readyState,
      currentTime: primary ? Math.floor(primary.currentTime) : undefined,
      duration: primary && Number.isFinite(primary.duration) ? Math.floor(primary.duration) : undefined,
    },
  }).catch(() => undefined);
}
