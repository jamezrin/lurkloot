// Apple-style buttery scrolling via Lenis, plus anchor-link smoothing.
// Fully disabled under prefers-reduced-motion. Inner scroll areas opt out with
// the `data-lenis-prevent` attribute (e.g. the embedded popup demo).
import Lenis from "lenis";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!reduceMotion) {
  const lenis = new Lenis({
    duration: 1.1,
    easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
    touchMultiplier: 1.4,
  });

  const raf = (time: number) => {
    lenis.raf(time);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  // Smoothly scroll to in-page anchors (nav, scroll cue, etc.).
  document.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
    if (!link) return;
    const id = link.getAttribute("href");
    if (!id || id === "#") return;
    const target = document.querySelector(id);
    if (!target) return;
    event.preventDefault();
    lenis.scrollTo(target as HTMLElement, { offset: -72, duration: 1.3 });
    history.replaceState(null, "", id);
  });
}
