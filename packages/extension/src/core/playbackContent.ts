import { browser } from "wxt/browser";
import type { PlaybackControl } from "@stream-autopilot/shared/messages";
import type { Platform } from "@stream-autopilot/shared/models";

const REPORT_INTERVAL_MS = 5000;
const DEFAULT_VIDEO_VOLUME = 1;
// Window during which we ignore volumechange/pause events that our own
// mute/unmute/replay mutations trigger, so recovering a blocked unmute does not
// re-queue control and spin a tight loop.
const CONTROL_SUPPRESS_MS = 300;
const controlledVideos = new WeakSet<HTMLVideoElement>();
let queuedPlaybackControl = false;
let suppressControlUntil = 0;

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
  }).catch((): PlaybackControl => ({ managed: false, keepVideosUnmuted: false })) as PlaybackControl | undefined;

  // Signal the MAIN-world keep-alive script (see keepAliveContent.ts) whether
  // this is the managed watch tab, so it only spoofs visibility while farming.
  setKeepAlive(Boolean(control?.managed));

  const videos = [...document.querySelectorAll("video")];
  let blockedPlaybackCount = 0;

  if (control?.managed && control.keepVideosUnmuted) {
    // Our mute/unmute/replay mutations below fire volumechange/pause events; keep
    // them from re-queuing control while we are actively driving the elements.
    for (const video of videos) {
      suppressControlUntil = Date.now() + CONTROL_SUPPRESS_MS;
      controlVideo(video, platform);
      let blocked = false;
      try {
        await video.play();
      } catch {
        blocked = true;
      }
      // Safety net: if an unmute attempt still gets blocked (the browser pauses
      // the element instead of throwing), re-mute and resume so farming keeps
      // progressing — watch time is credited even while muted.
      if (blocked || video.paused) {
        blockedPlaybackCount += 1;
        video.muted = true;
        try {
          await video.play();
        } catch {
          // Nothing more we can do; telemetry will surface the stalled video.
        }
      }
    }
    suppressControlUntil = Date.now() + CONTROL_SUPPRESS_MS;
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
      adActive: detectAd(platform),
      readyState: primary?.readyState,
      currentTime: primary ? Math.floor(primary.currentTime) : undefined,
      duration: primary && Number.isFinite(primary.duration) ? Math.floor(primary.duration) : undefined,
    },
  }).catch(() => undefined);
}

// Markers the platform leaves in the DOM while an ad is rolling. Twitch's are
// stable data-attributes used by its own player; Kick's are best-effort
// (video.js overlay classes / generic ad containers) and may need tuning. We
// only read the DOM here — the platform is not otherwise modified.
const AD_SELECTORS: Record<Platform, string[]> = {
  twitch: [
    '[data-a-target="video-ad-label"]',
    '[data-a-target="video-ad-countdown"]',
    ".video-player__ad-info-container",
    '[data-a-target="player-ad-notice"]',
    '[data-test-selector="ad-banner-default-text-area"]',
  ],
  kick: [
    ".vjs-ad-playing",
    ".vjs-ad-loading",
    '[class*="ad-overlay"]',
    '[data-testid*="ad"]',
  ],
};

function detectAd(platform: Platform): boolean {
  return AD_SELECTORS[platform].some((selector) => document.querySelector(selector) != null);
}

function setKeepAlive(active: boolean): void {
  const root = document.documentElement;
  if (!root) return;
  if (active) {
    root.dataset.smKeepalive = "1";
  } else {
    delete root.dataset.smKeepalive;
  }
}

function controlVideo(video: HTMLVideoElement, platform: Platform): void {
  if (!controlledVideos.has(video)) {
    controlledVideos.add(video);
    video.addEventListener("volumechange", () => {
      if (Date.now() < suppressControlUntil) return;
      if (video.muted || video.volume === 0) {
        queuePlaybackControl(platform);
      }
    });
    video.addEventListener("pause", () => {
      if (Date.now() < suppressControlUntil) return;
      queuePlaybackControl(platform);
    });
  }

  video.defaultMuted = false;
  video.removeAttribute("muted");
  // Only unmute once the document has sticky user activation. Browsers (notably
  // Firefox) refuse to unmute media in a tab that has had no user gesture, log a
  // warning, and pause the element — so attempting it in a background watch tab
  // is pure noise. Leave it muted but playing until the user interacts.
  if (canUnmuteVideos()) {
    video.muted = false;
  }
  if (video.volume === 0) video.volume = DEFAULT_VIDEO_VOLUME;
}

function canUnmuteVideos(): boolean {
  // Browsers without the userActivation API fall back to attempting the unmute,
  // preserving the prior behavior.
  return navigator.userActivation?.hasBeenActive ?? true;
}
