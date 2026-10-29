import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Script, runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { createRunRecorder, clearRuns, listRuns, readRun, pruneRuns, runIdValid, RUN_BYTES, RETENTION_MS, SHOT_BYTES } from '../plugins/sleight/lib/runs/store.mjs';
import { downscaleScreenshot } from '../plugins/sleight/lib/runs/screenshot.mjs';
import { buildRunHTML, buildRunsHTML, replayFrame } from '../plugins/sleight/lib/runs/viewer.mjs';
import { runsCommand } from '../plugins/sleight/lib/runs/command.mjs';
import { startRunRetention } from '../plugins/sleight/lib/runs/retention.mjs';
import { createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';
import { handSetting, readHandConfig } from '../plugins/sleight/lib/hand/settings.mjs';
import { writeHandSetting } from '../plugins/sleight/lib/hand/command.mjs';
import { settingsCommand } from '../plugins/sleight/lib/person-gate.mjs';
import { highStakesChange } from '../plugins/sleight/lib/person-confirm.mjs';
import { settingsChangeRefusal } from '../plugins/sleight/lib/launch.mjs';
import { preapprovedWriteDenied } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { createBrowserHand } from '../plugins/sleight/lib/hand/browser-hand.mjs';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';

const session = 'a'.repeat(32), call = 'b'.repeat(32), now = Date.parse('2026-10-26T12:00:00Z');
const id = '2026-10-26-' + session;
const event = (extra = {}) => ({ v: 'sleight.cursor/1', session, seq: 1, ts: now, type: 'session', state: 'start', ...extra });
const action = (extra = {}) => event({ type: 'action', call, index: 0, phase: 'act', kind: 'click', source: 'native', point: [150, 250], window: { id: 7, rect: [100, 200, 200, 100] }, ...extra });
const shot = { mimeType: 'image/jpeg', data: '/9j/2Q==', width: 200, height: 100 };
const content = [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }];
function world(t) {
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-runs-test-')))));
  return { dir, root: join(dir, 'runs') };
}
const record = (root, extra = {}) => createRunRecorder({ root, now: () => now, encode: async () => shot, ...extra });

test('run IDs refuse traversal, malformed dates and arbitrary files', () => {
  assert.equal(runIdValid(id), true);
  for (const value of ['../' + id, id + '.jsonl', '2026-02-30-' + session, '2026-13-01-' + session, '2026-01-01-x', '']) assert.equal(runIdValid(value), false);
});
test('writer uses private modes and records only one session with immutable event snapshots', async t => {
  const { root } = world(t), r = record(root), input = action();
  r.write(input); input.point[0] = 999; r.write(event({ session: 'c'.repeat(32) })); await r.close();
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(root, id + '.jsonl')).mode & 0o777, 0o600);
  assert.deepEqual((await readRun(id, { root }))[0].point, [150, 250]);
  assert.equal((await readRun(id, { root })).length, 1);
});
test('writer caps the complete JSONL at 5 MiB without partial lines or rollover', async t => {
  const { root } = world(t), r = record(root), payload = 'x'.repeat(64000);
  for (let seq = 1; seq <= 100; seq++) r.write(event({ seq, say: payload }));
  await r.close();
  const bytes = readFileSync(join(root, id + '.jsonl'));
  assert.ok(bytes.length <= RUN_BYTES); assert.ok(bytes.length > RUN_BYTES - 65000);
  assert.equal(bytes.at(-1), 10); assert.equal((await listRuns({ root })).length, 1);
  assert.equal(r.stats().stopped, true); assert.ok(r.stats().dropped > 0);
});
test('writer bounds the pending queue at 256 and exposes drop count', async t => {
  const { root } = world(t), r = record(root);
  for (let seq = 1; seq <= 300; seq++) r.write(event({ seq }));
  assert.equal(r.stats().pending, 256); assert.equal(r.stats().dropped, 44);
  await r.close(); const rows = await readRun(id, { root }); assert.equal(rows.length, 257);
  assert.match(replayFrame(rows, rows.length - 1).losses, /44 queued records dropped/);
});
test('retention deletes expired runs oldest first and keeps the boundary day and unrelated files', async t => {
  const { root } = world(t); mkdirSync(root, { mode: 0o700 });
  const day = new Date(now - RETENTION_MS).toISOString().slice(0, 10);
  const ids = ['2026-09-01-' + session, '2026-09-25-' + session, day + '-' + session, id];
  for (const name of ids) writeFileSync(join(root, name + '.jsonl'), '\n', { mode: 0o600 });
  writeFileSync(join(root, 'owner.txt'), 'keep');
  const midnight = Date.parse('2026-10-26');
  assert.equal(await pruneRuns({ root, now: midnight }), 2);
  assert.deepEqual((await listRuns({ root, now: midnight })).map(r => r.id), [id, ids[2]]);
  assert.equal(readFileSync(join(root, 'owner.txt'), 'utf8'), 'keep');
});
test('recording startup prunes expired files before writing', async t => {
  const { root } = world(t); mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, '2026-01-01-' + session + '.jsonl'), '\n', { mode: 0o600 });
  const r = record(root); r.write(event()); await r.close(); assert.deepEqual((await listRuns({ root })).map(r => r.id), [id]);
});

