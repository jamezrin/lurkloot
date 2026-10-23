import type React from "react";
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { I18nContext } from "./context";
import { cn, scrollIntoPanel } from "./primitives";
import {
  clampTarget,
  placeCard,
  placementFrame,
  type Rect,
  TOUR_STEPS,
  type TourAction,
  type TourPhase,
  type TourStep,
  unionRect,
} from "./onboardingTour.logic";

export type VisibleTourPhase = Exclude<TourPhase, { kind: "loading" | "hidden" }>;

const SCRIM = "rgba(9, 9, 11, 0.6)";
const SPOTLIGHT_PADDING = 6;
// Frames to wait for a step's targets once the frame shows the step's view.
const TARGET_FRAMES = 30;
// Frames to wait for the frame to switch to the step's view at all.
const VIEW_FRAMES = 60;
// Frames to keep re-measuring a found target until it holds still.
const SETTLE_FRAMES = 30;
const FALLBACK_FRAME = { width: 720, height: 600 };
const FALLBACK_CARD = { width: 300, height: 160 };

type Size = { width: number; height: number };

function primaryAction(phase: VisibleTourPhase): TourAction {
  if (phase.kind === "welcome") return "start";
  if (phase.kind === "done") return "finish";
  return "next";
}

function frameSize(main: HTMLElement): Size {
  return {
    width: main.clientWidth || FALLBACK_FRAME.width,
    height: main.clientHeight || FALLBACK_FRAME.height,
  };
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

// The step's targets, first match per selector. Every lookup goes through
// `main.querySelector`, so the overlay never reaches outside the popup frame.
function findTargets(main: HTMLElement, step: TourStep): Element[] {
  return step.targets
    .map((selector) => main.querySelector(selector))
    .filter((element): element is Element => element !== null);
}

function relativeRect(main: HTMLElement, element: Element): Rect {
  const origin = main.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top - origin.top,
    left: rect.left - origin.left,
    width: rect.width,
    height: rect.height,
  };
}

function measureTargets(main: HTMLElement, targets: readonly Element[]): Rect | null {
  const union = unionRect(targets.map((element) => relativeRect(main, element)));
  if (!union) return null;
  return clampTarget(
    {
      top: union.top - SPOTLIGHT_PADDING,
      left: union.left - SPOTLIGHT_PADDING,
      width: union.width + SPOTLIGHT_PADDING * 2,
      height: union.height + SPOTLIGHT_PADDING * 2,
    },
    frameSize(main),
  );
}

// The step's main cut-out, plus the rail's own when the step lights its view's
// rail entry. `railBounds` is the whole rail, which the rail cut-out's scrim
// covers and the card stays out of.
interface Spotlight {
  target: Rect;
  rail: { hole: Rect; bounds: Rect } | null;
}

function sameSpotlight(a: Spotlight | null, b: Spotlight | null): boolean {
  if (!a || !b) return a === b;
  if (!sameRect(a.target, b.target)) return false;
  if (!a.rail || !b.rail) return a.rail === b.rail;
  return sameRect(a.rail.hole, b.rail.hole) && sameRect(a.rail.bounds, b.rail.bounds);
}

// The rail entry for the step's view, looked up inside the rail alone: the
// frame itself also carries `data-view`.
function measureRail(main: HTMLElement, step: TourStep): Spotlight["rail"] {
  if (!step.railView) return null;
  const nav = main.querySelector('[data-tour="rail"]');
  const button = nav?.querySelector(`button[data-view="${step.railView}"]`);
  if (!nav || !button) return null;
  const hole = measureTargets(main, [button]);
  return hole ? { hole, bounds: relativeRect(main, nav) } : null;
}

