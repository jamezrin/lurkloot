// Draws and drives the snake in the closing call to action (the rules are in
// dropSnake.ts). While the panel is on screen and nobody is playing, the snake
// tours one random maze after another. A click or tap on the panel, or its Play
// button, starts a game: the copy steps aside, and the arrow keys or WASD, or a
// click or tap towards where to turn, steer. Esc, the Exit button, moving focus
// elsewhere or scrolling the panel away goes back to the tours. With reduced
// motion a tour is a still frame until a game starts.
import {
  createBoard,
  createMatch,
  createTour,
  matchStep,
  onBoard,
  tourStep,
  turn,
  type Board,
  type Cell,
  type Direction,
  type Item,
  type Match,
  type Rect,
  type Snake,
  type Tour,
} from "../dropSnake";

const TOUR_STEP = 0.1;
// Seconds per move in a game: quicker as the snake grows, down to a floor.
const MATCH_STEP = 0.14;
const FASTEST_STEP = 0.085;
const BITE_PAUSE_MS = 900;
const FADE_MS = 500;
const BEST_KEY = "lurkloot:drop-snake-best";
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
const VECTORS: Record<Direction, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
// Text is measured line by line so drops can sit beside a short line; the
// other pieces are measured as boxes.
const COPY_TEXT = "h2, .sg-cta__lede, .sg-cta__fine";
const COPY_BOXES = ".sg-pill, .bpills__icons, .bpills__label";
const CHROME = "[data-snake-ui]";

type Point = { x: number; y: number };

function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : fallback;
}

function toHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const light = (max + min) / 2;
  if (max === min) return [0, 0, light * 100];
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * light - 1));
  const hue = max === rn ? ((gn - bn) / delta) % 6 : max === gn ? (bn - rn) / delta + 2 : (rn - gn) / delta + 4;
  return [(hue * 60 + 360) % 360, saturation * 100, light * 100];
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
  const canvas = panel.querySelector<HTMLCanvasElement>("[data-snake-canvas]");
  const context = canvas?.getContext("2d");
  const toggle = panel.querySelector<HTMLButtonElement>("[data-snake-toggle]");
  const toggleLabel = panel.querySelector<HTMLElement>("[data-snake-label]");
  const scoreValue = panel.querySelector<HTMLElement>("[data-snake-score]");
  const scoreUnit = panel.querySelector<HTMLElement>("[data-snake-unit]");
  const bestValue = panel.querySelector<HTMLElement>("[data-snake-best]");
  if (!canvas || !context || !toggle || !toggleLabel || !scoreValue || !scoreUnit || !bestValue) return;
  const c = context;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const style = getComputedStyle(panel);
  const cell = parseFloat(style.getPropertyValue("--sg-cta-cell")) || 48;
  const twitch = hexToRgb(style.getPropertyValue("--sg-twitch"), [169, 112, 255]);
  const kick = hexToRgb(style.getPropertyValue("--sg-kick"), [83, 252, 24]);
  const rgb = ([r, g, b]: number[], alpha = 1) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
  // The body shades from Twitch at the head to Kick at the tail. Blending in
  // HSL, the short way round the hue circle, passes through blue and cyan
  // rather than the grey an RGB blend gives halfway.
  const head = toHsl(twitch);
  const tail = toHsl(kick);
  const turnHue = ((tail[0] - head[0] + 540) % 360) - 180;
  const shade = (t: number) =>
    `hsl(${(head[0] + turnHue * t + 360) % 360}, ${head[1] + (tail[1] - head[1]) * t}%, ${head[2] + (tail[2] - head[2]) * t}%)`;

  let width = 0;
  let height = 0;
  let board: Board | undefined;
  let copy: Rect[] = [];
  // Fades whatever the canvas draws under the copy; see draw().
  let veil: HTMLCanvasElement | undefined;
  let tour: Tour | undefined;
  let walls: Path2D | undefined;
  let mazeAt = 0;
  let fading: { walls: Path2D; at: number } | undefined;
  let match: Match | undefined;
  let playing = false;
  let visible = false;
  let frame = 0;
  let last = 0;
  // Time banked towards the next move; negative for a pause between mazes.
  let clock = 0;
  let bittenAt = 0;
  let best = readBest();
  const held: Direction[] = [];
  const bursts: { x: number; y: number; at: number }[] = [];

  const centre = (spot: Cell | Point): Point => {
    const { col, row } = "col" in spot ? { col: spot.col, row: spot.row } : { col: spot.x, row: spot.y };
    return { x: board!.x + (col + 0.5) * cell, y: board!.y + (row + 0.5) * cell };
  };

  function measure() {
    const origin = panel.getBoundingClientRect();
    const pad = 6;
    const relative = (rects: DOMRect[]) =>
      rects
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({
          left: rect.left - origin.left - pad,
          top: rect.top - origin.top - pad,
          right: rect.right - origin.left + pad,
          bottom: rect.bottom - origin.top + pad,
        }));
    const text: DOMRect[] = [];
    for (const element of panel.querySelectorAll(COPY_TEXT)) {
      const range = document.createRange();
      range.selectNodeContents(element);
      text.push(...range.getClientRects());
    }
    const boxes = [...panel.querySelectorAll(COPY_BOXES)].map((element) => element.getBoundingClientRect());
    const chrome = [...panel.querySelectorAll(CHROME)].map((element) => element.getBoundingClientRect());
    return { copy: relative([...text, ...boxes]), chrome: relative(chrome) };
  }

  // Maze walls run along the background grid lines between cells. Cells left
  // out of the maze under the copy have none between them, which leaves the
  // copy on an island.
  function buildWalls(next: Tour): Path2D {
    const { maze, board: { x, y, cols, rows } } = next;
    const { solid } = maze;
    const path = new Path2D();
    const add = (x1: number, y1: number, x2: number, y2: number) => {
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
    };
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        const left = x + col * cell;
        const top = y + row * cell;
        if (col < cols - 1 && !maze.right[index] && !(solid[index] && solid[index + 1])) add(left + cell, top, left + cell, top + cell);
        if (row < rows - 1 && !maze.down[index] && !(solid[index] && solid[index + cols])) add(left, top + cell, left + cell, top + cell);
      }
    }
    return path;
  }

  // A soft-edged mask over the copy, drawn once per size. Each shape is drawn
  // off the canvas and only its blurred shadow lands in place, which softens
  // the edges in every browser.
  function buildVeil(ratio: number) {
    const mask = document.createElement("canvas");
    mask.width = canvas!.width;
    mask.height = canvas!.height;
    const m = mask.getContext("2d");
    if (!m) return undefined;
    const away = mask.width + 100;
    m.shadowColor = "rgba(0, 0, 0, 0.75)";
    m.shadowBlur = 16 * ratio;
    m.shadowOffsetX = away;
    for (const rect of copy) {
      m.fillRect(rect.left * ratio - away, rect.top * ratio, (rect.right - rect.left) * ratio, (rect.bottom - rect.top) * ratio);
    }
    return mask;
  }

  function startTour(now: number, side?: "left" | "right") {
    if (!board) return;
    tour = createTour(board, Math.random, side);
    walls = buildWalls(tour);
    mazeAt = now;
    clock = -0.3;
    if (reduce.matches) {
      // The still frame: the snake part of the way through.
      const inside = tour.route.filter((spot) => onBoard(board!, spot)).length;
      for (let i = Math.max(6, Math.floor(inside * 0.4)); i > 0; i--) tourStep(tour);
      clock = 0;
    }
  }

  function resize() {
    width = panel.clientWidth;
    height = panel.clientHeight;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas!.width = Math.round(width * ratio);
    canvas!.height = Math.round(height * ratio);
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    const measured = measure();
    copy = measured.copy;
    veil = buildVeil(ratio);
    const next = createBoard(width, height, cell, measured.copy, measured.chrome);
    panel.style.setProperty("--sg-cta-grid-x", `${next.x}px`);
    panel.style.setProperty("--sg-cta-grid-y", `${next.y}px`);
    const reshaped = !board || board.cols !== next.cols || board.rows !== next.rows;
    board = next;
    if (reshaped) {
      fading = undefined;
      startTour(performance.now());
      if (playing) {
        // A game can't carry over to a board of a different size: start over.
        match = createMatch(board);
        clock = 0;
        bittenAt = 0;
        panel.classList.remove("is-bitten");
        showScore();
      }
    } else {
      if (tour) {
        tour.board = board;
        walls = buildWalls(tour);
      }
      if (match) match.board = board;
    }
    draw(performance.now());
  }

  // ---------- drawing ----------

  function drawItem(item: Item, now: number) {
    const still = reduce.matches;
    const grow = still ? 1 : Math.min(1, item.age / 0.3);
    const s = 1 - (1 - grow) ** 3;
    if (s <= 0) return;
    const { x, y: cy } = centre(item);
    const y = cy + (still ? 0 : Math.sin(now / 600 + item.col + item.row * 1.3) * 1.2);
    const accent = rgb((item.col + item.row) % 2 ? kick : twitch);
    c.fillStyle = "rgba(255, 255, 255, 0.05)";
    c.beginPath();
    c.arc(x, y, 15 * s, 0, Math.PI * 2);
    c.fill();
    if (item.kind === "gift") {
      c.fillStyle = "#d9d9d9";
      c.beginPath();
      c.roundRect(x - 8 * s, y - 3 * s, 16 * s, 11 * s, 2 * s);
      c.fill();
      c.fillStyle = "#f5f5f5";
      c.beginPath();
      c.roundRect(x - 9.5 * s, y - 7 * s, 19 * s, 5 * s, 1.5 * s);
      c.fill();
      c.fillStyle = accent;
      c.fillRect(x - 1.5 * s, y - 7 * s, 3 * s, 15 * s);
      c.strokeStyle = accent;
      c.lineWidth = 1.8 * s;
      c.beginPath();
      c.ellipse(x - 3.6 * s, y - 9 * s, 3.4 * s, 2 * s, -0.5, 0, Math.PI * 2);
      c.moveTo(x + 7 * s, y - 9 * s);
      c.ellipse(x + 3.6 * s, y - 9 * s, 3.4 * s, 2 * s, 0.5, 0, Math.PI * 2);
      c.stroke();
    } else if (item.kind === "chest") {
      c.fillStyle = "#d9d9d9";
      c.beginPath();
      c.roundRect(x - 9 * s, y - 2 * s, 18 * s, 10 * s, 2 * s);
      c.fill();
      c.fillStyle = "#f5f5f5";
      c.beginPath();
      c.roundRect(x - 9 * s, y - 9 * s, 18 * s, 7 * s, [5 * s, 5 * s, 1 * s, 1 * s]);
      c.fill();
      c.fillStyle = "#0a0a0a";
      c.fillRect(x - 9 * s, y - 2.6 * s, 18 * s, 1.4 * s);
      c.fillStyle = accent;
      c.beginPath();
      c.roundRect(x - 2.2 * s, y - 4.5 * s, 4.4 * s, 5.5 * s, 1.2 * s);
      c.fill();
    } else {
      c.fillStyle = accent;
      c.beginPath();
      c.moveTo(x - 8 * s, y - 3 * s);
      c.lineTo(x - 4 * s, y - 8 * s);
      c.lineTo(x + 4 * s, y - 8 * s);
      c.lineTo(x + 8 * s, y - 3 * s);
      c.lineTo(x, y + 8 * s);
      c.closePath();
      c.fill();
      c.fillStyle = "rgba(255, 255, 255, 0.55)";
      c.beginPath();
      c.moveTo(x - 4 * s, y - 8 * s);
      c.lineTo(x, y - 3 * s);
      c.lineTo(x - 8 * s, y - 3 * s);
      c.closePath();
      c.fill();
      c.strokeStyle = "rgba(255, 255, 255, 0.35)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x - 8 * s, y - 3 * s);
      c.lineTo(x + 8 * s, y - 3 * s);
      c.stroke();
    }
  }

  // The snake's centre line, in cells. Between moves only the head slides into
  // its new cell and (unless the snake is growing) the tail out of its old
  // one; every joint between stays on a cell centre, so turns keep their
  // corners. In a game the edges wrap, so the points are unwrapped into one
  // unbroken line that may run past an edge; it is drawn again from the other
  // side.
  function snakePoints(snake: Snake, t: number, wrapped: boolean): Point[] {
    const { body, trail } = snake;
    const cols = board!.cols;
    const rows = board!.rows;
    const near = (value: number, to: number, size: number) => (wrapped ? value + Math.round((to - value) / size) * size : value);
    const toward = (from: Cell, to: Cell): Point => ({
      x: from.col + (near(to.col, from.col, cols) - from.col) * t,
      y: from.row + (near(to.row, from.row, rows) - from.row) * t,
    });
    const moving = t < 1 && trail.length > 0 && (trail[0].col !== body[0].col || trail[0].row !== body[0].row);
    let points: Point[];
    if (!moving) {
      points = body.map((spot) => ({ x: spot.col, y: spot.row }));
    } else {
      const grew = body.length > trail.length;
      points = [toward(trail[0], body[0])];
      for (let i = 0; i < trail.length - (grew ? 0 : 1); i++) points.push({ x: trail[i].col, y: trail[i].row });
      if (!grew && trail.length > 1) points.push(toward(trail[trail.length - 1], trail[trail.length - 2]));
    }
    for (let i = 1; i < points.length; i++) {
      points[i] = { x: near(points[i].x, points[i - 1].x, cols), y: near(points[i].y, points[i - 1].y, rows) };
    }
    return points;
  }

  function drawSnake(snake: Snake, t: number, wrapped: boolean, bitten: boolean, now: number) {
    if (bitten && !reduce.matches && Math.floor((now - bittenAt) / 150) % 2) return;
    const points = snakePoints(snake, t, wrapped).map(centre);
    const along = [0];
    for (let i = 1; i < points.length; i++) {
      along.push(along[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    }
    const total = along[along.length - 1] || 1;
    const span = { x: board!.cols * cell, y: board!.rows * cell };
    const shifts = wrapped ? [-1, 0, 1].flatMap((sx) => [-1, 0, 1].map((sy) => [sx, sy])) : [[0, 0]];
    c.save();
    if (wrapped) {
      c.beginPath();
      c.rect(board!.x, board!.y, span.x, span.y);
      c.clip();
    }
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = cell * 0.5;
    for (const [sx, sy] of shifts) {
      const xs = points.map((p) => p.x + sx * span.x);
      const ys = points.map((p) => p.y + sy * span.y);
      // Skip copies that sit wholly outside the board.
      if (Math.max(...xs) < board!.x - cell || Math.min(...xs) > board!.x + span.x + cell) continue;
      if (Math.max(...ys) < board!.y - cell || Math.min(...ys) > board!.y + span.y + cell) continue;
      c.save();
      c.shadowColor = bitten ? "transparent" : rgb(twitch, 0.4);
      c.shadowBlur = 16;
      c.strokeStyle = bitten ? "#3f3f46" : rgb(twitch);
      c.beginPath();
      xs.forEach((x, i) => (i ? c.lineTo(x, ys[i]) : c.moveTo(x, ys[i])));
      if (xs.length === 1) c.lineTo(xs[0], ys[0]);
      c.stroke();
      c.restore();
      if (!bitten) {
        // The body is cut into short square-ended slices, each in its own
        // shade, over discs at the joints and ends that round off the corners.
        // Round caps on the slices would show as arcs across the body.
        for (let i = 0; i < xs.length; i++) {
          c.fillStyle = shade(along[i] / total);
          c.beginPath();
          c.arc(xs[i], ys[i], cell * 0.25, 0, Math.PI * 2);
          c.fill();
        }
        c.lineCap = "butt";
        for (let i = xs.length - 1; i > 0; i--) {
          const length = along[i] - along[i - 1];
          if (!length) continue;
          const ux = (xs[i] - xs[i - 1]) / length;
          const uy = (ys[i] - ys[i - 1]) / length;
          const slices = Math.ceil(length / 4);
          for (let k = slices - 1; k >= 0; k--) {
            // Each slice overlaps its neighbours by half a pixel to hide seams.
            const from = (k / slices) * length - 0.5;
            const to = ((k + 1) / slices) * length + 0.5;
            c.strokeStyle = shade((along[i - 1] + (from + to) / 2) / total);
            c.beginPath();
            c.moveTo(xs[i - 1] + ux * from, ys[i - 1] + uy * from);
            c.lineTo(xs[i - 1] + ux * to, ys[i - 1] + uy * to);
            c.stroke();
          }
        }
        c.lineCap = "round";
      }
      // Eyes, looking where it is going.
      const [fx, fy] = VECTORS[snake.heading];
      const eyeX = xs[0] + fx * cell * 0.08;
      const eyeY = ys[0] + fy * cell * 0.08;
      c.fillStyle = "#0a0a0a";
      for (const side of [-1, 1]) {
        c.beginPath();
        c.arc(eyeX - fy * side * cell * 0.11, eyeY + fx * side * cell * 0.11, cell * 0.055, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }

  function strokeWalls(target: Path2D, alpha: number) {
    c.lineWidth = 2;
    c.lineCap = "round";
    c.strokeStyle = `rgba(255, 255, 255, ${0.16 * alpha})`;
    c.stroke(target);
  }

  function draw(now: number) {
    c.clearRect(0, 0, width, height);
    if (!board || board.cols < 2 || board.rows < 2) return;
    const still = reduce.matches;
    if (fading) {
      const alpha = still ? 0 : 1 - (now - fading.at) / FADE_MS;
      if (alpha > 0) strokeWalls(fading.walls, alpha);
      else fading = undefined;
    }
    if (playing && match) {
      for (const item of match.items) drawItem(item, now);
      const interval = Math.max(FASTEST_STEP, MATCH_STEP - match.score * 0.0015);
      drawSnake(match.snake, bittenAt ? 1 : Math.min(1, clock / interval), true, Boolean(bittenAt), now);
    } else if (tour && walls) {
      strokeWalls(walls, still ? 1 : Math.min(1, (now - mazeAt) / FADE_MS));
      for (const item of tour.items) drawItem(item, now);
      drawSnake(tour.snake, Math.min(1, Math.max(0, clock / TOUR_STEP)), false, false, now);
      // A maze that runs under the copy (no island) fades out beneath it, so
      // the text stays easy to read.
      if (veil && !tour.maze.solid.some(Boolean) && board.covered.some(Boolean)) {
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = "destination-out";
        c.drawImage(veil, 0, 0);
        c.restore();
      }
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
      c.arc(bursts[i].x, bursts[i].y, 10 + 18 * t, 0, Math.PI * 2);
      c.stroke();
    }
  }

  // ---------- loop ----------

  function showScore() {
    const score = match?.score ?? 0;
    scoreValue!.textContent = String(score);
    scoreUnit!.textContent = score === 1 ? "drop" : "drops";
    bestValue!.textContent = String(best);
  }

  function burst(spot: Cell, now: number) {
    if (!reduce.matches) bursts.push({ ...centre(spot), at: now });
  }

  function running() {
    return visible && !document.hidden && (playing || !reduce.matches);
  }

  function schedule() {
    if (frame || !running()) return;
    last = 0;
    frame = requestAnimationFrame(tick);
  }

  function advanceTour(seconds: number, now: number) {
    if (!tour) return;
    clock += seconds;
    while (clock >= TOUR_STEP && tour) {
      clock -= TOUR_STEP;
      const { eaten, done } = tourStep(tour);
      for (const item of eaten) burst(item, now);
      if (done && walls) {
        // The next maze starts on the side this one was left from.
        fading = { walls, at: now };
        startTour(now, tour.exit.col === 0 ? "left" : "right");
      }
    }
  }

  function advanceMatch(seconds: number, now: number) {
    if (!match || !board) return;
    if (bittenAt) {
      if (now - bittenAt < BITE_PAUSE_MS) return;
      bittenAt = 0;
      clock = 0;
      match = createMatch(board);
      panel.classList.remove("is-bitten");
      showScore();
      return;
    }
    clock += seconds;
    let interval = Math.max(FASTEST_STEP, MATCH_STEP - match.score * 0.0015);
    while (clock >= interval) {
      clock -= interval;
      const { eaten, bitten } = matchStep(match, held);
      if (bitten) {
        bittenAt = now;
        panel.classList.add("is-bitten");
        break;
      }
      if (eaten) {
        burst(eaten, now);
        if (match.score > best) {
          best = match.score;
          saveBest(best);
        }
        showScore();
        interval = Math.max(FASTEST_STEP, MATCH_STEP - match.score * 0.0015);
      }
    }
  }

  function tick(now: number) {
    frame = 0;
    if (!running()) return;
    const seconds = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    for (const item of (playing ? match?.items : tour?.items) ?? []) item.age += seconds;
    if (playing) advanceMatch(seconds, now);
    else advanceTour(seconds, now);
    draw(now);
    frame = requestAnimationFrame(tick);
  }

  // ---------- playing ----------

  function play() {
    if (playing || !board) return;
    const now = performance.now();
    playing = true;
    if (walls) fading = { walls, at: now };
    match = createMatch(board);
    clock = 0;
    bittenAt = 0;
    held.length = 0;
    showScore();
    panel.classList.add("is-playing");
    toggleLabel!.textContent = "Exit";
    toggle!.setAttribute("aria-label", "Exit the snake game");
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    draw(now);
    schedule();
  }

  function stop() {
    if (!playing) return;
    playing = false;
    match = undefined;
    bittenAt = 0;
    held.length = 0;
    panel.classList.remove("is-playing", "is-bitten");
    toggleLabel!.textContent = "Play";
    toggle!.setAttribute("aria-label", "Play the snake game");
    fading = undefined;
    startTour(performance.now());
    draw(performance.now());
    schedule();
  }

  // Turns towards a point on the board, along whichever axis is further off.
  function aim(x: number, y: number) {
    if (!match) return;
    const head = centre(match.snake.body[0]);
    const dx = x - head.x;
    const dy = y - head.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < cell / 2) return;
    turn(match, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  }

  panel.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a, button")) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    if (!playing) return play();
    const origin = panel.getBoundingClientRect();
    aim(event.clientX - origin.left, event.clientY - origin.top);
  });

  panel.addEventListener("keydown", (event) => {
    if (!playing || !match || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      stop();
      toggle!.focus();
      return;
    }
    const direction = KEYS[event.code];
    if (!direction) return;
    event.preventDefault();
    const index = held.indexOf(direction);
    if (index >= 0) held.splice(index, 1);
    held.push(direction);
    if (!event.repeat) turn(match, direction);
  });

  panel.addEventListener("keyup", (event) => {
    const index = held.indexOf(KEYS[event.code]);
    if (index >= 0) held.splice(index, 1);
  });
  window.addEventListener("blur", () => (held.length = 0));

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
    if (!playing) startTour(performance.now());
    draw(performance.now());
    schedule();
  });
  void document.fonts?.ready.then(resize);

  panel.tabIndex = -1;
  panel.dataset.snakeReady = "";
  for (const element of panel.querySelectorAll<HTMLElement>(CHROME)) element.hidden = false;
  showScore();
  resize();
}

const panel = document.querySelector<HTMLElement>("[data-snake]");
if (panel) run(panel);
