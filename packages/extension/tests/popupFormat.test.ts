import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../popup-ui/src/format";

describe("formatDateTime", () => {
  const at = "2026-09-25T16:00:00Z";

  it("formats in the popup's language even for catalog codes with an underscore", () => {
    // pt_BR is not a valid BCP 47 tag; without normalising it the date would
    // fall back to the browser's language rather than the popup's.
    expect(formatDateTime(at, "pt_BR")).toBe(new Date(at).toLocaleString("pt-BR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  });

  it("returns nothing for a missing or unreadable date", () => {
    expect(formatDateTime("", "en")).toBe("");
    expect(formatDateTime("not a date", "en")).toBe("");
  });
});
