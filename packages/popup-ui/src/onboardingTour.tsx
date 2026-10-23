import type React from "react";
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { I18nContext } from "./context";
import { cn, scrollIntoPanel } from "./primitives";
import {
  clampTarget,
  placeCard,
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

function measureTargets(main: HTMLElement, targets: readonly Element[]): Rect | null {
  const origin = main.getBoundingClientRect();
  const union = unionRect(
    targets.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top - origin.top,
        left: rect.left - origin.left,
        width: rect.width,
        height: rect.height,
      };
    }),
  );
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

// Finds the current step's targets in the frame and keeps their rect current.
// Returns null while there is no step, or when the targets never turned up.
function useSpotlight(
  rootRef: React.RefObject<HTMLDivElement | null>,
  step: TourStep | undefined,
): { target: Rect | null; frame: Size } {
  const [target, setTarget] = useState<Rect | null>(null);
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
    let last: Rect | null = null;

    const measure = () => {
      if (cancelled || found.length === 0) return;
      const next = measureTargets(main, found);
      updateFrame(main);
      setTarget((current) => (sameRect(current, next) ? current : next));
      last = next;
    };

    // Keeps measuring until the rect holds still for two frames, for layout that
    // is still settling after the view switch or the scroll.
    const settle = (frames: number, still: number) => {
      handle = requestAnimationFrame(() => {
        if (cancelled) return;
        const before = last;
        measure();
        const nextStill = sameRect(before, last) ? still + 1 : 0;
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

  return { target, frame };
}

const secondaryButton =
  "rounded-lg px-2.5 py-1 text-[11px] font-semibold text-zinc-600 outline-none transition-colors hover:bg-black/5 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-300 dark:hover:bg-white/5 dark:hover:text-zinc-100";
const primaryButton =
  "rounded-lg px-3 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]";

/** The onboarding tour drawn over the popup frame: a scrim with one cut-out
 * around the step's target, and the message card beside it. It only reads the
 * frame's DOM; every decision goes back through `onAction`. */
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
  const { target, frame } = useSpotlight(rootRef, step);
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

  const placement = placeCard(step ? target : null, card, frame);
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
        <div
          data-tour-spotlight
          aria-hidden="true"
          className="pointer-events-none absolute rounded-[10px] motion-safe:transition-all motion-safe:duration-300"
          style={{
            top: target.top,
            left: target.left,
            width: target.width,
            height: target.height,
            boxShadow: `0 0 0 2px var(--accent), 0 0 0 9999px ${SCRIM}`,
          }}
        />
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
