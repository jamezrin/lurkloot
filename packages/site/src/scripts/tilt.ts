// Pointer-tracked 3D tilt + glare for any element with [data-tilt].
// `data-tilt-max` tunes the max rotation in degrees (default 7).
// Mouse-only by design: skipped on coarse pointers and under reduced motion.
// NOTE: tilted elements must not carry a fill-mode animation that pins
// `transform` (e.g. .reveal) — put that on a wrapper instead.
const fine = window.matchMedia("(pointer: fine)").matches;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (fine && !reduceMotion) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-tilt]")) {
    const max = Number(el.dataset.tiltMax) || 7;
    const glare = document.createElement("div");
    glare.className = "tilt-glare";
    glare.setAttribute("aria-hidden", "true");
    el.appendChild(glare);

    let raf = 0;
    el.addEventListener(
      "pointermove",
      (e) => {
        const r = el.getBoundingClientRect();
        const nx = (e.clientX - r.left) / r.width - 0.5;
        const ny = (e.clientY - r.top) / r.height - 0.5;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          el.style.transform =
            `perspective(900px) rotateX(${(-ny * max).toFixed(2)}deg) ` +
            `rotateY(${(nx * max).toFixed(2)}deg) translateZ(10px)`;
          el.style.setProperty("--mx", `${((nx + 0.5) * 100).toFixed(1)}%`);
          el.style.setProperty("--my", `${((ny + 0.5) * 100).toFixed(1)}%`);
        });
      },
      { passive: true },
    );
    el.addEventListener("pointerleave", () => {
      cancelAnimationFrame(raf);
      el.style.transform = "";
    });
  }
}
