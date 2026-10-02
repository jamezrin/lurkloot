// Model for the snake in the closing call to action, whose background grid is
// the board. On its own the snake tours a random maze: it comes in at one
// corner, follows the shortest route (A*) out of the opposite one, and a new
// maze takes its place. The copy is a solid island in the maze, so the route
// goes round it; only when the copy cuts the board in two (on narrow screens)
// does a maze run underneath it. A visitor who takes over plays snake on the open grid:
// every drop eaten adds a segment, the edges wrap around, and biting its own
// body ends the run. Pure and import-free so the node tests can load it
// directly; scripts/drop-snake.ts draws it and handles input.

export type Direction = "up" | "down" | "left" | "right";
export type ItemKind = "gift" | "chest" | "gem";

export interface Cell {
  col: number;
  row: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Item extends Cell {
  kind: ItemKind;
  /** Seconds since it appeared, for the pop-in. */
  age: number;
}

export interface Board {
  /** Cell size in pixels. */
  cell: number;
  cols: number;
  rows: number;
  /** Pixel offset of the first cell, which centres the board in the panel. */
  x: number;
  y: number;
  /** Cells clear of the copy and the corner controls: where a tour's drops go. */
  open: Cell[];
  /** Cells clear of the corner controls: where a game's drops go. */
  free: Cell[];
  /** Whether each cell (row * cols + col) sits under the copy. */
  covered: boolean[];
}

export interface Maze {
  cols: number;
  rows: number;
  /** Whether each cell (row * cols + col) opens onto the cell to its right. */
  right: boolean[];
  /** Whether each cell opens onto the cell below it. */
  down: boolean[];
  /** Cells left out of the maze, with no way in. */
  solid: boolean[];
}

export interface Snake {
  /** Head first. */
  body: Cell[];
  /** The body before the last move, so it can be drawn between moves. */
  trail: Cell[];
  heading: Direction;
  /** Segments still to add, one per move. */
  growth: number;
}

/** One crossing of one maze, with the snake steering itself. */
export interface Tour {
  board: Board;
  maze: Maze;
  /** The corner cells where the snake comes in and goes out. */
  entry: Cell;
  exit: Cell;
  /** Every cell the head will visit, running on past the exit off the board. */
  route: Cell[];
  next: number;
  snake: Snake;
  items: Item[];
}

/** A visitor's game. */
export interface Match {
  board: Board;
  snake: Snake;
  items: Item[];
  /** Turns pressed but not yet taken, oldest first. */
  turns: Direction[];
  score: number;
  random: () => number;
}

const MOVES: Record<Direction, Cell> = {
  up: { col: 0, row: -1 },
  down: { col: 0, row: 1 },
  left: { col: -1, row: 0 },
  right: { col: 1, row: 0 },
};
const REVERSE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };
const START_LENGTH = 4;
const MAX_TURNS = 3;
const MATCH_ITEMS = 3;
const ROUTE_ITEMS = 3;
const SPARE_ITEMS = 3;
// Share of the remaining walls knocked through after carving, so the maze has
// a few loops and more than one way through.
const LOOPS = 0.08;

const same = (a: Cell, b: Cell) => a.col === b.col && a.row === b.row;
const pick = <T>(items: T[], random: () => number) => items[Math.floor(random() * items.length)];
const wrap = (value: number, size: number) => ((value % size) + size) % size;

export function onBoard(board: Board, cell: Cell) {
  return cell.col >= 0 && cell.col < board.cols && cell.row >= 0 && cell.row < board.rows;
}

export function createBoard(width: number, height: number, cell: number, copy: Rect[] = [], chrome: Rect[] = []): Board {
  const cols = Math.max(0, Math.floor(width / cell));
  const rows = Math.max(0, Math.floor(height / cell));
  const x = Math.floor((width - cols * cell) / 2);
  const y = Math.floor((height - rows * cell) / 2);
  const open: Cell[] = [];
  const free: Cell[] = [];
  const covered: boolean[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = x + col * cell;
      const top = y + row * cell;
      // Any overlap counts, so maze walls along the cell edges stay off the text.
      const under = (rects: Rect[]) =>
        rects.some((r) => left < r.right && left + cell > r.left && top < r.bottom && top + cell > r.top);
      covered.push(under(copy));
      if (under(chrome)) continue;
      free.push({ col, row });
      if (!covered[covered.length - 1]) open.push({ col, row });
    }
  }
  return { cell, cols, rows, x, y, open, free, covered };
}

function itemKind(random: () => number): ItemKind {
  const roll = random();
  return roll < 0.6 ? "gift" : roll < 0.8 ? "chest" : "gem";
}

// ---------- maze ----------

/**
 * Carves a maze with a randomised depth-first search, then adds a few loops.
 * `solid` cells are left out; if they split the board, each part is carved as
 * its own maze.
 */
