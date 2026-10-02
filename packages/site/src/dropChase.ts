// Model for the drop chase in the closing call to action: a pac-man style
// chaser that runs along the panel's background grid eating drops, on its own
// until a visitor takes over. It is pure and import-free so the node tests can
// load it directly; scripts/drop-chase.ts draws it and handles input.
//
// The board is the grid itself. Spots sit where grid lines cross, numbered from
// 1 so no lane hugs the panel edge. The chaser may pass under the copy, but
// drops only appear on open spots, clear of the text and the corner controls.

export type Direction = "up" | "down" | "left" | "right";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Spot {
  col: number;
  row: number;
}

export interface Board {
  /** Grid spacing in pixels. */
  cell: number;
  cols: number;
  rows: number;
  /** Spots a drop may appear on. */
  open: Spot[];
}

export interface Drop extends Spot {
  /** Seconds since it appeared, for the pop-in. */
  age: number;
}

export interface Chaser extends Spot {
  /** Where it is moving, or null while stopped against an edge. */
  heading: Direction | null;
  /** The way its mouth points, which outlasts a stop. */
  facing: Direction;
  /** A turn asked for between spots, taken at the first spot that allows it. */
  queued: Direction | null;
  /** How far along the lane to the next spot, from 0 to 1. */
  progress: number;
  /** Cells travelled so far, which drives the mouth. */
  travelled: number;
}

export interface Game {
  board: Board;
  chaser: Chaser;
  drops: Drop[];
  /** Countdowns, in seconds, until each eaten drop is replaced. */
  respawns: number[];
  eaten: number;
  random: () => number;
}

const MOVES: Record<Direction, Spot> = {
  up: { col: 0, row: -1 },
  down: { col: 0, row: 1 },
  left: { col: -1, row: 0 },
  right: { col: 1, row: 0 },
};
const DIRECTIONS = Object.keys(MOVES) as Direction[];
const REVERSE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };
const RESPAWN_SECONDS = 0.8;
const LINEUP = 4;

const same = (a: Spot, b: Spot) => a.col === b.col && a.row === b.row;
const distance = (a: Spot, b: Spot) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
const pick = <T>(items: T[], random: () => number) => items[Math.floor(random() * items.length)];

export function createBoard(width: number, height: number, cell: number, avoid: Rect[] = []): Board {
  const cols = Math.max(0, Math.floor((width - cell / 2) / cell));
  const rows = Math.max(0, Math.floor((height - cell / 2) / cell));
  const open: Spot[] = [];
  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      const x = col * cell;
      const y = row * cell;
      if (!avoid.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) open.push({ col, row });
    }
  }
  return { cell, cols, rows, open };
}

function canMove(board: Board, from: Spot, direction: Direction) {
  const col = from.col + MOVES[direction].col;
  const row = from.row + MOVES[direction].row;
  return col >= 1 && col <= board.cols && row >= 1 && row <= board.rows;
}

// The opening picture: the chaser facing a short line of drops, on the lowest
// row with room for one and as close to the middle as it fits. It is also the
// still frame shown with reduced motion.
function lineup(board: Board): { chaser: Spot; drops: Spot[] } {
  const open = new Set(board.open.map((spot) => `${spot.col}:${spot.row}`));
  const middle = (board.cols + 1) / 2;
  for (let length = LINEUP; length >= 1; length--) {
    for (let row = board.rows; row >= 1; row--) {
      let best: number | null = null;
      for (let col = 1; col + length <= board.cols; col++) {
        let fits = true;
        for (let i = 0; i <= length && fits; i++) fits = open.has(`${col + i}:${row}`);
        if (fits && (best === null || Math.abs(col + length / 2 - middle) < Math.abs(best + length / 2 - middle))) best = col;
      }
      if (best !== null) {
        const start = best;
        return { chaser: { col: start, row }, drops: Array.from({ length }, (_, i) => ({ col: start + i + 1, row })) };
      }
    }
  }
  return { chaser: { col: Math.max(1, Math.ceil(middle)), row: Math.max(1, board.rows) }, drops: [] };
}

function dropTarget(board: Board) {
  return Math.min(board.open.length, Math.max(LINEUP, Math.min(14, Math.round(board.open.length / 10))));
}

// Adds a drop on a random free spot, away from the chaser. Returns false when
// there is nowhere left to put one.
function spawn(game: Game) {
  const free = game.board.open.filter(
    (spot) => distance(spot, game.chaser) > 1 && !game.drops.some((drop) => same(drop, spot)),
  );
  if (!free.length) return false;
  const spot = pick(free, game.random);
  game.drops.push({ col: spot.col, row: spot.row, age: 0 });
  return true;
}

function fill(game: Game) {
  while (game.drops.length + game.respawns.length < dropTarget(game.board) && spawn(game));
}

export function createGame(board: Board, random: () => number = Math.random): Game {
  const start = lineup(board);
  const game: Game = {
    board,
    chaser: { ...start.chaser, heading: null, facing: "right", queued: null, progress: 0, travelled: 0 },
    drops: start.drops.map((spot) => ({ ...spot, age: Number.POSITIVE_INFINITY })),
    respawns: [],
    eaten: 0,
    random,
  };
  fill(game);
  return game;
}

