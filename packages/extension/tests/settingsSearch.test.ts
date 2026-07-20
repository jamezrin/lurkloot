import { describe, expect, it } from "vitest";
import {
  filterSettingsTree,
  matchesSearch,
  normalizeSearchText,
  type SettingsSectionNode,
} from "../../popup-ui/src/settingsSearch";

describe("normalizeSearchText", () => {
  it("lowercases, trims and folds diacritics", () => {
    expect(normalizeSearchText("  Margen DE Seguridad  ")).toBe("margen de seguridad");
    expect(normalizeSearchText("Sicherheitsmarge")).toBe("sicherheitsmarge");
    expect(normalizeSearchText("Marge de sécurité")).toBe("marge de securite");
  });

  it("leaves non-latin scripts intact", () => {
    expect(normalizeSearchText("安全边际")).toBe("安全边际");
  });
});

describe("matchesSearch", () => {
  const haystack = ["Deadline safety margin", "Extra buffer minutes before a reward deadline."];

  it("matches an empty query", () => {
    expect(matchesSearch(haystack, "")).toBe(true);
    expect(matchesSearch(haystack, "   ")).toBe(true);
  });

  it("matches a single token in the title", () => {
    expect(matchesSearch(haystack, "deadline")).toBe(true);
  });

  it("matches a token in the description", () => {
    expect(matchesSearch(haystack, "buffer")).toBe(true);
  });

  it("requires every token to match, in any order or field", () => {
    expect(matchesSearch(haystack, "safety margin")).toBe(true);
    expect(matchesSearch(haystack, "margin safety")).toBe(true);
    expect(matchesSearch(haystack, "margin buffer")).toBe(true);
    expect(matchesSearch(haystack, "safety unrelated")).toBe(false);
  });

  it("ignores accents in the query", () => {
    expect(matchesSearch(["Marge de sécurité"], "securite")).toBe(true);
    expect(matchesSearch(["Marge de securite"], "sécurité")).toBe(true);
  });

  it("does not match on substrings of the query", () => {
    expect(matchesSearch(haystack, "deadlines")).toBe(false);
  });
});

describe("filterSettingsTree", () => {
  const labels: Record<string, string> = {
    generalTitle: "General",
    twitchTitle: "Twitch",
    dropsTitle: "Drops",
    schedulerTitle: "Scheduler & timing",
    autoClaimTitle: "Auto-claim drops",
    autoClaimDescription: "Claim rewards as soon as they are earned.",
    intervalTitle: "Scheduler interval",
    intervalDescription: "How often the scheduler re-evaluates channels.",
    compatTitle: "Compatibility profile",
    compatDescription: "Heartbeat and inventory behavior.",
  };
  const t = (key: string) => labels[key] ?? key;

  const tree: SettingsSectionNode[] = [
    {
      id: "general",
      titleKey: "generalTitle",
      rows: [],
      groups: [
        {
          id: "general.drops",
          titleKey: "dropsTitle",
          entries: [{ id: "general.drops.autoClaim", titleKey: "autoClaimTitle", descriptionKey: "autoClaimDescription" }],
        },
        {
          id: "general.scheduler",
          titleKey: "schedulerTitle",
          advanced: true,
          entries: [{ id: "general.scheduler.interval", titleKey: "intervalTitle", descriptionKey: "intervalDescription" }],
        },
      ],
    },
    {
      id: "twitch",
      titleKey: "twitchTitle",
      rows: [],
      groups: [
        {
          id: "twitch.compatibility",
          titleKey: "compatTitle",
          advanced: true,
          entries: [{ id: "twitch.compatibility.profile", titleKey: "compatTitle", descriptionKey: "compatDescription" }],
        },
      ],
    },
  ];

  it("hides advanced groups when the switch is off and there is no query", () => {
    const result = filterSettingsTree(tree, { t, query: "", showAdvanced: false });
    expect(result.map((section) => section.id)).toEqual(["general"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops"]);
  });

  it("shows advanced groups when the switch is on", () => {
    const result = filterSettingsTree(tree, { t, query: "", showAdvanced: true });
    expect(result.map((section) => section.id)).toEqual(["general", "twitch"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops", "general.scheduler"]);
  });

  it("reveals a matching advanced entry even while the switch is off", () => {
    const result = filterSettingsTree(tree, { t, query: "heartbeat", showAdvanced: false });
    expect(result.map((section) => section.id)).toEqual(["twitch"]);
    expect(result[0]!.groups[0]!.entries.map((entry) => entry.id)).toEqual(["twitch.compatibility.profile"]);
  });

  it("drops non-matching entries, groups and sections", () => {
    const result = filterSettingsTree(tree, { t, query: "auto-claim", showAdvanced: true });
    expect(result.map((section) => section.id)).toEqual(["general"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops"]);
  });

  it("reports a per-section match count while searching", () => {
    const result = filterSettingsTree(tree, { t, query: "scheduler", showAdvanced: true });
    expect(result[0]!.matchCount).toBe(1);
  });

  it("returns every section with a zero match count for an empty query", () => {
    const result = filterSettingsTree(tree, { t, query: "", showAdvanced: true });
    expect(result.every((section) => section.matchCount === 0)).toBe(true);
  });

  it("matches a section by its own title and keeps all its non-advanced content", () => {
    const result = filterSettingsTree(tree, { t, query: "general", showAdvanced: false });
    expect(result.map((section) => section.id)).toEqual(["general"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops"]);
  });

  it("reveals an advanced group's entries when its own title matches, switch off", () => {
    const result = filterSettingsTree(tree, { t, query: "scheduler", showAdvanced: false });
    expect(result.map((section) => section.id)).toEqual(["general"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.scheduler"]);
    expect(result[0]!.groups[0]!.entries.map((entry) => entry.id)).toEqual(["general.scheduler.interval"]);
  });

  it("keeps a broad section-title match from leaking advanced groups", () => {
    const result = filterSettingsTree(tree, { t, query: "general", showAdvanced: false });
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops"]);
  });
});
