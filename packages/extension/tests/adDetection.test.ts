import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage: vi.fn() } } }));

const { detectAdIn } = await import("../src/core/playbackContent");

function documentFrom(html: string): ParentNode {
  return parseHTML(`<html><body>${html}</body></html>`).document as unknown as ParentNode;
}

describe("ad detection", () => {
  it("does not treat Kick chat identity badges as an ad", () => {
    const root = documentFrom(`
      <div data-testid="identity-badge-subscriber"></div>
      <div data-testid="identity-badge-chat_identity"></div>
    `);

    expect(detectAdIn("kick", root)).toBe(false);
  });

  it("does not match unrelated elements whose class merely contains 'ad'", () => {
    const root = documentFrom(`
      <div class="header-loading"></div>
      <div class="thread-overlay"></div>
      <div data-testid="download-badge"></div>
    `);

    expect(detectAdIn("kick", root)).toBe(false);
  });

  it("detects a Kick ad from the video.js ad classes", () => {
    expect(detectAdIn("kick", documentFrom(`<div class="vjs-ad-playing"></div>`))).toBe(true);
    expect(detectAdIn("kick", documentFrom(`<div class="video-js vjs-ad-loading"></div>`))).toBe(true);
  });

  it("detects a Kick ad from an exact ad-overlay class token", () => {
    expect(detectAdIn("kick", documentFrom(`<div class="ad-overlay"></div>`))).toBe(true);
    expect(detectAdIn("kick", documentFrom(`<div class="player ad-overlay visible"></div>`))).toBe(true);
  });

  it("detects a Kick ad from an anchored ad testid", () => {
    expect(detectAdIn("kick", documentFrom(`<div data-testid="ad-overlay"></div>`))).toBe(true);
    expect(detectAdIn("kick", documentFrom(`<div data-testid="player-ad"></div>`))).toBe(true);
  });

  it("reports no ad on an empty Kick page", () => {
    expect(detectAdIn("kick", documentFrom(`<div class="chat"></div>`))).toBe(false);
  });

  it("detects Twitch ads from their stable player attributes", () => {
    expect(detectAdIn("twitch", documentFrom(`<div data-a-target="video-ad-label"></div>`))).toBe(true);
    expect(detectAdIn("twitch", documentFrom(`<div class="video-player__ad-info-container"></div>`))).toBe(true);
  });

  it("does not fire on Twitch chat badges", () => {
    const root = documentFrom(`
      <div data-a-target="chat-badge"></div>
      <div data-test-selector="chat-badge-subscriber"></div>
    `);

    expect(detectAdIn("twitch", root)).toBe(false);
  });
});