export function createMaze(
  cols: number,
  rows: number,
  random: () => number = Math.random,
  { loops = LOOPS, solid = [] }: { loops?: number; solid?: boolean[] } = {},
): Maze {
  const size = cols * rows;
  const right = new Array<boolean>(size).fill(false);
  const down = new Array<boolean>(size).fill(false);
  const blocked = Array.from({ length: size }, (_, index) => Boolean(solid[index]));
  // Solid cells count as visited, so the search never goes into them.
  const seen = blocked.slice();
  const carve = (start: number) => {
    const stack = [start];
    seen[start] = true;
    while (stack.length) {
      const current = stack[stack.length - 1];
      const col = current % cols;
      const options: number[] = [];
      if (col > 0 && !seen[current - 1]) options.push(current - 1);
      if (col < cols - 1 && !seen[current + 1]) options.push(current + 1);
      if (current >= cols && !seen[current - cols]) options.push(current - cols);
      if (current + cols < size && !seen[current + cols]) options.push(current + cols);
      if (!options.length) {
        stack.pop();
        continue;
      }
      const next = pick(options, random);
      if (next === current + 1) right[current] = true;
      else if (next === current - 1) right[next] = true;
      else if (next === current + cols) down[current] = true;
      else down[next] = true;
      seen[next] = true;
      stack.push(next);
    }
  };
  const unseen = seen.map((value, index) => (value ? -1 : index)).filter((index) => index >= 0);
  if (unseen.length) carve(pick(unseen, random));
  for (let index = 0; index < size; index++) if (!seen[index]) carve(index);
  for (let index = 0; index < size; index++) {
    if (blocked[index]) continue;
    if (index % cols < cols - 1 && !blocked[index + 1] && !right[index] && random() < loops) right[index] = true;
    if (index + cols < size && !blocked[index + cols] && !down[index] && random() < loops) down[index] = true;
  }
  return { cols, rows, right, down, solid: blocked };
}

export function passages(maze: Maze, index: number): number[] {
  const { cols, right, down } = maze;
  const result: number[] = [];
  if (index % cols < cols - 1 && right[index]) result.push(index + 1);
  if (index % cols > 0 && right[index - 1]) result.push(index - 1);
  if (down[index]) result.push(index + cols);
  if (index >= cols && down[index - cols]) result.push(index - cols);
  return result;
}

/** The shortest route through the maze by A*, both ends included; empty if none. */
export function findPath(maze: Maze, from: Cell, to: Cell): Cell[] {
  const { cols, rows } = maze;
  const size = cols * rows;
  const start = from.row * cols + from.col;
  const goal = to.row * cols + to.col;
  if (!size || start < 0 || goal < 0 || start >= size || goal >= size) return [];
  const estimate = (index: number) => Math.abs((index % cols) - to.col) + Math.abs(Math.floor(index / cols) - to.row);
  const cost = new Array<number>(size).fill(Number.POSITIVE_INFINITY);
  const came = new Array<number>(size).fill(-1);
  const closed = new Array<boolean>(size).fill(false);
  const open = [start];
  cost[start] = 0;
  while (open.length) {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (cost[open[i]] + estimate(open[i]) < cost[open[best]] + estimate(open[best])) best = i;
    }
    const current = open.splice(best, 1)[0];
    if (current === goal) {
      const path: Cell[] = [];
      for (let index = goal; index !== -1; index = came[index]) path.unshift({ col: index % cols, row: Math.floor(index / cols) });
      return path;
    }
    closed[current] = true;
    for (const next of passages(maze, current)) {
      if (closed[next] || cost[current] + 1 >= cost[next]) continue;
      cost[next] = cost[current] + 1;
      came[next] = current;
      if (!open.includes(next)) open.push(next);
    }
  }
  return [];
}

// ---------- snake ----------

function moveSnake(snake: Snake, head: Cell, items: Item[]): Item[] {
  snake.trail = snake.body.map((cell) => ({ ...cell }));
  snake.body.unshift(head);
  const eaten: Item[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (!same(items[i], head)) continue;
    eaten.push(...items.splice(i, 1));
    snake.growth++;
  }
  if (snake.growth > 0) snake.growth--;
  else snake.body.pop();
  return eaten;
}

// ---------- tour ----------

/**
 * A new crossing. `side` picks the edge the snake comes in from, so the next
 * tour can start on the side the last one left; the corner on it is random.
 */
