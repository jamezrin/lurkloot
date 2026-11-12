import { describe, expect, it } from "vitest";
import {
  reviewStoreLink,
  shouldShowGithubStarNudge,
  shouldShowRateNudge,
} from "@lurkloot/popup-ui/rateNudge";

describe("shouldShowRateNudge", () => {
  const now = new Date("2026-06-14T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  it("hides until the extension has been installed at least minDays", () => {
    expect(shouldShowRateNudge(daysAgo(1), "pending", now, 3)).toBe(false);
    expect(shouldShowRateNudge(daysAgo(3), "pending", now, 3)).toBe(true);
    expect(shouldShowRateNudge(daysAgo(10), "pending", now, 3)).toBe(true);
  });

  it("stays hidden once rated or dismissed, regardless of age", () => {
    expect(shouldShowRateNudge(daysAgo(30), "rated", now, 3)).toBe(false);
    expect(shouldShowRateNudge(daysAgo(30), "dismissed", now, 3)).toBe(false);
  });

  it("stays hidden when the install date is missing or unparseable", () => {
    expect(shouldShowRateNudge(undefined, "pending", now, 3)).toBe(false);
    expect(shouldShowRateNudge("not-a-date", "pending", now, 3)).toBe(false);
  });
});

describe("shouldShowGithubStarNudge", () => {
  const now = new Date("2026-06-14T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  it("hides until the extension has been installed at least minDays", () => {
    expect(shouldShowGithubStarNudge(daysAgo(6), "pending", now, 7)).toBe(false);
    expect(shouldShowGithubStarNudge(daysAgo(7), "pending", now, 7)).toBe(true);
    expect(shouldShowGithubStarNudge(daysAgo(30), "pending", now, 7)).toBe(true);
  });

  it("stays hidden once starred or dismissed, regardless of age", () => {
    expect(shouldShowGithubStarNudge(daysAgo(30), "starred", now, 7)).toBe(false);
    expect(shouldShowGithubStarNudge(daysAgo(30), "dismissed", now, 7)).toBe(false);
  });

  it("stays hidden when the install date is missing or unparseable", () => {
    expect(shouldShowGithubStarNudge(undefined, "pending", now, 7)).toBe(false);
    expect(shouldShowGithubStarNudge("not-a-date", "pending", now, 7)).toBe(false);
  });
});

describe("reviewStoreLink", () => {
  it("sends a host that names no store to the Chrome Web Store", () => {
    const chrome = {
      href: "https://chromewebstore.google.com/detail/aobaackpofkghaejdnnmpmeaiaoibhdn/reviews",
      bodyKey: "rateNudgeBody",
    };
    expect(reviewStoreLink(undefined)).toEqual(chrome);
    expect(reviewStoreLink("chrome-web-store")).toEqual(chrome);
  });

  it("sends the Firefox build to its Firefox Add-ons reviews, named as such", () => {
    expect(reviewStoreLink("firefox-add-ons")).toEqual({
      href: "https://addons.mozilla.org/firefox/addon/lurkloot/reviews/",
      bodyKey: "rateNudgeBodyFirefox",
    });
  });

  it("has nowhere to send a host no store distributes", () => {
    expect(reviewStoreLink(null)).toBeNull();
  });
});
