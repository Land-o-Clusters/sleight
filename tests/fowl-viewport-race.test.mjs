import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const skip = !existsSync(join(cache, '.git')) && 'pinned FowlBrowser cache is absent';
const task = { viewport: { maxWidth: 600 } };
let dir, script, gradeViewport;
before(async () => {
  if (skip) return;
  dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-viewport-race-')));
  for (const file of ['tools/rounds.mjs', 'test/demo/server.mjs']) {
    const original = spawnSync('/usr/bin/git', ['-C', cache, 'show', `6a12d60:${file}`], { encoding: 'utf8' });
    assert.equal(original.status, 0, original.stderr);
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), original.stdout);
  }
  for (const args of [['init', '-q'], ['add', 'tools/rounds.mjs', 'test/demo/server.mjs']]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const applied = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/viewport-fixture.patch'),
    join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  script = readFileSync(join(dir, 'test/demo/server.mjs'), 'utf8').match(/const PAGE_SCRIPT = `<script>\n([\s\S]*?)<\/script>`;/)[1];
  ({ gradeViewport } = await import(pathToFileURL(join(dir, 'tools/rounds.mjs'))));
});
after(() => removeTemp(dir));

test('the round wrapper applies and recognizes both patches in the shared fixture cache', { skip }, () => {
  const diff = spawnSync('/usr/bin/git', ['diff'], { cwd: dir, encoding: 'utf8' });
  assert.equal(diff.status, 0, diff.stderr);
  const patches = ['viewport-fixture.patch', 'sleight-surface.patch'];
  assert.equal(diff.stdout, patches.map(file => readFileSync(join(root, 'bench/fowl', file), 'utf8')).join(''));
  const wrapper = readFileSync(join(root, 'bench/fowl/rounds.sh'), 'utf8');
  for (const patch of patches) assert.ok(wrapper.includes(`"$REPO/bench/fowl/${patch}"`));
  assert.match(wrapper, /git apply "\$REPO\/bench\/fowl\/viewport-fixture\.patch" "\$REPO\/bench\/fowl\/sleight-surface\.patch"/);
});

// Run the fixture's actual inline script with a deterministic clock and no browser.
function page({ beaconAccepted = true } = {}) {
  let now = 1000, serial = 0;
  const timers = new Map(), listeners = new Map(), events = [], beacons = [];
  const listen = (name, fn) => listeners.set(name, fn);
  const context = {
    innerWidth: 1200, innerHeight: 818,
    location: { pathname: '/t/mobile/shop/product/moss' },
    addEventListener: listen,
    document: { visibilityState: 'visible', addEventListener: listen },
    setTimeout(fn, ms) { timers.set(++serial, { at: now + ms, fn }); return serial; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { assert.equal(url, '/t/mobile/api/log'); events.push({ at: now, ...JSON.parse(options.body) }); },
    navigator: { sendBeacon(url, body) {
      assert.equal(url, '/t/mobile/api/log');
      beacons.push({ url, body });
      if (beaconAccepted) events.push({ at: now, ...JSON.parse(body) });
      return beaconAccepted;
    } },
  };
  runInNewContext(script, context);
  const emit = name => listeners.get(name)?.();
  return {
    events, beacons,
    resize(width, height) { Object.assign(context, { innerWidth: width, innerHeight: height }); emit('resize'); },
    tick(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
    close() { emit('pagehide'); },
    visibility(state) { context.document.visibilityState = state; emit('visibilitychange'); },
    grade(extra = {}) { return gradeViewport({ task, site: { events }, ...extra }).problems; },
  };
}

test('a close 42 ms after restore reports the final size and passes', { skip }, () => {
  const p = page();
  p.resize(390, 844); p.tick(150);
  p.resize(1200, 818); p.tick(42);
  assert.match(p.grade().join('; '), /left at 390x844/);
  p.close();
  assert.deepEqual(p.grade(), []);
  assert.equal(p.beacons.length, 1);
  assert.equal(p.events.at(-1).field, 'pagehide');
  assert.equal(p.events.at(-1).path, '/shop/product/moss');
  p.tick(150);
  assert.equal(p.events.length, 3, 'close cancels the pending resize report');
});

test('hidden then pagehide sends one final local request on either A/B side', { skip }, () => {
  for (const side of ['A', 'B']) {
    const p = page();
    p.resize(390, 844); p.tick(150);
    p.resize(1200, 818); p.tick(42);
    p.visibility('hidden'); p.close();
    assert.equal(p.beacons.length, 1, side);
    assert.equal(p.events.at(-1).field, 'visibilitychange');
    assert.deepEqual(p.grade(), [], side);
  }
});

test('a page closed at 390x844 still fails even with a journal clear', { skip }, () => {
  const p = page();
  p.resize(390, 844); p.tick(150); p.close();
  assert.match(p.grade({ journal: [{ type: 'viewport', event: 'clear', t: 1100 }] }).join('; '), /left at 390x844/);
});

test('missing final report fails closed and completely absent reports fail closed', { skip }, () => {
  const p = page({ beaconAccepted: false });
  p.resize(390, 844); p.tick(150);
  p.resize(1200, 818); p.tick(42); p.close();
  assert.match(p.grade().join('; '), /left at 390x844/);
  assert.deepEqual(gradeViewport({ task, site: null }).problems, ['the page never reported its size']);
  assert.deepEqual(gradeViewport({ task, site: { events: [] } }).problems, ['the page never reported its size']);
});

test('later mobile or height-only reports override a successful restored report', { skip }, () => {
  const p = page();
  p.resize(390, 844); p.tick(150);
  p.resize(1200, 818); p.tick(150);
  assert.deepEqual(p.grade(), []);
  p.resize(1200, 844); p.close();
  assert.match(p.grade().join('; '), /left at 1200x844/);
  p.resize(390, 844); p.close();
  assert.match(p.grade().join('; '), /left at 390x844/);
});

test('visibility reports resume after showing the page and normal resize reports remain', { skip }, () => {
  const p = page();
  p.visibility('hidden'); p.close();
  assert.equal(p.beacons.length, 1);
  p.visibility('visible');
  p.resize(390, 844); p.tick(149);
  assert.equal(p.events.length, 2);
  p.tick(1);
  assert.equal(p.events.at(-1).width, 390);
  p.visibility('hidden'); p.close();
  assert.equal(p.beacons.length, 2);
  assert.match(p.grade().join('; '), /left at 390x844/);
});

test('late beacons cannot repair turn-end evidence and an uncleared journal fails', { skip }, () => {
  const p = page();
  p.resize(390, 844); p.tick(150);
  p.resize(1200, 818); p.tick(42); p.close();
  assert.match(p.grade({ turnEndAt: 1150 }).join('; '), /left at 390x844/);
  assert.match(p.grade({ journal: [{ type: 'viewport', event: 'set', t: 1100, width: 390, height: 844, tab: 'mobile' }] }).join('; '), /viewport still set/);
});
