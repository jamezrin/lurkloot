// Draws and drives the drop chase in the closing call to action (the model is
// in dropChase.ts). While the panel is on screen the chaser plays on its own;
// a click or tap on the panel, or its Play button, hands it to the visitor, who
// steers with the arrow keys or WASD, or by clicking where to go. Esc, the Exit
// button, moving focus elsewhere or scrolling the panel away ends the game.
// With reduced motion the board holds a still frame until a game starts.
import { chaserPoint, createBoard, createGame, reshape, steer, step, type Direction, type Game, type Rect } from "../dropChase";

const AUTO_SPEED = 2.6;
const PLAY_SPEED = 4.5;
const BEST_KEY = "lurkloot:drop-chase-best";
const KEYS: Record<string, Direction> = {
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
};
const ANGLES: Record<Direction, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
// Text is measured line by line so drops can sit beside a short line; the
// other pieces are measured as boxes.
const AVOID_TEXT = "h2, .sg-cta__lede, .sg-cta__fine";
const AVOID_BOXES = ".sg-pill, .bpills__icons, .bpills__label, [data-chase-ui]";

function rgba(hex: string, alpha: number) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  const [r, g, b] = match ? match.slice(1).map((part) => parseInt(part, 16)) : [255, 255, 255];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function readBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest(value: number) {
  try {
    localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // No storage: the best score lasts for this visit only.
  }
}

