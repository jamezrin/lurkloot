import assert from "node:assert/strict";
import test from "node:test";
import { chaserPoint, createBoard, createGame, reshape, steer, step } from "../src/dropChase.ts";

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
const key = (spot) => `${spot.col}:${spot.row}`;
const near = (a, b) => Math.abs(a - b) < 1e-9;

function idle(game) {
  game.drops = [];
  game.respawns = [];
  game.chaser.heading = null;
  game.chaser.progress = 0;
  return game;
}

test("lays lanes on the grid, clear of the panel edges", () => {
  const board = createBoard(1200, 600, CELL);

  assert.equal(board.cols, 24);
  assert.equal(board.rows, 12);
  assert.equal(board.open.length, 24 * 12);
  assert.equal(createBoard(100, 60, CELL).rows, 0);
});

test("keeps drops off the copy, off each other and off the chaser", () => {
  const board = createBoard(1200, 600, CELL, [copy]);
  const open = new Set(board.open.map(key));
  assert.ok(open.size < 24 * 12);

  for (let seed = 1; seed <= 25; seed++) {
    const game = createGame(board, seeded(seed));
    for (let tick = 0; tick < 200; tick++) step(game, 1 / 30, 6, true);

    const spots = game.drops.map(key);
    assert.equal(new Set(spots).size, spots.length);
    assert.ok(!spots.includes(key(game.chaser)));
    for (const spot of spots) assert.ok(open.has(spot), `drop on covered spot ${spot}`);
  }
});

test("opens on the chaser facing a line of drops", () => {
  const game = createGame(createBoard(1200, 600, CELL, [copy]), seeded(1));
  const { chaser } = game;

  assert.equal(chaser.heading, null);
  assert.equal(chaser.facing, "right");
  for (let i = 1; i <= 4; i++) {
    assert.ok(game.drops.some((drop) => drop.col === chaser.col + i && drop.row === chaser.row));
  }
});

test("copes with a board that has no room for drops", () => {
  const game = createGame(createBoard(400, 300, CELL, [{ left: 0, top: 0, right: 400, bottom: 300 }]), seeded(1));

  assert.deepEqual(game.drops, []);
  step(game, 1, 4, true);
  assert.deepEqual(game.drops, []);
});

test("waits for the next spot before turning", () => {
  const game = idle(createGame(createBoard(1200, 600, CELL), seeded(1)));
  game.chaser.col = 5;
  game.chaser.row = 5;
  steer(game, "right");
  step(game, 0.1, 3, false);
  steer(game, "up");

  assert.equal(game.chaser.heading, "right");
  assert.equal(game.chaser.queued, "up");
  step(game, 0.3, 3, false);
  const { x, y } = chaserPoint(game);
  assert.equal(game.chaser.heading, "up");
  assert.equal(x, 6 * CELL);
  assert.ok(near(y, 4.8 * CELL));
});

test("turns around at once, even between spots", () => {
  const game = idle(createGame(createBoard(1200, 600, CELL), seeded(1)));
  game.chaser.col = 5;
  game.chaser.row = 5;
  steer(game, "right");
  step(game, 0.1, 3, false);
  const before = chaserPoint(game);
  steer(game, "left");

  const after = chaserPoint(game);
  assert.equal(game.chaser.heading, "left");
  assert.ok(near(after.x, before.x) && near(after.y, before.y));
});

test("stops at the edge of the board", () => {
  const board = createBoard(1200, 600, CELL);
  const game = idle(createGame(board, seeded(1)));
  game.chaser.col = board.cols - 1;
  steer(game, "right");
  step(game, 2, 3, false);

  assert.equal(game.chaser.col, board.cols);
  assert.equal(game.chaser.heading, null);
  assert.deepEqual(chaserPoint(game), { x: board.cols * CELL, y: game.chaser.row * CELL });
});

test("counts eaten drops and replaces them", () => {
  const game = idle(createGame(createBoard(1200, 600, CELL), seeded(1)));
  game.chaser.col = 5;
  game.chaser.row = 5;
  game.drops = [{ col: 7, row: 5, age: 1 }];
  steer(game, "right");

  const eaten = step(game, 0.7, 3, false);
  assert.deepEqual(eaten, [{ col: 7, row: 5 }]);
  assert.equal(game.eaten, 1);
  assert.equal(game.drops.length, 0);

  step(game, 1, 3, false);
  assert.equal(game.drops.length, 1);
});

test("autopilot crosses the board to reach a drop", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const board = createBoard(1200, 600, CELL, [copy]);
    const game = idle(createGame(board, seeded(seed)));
    game.chaser.col = 1;
    game.chaser.row = 1;
    game.drops = [{ col: board.cols, row: board.rows, age: 1 }];
    // 34 cells apart; 40 half-second ticks at 4 cells/s cover 80.
    for (let tick = 0; tick < 40 && game.eaten === 0; tick++) step(game, 0.5, 4, true);
    assert.ok(game.eaten > 0, `seed ${seed} never ate`);
  }
});

test("fits a running game to a smaller board", () => {
  const game = createGame(createBoard(1200, 600, CELL), seeded(3));
  game.chaser.col = 20;
  steer(game, "right");
  step(game, 0.1, 3, false);
  const board = createBoard(400, 600, CELL);
  reshape(game, board);

  assert.equal(game.chaser.col, board.cols);
  assert.equal(game.chaser.progress, 0);
  assert.equal(game.chaser.heading, null);
  for (const drop of game.drops) assert.ok(drop.col <= board.cols);
});
