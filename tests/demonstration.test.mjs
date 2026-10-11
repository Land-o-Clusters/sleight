import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DemoRecording, recordWatch, watchOptions, collectCompiler, createDemoHelper, sessionIdleSeconds, observerCacheKey } from '../plugins/sleight/lib/demonstration.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { routineApps } from '../plugins/sleight/lib/routines.mjs';

const seven = { id: 'Seven', idCount: 1, role: 'AXButton' };
const text = { label: 'Text', labelCount: 1, role: 'AXTextArea', editable: true };

test('a requested non-listed bundle records editable native areas and fields from empty baselines', () => {
  for (const role of ['AXTextArea', 'AXTextField']) {
    const recording = new DemoRecording('org.example.editor');
    assert.equal(watchOptions(['--watch', 'org.example.editor', 'task.json']).app, 'org.example.editor');
    const element = { ...text, role };
    recording.observe({ kind: 'baseline', element, empty: true });
    recording.observe({ kind: 'value', element, value: 'fixture' });
    assert.deepEqual(routineApps(recording.script()), ['org.example.editor']);
    assert.match(recording.script().steps[1].args.code, /setValue/);
    for (const bad of [{ ...element, editable: false }, { ...element, role: 'AXWebArea' }]) {
      const other = new DemoRecording('org.example.editor');
      assert.throws(() => other.observe({ kind: 'baseline', element: bad, empty: true }));
    }
    const nonempty = new DemoRecording('org.example.editor');
    assert.throws(() => nonempty.observe({ kind: 'baseline', element, empty: false }));
  }
});
test('compiler cancellation waits for close before cache cleanup, escalating only its owned group', async () => {
  const child = new EventEmitter(), signals = new EventEmitter(), sent = [];
  child.pid = 123; child.stderr = new PassThrough();
  let collected = false, rejectSignal;
  const killed = new Promise(resolve => { rejectSignal = resolve; });
  const pending = collectCompiler(child, { signals, graceMs: 1, collect: async () => {}, signalGroup: name => {
    sent.push(name); if (name === 'SIGKILL') rejectSignal();
  } }).finally(() => { collected = true; });
  const rejected = assert.rejects(pending, /interrupted/);
  signals.emit('SIGINT');
  await killed;
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
  assert.equal(collected, false, 'caller must not remove the cache while compiler pipes remain open');
  child.emit('close', null);
  await rejected;
  assert.equal(collected, true);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('Calculator clicks and menu selections produce the ordinary portable replay format', () => {
  const recording = new DemoRecording('com.apple.calculator');
  recording.observe({ kind: 'ready', title: 'Calculator' });
  recording.observe({ kind: 'focus', element: seven });
  recording.observe({ kind: 'click', element: seven });
  recording.observe({ kind: 'menu', element: { label: 'Basic', labelCount: 1, role: 'AXMenuItem' } });
  const script = recording.script();
  assert.deepEqual(routineApps(script), ['com.apple.calculator']);
  assert.equal(script.steps.length, 3);
  assert.match(script.steps[1].args.code, /click\(\{"id":"Seven"\}\)/);
  assert.deepEqual(script.window, { title: 'Calculator' });
  assert.equal(JSON.stringify(script).includes('coordinates'), false);
});

test('TextEdit value notifications coalesce while focus alone never invents input', () => {
  const recording = new DemoRecording('com.apple.TextEdit');
  recording.observe({ kind: 'focus', element: text });
  recording.observe({ kind: 'baseline', element: text, empty: true });
  recording.observe({ kind: 'value', element: text, value: 'a' });
  recording.observe({ kind: 'value', element: text, value: 'a);b' });
  const script = recording.script();
  assert.equal(script.steps.length, 2);
  assert.match(script.steps[1].args.code, /setValue\(\{"label":"Text"\},"a\);b"\)/);
  assert.deepEqual(routineApps(script), ['com.apple.TextEdit']);
});

test('secure, ambiguous, drag, web, window-switch and unsupported input observations stop without output', () => {
  const events = [
    { kind: 'value', element: { ...text, secure: true }, value: 'secret' },
    { kind: 'click', element: { ...seven, idCount: 2 } },
    { kind: 'drag' }, { kind: 'unsupported', reason: 'keyboard shortcut' }, { kind: 'window-changed' },
    { kind: 'value', element: { ...text, role: 'AXWebArea' }, value: 'web' },
  ];
  for (const event of events) {
    const recording = new DemoRecording('com.apple.TextEdit');
    assert.throws(() => recording.observe(event));
    assert.throws(() => recording.script(), /stopped/);
  }
  assert.throws(() => new DemoRecording('Terminal'));
  assert.throws(() => new DemoRecording('com.apple.calculator').script(), /no actions/);
});

test('watch checks trust before starting observation and never replaces a file', async t => {
  const home = mkdtempSync('/private/tmp/sleight-demo-test-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const output = join(home, 'task.json');
  let observed = 0;
  const denied = { check: async () => ({ trusted: false }), observe: async () => { observed++; } };
  await assert.rejects(recordWatch({ app: 'com.apple.calculator', output, input: { isTTY: true }, notify: async () => {}, helper: denied }), /Accessibility/);
  assert.equal(observed, 0);
  assert.equal(existsSync(output), false);
  const helper = { check: async () => ({ trusted: true, listening: true }), observe: async emit => { observed++; emit({ kind: 'click', element: seven }); } };
  await recordWatch({ app: 'com.apple.calculator', output, input: { isTTY: true }, notify: async () => {}, helper });
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).sleightReplay, 1);
  await assert.rejects(recordWatch({ app: 'com.apple.calculator', output, input: { isTTY: true }, notify: async () => {}, helper }), /exists/);
  assert.equal(observed, 1);
});

test('watch refuses missing listen permission and incomplete event streams without saving', async t => {
  const home = mkdtempSync('/private/tmp/sleight-demo-test-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const output = join(home, 'task.json');
  await assert.rejects(recordWatch({ app: 'com.apple.calculator', output, input: { isTTY: true }, notify: async () => {}, helper: { check: async () => ({ trusted: true, listening: false }) } }), /Input Monitoring/);
  await assert.rejects(recordWatch({ app: 'com.apple.calculator', output, input: { isTTY: true }, notify: async () => {}, helper: {
    check: async () => ({ trusted: true, listening: true }), observe: async emit => { emit({ kind: 'click', element: seven }); throw new Error('observer disconnected'); },
  } }), /disconnected/);
  assert.equal(existsSync(output), false);
  assert.deepEqual(watchOptions(['--watch', 'com.apple.TextEdit', output, '--seconds', '2']), { app: 'com.apple.TextEdit', output, seconds: 2 });
  assert.throws(() => watchOptions(['--watch', 'com.apple.TextEdit']), /out.json/);
  assert.throws(() => watchOptions(['--watch', 'com.apple.calculator', '--seconds', '2']), /out.json/);
  for (const args of [['--watch','com.apple.calculator',output,'--yes'], ['--watch','com.apple.calculator',output,'--seconds','0']]) assert.throws(() => watchOptions(args));
});

test('menu opening records a step and AX/mouse duplicates reconcile in either callback order', () => {
  for (const order of [['menu', 'click'], ['click', 'menu']]) {
    const recording = new DemoRecording('com.apple.calculator');
    recording.observe({ kind: 'click', element: { label: 'View', labelCount: 1, role: 'AXMenuBarItem' }, interaction: 'mouse-1' });
    for (const kind of order) recording.observe({ kind, element: { label: 'Basic', labelCount: 1, role: 'AXMenuItem' }, interaction: 'mouse-2' });
    // A second real click on the same item is a new interaction, not a duplicate.
    recording.observe({ kind: 'click', element: { label: 'Basic', labelCount: 1, role: 'AXMenuItem' }, interaction: 'mouse-3' });
    assert.equal(recording.script().steps.length, 4);
  }
});

test('HID idle time is nanoseconds from ioreg, and the observer compiles once per source hash', async t => {
  assert.equal(await sessionIdleSeconds({ execFile: async () => ({ stdout: '| | |   "HIDIdleTime" = 10865666\n' }) }), 10865666 / 1e9);
  const home = mkdtempSync('/private/tmp/sleight-observer-cache-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, 'demonstration.swift');
  writeFileSync(source, 'source-a');
  let compiles = 0;
  const compile = async ({ binary }) => { compiles++; writeFileSync(binary, 'observer'); };
  const first = await createDemoHelper({ cacheRoot: join(home, 'cache'), source, compile });
  const second = await createDemoHelper({ cacheRoot: join(home, 'cache'), source, compile });
  assert.equal(compiles, 1);
  assert.equal(existsSync(join(home, 'cache', observerCacheKey(readFileSync(source)), 'observer')), true);
  await first.close(); await second.close();
  assert.equal(existsSync(join(home, 'cache', observerCacheKey(readFileSync(source)), 'observer')), true);
  writeFileSync(source, 'source-b');
  await createDemoHelper({ cacheRoot: join(home, 'cache'), source, compile });
  assert.equal(compiles, 2);
});
