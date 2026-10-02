import assert from "node:assert/strict";
import test from "node:test";
import {
  createBoard,
  createMatch,
  createMaze,
  createTour,
  findPath,
  matchStep,
  onBoard,
  passages,
  tourStep,
  turn,
} from "../src/dropSnake.ts";

// Deterministic stand-in for Math.random (mulberry32).
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL = 48;
const copy = { left: 300, top: 100, right: 900, bottom: 400 };
const key = (cell) => `${cell.col}:${cell.row}`;

// Breadth-first distances from one cell, to check A* against.
function distances(maze, from) {
  const result = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    for (const next of passages(maze, current)) {
      if (result.has(next)) continue;
      result.set(next, result.get(current) + 1);
      queue.push(next);
    }
  }
  return result;
}

function adjacent(a, b) {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1;
}

test("centres whole cells in the panel and keeps drops clear of the copy", () => {
  const board = createBoard(1280, 632, CELL, [copy], [{ left: 0, top: 0, right: 200, bottom: 60 }]);

  assert.equal(board.cols, 26);
  assert.equal(board.rows, 13);
  assert.equal(board.x, 16);
  assert.equal(board.y, 4);
  assert.ok(board.free.length < 26 * 13);
  assert.ok(board.open.length < board.free.length);
  for (const cell of board.open) {
    const left = board.x + cell.col * CELL;
    const top = board.y + cell.row * CELL;
    assert.ok(left >= copy.right || left + CELL <= copy.left || top >= copy.bottom || top + CELL <= copy.top);
  }
});

test("carves a maze that reaches every cell", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const perfect = createMaze(20, 10, seeded(seed), { loops: 0 });
    const open = perfect.right.filter(Boolean).length + perfect.down.filter(Boolean).length;
    assert.equal(open, 20 * 10 - 1, "a maze without loops is a spanning tree");
    assert.equal(distances(perfect, 0).size, 200);
    assert.equal(distances(createMaze(20, 10, seeded(seed)), 0).size, 200);
  }
});

test("finds the shortest way from corner to corner", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const maze = createMaze(26, 13, seeded(seed));
    const path = findPath(maze, { col: 0, row: 0 }, { col: 25, row: 12 });

    assert.deepEqual(path[0], { col: 0, row: 0 });
    assert.deepEqual(path.at(-1), { col: 25, row: 12 });
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1].row * 26 + path[i - 1].col;
      assert.ok(passages(maze, from).includes(path[i].row * 26 + path[i].col), "the path never goes through a wall");
    }
    assert.equal(path.length - 1, distances(maze, 0).get(26 * 13 - 1));
  }
});

test("leaves solid cells out of the maze", () => {
  const solid = Array.from({ length: 200 }, (_, index) => index % 20 >= 5 && index % 20 < 15 && index >= 60 && index < 140);
  const maze = createMaze(20, 10, seeded(4), { solid });
  const reached = distances(maze, 0);

  assert.equal(reached.size, solid.filter((value) => !value).length);
  for (const index of reached.keys()) assert.ok(!solid[index]);
});

test("routes a tour round the copy when it can, and under it when it can't", () => {
  const island = createBoard(1280, 632, CELL, [copy]);
  const band = createBoard(1280, 632, CELL, [{ left: 0, top: 250, right: 1280, bottom: 350 }]);
  for (let seed = 1; seed <= 10; seed++) {
    const around = createTour(island, seeded(seed));
    for (const cell of around.route.filter((spot) => onBoard(island, spot))) {
      assert.ok(!island.covered[cell.row * island.cols + cell.col], "stays off the copy");
    }

    const under = createTour(band, seeded(seed));
    assert.deepEqual(under.route[0], under.entry);
    assert.ok(under.route.some((spot) => onBoard(band, spot) && band.covered[spot.row * band.cols + spot.col]));
  }
});

test("tours from one corner, through every drop, out of the opposite one", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const board = createBoard(1280, 632, CELL, [copy]);
    const tour = createTour(board, seeded(seed));
    const { entry, exit, maze } = tour;
    const isOpen = new Set(board.open.map(key));
    const drops = tour.items.length;

    assert.ok([0, 25].includes(entry.col) && [0, 12].includes(entry.row), "starts in a corner");
    assert.equal(exit.col, 25 - entry.col);
    assert.equal(exit.row, 12 - entry.row);
    assert.equal(drops, 6);
    assert.ok(tour.snake.body.every((cell) => !onBoard(board, cell)), "starts off the board");
    for (const item of tour.items) assert.ok(isOpen.has(key(item)), "no drop under the copy");

    const visited = [];
    let done = false;
    let steps = 0;
    while (!done && steps < 2000) {
      ({ done } = tourStep(tour));
      steps++;
      const head = tour.snake.body[0];
      if (!onBoard(board, head)) continue;
      const previous = visited.at(-1);
      if (previous) {
        const from = previous.row * board.cols + previous.col;
        assert.ok(passages(maze, from).includes(head.row * board.cols + head.col), "never goes through a wall");
      }
      if (head.col === exit.col && head.row === exit.row) {
        assert.equal(tour.items.length, 0, "only reaches the exit once every drop is eaten");
      }
      visited.push(head);
    }

    assert.ok(done);
    assert.deepEqual(visited[0], entry);
    assert.deepEqual(visited.at(-1), exit);
    assert.equal(tour.snake.body.length, 4 + drops, "grew by one for each drop");
  }
});

