import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';

// The production stage handlers run in geometry-only mode. No app, window or decoder starts.
const folder = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-retirement-'))));
after(() => rmSync(folder, { recursive: true, force: true }));
let binary;
function host() {
  if (binary) return binary;
  binary = join(folder, 'host');
  const source = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
  const child = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), source, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(child, 0, child.stderr);
  return binary;
}
const nonce = 'a'.repeat(64);
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
  hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
  'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const character = { hand: 'character', nonce, seq: 1, id: 'fixture', sheet: join(folder, 'sheet.png'), extra: null,
  cell: [192, 208], table: { idle: { ...entry, frames: 2 } },
  perch: { anchor: [96, 150], table: Object.fromEntries(states.map(state => [state, entry])) }, size: 'stage' };
const world = (extra = {}) => ({ dumpWorld: { windows: [{ id: 7, pid: 42, frame: [200, 500, 900, 350] }],
  displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }], pointer: [1750, 1150], inputAge: 20,
  pointerAway: 10, person: [1450, 700, 300, 300], cards: [], ...extra } });
const aim = (seq, at = [650, 700], extra = {}) => ({ hand: 'aim', nonce, seq, kind: 'click', pid: 42, windowId: 7, at, ...extra });
const stats = { dumpStats: true };
function dump(lines, throughRing = false) {
  const child = spawnSync(host(), ['--stage-dump', ...throughRing ? ['--through-ring'] : []], {
    input: [character, { dumpStageArt: true }, world(), ...lines].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  assertChildStatus(child, 0, child.stderr || child.stdout);
  return child.stdout.trim().split('\n').map(JSON.parse);
}
const draws = rows => rows.filter(row => row.effect === 'stage');
const samples = rows => rows.filter(row => row.effect === 'stage-stats');
const center = box => [box[0] + box[2] / 2, box[1] + box[3] / 2];
const contains = (box, point) => box[0] <= point[0] && point[0] <= box[0] + box[2] && box[1] <= point[1] && point[1] <= box[1] + box[3];

describe('RET3 conservative admission safety', { skip: macCommandSkip('xcrun') }, () => {
  for (const throughRing of [false, true]) test(`new protection under paused drawing clears at admission, ring=${throughRing}`, () => {
    const seed = aim(2), old = draws(dump([seed], throughRing)).at(-1).box, target = center(old);
    const rows = dump([seed, { dumpPaused: true }, { dumpClock: 1 }, aim(3, target), stats], throughRing);
    const sample = samples(rows).at(-1);
    assert.equal(sample.shown, false, 'a paused drawing cannot remain over newly protected geometry');
    assert.ok(sample.targetBindings.some(binding => contains(binding.rect, target)), 'the new reference survives resume');
    const hide = rows.find(row => row.time === 1 && row.effect === 'stage-hide');
    assert.equal(hide?.duration, 0, 'protection removes every visible layer without a fade');
    assert.equal(rows.filter(row => row.time === 1 && row.effect === 'stage').length, 0);
  });

  test('a paused fresh target stays protected after resume and call completion', () => {
    const seed = aim(2), target = center(draws(dump([seed])).at(-1).box);
    const done = { hand: 'status', nonce, seq: 4, state: 'done', ok: true, pid: 42, windowId: 7, at: [650, 700] };
    const rows = dump([seed, { dumpPaused: true }, aim(3, target), { dumpPaused: false }, done,
      { dumpClock: 30 }, stats, { dumpClock: 600 }, stats]);
    for (const sample of samples(rows)) assert.ok(sample.targetBindings.some(binding => contains(binding.rect, target)));
  });

  test('a new person-view exclusion removes a paused drawing immediately', () => {
    const seed = aim(2), box = draws(dump([seed])).at(-1).box;
    const rows = dump([seed, { dumpPaused: true }, { dumpClock: 1 }, world({ person: box }), stats]);
    assert.equal(samples(rows).at(-1).shown, false);
    assert.equal(rows.findLast(row => row.effect === 'stage-hide').duration, 0);
  });
});