// Finds the current step's targets in the frame and keeps their rect current.
// Returns null while there is no step, or when the targets never turned up.
function useSpotlight(
  rootRef: React.RefObject<HTMLDivElement | null>,
  step: TourStep | undefined,
): { spotlight: Spotlight | null; frame: Size } {
  const [target, setTarget] = useState<Spotlight | null>(null);
  const [frame, setFrame] = useState<Size>(FALLBACK_FRAME);
  const updateFrame = (main: HTMLElement) => {
    const next = frameSize(main);
    setFrame((current) =>
      current.width === next.width && current.height === next.height ? current : next,
    );
  };

  useEffect(() => {
    const main = rootRef.current?.closest("main");
    if (!main) return undefined;
    updateFrame(main);
    // The previous step's rect stays until this one's is measured, so the
    // spotlight glides from one target to the next instead of blinking out.
    if (!step) {
      setTarget(null);
      return undefined;
    }

    let handle = 0;
    let cancelled = false;
    let found: Element[] = [];
    let last: Spotlight | null = null;

    const measure = () => {
      if (cancelled || found.length === 0) return;
      const rect = measureTargets(main, found);
      const next = rect ? { target: rect, rail: measureRail(main, step) } : null;
      updateFrame(main);
      setTarget((current) => (sameSpotlight(current, next) ? current : next));
      last = next;
    };

    // Keeps measuring until the rect holds still for two frames, for layout that
    // is still settling after the view switch or the scroll.
    const settle = (frames: number, still: number) => {
      handle = requestAnimationFrame(() => {
        if (cancelled) return;
        const before = last;
        measure();
        const nextStill = sameSpotlight(before, last) ? still + 1 : 0;
        if (nextStill < 2 && frames < SETTLE_FRAMES) settle(frames + 1, nextStill);
      });
    };

    // The frame switches to the step's view in its own effect, after this one,
    // so frames spent waiting for that do not count against the target.
    const query = (viewFrames: number, targetFrames: number) => {
      handle = requestAnimationFrame(() => {
        if (cancelled) return;
        const onStep =
          main.getAttribute("data-view") === step.view
          && main.getAttribute("data-platform") === step.platform;
        if (!onStep) {
          if (viewFrames < VIEW_FRAMES) query(viewFrames + 1, targetFrames);
          else setTarget(null);
          return;
        }
        found = findTargets(main, step);
        if (found.length === 0) {
          if (targetFrames < TARGET_FRAMES) query(viewFrames, targetFrames + 1);
          else setTarget(null);
          return;
        }
        scrollIntoPanel(found[0]);
        measure();
        settle(0, 0);
      });
    };
    query(0, 0);

    // Capture: the panel's scroll does not bubble, and it is the panel that moves.
    main.addEventListener("scroll", measure, true);
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : undefined;
    observer?.observe(main);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
      main.removeEventListener("scroll", measure, true);
      observer?.disconnect();
    };
  }, [rootRef, step]);

  return { spotlight: target, frame };
}

// A clip-path that keeps only `rect` of the frame.
function insetTo(rect: Rect, frame: Size): string {
  const right = Math.max(0, frame.width - (rect.left + rect.width));
  const bottom = Math.max(0, frame.height - (rect.top + rect.height));
  return `inset(${rect.top}px ${right}px ${bottom}px ${rect.left}px)`;
}

function spotlightStyle(rect: Rect): React.CSSProperties {
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    boxShadow: `0 0 0 2px var(--accent), 0 0 0 9999px ${SCRIM}`,
  };
}

const secondaryButton =
  "rounded-lg px-2.5 py-1 text-[11px] font-semibold text-zinc-600 outline-none transition-colors hover:bg-black/5 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-300 dark:hover:bg-white/5 dark:hover:text-zinc-100";
const primaryButton =
  "rounded-lg px-3 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]";

/** The onboarding tour drawn over the popup frame: a scrim with a cut-out
 * around the step's target, a second one around the rail entry of the step's
 * view when it has one, and the message card beside them. It only reads the
 * frame's DOM; every decision goes back through `onAction`.
 *
 * A box-shadow scrim has room for one hole, so a lit rail splits the frame in
 * two: the main spotlight's scrim is clipped to the content beside the rail,
 * and the rail gets its own spotlight clipped to the rail. The two regions
 * meet at the rail's edge, so the scrim reads as one. */
