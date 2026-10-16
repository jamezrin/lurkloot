import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCountdown, formatDateTime, formatRelative } from "../../popup-ui/src/format";
import type { TFunction } from "../../popup-ui/src/types";

const t: TFunction = (key, substitutions) =>
  substitutions === undefined ? key : `${key}:${[substitutions].flat().join(", ")}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("formatDateTime", () => {
  // Pinned inside the current year, so the year stays out of the format.
  const at = `${new Date().getFullYear()}-09-25T16:00:00Z`;

  it("formats in the popup's language even for catalog codes with an underscore", () => {
    // pt_BR is not a valid BCP 47 tag; without normalising it the date would
    // fall back to the browser's language rather than the popup's.
    expect(formatDateTime(at, "pt_BR")).toBe(
      new Date(at).toLocaleString("pt-BR", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  });

  it("names the year only when it is not the current one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-20T12:00:00Z"));

    expect(formatDateTime("2026-12-28T12:00:00Z", "en")).not.toContain("2026");
    expect(formatDateTime("2027-01-04T12:00:00Z", "en")).toContain("2027");
  });

  it("returns nothing for a missing or unreadable date", () => {
    expect(formatDateTime("", "en")).toBe("");
    expect(formatDateTime("not a date", "en")).toBe("");
  });
});

describe("formatRelative", () => {
  it("says which side of now a boundary is on", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));

    expect(formatRelative("2026-10-18T16:30:00Z", t)).toBe("relativeIn:2d 4h");
    expect(formatRelative("2026-10-16T09:00:00Z", t)).toBe("relativeAgo:3h");
    expect(formatRelative("", t)).toBe("");
  });

  it("leaves out a zero second unit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));

    expect(formatRelative("2026-10-28T12:00:00Z", t)).toBe("relativeIn:12d");
    expect(formatCountdown("2026-10-16T14:05:00Z", t)).toBe("2h 5m");
  });
});
