import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { MessageCatalog } from "@lurkloot/shared/i18n";
import { formatActivityEvent } from "../../popup-ui/src/activity.logic";

// Diagnostics are the surface users paste into bug reports, so they must read the
// same in every locale. A translator that shouts on every lookup makes any
// catalog leak into a diagnostic entry impossible to miss.
const shouting = (key: string) => `TRANSLATED(${key})`;

const messagesDir = dirname(createRequire(import.meta.url).resolve("@lurkloot/locales/messages/en.json"));
const catalogs = () => readdirSync(messagesDir)
  .filter((entry) => entry.endsWith(".json"))
  .map((entry) => ({
    locale: entry.replace(/\.json$/, ""),
    catalog: JSON.parse(readFileSync(join(messagesDir, entry), "utf8")) as MessageCatalog,
  }));

const diagnostic: ActivityHistoryRecord = {
  id: "diagnostic-1",
  at: "2026-07-25T12:00:00.000Z",
  category: "diagnostic",
  level: "warn",
  platform: "kick",
  code: "farming_stopped",
  message: 'Stopped farming "Golden Hat" from campaign "Summer Campaign": reason=channel_offline',
};

const legacy: ActivityHistoryRecord = {
  id: "legacy-1",
  at: "2026-07-25T12:00:00.000Z",
  legacy: true,
  level: "info",
  message: "Recorded before the structured event contract",
};

describe("diagnostics stay English", () => {
  it("renders a diagnostic message verbatim instead of translating it", () => {
    expect(formatActivityEvent(diagnostic, shouting)).toBe(diagnostic.message);
    expect(formatActivityEvent(diagnostic, shouting)).not.toContain("TRANSLATED");
  });

  it("renders legacy prose verbatim too", () => {
    expect(formatActivityEvent(legacy, shouting)).toBe(legacy.message);
  });

  it("keeps translating structured activity entries", () => {
    // The counterpart guarantee: only diagnostics opt out of localization, so a
    // regression that made everything English would fail here.
    expect(formatActivityEvent({
      id: "activity-1",
      at: "2026-07-25T12:00:00.000Z",
      category: "activity",
      code: "farming_started",
      level: "info",
      platform: "kick",
      data: { campaignId: "c", campaignName: "C", rewardId: "r", rewardName: "R" },
    }, shouting)).toContain("TRANSLATED");
  });

  it("ships no catalog keys for diagnostic message bodies", () => {
    // Settings copy and the view switch legitimately mention diagnostics; entries
    // that would translate a diagnostic body do not exist and must not appear.
    const allowed = new Set([
      "diagnosticLoggingTitle",
      "diagnosticLoggingDescription",
      "diagnosticsViewTab",
      "platformDiagnostics",
      "noDiagnostics",
    ]);
    for (const { locale, catalog } of catalogs()) {
      const offenders = Object.keys(catalog).filter((key) => /^diagnostic/i.test(key) && !allowed.has(key));
      expect(offenders, locale).toEqual([]);
    }
  });
});
