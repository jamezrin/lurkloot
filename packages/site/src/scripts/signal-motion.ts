// Scroll choreography for the signal homepage. Everything is progressive
// enhancement: the page reads top to bottom without this script, and with
// reduced motion it only keeps the nav state. It adds two <html> classes:
//   sg-motion  — entrance reveals and the demo window rising into place;
//   sg-pinned  — the sticky farming-order steps, only on screens big enough
//                to hold a full-height scene.
// One rAF-throttled scroll handler writes progress into CSS variables.
const root = document.documentElement;
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
const roomy = window.matchMedia("(min-width: 901px) and (min-height: 700px)");

const nav = document.querySelector<HTMLElement>("[data-nav]");
const demo = document.querySelector<HTMLElement>("[data-rise]");
const steps = document.querySelector<HTMLElement>(".sg-steps");
const stepStage = steps?.querySelector<HTMLElement>(".sg-steps__stage");
const stepItems = Array.from(steps?.querySelectorAll<HTMLElement>("[data-step-item]") ?? []);
const scenes = Array.from(steps?.querySelectorAll<HTMLElement>("[data-scene]") ?? []);

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

// Progress of a tall section through its sticky range: 0 when its top meets the
// viewport top, 1 when its bottom meets the viewport bottom.
function pinProgress(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return clamp(-rect.top / Math.max(1, rect.height - innerHeight));
}

function setCurrent(items: HTMLElement[], index: number) {
  items.forEach((item, i) => item.classList.toggle("is-current", i === index));
}

let frame = 0;
function update() {
  frame = 0;
  nav?.toggleAttribute("data-scrolled", scrollY > 8);
  if (!root.classList.contains("sg-motion")) return;

  if (demo) {
    const rect = demo.getBoundingClientRect();
    demo.style.setProperty("--rp", clamp((innerHeight - rect.top) / (innerHeight * 0.55)).toFixed(4));
  }

  if (!root.classList.contains("sg-pinned")) return;
  if (stepStage && stepItems.length) {
    const scaled = pinProgress(stepStage) * stepItems.length;
    const index = Math.min(stepItems.length - 1, Math.floor(scaled));
    setCurrent(stepItems, index);
    setCurrent(scenes, index);
    stepItems.forEach((item, i) => item.style.setProperty("--sp", String(i < index ? 1 : i > index ? 0 : clamp(scaled - index))));
  }
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

const revealObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add("is-in");
    revealObserver.unobserve(entry.target);
  }
}, { rootMargin: "0px 0px -8% 0px" });

function configure() {
  const motion = !reduce.matches;
  root.classList.toggle("sg-motion", motion);
  root.classList.toggle("sg-pinned", motion && roomy.matches);
  revealObserver.disconnect();

  const reveals = document.querySelectorAll<HTMLElement>(".signal [data-reveal]");
  if (motion) {
    reveals.forEach((element) => {
      if (element.classList.contains("is-in")) return;
      // Stagger siblings that reveal together, like a row of cards.
      const siblings = Array.from(element.parentElement?.children ?? []).filter((child) => child.hasAttribute("data-reveal"));
      element.style.setProperty("--d", `${Math.min(siblings.indexOf(element), 3) * 90}ms`);
      revealObserver.observe(element);
    });
  } else {
    reveals.forEach((element) => element.classList.add("is-in"));
    demo?.style.removeProperty("--rp");
  }
  if (!root.classList.contains("sg-pinned")) {
    [...stepItems, ...scenes].forEach((element) => element.classList.remove("is-current"));
    stepItems.forEach((item) => item.style.removeProperty("--sp"));
  }
  update();
}

// Keyboard focus should never land on content that is still hidden.
document.querySelector(".signal")?.addEventListener("focusin", (event) => {
  (event.target as HTMLElement).closest("[data-reveal]")?.classList.add("is-in");
});

window.addEventListener("scroll", schedule, { passive: true });
window.addEventListener("resize", schedule, { passive: true });
reduce.addEventListener("change", configure);
roomy.addEventListener("change", configure);
configure();
