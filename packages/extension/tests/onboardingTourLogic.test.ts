import { describe, expect, it } from "vitest";
import {
  clampTarget,
  dismissesForGood,
  placeCard,
  TOUR_STEPS,
  type TourAction,
  type TourPhase,
  tourReducer,
  unionRect,
} from "../../popup-ui/src/onboardingTour.logic";
import english from "../../locales/messages/en.json";

const frame = { width: 720, height: 600 };
const card = { width: 300, height: 150 };

describe("TOUR_STEPS", () => {
  it("has twelve steps with unique ids", () => {
    expect(TOUR_STEPS.length).toBe(12);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(12);
  });

  it("only references title and body keys that exist in en.json", () => {
    for (const s of TOUR_STEPS) {
      expect(english, s.titleKey).toHaveProperty(s.titleKey);
      expect(english, s.bodyKey).toHaveProperty(s.bodyKey);
    }
  });

  it("derives each body key from its title key", () => {
    for (const s of TOUR_STEPS) {
      expect(s.bodyKey).toBe(s.titleKey.replace("Title", "Body"));
    }
  });

  it("runs twitch steps 1-8 then kick steps 9-12", () => {
    TOUR_STEPS.forEach((s, i) => {
      expect(s.platform).toBe(i < 8 ? "twitch" : "kick");
    });
  });

  it("frames the strategy group header alone on the queue controls step", () => {
    const controls = TOUR_STEPS.find((s) => s.id === "queueControls");
    expect(controls?.targets).toEqual(['[data-tour="queue-strategy"]']);
  });

  it("never targets diagnostics", () => {
    for (const s of TOUR_STEPS) {
      for (const t of s.targets) expect(t).not.toContain("diagnostic");
    }
  });
});

describe("tourReducer", () => {
  const step = (index: number): TourPhase => ({ kind: "step", index });

  it("arms and disarms from loading", () => {
    expect(tourReducer({ kind: "loading" }, "arm")).toEqual({ kind: "welcome" });
    expect(tourReducer({ kind: "loading" }, "disarm")).toEqual({ kind: "hidden" });
  });

  it("re-arms from hidden", () => {
    expect(tourReducer({ kind: "hidden" }, "arm")).toEqual({ kind: "welcome" });
  });

  it("starts at step 0", () => {
    expect(tourReducer({ kind: "welcome" }, "start")).toEqual(step(0));
  });

  it("moves next and back, staying at 0", () => {
    expect(tourReducer(step(3), "next")).toEqual(step(4));
    expect(tourReducer(step(3), "back")).toEqual(step(2));
    expect(tourReducer(step(0), "back")).toEqual(step(0));
  });

  it("finishes after the last step", () => {
    expect(tourReducer(step(11), "next")).toEqual({ kind: "done" });
  });

  it("hides on skip or finish from welcome, step or done", () => {
    for (const phase of [{ kind: "welcome" }, step(5), { kind: "done" }] as TourPhase[]) {
      expect(tourReducer(phase, "skip")).toEqual({ kind: "hidden" });
      expect(tourReducer(phase, "finish")).toEqual({ kind: "hidden" });
    }
  });

  it("returns the same phase object for any other pair", () => {
    const phases: TourPhase[] = [
      { kind: "loading" },
      { kind: "hidden" },
      { kind: "welcome" },
      step(2),
      { kind: "done" },
    ];
    const actions: TourAction[] = ["arm", "disarm", "start", "next", "back", "skip", "finish"];
    const handled = (p: TourPhase, a: TourAction) =>
      (p.kind === "loading" && (a === "arm" || a === "disarm"))
      || (p.kind === "hidden" && a === "arm")
      || (p.kind === "welcome" && (a === "start" || a === "skip" || a === "finish"))
      || (p.kind === "step" && a !== "arm" && a !== "disarm" && a !== "start")
      || (p.kind === "done" && (a === "skip" || a === "finish"));
    for (const p of phases) {
      for (const a of actions) {
        if (!handled(p, a)) expect(tourReducer(p, a)).toBe(p);
      }
    }
  });
});

describe("dismissesForGood", () => {
  it("is true only for skip and finish", () => {
    const actions: TourAction[] = ["arm", "disarm", "start", "next", "back", "skip", "finish"];
    expect(actions.filter(dismissesForGood)).toEqual(["skip", "finish"]);
  });
});

describe("rect helpers", () => {
  it("unions rects", () => {
    expect(
      unionRect([
        { top: 0, left: 0, width: 10, height: 10 },
        { top: 5, left: 20, width: 10, height: 10 },
      ]),
    ).toEqual({ top: 0, left: 0, width: 30, height: 15 });
    expect(unionRect([])).toBeNull();
  });

  it("clamps a tall target to 55% of the frame height", () => {
    const r = clampTarget({ top: 10, left: 20, width: 100, height: 500 }, frame);
    expect(r).toEqual({ top: 10, left: 20, width: 100, height: 330 });
  });

  it("clips a target to the frame", () => {
    const r = clampTarget({ top: 550, left: 700, width: 100, height: 100 }, frame);
    expect(r.top + r.height).toBeLessThanOrEqual(frame.height);
    expect(r.left + r.width).toBeLessThanOrEqual(frame.width);
  });
});

describe("placeCard", () => {
  const inside = (p: { top: number; left: number }) => {
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top + card.height).toBeLessThanOrEqual(frame.height - 8);
    expect(p.left + card.width).toBeLessThanOrEqual(frame.width - 8);
  };

  it("places below a target at the top", () => {
    const p = placeCard({ top: 10, left: 100, width: 200, height: 40 }, card, frame);
    expect(p.side).toBe("below");
    expect(p.top).toBe(10 + 40 + 12);
    inside(p);
  });

  it("places above a target at the bottom", () => {
    const p = placeCard({ top: 540, left: 100, width: 200, height: 50 }, card, frame);
    expect(p.side).toBe("above");
    expect(p.top).toBe(540 - 12 - card.height);
    inside(p);
  });

  it("places right of a tall left-side target", () => {
    const p = placeCard({ top: 20, left: 10, width: 120, height: 560 }, card, frame);
    expect(p.side).toBe("right");
    expect(p.left).toBe(10 + 120 + 12);
    inside(p);
  });

  it("places left of a tall right-side target", () => {
    const p = placeCard({ top: 20, left: 590, width: 120, height: 560 }, card, frame);
    expect(p.side).toBe("left");
    inside(p);
  });

  it("falls back to below, clamped, when nothing fits", () => {
    const p = placeCard({ top: 0, left: 0, width: 720, height: 600 }, card, frame);
    expect(p.side).toBe("below");
    inside(p);
  });

  it("centres without a target", () => {
    const p = placeCard(null, card, frame);
    expect(p).toEqual({ top: 225, left: 210, side: "center" });
  });
});
