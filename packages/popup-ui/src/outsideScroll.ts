import React from "react";

/** Closes a non-modal floating popup when anything outside it scrolls.
 *
 * Non-modal popups leave page scroll unlocked (a modal one restyles the body,
 * and every body restyle makes Chrome re-measure the extension popup), so the
 * Queue can scroll under an open menu, and the anchored menu would ride along
 * off screen. Closing it, as a native select does, keeps it with its trigger.
 * `container` is where the popup is portalled (usePortalContainer). */
export function useCloseOnOutsideScroll(
  open: boolean,
  close: () => void,
  popupRef: React.RefObject<Element | null>,
  container: HTMLElement | ShadowRoot | null,
): void {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return;
      closeRef.current();
    };
    // Scroll does not bubble, so only a capturing listener hears every
    // scroller; nor does it leave a shadow root, so in the site demo the
    // listener goes on the root the popup is portalled into.
    const target = container?.nodeType === 11 ? container : document;
    target.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => target.removeEventListener("scroll", onScroll, { capture: true });
  }, [open, container, popupRef]);
}
