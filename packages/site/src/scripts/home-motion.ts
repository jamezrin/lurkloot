// Progressive enhancement: content is visible without JS. Only the artwork
// moves with scrolling; the interactive popup and its ancestors stay still.
const home = document.querySelector<HTMLElement>(".home");
const preference = window.matchMedia("(prefers-reduced-motion: reduce)");

if (home) {
  const reveals = home.querySelectorAll<HTMLElement>([
    ".home-intro", ".home-section-head", ".home-steps > li",
    ".home-priorities > div", ".home-platforms > article",
    ".home-runtime-options > article", ".home-questions > div", ".home-close > div",
    ".guide-hero-copy", ".guide-overview", ".guide-section-heading", ".guide-section-body",
    ".document-hero", ".release",
  ].join(","));
  const artwork = home.querySelector<HTMLElement>(".home-game-art");
  const covers = artwork?.querySelectorAll<HTMLElement>(":scope > div") ?? [];
  const animations = new Set<Animation>();
  let cleanup = () => {};

  function configureMotion() {
    cleanup();
    if (preference.matches) return;

    const entranceObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entranceObserver.unobserve(entry.target);
        const element = entry.target as HTMLElement;
        const siblings = Array.from(element.parentElement?.children ?? []);
        const stagger = element.matches("li, article") ? Math.min(siblings.indexOf(element), 2) * 75 : 0;
        const animation = element.animate([
          { opacity: 0, transform: "translateY(22px)" },
          { opacity: 1, transform: "translateY(0)" },
        ], { duration: 600, delay: stagger, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" });
        animations.add(animation);
        animation.onfinish = () => animations.delete(animation);
      }
    }, { threshold: 0, rootMargin: "0px 0px -32px 0px" });
    reveals.forEach((element) => entranceObserver.observe(element));

    let frame = 0;
    let visible = false;
    const updateArtwork = () => {
      frame = 0;
      if (!artwork || !visible) return;
      const rect = artwork.getBoundingClientRect();
      const progress = Math.max(-1, Math.min(1, (innerHeight / 2 - rect.top - rect.height / 2) / (innerHeight / 2 + rect.height / 2)));
      const distance = innerWidth <= 700 ? 14 : 28;
      covers.forEach((cover, index) => {
        cover.style.setProperty("--artwork-drift", `${progress * distance * [0.65, -0.8, 1][index % 3]}px`);
      });
    };
    const scheduleArtwork = () => {
      if (visible && !frame) frame = requestAnimationFrame(updateArtwork);
    };
    const artworkObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      artwork?.toggleAttribute("data-motion-visible", visible);
      scheduleArtwork();
    });
    if (artwork) artworkObserver.observe(artwork);
    window.addEventListener("scroll", scheduleArtwork, { passive: true });
    window.addEventListener("resize", scheduleArtwork, { passive: true });

    // Keyboard focus should never wait for an entrance animation to finish.
    const finishEntrances = () => animations.forEach((animation) => animation.finish());
    home!.addEventListener("focusin", finishEntrances);
    cleanup = () => {
      entranceObserver.disconnect();
      artworkObserver.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleArtwork);
      window.removeEventListener("resize", scheduleArtwork);
      home!.removeEventListener("focusin", finishEntrances);
      animations.forEach((animation) => animation.cancel());
      animations.clear();
      artwork?.removeAttribute("data-motion-visible");
      covers.forEach((cover) => cover.style.removeProperty("--artwork-drift"));
    };
  }

  configureMotion();
  preference.addEventListener("change", configureMotion);
}