export function createTour(board: Board, random: () => number = Math.random, side?: "left" | "right"): Tour {
  const { cols, rows } = board;
  const fromLeft = side ? side === "left" : random() < 0.5;
  const entry = { col: fromLeft ? 0 : cols - 1, row: random() < 0.5 ? 0 : rows - 1 };
  const exit = { col: cols - 1 - entry.col, row: rows - 1 - entry.row };
  const inward = fromLeft ? 1 : -1;
  let maze = createMaze(cols, rows, random, { solid: board.covered });
  let path = findPath(maze, entry, exit);
  if (!path.length) {
    // The copy leaves no way round it: run the maze underneath instead.
    maze = createMaze(cols, rows, random);
    path = findPath(maze, entry, exit);
  }
  // Past the exit the head keeps going until the whole body is off the board.
  const runout = Array.from({ length: START_LENGTH + ROUTE_ITEMS + 2 }, (_, i) => ({ col: exit.col + inward * (i + 1), row: exit.row }));
  const body = Array.from({ length: START_LENGTH }, (_, i) => ({ col: entry.col - inward * (i + 1), row: entry.row }));
  const tour: Tour = {
    board,
    maze,
    entry,
    exit,
    route: [...path, ...runout],
    next: 0,
    snake: { body, trail: body.map((cell) => ({ ...cell })), heading: fromLeft ? "right" : "left", growth: 0 },
    items: [],
  };

  // A few drops along the way, so the snake grows as it goes, and a few more
  // around the maze. Neither lands under the copy or at the very ends.
  const isOpen = new Set(board.open.map((cell) => `${cell.col}:${cell.row}`));
  const onRoute = new Set(path.map((cell) => `${cell.col}:${cell.row}`));
  const stops = path.slice(2, -2).filter((cell) => isOpen.has(`${cell.col}:${cell.row}`));
  for (let i = 0; i < ROUTE_ITEMS && stops.length; i++) {
    const stretch = stops.slice(Math.floor((i * stops.length) / ROUTE_ITEMS), Math.floor(((i + 1) * stops.length) / ROUTE_ITEMS));
    if (stretch.length) tour.items.push({ ...pick(stretch, random), kind: itemKind(random), age: Number.POSITIVE_INFINITY });
  }
  const spare = board.open.filter((cell) => !onRoute.has(`${cell.col}:${cell.row}`));
  for (let i = 0; i < SPARE_ITEMS && spare.length; i++) {
    const [cell] = spare.splice(Math.floor(random() * spare.length), 1);
    tour.items.push({ ...cell, kind: itemKind(random), age: Number.POSITIVE_INFINITY });
  }
  return tour;
}

/** Moves the touring snake one cell. `done` once it has left the board. */
export function tourStep(tour: Tour): { eaten: Item[]; done: boolean } {
  const head = tour.route[tour.next];
  if (!head) return { eaten: [], done: true };
  tour.next++;
  const from = tour.snake.body[0];
  const direction = (Object.keys(MOVES) as Direction[]).find(
    (d) => from.col + MOVES[d].col === head.col && from.row + MOVES[d].row === head.row,
  );
  if (direction) tour.snake.heading = direction;
  const eaten = moveSnake(tour.snake, { ...head }, tour.items);
  return { eaten, done: tour.snake.body.every((cell) => !onBoard(tour.board, cell)) };
}

// ---------- match ----------

function spawn(match: Match) {
  const { snake, items } = match;
  const taken = new Set([...snake.body, ...items].map((cell) => `${cell.col}:${cell.row}`));
  const choices = match.board.free.filter((cell) => !taken.has(`${cell.col}:${cell.row}`));
  if (!choices.length) return false;
  items.push({ ...pick(choices, match.random), kind: itemKind(match.random), age: 0 });
  return true;
}

export function createMatch(board: Board, random: () => number = Math.random): Match {
  const row = Math.floor(board.rows / 2);
  const head = Math.max(START_LENGTH - 1, Math.floor(board.cols / 3));
  const body = Array.from({ length: START_LENGTH }, (_, i) => ({ col: head - i, row }));
  const match: Match = {
    board,
    snake: { body, trail: body.map((cell) => ({ ...cell })), heading: "right", growth: 0 },
    items: [],
    turns: [],
    score: 0,
    random,
  };
  while (match.items.length < MATCH_ITEMS && spawn(match));
  return match;
}

/**
 * Queues a turn for a coming move, so quick presses (right, then up) each get
 * their own move. Turns that repeat or reverse the one before are dropped.
 */
export function turn(match: Match, direction: Direction) {
  const last = match.turns[match.turns.length - 1] ?? match.snake.heading;
  if (direction === last || direction === REVERSE[last] || match.turns.length >= MAX_TURNS) return;
  match.turns.push(direction);
}

/**
 * Moves the visitor's snake one cell. `held` lists the direction keys held
 * down, most recent last: with no turn queued, holding two or more of them
 * turns towards the latest that is not the current heading, so the snake runs
 * diagonally in a staircase. A single held key does nothing, so resting on one
 * doesn't undo the turns tapped in with another. Reports a bite without
 * moving; the caller starts over.
 */
export function matchStep(match: Match, held: Direction[] = []): { eaten: Item | null; bitten: boolean } {
  const { board, snake } = match;
  let heading = match.turns.shift();
  for (let i = held.length - 1; !heading && held.length > 1 && i >= 0; i--) {
    if (held[i] !== snake.heading && held[i] !== REVERSE[snake.heading]) heading = held[i];
  }
  if (heading) snake.heading = heading;
  const move = MOVES[snake.heading];
  const head = { col: wrap(snake.body[0].col + move.col, board.cols), row: wrap(snake.body[0].row + move.row, board.rows) };
  // The tail moves out of the way this step unless the snake is growing.
  const growing = snake.growth > 0 || match.items.some((item) => same(item, head));
  const body = growing ? snake.body : snake.body.slice(0, -1);
  if (body.some((cell) => same(cell, head))) return { eaten: null, bitten: true };
  const [eaten] = moveSnake(snake, head, match.items);
  if (eaten) {
    match.score++;
    spawn(match);
  }
  return { eaten: eaten ?? null, bitten: false };
}