function run(panel: HTMLElement) {
  const canvas = panel.querySelector<HTMLCanvasElement>("[data-chase-canvas]");
  const context = canvas?.getContext("2d");
  const toggle = panel.querySelector<HTMLButtonElement>("[data-chase-toggle]");
  const toggleLabel = panel.querySelector<HTMLElement>("[data-chase-label]");
  const scoreValue = panel.querySelector<HTMLElement>("[data-chase-score]");
  const scoreUnit = panel.querySelector<HTMLElement>("[data-chase-unit]");
  const bestValue = panel.querySelector<HTMLElement>("[data-chase-best]");
  if (!canvas || !context || !toggle || !toggleLabel || !scoreValue || !scoreUnit || !bestValue) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const style = getComputedStyle(panel);
  const cell = parseFloat(style.getPropertyValue("--sg-cta-cell")) || 48;
  const twitch = style.getPropertyValue("--sg-twitch").trim() || "#a970ff";
  const kick = style.getPropertyValue("--sg-kick").trim() || "#53fc18";

  let game: Game | undefined;
  let width = 0;
  let height = 0;
  let playing = false;
  let visible = false;
  let frame = 0;
  let last = 0;
  let best = readBest();
  const bursts: { x: number; y: number; at: number }[] = [];

  function measure(): Rect[] {
    const origin = panel.getBoundingClientRect();
    const pad = cell * 0.4;
    const rects: DOMRect[] = [];
    for (const element of panel.querySelectorAll(AVOID_TEXT)) {
      const range = document.createRange();
      range.selectNodeContents(element);
      rects.push(...range.getClientRects());
    }
    for (const element of panel.querySelectorAll(AVOID_BOXES)) rects.push(element.getBoundingClientRect());
    return rects
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: rect.left - origin.left - pad,
        top: rect.top - origin.top - pad,
        right: rect.right - origin.left + pad,
        bottom: rect.bottom - origin.top + pad,
      }));
  }

  function resize() {
    width = panel.clientWidth;
    height = panel.clientHeight;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas!.width = Math.round(width * ratio);
    canvas!.height = Math.round(height * ratio);
    context!.setTransform(ratio, 0, 0, ratio, 0, 0);
    const board = createBoard(width, height, cell, measure());
    if (!game || (!playing && reduce.matches)) game = createGame(board);
    else reshape(game, board);
    draw(performance.now());
  }

  function drawDrop(x: number, y: number, scale: number) {
    const c = context!;
    c.fillStyle = "rgba(255, 255, 255, 0.07)";
    c.beginPath();
    c.arc(x, y, 11 * scale, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#ededed";
    c.beginPath();
    c.moveTo(x, y - 7 * scale);
    c.bezierCurveTo(x + 5.5 * scale, y - 1 * scale, x + 5 * scale, y + 5 * scale, x, y + 5 * scale);
    c.bezierCurveTo(x - 5 * scale, y + 5 * scale, x - 5.5 * scale, y - 1 * scale, x, y - 7 * scale);
    c.fill();
  }

  function drawChaser() {
    const c = context!;
    const { x, y } = chaserPoint(game!);
    const radius = cell * 0.32;
    // Fully open at each spot, closed halfway between.
    const mouth = (0.03 + 0.21 * Math.abs(Math.cos(game!.chaser.travelled * Math.PI))) * Math.PI;
    const facing = ANGLES[game!.chaser.facing];
    const fill = c.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    fill.addColorStop(0, twitch);
    fill.addColorStop(1, kick);
    c.save();
    c.shadowColor = rgba(twitch, 0.45);
    c.shadowBlur = 18;
    c.fillStyle = fill;
    c.beginPath();
    c.moveTo(x, y);
    c.arc(x, y, radius, facing + mouth, facing - mouth + Math.PI * 2);
    c.closePath();
    c.fill();
    c.restore();
  }

  function draw(now: number) {
    if (!game) return;
    const c = context!;
    const still = reduce.matches;
    c.clearRect(0, 0, width, height);
    for (const drop of game.drops) {
      const grow = still ? 1 : Math.min(1, drop.age / 0.3);
      const bob = still ? 0 : Math.sin(now / 520 + drop.col * 0.9 + drop.row * 1.7) * 1.5;
      drawDrop(drop.col * cell, drop.row * cell + bob, 1 - (1 - grow) ** 3);
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const t = (now - bursts[i].at) / 380;
      if (t >= 1) {
        bursts.splice(i, 1);
        continue;
      }
      c.strokeStyle = `rgba(255, 255, 255, ${0.5 * (1 - t)})`;
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(bursts[i].x, bursts[i].y, 6 + 16 * t, 0, Math.PI * 2);
      c.stroke();
    }
    drawChaser();
  }

  function showScore() {
    const eaten = game?.eaten ?? 0;
    scoreValue!.textContent = String(eaten);
    scoreUnit!.textContent = eaten === 1 ? "drop" : "drops";
    bestValue!.textContent = String(best);
  }

  function running() {
    return visible && !document.hidden && (playing || !reduce.matches);
  }

  function schedule() {
    if (frame || !running()) return;
    last = 0;
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    frame = 0;
    if (!game || !running()) return;
    const seconds = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    for (const spot of step(game, seconds, playing ? PLAY_SPEED : AUTO_SPEED, !playing)) {
      if (!reduce.matches) bursts.push({ x: spot.col * cell, y: spot.row * cell, at: now });
      if (!playing) continue;
      if (game.eaten > best) {
        best = game.eaten;
        saveBest(best);
      }
      showScore();
    }
    draw(now);
    frame = requestAnimationFrame(tick);
  }

  function play() {
    if (playing || !game) return;
    playing = true;
    game.eaten = 0;
    showScore();
    panel.classList.add("is-playing");
    toggleLabel!.textContent = "Exit";
    toggle!.setAttribute("aria-label", "Exit the drop chase");
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    // A still chaser sets off the way it faces, into its line of drops.
    if (!game.chaser.heading) steer(game, game.chaser.facing);
    schedule();
  }

  function stop() {
    if (!playing || !game) return;
    playing = false;
    panel.classList.remove("is-playing");
    toggleLabel!.textContent = "Play";
    toggle!.setAttribute("aria-label", "Play the drop chase");
    if (reduce.matches) {
      game = createGame(game.board);
      draw(performance.now());
    } else {
      game.chaser.queued = null;
      schedule();
    }
  }

  // Steers towards a point on the board, along whichever axis is further off.
  function aim(x: number, y: number) {
    if (!game) return;
    const from = chaserPoint(game);
    const dx = x - from.x;
    const dy = y - from.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < cell / 2) return;
    steer(game, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  }

  panel.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a, button")) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    const wasPlaying = playing;
    play();
    const origin = panel.getBoundingClientRect();
    // The first click only starts the game, so it doesn't undo the opening run.
    if (wasPlaying) aim(event.clientX - origin.left, event.clientY - origin.top);
  });

  panel.addEventListener("keydown", (event) => {
    if (!playing || !game || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      stop();
      toggle!.focus();
      return;
    }
    const direction = KEYS[event.code];
    if (!direction) return;
    event.preventDefault();
    steer(game, direction);
  });

  panel.addEventListener("focusout", (event) => {
    if (!playing || panel.contains(event.relatedTarget as Node | null)) return;
    // Switching windows blurs the page but leaves focus where it was.
    setTimeout(() => {
      if (!panel.contains(document.activeElement)) stop();
    });
  });

  toggle.addEventListener("click", () => (playing ? stop() : play()));

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (!visible) stop();
    schedule();
  }).observe(panel);
  new ResizeObserver(resize).observe(panel);
  document.addEventListener("visibilitychange", schedule);
  reduce.addEventListener("change", () => {
    if (!playing && reduce.matches && game) game = createGame(game.board);
    draw(performance.now());
    schedule();
  });
  void document.fonts?.ready.then(resize);

  panel.tabIndex = -1;
  panel.dataset.chaseReady = "";
  for (const element of panel.querySelectorAll<HTMLElement>("[data-chase-ui]")) element.hidden = false;
  showScore();
  resize();
}

const panel = document.querySelector<HTMLElement>("[data-chase]");
if (panel) run(panel);