test('relay retention sweeps at startup and when recording is turned off while idle', async t => {
  const { dir, root } = world(t); mkdirSync(root, { mode: 0o700 });
  const config = join(dir, 'hand.json'), expired = join(root, '2026-01-01-' + session + '.jsonl');
  writeFileSync(config, '{"version":1,"enabled":false,"record_runs":true}', { mode: 0o600 });
  writeFileSync(expired, '\n', { mode: 0o600 });
  const retention = startRunRetention({ root, config, now: () => now, onError: error => assert.fail(error) });
  t.after(() => retention.close()); await retention.ready; assert.deepEqual(await readdir(root), []);
  writeFileSync(expired, '\n', { mode: 0o600 });
  writeFileSync(config, '{"version":1,"enabled":false,"record_runs":false}');
  // macOS directory events can be coalesced beyond the old 500 ms polling
  // budget. Wait for the deletion, with a bounded deadline, before flushing.
  const changed = Date.now(), deadline = changed + 5000;
  while ((await readdir(root)).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await retention.flush(); assert.deepEqual(await readdir(root), []); await retention.close();
  t.diagnostic(`idle retention sweep observed after ${Date.now() - changed} ms`);
});

test('mixed unsafe files are reported while recording, listing and clearing safe runs continue', async t => {
  const { dir, root } = world(t); mkdirSync(root, { mode: 0o700 });
  const bad = n => `2026-10-26-${String(n).padStart(32, '0')}.jsonl`;
  const outside = join(dir, 'outside'); writeFileSync(outside, 'private', { mode: 0o600 });
  writeFileSync(join(root, bad(1)), '\n', { mode: 0o644 });
  linkSync(outside, join(root, bad(2))); symlinkSync(outside, join(root, bad(3)));
  writeFileSync(join(root, bad(4)), '', { mode: 0o600 }); truncateSync(join(root, bad(4)), RUN_BYTES + 1);
  const skipped = [], r = record(root); r.write(event()); await r.close();
  assert.equal(r.stats().stopped, false);
  assert.deepEqual((await listRuns({ root, now, onSkip: row => skipped.push(row) })).map(r => r.id), [id]);
  assert.deepEqual(skipped.map(r => r.name).sort(), [1, 2, 3, 4].map(bad));
  const lines = [], options = { root, now, temp: dir, open() {}, out: line => lines.push(line) };
  assert.equal(await runsCommand(['list'], options), 0);
  assert.ok(lines.join('').includes('Skipped 4')); lines.length = 0;
  assert.equal(await runsCommand(['clear'], options), 0);
  assert.match(lines.join(''), /Removed 1 recordings/); assert.match(lines.join(''), /Skipped 4/);
  assert.deepEqual((await readdir(root)).sort(), [1, 2, 3, 4].map(bad));
  assert.equal(readFileSync(outside, 'utf8'), 'private');
});

test('list and open sweep expired files, and list enforces a 200 MiB oldest-first bank cap', async t => {
  const { root } = world(t); mkdirSync(root, { mode: 0o700 });
  const old = '2026-01-01-' + session;
  writeFileSync(join(root, old + '.jsonl'), '\n', { mode: 0o600 });
  await assert.rejects(readRun(old, { root, now })); assert.deepEqual(await readdir(root), []);
  for (let n = 0; n < 41; n++) {
    const path = join(root, '2026-10-26-' + n.toString(16).padStart(32, '0') + '.jsonl');
    writeFileSync(path, '', { mode: 0o600 }); truncateSync(path, RUN_BYTES);
  }
  const rows = await listRuns({ root, now });
  assert.equal(rows.length, 40); assert.equal(rows.reduce((n, r) => n + r.bytes, 0), 200 * 1024 * 1024);
  assert.equal(rows.some(r => r.id.endsWith('0'.repeat(32))), false);
});

test('file size stop is recorded so the viewer explains why recording ended', async t => {
  const { root } = world(t), r = record(root);
  for (let seq = 1; seq <= 100; seq++) r.write(event({ seq, say: 'x'.repeat(64000) }));
  await r.close(); const rows = await readRun(id, { root, now });
  assert.equal(rows.at(-1).type, 'recording'); assert.equal(rows.at(-1).state, 'stopped');
  assert.match(replayFrame(rows, rows.length - 1).stopped, /size/);
});

test('appending a recording prunes the oldest file before the bank exceeds 200 MiB', async t => {
  const { root } = world(t); mkdirSync(root, { mode: 0o700 });
  const oldest = '2026-10-25-' + '0'.repeat(32);
  for (let n = 0; n < 40; n++) {
    const path = join(root, (n ? '2026-10-26-' + n.toString(16).padStart(32, '0') : oldest) + '.jsonl');
    writeFileSync(path, '', { mode: 0o600 }); truncateSync(path, RUN_BYTES);
  }
  const r = record(root); r.write(event()); await r.close();
  const rows = await listRuns({ root, now });
  assert.equal(rows.length, 40); assert.ok(rows.reduce((sum, row) => sum + row.bytes, 0) <= 200 * 1024 * 1024);
  assert.equal(rows.some(row => row.id === oldest), false); assert.equal(r.stats().stopped, false);
});
test('screenshots are embedded once with known native geometry and bounded conversion queue', async t => {
  const { root } = world(t), r = record(root);
  r.write(action());
  for (let i = 0; i < 4; i++) r.screenshot(content, { windowId: 7 });
  await r.close(); const rows = await readRun(id, { root });
  assert.equal(rows.filter(r => r.type === 'screenshot').length, 2);
  assert.deepEqual(rows[1].window, { id: 7, rect: [100, 200, 200, 100] });
  assert.deepEqual(rows[1].image, shot); assert.equal(rows[1].v, 'sleight.run/1');
  assert.match(replayFrame(rows, rows.length - 1).losses, /2 screenshots skipped/);
});
test('screenshots without safe geometry retain pixels without claiming a mapping', async t => {
  const { root } = world(t), r = record(root); r.write(action()); r.screenshot(content, { source: 'turbo', windowId: 7 });
  await r.close(); assert.equal((await readRun(id, { root }))[1].window, undefined);
});
test('oversized screenshot and failed conversions leave event recording intact', async t => {
  const { root } = world(t), r = record(root, { encode: async () => ({ ...shot, data: Buffer.alloc(SHOT_BYTES + 1).toString('base64') }) });
  r.write(event()); r.screenshot(content); await r.close(); const rows = await readRun(id, { root });
  assert.equal(rows.length, 2); assert.equal(rows.at(-1).screenshots, 1);
});
test('off during a pending conversion prevents pixels from being saved', async t => {
  const { root } = world(t); let enabled = true, release, began;
  const started = new Promise(resolve => { began = resolve; });
  const r = record(root, { enabled: () => enabled, encode: async () => { began(); return new Promise(resolve => { release = resolve; }); } });
  r.write(event()); r.screenshot(content); await started; enabled = false; release(shot); await r.close();
  assert.equal((await readRun(id, { root })).length, 1);
});
test('clearing an active file stops its writer and never recreates it', async t => {
  const { root } = world(t), r = record(root); r.write(event()); await r.flush();
  assert.equal(await clearRuns({ root }), 1); r.write(action()); await r.close();
  assert.equal(r.stats().stopped, true); assert.deepEqual(await listRuns({ root }), []);
});
test('bank and files refuse symlinks, wrong modes and hardlinks', async t => {
  const { dir, root } = world(t); mkdirSync(root, { mode: 0o700 });
  const target = join(dir, 'outside'); writeFileSync(target, 'private', { mode: 0o600 });
  symlinkSync(target, join(root, id + '.jsonl'));
  await assert.rejects(readRun(id, { root })); assert.equal(await clearRuns({ root }), 0);
  assert.equal(readFileSync(target, 'utf8'), 'private');
  await rm(join(root, id + '.jsonl')); chmodSync(root, 0o755); await assert.rejects(listRuns({ root }), /RUNS_UNSAFE/);
  chmodSync(root, 0o700); writeFileSync(join(root, id + '.jsonl'), '\n', { mode: 0o644 }); await assert.rejects(readRun(id, { root }), /RUNS_UNSAFE/);
  await rm(join(root, id + '.jsonl')); linkSync(target, join(root, id + '.jsonl')); await assert.rejects(readRun(id, { root }), /RUNS_UNSAFE/);
});
test('writer never follows a linked bank or overwrites an existing session', async t => {
  const { dir, root } = world(t), alias = join(dir, 'alias'); mkdirSync(root, { mode: 0o700 }); symlinkSync(root, alias);
  const r = record(alias); r.write(event()); await r.close(); assert.equal(r.stats().stopped, true); assert.deepEqual(await readdir(root), []);
  const first = record(root); first.write(event()); await first.close();
  const second = record(root); second.write(action()); await second.close();
  assert.equal(second.stats().stopped, true); assert.equal((await readRun(id, { root }))[0].type, 'session');
  const linkedChild = record(join(alias, 'never-created')); linkedChild.write(event()); await linkedChild.close();
  assert.equal(linkedChild.stats().stopped, true); assert.deepEqual(await readdir(root), [id + '.jsonl']);
});
test('reader ignores interrupted final line and refuses oversized files', async t => {
  const { root } = world(t); mkdirSync(root, { mode: 0o700 });
  const path = join(root, id + '.jsonl'); writeFileSync(path, JSON.stringify(event()) + '\n{"unfinished":', { mode: 0o600 });
  assert.equal((await readRun(id, { root })).length, 1);
  writeFileSync(path, Buffer.alloc(RUN_BYTES + 1)); await assert.rejects(readRun(id, { root }));
});
test('record_runs is off by default, validated as boolean and preserved by hand writers', t => {
  const { dir } = world(t), path = join(dir, 'hand.json');
  assert.equal(handSetting({ path, env: {}, platform: 'darwin' }).record_runs, undefined);
  writeFileSync(path, JSON.stringify({ version: 1, enabled: false, record_runs: true }), { mode: 0o600 });
  assert.equal(handSetting({ path, env: {}, platform: 'darwin' }).record_runs, true);
  assert.equal(handSetting({ path, env: { SLEIGHT_HAND: '0' }, platform: 'darwin' }).record_runs, false);
  writeHandSetting({ capture: 'visible' }, { path }); assert.equal(readHandConfig(path).record_runs, true);
  writeFileSync(path, JSON.stringify({ version: 1, enabled: false, record_runs: 'true' })); assert.equal(readHandConfig(path).state, 'unsafe');
});
test('record-only session uses filtered events without renderer discovery or host drawing', async t => {
  const { root } = world(t), r = record(root); let sockets = 0, hosts = 0;
  const cursor = createCursorEvents({ env: {}, setting: () => ({ record_runs: true, labels: 'off' }), recorder: () => r,
    now: () => now, sink: { write() { sockets++; }, close() {} }, repeat() { throw Error('no discovery'); } });
  cursor.connectHost({ cursor() { hosts++; } });
  cursor.action({ call, index: 0, phase: 'act', kind: 'type', source: 'native', label: 'PRIVATE', text: 'SECRET' });
  cursor.screenshot(content); const closing = cursor.close(); assert.equal(cursor.close(), closing); await closing;
  const rows = await readRun(r.stats().id, { root });
  assert.equal(rows.length, 5); assert.equal(rows[2].label, undefined); assert.equal(rows[2].text, undefined);
  assert.equal(sockets, 0); assert.equal(hosts, 0);
});
test('off recording never constructs a writer, and opting in later includes session start', () => {
  let enabled = false, time = now, factories = 0; const rows = [];
  const cursor = createCursorEvents({ env: {}, now: () => time, setting: () => ({ record_runs: enabled, enabled: true, style: 'ring' }),
    recorder: () => { factories++; return { write: e => rows.push(e), close() {} }; } });
  cursor.status('thinking'); assert.equal(factories, 0);
  enabled = true; time += 250; cursor.status('done'); cursor.close();
  assert.equal(factories, 1); assert.equal(rows[0].state, 'start'); assert.equal(rows[1].state, 'done');
});
test('native and turbo record-only events use no host, geometry, page metrics or box reads', async t => {
  const { root } = world(t), r = record(root), setting = () => ({ record_runs: true });
  const cursor = createCursorEvents({ env: {}, setting, recorder: () => r, now: () => now });
  const geometry = { ok: true, window: { pid: 42, windowId: 7, bounds: { X: 0, Y: 0, Width: 500, Height: 400 } },
    windows: [{ id: 7, pid: 42, bounds: { X: 0, Y: 0, Width: 500, Height: 400 } }], displays: [{ X: 0, Y: 0, Width: 1000, Height: 800 }],
    elements: { 1: { X: 10, Y: 10, Width: 20, Height: 20 } } };
  const noHost = () => { assert.fail('host loaded'); };
  let lookups = 0;
  const extraRead = async () => { lookups++; return geometry; };
  const hand = createRelayHand({ env: {}, events: cursor, setting, loadClient: noHost, now: () => 0, locate: extraRead });
  hand.admit(1, { code: 'await app.click(1)', lines: { 1: 'button Description: Save' }, target: { app: 'Editor' } });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
  hand.result(1, false);
  const browser = createBrowserHand({ env: {}, events: cursor, setting, loadClient: noHost, locate: extraRead, readMetrics: extraRead });
  const token = browser.step({ op: 'click', page: {}, locator: { boundingBox: extraRead } });
  browser.finish(token);
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
  hand.close(); browser.close(); cursor.close(); await r.close();
  const rows = await readRun(r.stats().id, { root });
  assert.ok(rows.some(row => row.type === 'action' && row.source === 'native' && row.phase === 'done'));
  assert.ok(rows.some(row => row.type === 'action' && row.source === 'turbo' && row.phase === 'done'));
  assert.equal(lookups, 0); assert.equal(rows.some(row => row.point), false);
});
test('replay maps global points into screenshot percentages and carries label/narration without voice', () => {
  const rows = [event(), { v: 'sleight.run/1', type: 'screenshot', ts: now, window: { id: 7, rect: [100, 200, 200, 100] }, image: shot }, action({ seq: 4, say: 'Done', label: 'button' })];
  const frame = replayFrame(rows, 2); assert.deepEqual(frame.point, [25, 50]); assert.equal(frame.narration, 'Done'); assert.equal(frame.gaps, 2);
  assert.equal(replayFrame(rows, 0).shot, undefined);
  for (const extra of [{ window: { id: 8 } }, { point: [-100, 0] }, { phase: 'skipped' }, { point: null }])
    assert.equal(replayFrame([...rows.slice(0, 2), action(extra)], 2).point, undefined);
});
test('a screenshot before the first action uses that action geometry only for the certified window and matching aspect', () => {
  const snapshot = { v: 'sleight.run/1', type: 'screenshot', ts: now, window: { id: 7 }, image: shot };
  assert.deepEqual(replayFrame([snapshot, action()], 1).point, [25, 50]);
  assert.equal(replayFrame([{ ...snapshot, image: { ...shot, height: 200 } }, action()], 1).point, undefined);
});
test('HTML golden structure uses inline hashed scripts and no external resources', () => {
  const html = buildRunHTML([event(), action({ say: '</script><img src="https://example.invalid/steal">' })]);
  for (const part of ['<!doctype html>', 'id="timeline"', 'id="screenshot"', 'id="ring"', 'id="narration"', '#ff7a3d', '#5b8dff', "connect-src 'none'", "default-src 'none'"]) assert.ok(html.includes(part), part);
  assert.doesNotMatch(html, /<(?:script|img|link)[^>]+(?:src|href)=["'](?:https?:|\/\/)/i);
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|speechSynthesis|<script[^>]+src=/);
  assert.ok(html.includes('\\u003c/script>')); assert.ok(!html.includes('<img src="https://'));
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  new Script(script); assert.ok(html.includes('sha256-' + createHash('sha256').update(script).digest('base64')));
  assert.equal((html.match(/<script/g) ?? []).length, 2);
  assert.ok(buildRunsHTML([]).includes('id="runs"'));
});
test('inline player scrubs through images and phases with text-only narration in a DOM fixture', () => {
  const rows = [event(), { v: 'sleight.run/1', type: 'screenshot', ts: now, window: { id: 7, rect: [100, 200, 200, 100] }, image: shot },
    action({ phase: 'aim', label: 'button', say: '<img src=x onerror=steal()>' }), action({ phase: 'act' }), action({ phase: 'done' })];
  const html = buildRunHTML(rows), elements = new Map();
  for (const id of ['run-data', 'timeline', 'screenshot', 'ring', 'position', 'event', 'narration', 'notice', 'gaps', 'stopped', 'shot-time', 'previous', 'next'])
    elements.set(id, { textContent: '', value: '0', style: {}, dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, removeAttribute(name) { delete this[name]; } });
  elements.get('run-data').textContent = JSON.stringify(rows);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  runInNewContext(script, { document: { getElementById: id => elements.get(id) } });
  const slider = elements.get('timeline'), ring = elements.get('ring');
  assert.equal(elements.get('screenshot').hidden, true);
  slider.value = '2'; slider.listeners.input();
  assert.equal(elements.get('screenshot').src, 'data:image/jpeg;base64,' + shot.data);
  assert.equal(ring.style.left, '25%'); assert.equal(ring.style.top, '50%'); assert.equal(ring.dataset.phase, 'aim');
  assert.equal(elements.get('narration').textContent, rows[2].say);
  elements.get('next').listeners.click(); assert.equal(ring.dataset.phase, 'act');
  elements.get('next').listeners.click(); assert.equal(ring.dataset.phase, 'done');
  elements.get('previous').listeners.click(); assert.equal(ring.dataset.phase, 'act');
});
test('list and open build private HTML and invoke only the injected browser opener', async t => {
  const { dir, root } = world(t), r = record(root); r.write(event()); await r.close();
  const opened = [], lines = [], options = { root, temp: dir, open: async p => opened.push(p), out: t => lines.push(t) };
  assert.equal(await runsCommand(['list'], options), 0); assert.equal(await runsCommand(['open', id], options), 0);
  assert.equal(opened.length, 2);
  for (const path of opened) { assert.equal(lstatSync(path).mode & 0o777, 0o600); assert.ok(readFileSync(path, 'utf8').startsWith('<!doctype html>')); }
  assert.ok(lines.join('').includes(id)); assert.equal((await listRuns({ root })).length, 1);
  assert.equal(await runsCommand(['clear'], options), 0); assert.equal(opened.length, 2); assert.equal((await listRuns({ root })).length, 0);
});
test('CLI rejects malformed forms before reading, writing or opening anything', async t => {
  const { dir, root } = world(t);
  for (const args of [[], ['open'], ['open', '../x'], ['list', 'extra'], ['clear', 'extra'], ['on']]) {
    assert.equal(await runsCommand(args, { root, temp: dir, out() {}, open() { assert.fail('opened'); } }), 2);
  }
  assert.deepEqual(await readdir(dir), []);
});
test('person gate admits exact list/open forms and requires a terminal for clear without Touch ID', async () => {
  assert.equal(settingsCommand(['runs', 'list']), undefined); assert.equal(settingsCommand(['runs', 'open', id]), undefined);
  assert.equal(settingsCommand(['runs', 'clear']), 'runs clear'); assert.equal(highStakesChange(['runs', 'clear']), undefined);
  for (const args of [['runs'], ['runs', 'open'], ['runs', 'open', '../x'], ['runs', 'list', 'extra']]) assert.ok(settingsCommand(args));
  let checked = 0;
  assert.equal(await settingsChangeRefusal(['runs', 'clear'], { gate: (a, options) => { checked++; assert.equal(options.freshMs, 0); return 'terminal refused'; },
    confirmation: { confirm() { assert.fail('Touch ID'); } } }), 'terminal refused'); assert.equal(checked, 1);
});
test('shell guard allows literal run reads and refuses clear, extra args and opaque shell forms', async () => {
  const denied = command => preapprovedWriteDenied({ tool: 'Bash', command }, { stat: async path => ({ realPath: path }) });
  for (const cmd of ['sleight-mcp runs list', `sleight-mcp runs open ${id}`, `node plugins/sleight/lib/launch.mjs runs open ${id}`,
    'git commit -m "launch.mjs runs fast"', 'git commit -m "sleight-mcp runs fast"']) assert.equal(await denied(cmd), false, cmd);
  for (const cmd of ['sleight-mcp runs clear', 'sleight-mcp runs list extra', 'sleight-mcp runs open ../x', 'sleight-mcp runs "$OP"',
    'B=sleight-mcp; $B runs clear', 'echo clear | xargs sleight-mcp runs', 'sh -c "sleight-mcp runs clear"',
    "sleight-mcp runs'' clear", 'sleight-mcp ru""ns clear', 'nohup sleight-mcp runs clear',
    'sleight-mcp runs list && sleight-mcp runs clear', 'sleight-mcp runs list; sleight-mcp runs clear',
    'echo clear | sleight-mcp runs', 'sleight-mcp runs list > /tmp/replay-index']) assert.equal(await denied(cmd), true, cmd);
});
test('actual launcher routes malformed runs commands to usage and refuses headless clear', () => {
  const launcher = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url);
  const bad = spawnSync(process.execPath, [launcher.pathname, 'runs', 'list', 'extra'], { env: process.env, encoding: 'utf8' });
  assert.equal(bad.status, 3); // Extra arguments fail closed at the person gate before dispatch.
  const clear = spawnSync(process.execPath, [launcher.pathname, 'runs', 'clear'], { env: process.env, encoding: 'utf8' });
  assert.equal(clear.status, 3); assert.match(clear.stderr, /run it yourself in a terminal/);
});

// Synthetic PNG data, never a screen capture. CRCs keep the fixture valid for the system decoder.
function png(width, height) {
  const crc = b => { let c = 0xffffffff; for (const n of b) { c ^= n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type), out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([name, data])), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 120); for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
test('system converter downscales only supplied synthetic pixels to a bounded JPEG', { skip: process.platform !== 'darwin' }, async () => {
  const result = await downscaleScreenshot({ mimeType: 'image/png', data: png(1600, 800).toString('base64') });
  assert.equal(result.mimeType, 'image/jpeg'); assert.equal(result.width, 960); assert.equal(result.height, 480);
  assert.ok(Buffer.from(result.data, 'base64').length <= SHOT_BYTES);
});
test('converter refuses malformed and oversized image headers without capture', async () => {
  for (const image of [{ mimeType: 'image/png', data: 'AAAA' }, { mimeType: 'image/svg+xml', data: 'AAAA' }, { mimeType: 'image/jpeg', data: 'not base64' }]) assert.equal(await downscaleScreenshot(image), undefined);
  const tooBig = png(1, 1); tooBig.writeUInt32BE(20000, 16); tooBig.writeUInt32BE(20000, 20);
  assert.equal(await downscaleScreenshot({ mimeType: 'image/png', data: tooBig.toString('base64') }), undefined);
});

test('headless Chromium renders the local replay under CSP without errors or network requests', {
  skip: process.env.SLEIGHT_RUN_VIEWER_BROWSER !== '1', timeout: 15000,
}, async t => {
  const { chromium } = await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  const { dir } = world(t), path = join(dir, 'replay.html');
  const image = await downscaleScreenshot({ mimeType: 'image/png', data: png(1600, 800).toString('base64') });
  assert.equal(image.mimeType, 'image/jpeg');
  writeFileSync(path, buildRunHTML([event(), { v: 'sleight.run/1', type: 'screenshot', ts: now, window: action().window, image },
    action({ say: '<img src=x onerror=steal()>', label: 'button' }),
    { v: 'sleight.run/1', type: 'recording', state: 'stopped', reason: 'file size limit reached', ts: now }]), { mode: 0o600 });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [], requests = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
    await page.goto(pathToFileURL(path).href);
    await page.evaluate(() => { const slider = document.getElementById('timeline'); slider.value = slider.max; slider.dispatchEvent(new Event('input')); });
    await page.locator('#screenshot').evaluate(image => image.decode());
    const view = await page.evaluate(() => ({
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      image: document.getElementById('screenshot').naturalWidth,
      ring: getComputedStyle(document.getElementById('ring')).display,
      point: document.getElementById('ring').style.left,
      narration: document.getElementById('narration').textContent,
      stopped: document.getElementById('stopped').textContent,
    }));
    assert.ok(view.csp.includes("script-src 'sha256-")); assert.equal(view.image, 960);
    assert.notEqual(view.ring, 'none'); assert.equal(view.point, '25%');
    assert.equal(view.narration, '<img src=x onerror=steal()>'); assert.match(view.stopped, /Recording stopped:.*size/);
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    t.diagnostic(`Chromium ${browser.version()}: 0 console errors, 0 page errors, 0 network requests`);
  } finally { await browser.close(); }
});