// Fits a running game to a resized board: the chaser snaps to its last spot
// (pulled inside the new edges) and drops that are no longer open go away.
export function reshape(game: Game, board: Board) {
  const { chaser } = game;
  game.board = board;
  chaser.col = Math.min(Math.max(chaser.col, 1), Math.max(board.cols, 1));
  chaser.row = Math.min(Math.max(chaser.row, 1), Math.max(board.rows, 1));
  chaser.progress = 0;
  if (chaser.heading && !canMove(board, chaser, chaser.heading)) chaser.heading = null;
  game.drops = game.drops.filter((drop) => !same(drop, chaser) && board.open.some((spot) => same(spot, drop)));
  fill(game);
}

// A visitor's turn. Reversing happens at once, even between spots; any other
// turn waits for the next spot where it is possible.
export function steer(game: Game, direction: Direction) {
  const { board, chaser } = game;
  if (chaser.heading && chaser.progress > 0 && direction === REVERSE[chaser.heading]) {
    chaser.col += MOVES[chaser.heading].col;
    chaser.row += MOVES[chaser.heading].row;
    chaser.progress = 1 - chaser.progress;
    chaser.heading = chaser.facing = direction;
    chaser.queued = null;
  } else if (!chaser.heading || chaser.progress === 0) {
    if (canMove(board, chaser, direction)) {
      chaser.heading = chaser.facing = direction;
      chaser.queued = null;
    }
  } else {
    chaser.queued = direction === chaser.heading ? null : direction;
  }
}

// The autopilot's choice at a spot: towards the nearest drop, usually keeping
// its line so it doesn't zig-zag, or onwards when there is nothing to chase.
function autopilot(game: Game): Direction | null {
  const { board, chaser, drops, random } = game;
  const options = DIRECTIONS.filter((direction) => canMove(board, chaser, direction));
  if (!options.length) return null;
  let target: Drop | undefined;
  for (const drop of drops) if (!target || distance(drop, chaser) < distance(target, chaser)) target = drop;
  if (target) {
    const goal = target;
    const closer = options.filter(
      (direction) => distance({ col: chaser.col + MOVES[direction].col, row: chaser.row + MOVES[direction].row }, goal) < distance(chaser, goal),
    );
    if (chaser.heading && closer.includes(chaser.heading) && random() < 0.7) return chaser.heading;
    if (closer.length) return pick(closer, random);
  }
  if (chaser.heading && options.includes(chaser.heading)) return chaser.heading;
  const turns = options.filter((direction) => !chaser.heading || direction !== REVERSE[chaser.heading]);
  return pick(turns.length ? turns : options, random);
}

function nextHeading(game: Game, auto: boolean): Direction | null {
  const { board, chaser } = game;
  if (auto) return autopilot(game);
  if (chaser.queued && canMove(board, chaser, chaser.queued)) {
    const turn = chaser.queued;
    chaser.queued = null;
    return turn;
  }
  return chaser.heading && canMove(board, chaser, chaser.heading) ? chaser.heading : null;
}

function eatAt(game: Game, eaten: Spot[]) {
  const index = game.drops.findIndex((drop) => same(drop, game.chaser));
  if (index < 0) return;
  const [drop] = game.drops.splice(index, 1);
  game.eaten++;
  game.respawns.push(RESPAWN_SECONDS);
  eaten.push({ col: drop.col, row: drop.row });
}

// Advances the game by `seconds` at `speed` cells per second, with the
// autopilot steering when `auto` is set. Returns the spots eaten on the way.
export function step(game: Game, seconds: number, speed: number, auto: boolean): Spot[] {
  const { chaser } = game;
  const eaten: Spot[] = [];
  for (const drop of game.drops) drop.age += seconds;
  const due = game.respawns.filter((left) => left <= seconds).length;
  game.respawns = game.respawns.map((left) => left - seconds).filter((left) => left > 0);
  for (let i = 0; i < due; i++) spawn(game);

  if (chaser.progress === 0) eatAt(game, eaten);
  let travel = speed * seconds;
  // Each pass moves at least to the next spot, so this only bounds a huge step.
  for (let passes = 0; travel > 0 && passes < 256; passes++) {
    if (!chaser.heading || chaser.progress === 0) {
      const heading = nextHeading(game, auto);
      if (!heading) {
        chaser.heading = null;
        break;
      }
      chaser.heading = chaser.facing = heading;
    }
    const left = 1 - chaser.progress;
    if (travel < left) {
      chaser.progress += travel;
      chaser.travelled += travel;
      break;
    }
    travel -= left;
    chaser.travelled += left;
    chaser.col += MOVES[chaser.heading].col;
    chaser.row += MOVES[chaser.heading].row;
    chaser.progress = 0;
    eatAt(game, eaten);
  }
  return eaten;
}

/** The chaser's centre in board pixels. */
export function chaserPoint(game: Game) {
  const { board, chaser } = game;
  const move = chaser.heading ? MOVES[chaser.heading] : { col: 0, row: 0 };
  return {
    x: (chaser.col + move.col * chaser.progress) * board.cell,
    y: (chaser.row + move.row * chaser.progress) * board.cell,
  };
}