export function OnboardingOverlay({
  phase,
  onAction,
}: {
  phase: VisibleTourPhase;
  onAction(action: TourAction): void;
}): React.ReactElement {
  const { t, dir } = useContext(I18nContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const index = phase.kind === "step" ? phase.index : -1;
  const step = index >= 0 ? TOUR_STEPS[index] : undefined;
  const { spotlight, frame } = useSpotlight(rootRef, step);
  const target = spotlight?.target ?? null;
  const rail = step?.railView ? (spotlight?.rail ?? null) : null;
  const content = rail ? placementFrame(frame, rail.bounds) : null;
  const [card, setCard] = useState<Size>(FALLBACK_CARD);

  // The card's height follows its copy, so it is measured after every render.
  useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    const next = {
      width: element.offsetWidth || FALLBACK_CARD.width,
      height: element.offsetHeight || FALLBACK_CARD.height,
    };
    setCard((current) =>
      current.width === next.width && current.height === next.height ? current : next,
    );
  });

  useEffect(() => {
    primaryRef.current?.focus();
  }, [phase.kind, index]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onAction("skip");
        return;
      }
      if (event.key === "Enter") {
        // A focused card button already answers Enter with its own click.
        const focused = event.target as Element | null;
        if (focused?.closest?.("button") && cardRef.current?.contains(focused)) return;
        event.preventDefault();
        onAction(primaryAction(phase));
        return;
      }
      if (phase.kind !== "step") return;
      const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
      const backward = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
      if (event.key === forward) {
        event.preventDefault();
        onAction("next");
      } else if (event.key === backward) {
        event.preventDefault();
        onAction("back");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dir, onAction, phase]);

  const placement = placeCard(
    step ? target : null,
    card,
    step && target && content ? content : frame,
  );
  const title =
    phase.kind === "welcome"
      ? "tourWelcomeTitle"
      : phase.kind === "done"
        ? "tourDoneTitle"
        : step!.titleKey;
  const body =
    phase.kind === "welcome"
      ? "tourWelcomeBody"
      : phase.kind === "done"
        ? "tourDoneBody"
        : step!.bodyKey;

  return (
    <div ref={rootRef} data-onboarding-tour className="absolute inset-0 z-50">
      {step && target ? (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden"
            style={content ? { clipPath: insetTo({ ...content, top: 0 }, frame) } : undefined}
          >
            <div
              data-tour-spotlight
              className="absolute rounded-[10px] motion-safe:transition-all motion-safe:duration-300"
              style={spotlightStyle(target)}
            />
          </div>
          {rail && content ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden"
              style={{
                clipPath: insetTo(
                  content.left > 0
                    ? { top: 0, left: 0, width: content.left, height: frame.height }
                    : {
                        top: 0,
                        left: content.width,
                        width: frame.width - content.width,
                        height: frame.height,
                      },
                  frame,
                ),
              }}
            >
              <div
                data-tour-rail-spotlight
                data-rail-view={step.railView}
                className="absolute rounded-[10px]"
                style={spotlightStyle(rail.hole)}
              />
            </div>
          ) : null}
        </>
      ) : (
        <div
          data-tour-scrim
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ backgroundColor: SCRIM }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-side={placement.side}
        className="surface absolute w-[300px] ring-1 ring-black/5 dark:ring-white/15 max-w-[calc(100%-16px)] rounded-xl p-3.5 motion-safe:transition-all motion-safe:duration-300"
        style={{ top: placement.top, left: placement.left }}
      >
        {phase.kind === "step" ? (
          <p
            data-tour-progress
            aria-live="polite"
            className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 tabular-nums dark:text-zinc-400"
          >
            {t("tourProgress", [String(index + 1), String(TOUR_STEPS.length)])}
          </p>
        ) : null}
        <h2
          id={titleId}
          className="text-[13px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100"
        >
          {t(title)}
        </h2>
        <p id={bodyId} className="mt-1 text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
          {t(body)}
        </p>
        <div className="mt-3 flex items-center gap-1.5">
          {phase.kind === "done" ? null : (
            <button
              type="button"
              data-tour-action="skip"
              onClick={() => onAction("skip")}
              className={cn(secondaryButton, "-ms-2.5")}
            >
              {t("tourSkip")}
            </button>
          )}
          <span className="flex-1" />
          {phase.kind === "step" && index > 0 ? (
            <button
              type="button"
              data-tour-action="back"
              onClick={() => onAction("back")}
              className={secondaryButton}
            >
              {t("tourBack")}
            </button>
          ) : null}
          <button
            ref={primaryRef}
            type="button"
            data-tour-action={primaryAction(phase)}
            onClick={() => onAction(primaryAction(phase))}
            className={primaryButton}
            style={{ backgroundColor: "var(--accent)" }}
          >
            {t(
              phase.kind === "welcome"
                ? "tourStart"
                : phase.kind === "done"
                  ? "tourFinish"
                  : "tourNext",
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