test("collects the drops in the order with the shortest trip", () => {
  const permutations = (items) =>
    items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
  for (let seed = 1; seed <= 5; seed++) {
    const board = createBoard(1280, 632, CELL, [copy]);
    const tour = createTour(board, seeded(seed));
    const index = (cell) => cell.row * board.cols + cell.col;
    // While collecting, the exit is walled off.
    const exitIndex = index(tour.exit);
    const collecting = { ...tour.maze, right: tour.maze.right.slice(), down: tour.maze.down.slice() };
    collecting.right[exitIndex] = collecting.down[exitIndex] = false;
    if (exitIndex % board.cols > 0) collecting.right[exitIndex - 1] = false;
    if (exitIndex >= board.cols) collecting.down[exitIndex - board.cols] = false;
    const stepsBetween = (a, b) => distances(b === tour.exit ? tour.maze : collecting, index(a)).get(index(b));
    let shortest = Number.POSITIVE_INFINITY;
    for (const order of permutations(tour.items)) {
      let length = 0;
      let from = tour.entry;
      for (const drop of order) {
        length += stepsBetween(from, drop);
        from = drop;
      }
      shortest = Math.min(shortest, length + stepsBetween(from, tour.exit));
    }
    const onBoardRoute = tour.route.filter((cell) => onBoard(board, cell));
    assert.equal(onBoardRoute.length - 1, shortest);
  }
});

test("takes quick turns one move each", () => {
  const match = createMatch(createBoard(1280, 632, CELL), seeded(1));
  match.items = [];
  const start = { ...match.snake.body[0] };
  turn(match, "up");
  turn(match, "right");
  turn(match, "up");

  matchStep(match);
  matchStep(match);
  matchStep(match);
  assert.deepEqual(match.snake.body[0], { col: start.col + 1, row: start.row - 2 });
});

test("ignores reversing and repeated turns", () => {
  const match = createMatch(createBoard(1280, 632, CELL), seeded(1));
  turn(match, "left");
  turn(match, "right");
  assert.deepEqual(match.turns, []);
  turn(match, "up");
  turn(match, "down");
  turn(match, "up");
  assert.deepEqual(match.turns, ["up"]);
});

test("runs diagonally while two direction keys are held", () => {
  const match = createMatch(createBoard(1280, 632, CELL), seeded(1));
  match.items = [];
  const headings = [];
  for (let i = 0; i < 4; i++) {
    matchStep(match, ["right", "up"]);
    headings.push(match.snake.heading);
  }
  assert.deepEqual(headings, ["up", "right", "up", "right"]);
});

test("does not steer with a single held key", () => {
  const match = createMatch(createBoard(1280, 632, CELL), seeded(1));
  match.items = [];
  turn(match, "up");
  matchStep(match, ["right", "up"]);
  matchStep(match, ["right"]);
  matchStep(match, ["right"]);
  assert.equal(match.snake.heading, "up");
});

test("wraps around the edges", () => {
  const board = createBoard(1280, 632, CELL);
  const match = createMatch(board, seeded(1));
  match.items = [];
  match.snake.body = [{ col: 25, row: 3 }, { col: 24, row: 3 }, { col: 23, row: 3 }];

  matchStep(match);
  assert.deepEqual(match.snake.body[0], { col: 0, row: 3 });
});

test("grows and scores on a drop, and replaces it", () => {
  const match = createMatch(createBoard(1280, 632, CELL), seeded(1));
  const head = match.snake.body[0];
  match.items = [{ col: head.col + 1, row: head.row, kind: "gift", age: 1 }];
  const length = match.snake.body.length;

  const { eaten } = matchStep(match);
  assert.equal(eaten.kind, "gift");
  assert.equal(match.score, 1);
  assert.equal(match.snake.body.length, length + 1);
  assert.equal(match.items.length, 1);
  assert.ok(!match.snake.body.some((cell) => cell.col === match.items[0].col && cell.row === match.items[0].row));
});

test("ends the run on a bite, but may chase its own tail", () => {
  const match = createMatch(createBoard(1280, 632, CELL), seeded(1));
  match.items = [];
  // A tight loop: the head is about to move into the cell the tail leaves.
  match.snake.body = [{ col: 5, row: 5 }, { col: 5, row: 6 }, { col: 6, row: 6 }, { col: 6, row: 5 }];
  match.snake.heading = "right";
  assert.equal(matchStep(match).bitten, false);

  match.snake.body = [{ col: 5, row: 5 }, { col: 5, row: 6 }, { col: 6, row: 6 }, { col: 6, row: 5 }, { col: 7, row: 5 }];
  match.snake.heading = "right";
  const before = match.snake.body.map(key);
  assert.equal(matchStep(match).bitten, true);
  assert.deepEqual(match.snake.body.map(key), before);
});

test("never puts a drop on the snake", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const board = createBoard(400, 300, CELL);
    const match = createMatch(board, seeded(seed));
    for (let step = 0; step < 300; step++) {
      if (match.snake.body.length < 20) turn(match, ["up", "left", "down", "right"][step % 4]);
      if (matchStep(match).bitten) break;
      const body = new Set(match.snake.body.map(key));
      for (const item of match.items) assert.ok(!body.has(key(item)));
    }
  }
});
