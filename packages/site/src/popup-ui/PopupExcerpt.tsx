// A read-only excerpt of the real popup, opened on one view and drawn at a
// narrower frame so the rail collapses to icons, the way the extension does in
// a small window. It illustrates a section rather than being a second demo:
// inert, hidden from assistive tech, and never steals the page's scrolling.
import { useEffect, useRef, type CSSProperties } from "react";
import type { PopupView } from "@lurkloot/popup-ui";
import { FRAMELESS_CSS, mountPopup } from "./mountPopup";

export default function PopupExcerpt({
  view,
  width = 520,
  height = 560,
  scroll = "start",
}: {
  view: PopupView;
  width?: number;
  height?: number;
  // "end" scrolls the panel to the bottom once its content has settled.
  scroll?: "start" | "end";
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    const box = boxRef.current;
    const host = hostRef.current;
    if (!box || !host || mounted.current) return;
    mounted.current = true;
    const frame = `main[data-platform] { width: ${width}px !important; height: ${height}px !important; }`;
    const { shadow, unmount } = mountPopup(host, { css: `${FRAMELESS_CSS}\n${frame}`, view });

    const resize = new ResizeObserver(([entry]) => {
      box.style.setProperty("--excerpt-scale", String(Math.min(1, entry.contentRect.width / width)));
    });
    resize.observe(box);

    // The catalog and demo snapshot load asynchronously, so follow the panel
    // to its end while content arrives, then stop.
    let follow: MutationObserver | undefined;
    let stop: number | undefined;
    if (scroll === "end") {
      const toEnd = () => {
        const panel = shadow.querySelector<HTMLElement>("[data-scroll-panel]");
        if (panel) panel.scrollTop = panel.scrollHeight;
      };
      follow = new MutationObserver(toEnd);
      follow.observe(shadow, { childList: true, subtree: true, attributes: true });
      stop = window.setTimeout(() => follow?.disconnect(), 4000);
    }

    return () => {
      mounted.current = false;
      resize.disconnect();
      follow?.disconnect();
      window.clearTimeout(stop);
      unmount();
    };
  }, [view, width, height, scroll]);

  return (
    <div
      ref={boxRef}
      className="sg-excerpt"
      style={{ "--excerpt-w": width, "--excerpt-h": height } as CSSProperties}
      aria-hidden="true"
      inert
    >
      <div ref={hostRef} className="sg-excerpt__host" />
    </div>
  );
}
