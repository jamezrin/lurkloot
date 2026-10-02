// The interactive demo: the full popup workspace, sized by its container.
import { useEffect, useRef } from "react";
import { FRAMELESS_CSS, mountPopup } from "./mountPopup";

export default function PopupDemo({ frameless = false }: { frameless?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mounted.current) return;
    mounted.current = true;
    const { unmount } = mountPopup(host, { css: frameless ? FRAMELESS_CSS : undefined });
    return () => {
      mounted.current = false;
      unmount();
    };
  }, [frameless]);

  return (
    <div
      ref={hostRef}
      className="sg-demo__host"
      data-lenis-prevent
      aria-label="Lurkloot popup — interactive demo"
    />
  );
}
