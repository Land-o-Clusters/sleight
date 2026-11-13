import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const expired = '2026-01-01-' + 'a'.repeat(32) + '.jsonl';
const on = '{"version":1,"enabled":false,"record_runs":true}';
const off = '{"version":1,"enabled":false,"record_runs":false}';
async function swept(root) {
  const deadline = Date.now() + 5000;
  while ((await readdir(root)).length && Date.now() < deadline) await delay(20);
  assert.deepEqual(await readdir(root), []);
}
function fixture(t) {
  // The run store refuses a root whose realpath differs (RUNS_UNSAFE), and TMPDIR is often a symlinked path.
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-retention-')))));
  const config = join(dir, 'hand.json');
  writeFileSync(config, on, { mode: 0o600 });
  const bank = name => {
    const root = join(dir, name); mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, expired), '\n', { mode: 0o600 });
    return root;
  };
  const start = (root, create) => {
    const errors = [], retention = create({ root, config, onError: error => errors.push(error) });
    t.after(async () => { await retention.close(); assert.deepEqual(errors, []); });
    return retention;
  };
  return { dir, config, bank, start };
}

// Directory notifications are replaced for every test. Settings polling, the
// sweep and shutdown still run against real private fixture files.
async function silentRetention() {
  const url = new URL('../plugins/sleight/lib/runs/retention.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8'), site = 'watch(dirname(config),';
  assert.equal(source.split(site).length - 1, 1);
  const silent = source.replace(site, 'silentWatch(dirname(config),')
    .replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`) +
    '\nfunction silentWatch() { return { on() {}, close() {} }; }\n';
  assert.equal(silent.split(site).length - 1, 0);
  assert.equal(silent.split('silentWatch(dirname(config),').length - 1, 1);
  assert.equal(silent.split('watchFile(').length, source.split('watchFile(').length);
  const interval = source.match(/interval:\s*(\d+)/);
  const pollMs = interval ? Number(interval[1]) : 1000;
  const module = await import('data:text/javascript;base64,' + Buffer.from(silent).toString('base64'));
  return { startRunRetention: module.startRunRetention, pollMs };
}

test('stat polling prunes idle recordings when directory notifications are absent', async t => {
  const silent = await silentRetention();
  const f = fixture(t), root = f.bank('runs'), retention = f.start(root, silent.startRunRetention);
  await retention.ready; assert.deepEqual(await readdir(root), []);
  writeFileSync(join(root, expired), '\n', { mode: 0o600 });
  writeFileSync(f.config, off);
  await swept(root); await retention.flush();
});

test('retention follows an atomic settings replacement while recording is idle', async t => {
  const silent = await silentRetention();
  const f = fixture(t), root = f.bank('runs'), retention = f.start(root, silent.startRunRetention);
  await retention.ready; assert.deepEqual(await readdir(root), []);
  writeFileSync(join(root, expired), '\n', { mode: 0o600 });
  const replacement = join(f.dir, 'replacement.json'); writeFileSync(replacement, off, { mode: 0o600 });
  renameSync(replacement, f.config);
  await swept(root); await retention.flush();
});

test('closing one retention monitor preserves another monitor of the same settings file', async t => {
  const silent = await silentRetention();
  const f = fixture(t), first = f.bank('first'), second = f.bank('second');
  const a = f.start(first, silent.startRunRetention), b = f.start(second, silent.startRunRetention);
  await Promise.all([a.ready, b.ready]);
  await a.close(); await a.close();
  for (const root of [first, second]) writeFileSync(join(root, expired), '\n', { mode: 0o600 });
  writeFileSync(f.config, off);
  await swept(second); await b.flush();
  // A listener that survived close can share b's poll tick. Keep checking for
  // 1.5 poll intervals so that sweep is visible before the file is accepted.
  const waitMs = silent.pollMs * 1.5;
  assert.equal(silent.pollMs, 1000);
  assert.equal(waitMs, 1500);
  const started = Date.now(), until = started + waitMs;
  do {
    assert.deepEqual(await readdir(first), [expired]);
    const remaining = until - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(50, remaining));
  } while (Date.now() < until);
  assert.ok(Date.now() - started >= waitMs);
  assert.deepEqual(await readdir(first), [expired]);
});
