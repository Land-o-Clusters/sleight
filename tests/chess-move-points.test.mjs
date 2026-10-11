import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chessMovePoints } from '../bench/chess-move-points.mjs';

const recorded = JSON.parse(readFileSync(new URL('../bench/reliability-chess-points.json', import.meta.url), 'utf8'));
const launches = [
  { Width: 667, Height: 532, from: [357, 367], to: [357, 295] },
  { Width: 897, Height: 705, from: [480, 487], to: [480, 392] },
];

test('scales recorded screenshot points for both Chess launch sizes', () => {
  for (const { Width, Height, from, to } of launches) {
    const points = chessMovePoints({ bounds: { Width, Height }, recorded });
    assert.deepEqual(points.from, from);
    assert.deepEqual(points.to, to);
    assert.equal(points.source, 'scaled');
    assert.notDeepEqual(points.from, recorded.from);
  }
});

test('uses AX square centers when pieces carry frames, at both launch sizes', () => {
  const framed = [
    {
      Width: 667, Height: 532,
      squares: [
        { name: 'white pawn, e2', point: [356, 360], size: [40, 39] },
        { name: 'e4', point: [354, 277], size: [38, 35] },
      ],
      from: [356, 360], to: [354, 277],
    },
    {
      Width: 897, Height: 705,
      squares: [
        { name: 'white pawn, e2', frame: { x: 441, y: 440, width: 74, height: 70 } },
        { name: 'e4', frame: { X: 440, Y: 332, Width: 70, Height: 62 } },
      ],
      from: [478, 475], to: [475, 363],
    },
  ];
  for (const { Width, Height, squares, from, to } of framed) {
    const points = chessMovePoints({ bounds: { Width, Height }, squares, recorded });
    assert.deepEqual(points.from, from);
    assert.deepEqual(points.to, to);
    assert.equal(points.source, 'ax-frames');
  }
});

test('flips inverted Chess AX Y into screenshot space', () => {
  const points = chessMovePoints({
    bounds: { Width: 667, Height: 532 },
    squares: [
      { name: 'white pawn, e2', point: [356, 172], size: [40, 39] },
      { name: 'e4', point: [354, 255], size: [38, 35] },
    ],
    recorded,
  });
  assert.deepEqual(points.from, [356, 360]);
  assert.deepEqual(points.to, [354, 277]);
  assert.equal(points.source, 'ax-frames');
});

test('waits and reliability Chess paths compute points instead of matching recorded bounds', () => {
  const waits = readFileSync(new URL('../bench/waits-targeting-live.mjs', import.meta.url), 'utf8');
  const reliability = readFileSync(new URL('../bench/reliability-live.mjs', import.meta.url), 'utf8');
  assert.match(waits, /chessMovePoints/);
  assert.match(reliability, /chessMovePoints/);
  assert.doesNotMatch(waits, /--inspect-chess/);
  assert.doesNotMatch(waits, /assert\.deepEqual\(games\[0\]\.bounds, points\.bounds\)/);
  assert.doesNotMatch(reliability, /Screenshot geometry changed; no drag posted/);
});
