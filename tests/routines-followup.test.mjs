import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DemoRecording, recordWatch, watchOptions } from '../plugins/sleight/lib/demonstration.mjs';
import { terminalConfirm } from '../plugins/sleight/lib/terminal-confirm.mjs';
import { PassThrough } from 'node:stream';
import { RoutineStore, routineCommand, routinePlan } from '../plugins/sleight/lib/routines.mjs';

const field = { label: 'Text', labelCount: 1, role: 'AXTextArea', editable: true };
const button = { id: 'Seven', idCount: 1, role: 'AXButton' };
test('recording refuses non-terminal input and missing files before observing', async t => {
  const home = mkdtempSync('/private/tmp/sleight-followup-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let accessed = false;
  const helper = { check: async () => { accessed = true; return { trusted: true, listening: true }; } };
  await assert.rejects(recordWatch({ app: 'Calculator', output: join(home, 'out.json'), input: { isTTY: false }, helper }), /terminal/);
  await assert.rejects(recordWatch({ app: 'Calculator', input: { isTTY: true }, helper }), /output file/);
  assert.equal(accessed, false);
  assert.throws(() => watchOptions(['--watch', 'Calculator']), /out.json/);
});

test('recording announces start and stop, saves privately and never replaces a file', async t => {
  const home = mkdtempSync('/private/tmp/sleight-followup-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const output = join(home, 'out.json'), events = [];
  const helper = { check: async () => ({ trusted: true, listening: true }),
    observe: async emit => { events.push('observe'); emit({ kind: 'click', element: button }); },
    close: async () => events.push('close') };
  const options = { app: 'com.apple.calculator', output, input: { isTTY: true }, helper, notify: async state => events.push(state) };
  await recordWatch(options);
  assert.deepEqual(events, ['started', 'observe', 'close', 'stopped']);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const saved = readFileSync(output, 'utf8');
  await assert.rejects(recordWatch(options), /exists/);
  assert.equal(readFileSync(output, 'utf8'), saved);
  helper.observe = async () => { throw new Error('observation failed'); };
  await assert.rejects(recordWatch({ ...options, output: join(home, 'failed.json') }), /observation failed/);
  assert.equal(events.at(-1), 'stopped');
  assert.equal(existsSync(join(home, 'failed.json')), false);
});

test('text capture refuses prior contents and unobserved baselines', () => {
  const old = new DemoRecording('com.apple.TextEdit');
  assert.throws(() => old.observe({ kind: 'baseline', element: field, empty: false }), /empty.*baseline/);
  assert.throws(() => old.script(), /stopped/);
  const unknown = new DemoRecording('com.apple.TextEdit');
  assert.throws(() => unknown.observe({ kind: 'value', element: field, value: 'old document plus new text' }), /empty.*baseline/);
  const empty = new DemoRecording('com.apple.TextEdit');
  empty.observe({ kind: 'baseline', element: field, empty: true });
  empty.observe({ kind: 'value', element: field, value: 'new text' });
  assert.match(JSON.stringify(empty.script()), /new text/);
});

test('terminal confirmation refuses pipes and requires the exact typed word', async () => {
  await assert.rejects(terminalConfirm('install', { input: { isTTY: false } }), /terminal/);
  for (const [answer, expected] of [['yes', false], ['install', true]]) {
    const input = new PassThrough(), output = new PassThrough(); input.isTTY = true;
    output.on('data', () => queueMicrotask(() => input.write(answer + '\n')));
    assert.equal(await terminalConfirm('install', { input, output }), expected);
    input.end(); output.end();
  }
});

test('routine add and remove refuse non-terminal confirmation and reject the removed yes flag', async t => {
  const home = mkdtempSync('/private/tmp/sleight-confirm-test-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = { sleightReplay: 1, steps: [{ tool: 'js', args: { code: 'let app = await cua.getApp("Calculator");' } }] };
  const store = new RoutineStore({ home, preapproved: () => ({ allows: () => true }),
    confirm: word => terminalConfirm(word, { input: { isTTY: false } }) });
  const plan = routinePlan(script, '1m', store);
  await assert.rejects(store.add(script, '1m'), /terminal/);
  await assert.rejects(store.remove(plan.id), /terminal/);
  assert.equal(existsSync(join(home, 'Library')), false);
  await assert.rejects(routineCommand(['add', 'unused.json', '--every', '1m', '--yes'], { store }), /usage/);
  await assert.rejects(routineCommand(['remove', plan.id, '--yes'], { store }), /usage/);
});

test('active runs log a skip, stay unpaused, and retry on the next idle interval; busy runs notify', async t => {
  const home = mkdtempSync('/private/tmp/sleight-idle-test-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let idleSeconds = 119, replays = 0, finish;
  const notices = [], script = { sleightReplay: 1, steps: [{ tool: 'js', args: { code: 'let app = await cua.getApp("Calculator");' } }] };
  const store = new RoutineStore({ home, confirm: async () => true, preapproved: () => ({ allows: () => true }),
    launchctl: async () => {}, notify: async value => notices.push(value), idle: async () => idleSeconds,
    host: async () => ({ state: async () => ({ idleSeconds, apps: [{ name: 'Calculator', bundle: 'com.apple.calculator', pid: 123, windows: [{ title: 'Calculator' }] }] }) }),
    replay: async () => { replays++; return new Promise(resolve => { finish = resolve; }); } });
  const plan = await store.add(script, '1m');
  assert.deepEqual(await store.run(plan.id, { scheduled: true }), { ok: false, skipped: 'active' });
  assert.equal(store.list()[0].paused, false); assert.equal(replays, 0);
  assert.equal(JSON.parse(readFileSync(plan.logPath)).result.skipped, 'active');
  idleSeconds = 120; const pending = store.run(plan.id, { scheduled: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.run(plan.id)).busy, true); assert.equal(notices[0].status, 'skipped: busy');
  finish({ ok: true }); await pending; assert.equal(replays, 1);
});

test('an active skip never compiles the observer', async t => {
  const home = mkdtempSync('/private/tmp/sleight-idle-first-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let hosts = 0;
  const script = { sleightReplay: 1, steps: [{ tool: 'js', args: { code: 'let app = await cua.getApp("Calculator");' } }] };
  const store = new RoutineStore({ home, confirm: async () => true, preapproved: () => ({ allows: () => true }),
    launchctl: async () => {}, idle: async () => 0, host: async () => { hosts++; throw new Error('observer must stay uncompiled'); },
    replay: async () => { throw new Error('replay must not start'); } });
  const plan = await store.add(script, '1m');
  assert.deepEqual(await store.run(plan.id, { scheduled: true }), { ok: false, skipped: 'active' });
  assert.equal(hosts, 0);
  assert.equal(store.list()[0].paused, false);
});
