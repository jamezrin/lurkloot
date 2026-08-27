/** A window-like target, narrowed so tests can drive this with a stub. */
export interface ResizeTarget {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: "resize", handler: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: "resize", handler: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
}

/**
 * A browser action popup sizes its own window to its content, so it re-measures
 * — and fires `resize` — continuously, at an unchanged size. dnd-kit cancels any
 * in-flight drag on `resize` (both `PointerSensor`, via `AbstractPointerSensor`,
 * and `KeyboardSensor`), so starting a drag fires the very event that kills it
 * and campaign/watchlist reordering never completes. See issue #431: the same
 * popup UI reorders fine on the marketing site and in `popup.html` opened as a
 * tab, because neither of those is an auto-sizing popup window.
 *
 * Swallow the phantom events before anything else sees them. `resize` targets
 * the window, so window listeners run in registration order — calling this at
 * bootstrap puts it ahead of the listeners dnd-kit adds when a sensor starts.
 * A genuine size change is passed through untouched, so dnd-kit's
 * stale-measurement guard still works.
 *
 * Returns a teardown function.
 */
export function suppressPhantomResize(target: ResizeTarget): () => void {
  let size = `${target.innerWidth}x${target.innerHeight}`;

  const onResize = (event: Event): void => {
    const next = `${target.innerWidth}x${target.innerHeight}`;
    if (next === size) {
      event.stopImmediatePropagation();
      return;
    }
    size = next;
  };

  target.addEventListener("resize", onResize, true);
  return () => target.removeEventListener("resize", onResize, true);
}
