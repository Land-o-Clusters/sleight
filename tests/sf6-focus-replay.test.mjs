import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { gradeControl, parseEvidence, runControl } from '../bench/sf6-focus-probe.mjs';
import * as runtime from '../bench/sf6-focus-runtime.mjs';
const { liveControl, runtimeEnvironment, modelPlan } = runtime;
import { benchmarkDecision } from '../bench/approve.mjs';
import { remoteApprovalOptions } from '../plugins/sleight/lib/launch.mjs';

const journals = JSON.parse(readFileSync(new URL('./fixtures/sf6-focus-journals.json', import.meta.url)));
const html = readFileSync(new URL('./fixtures/sf6-focus-probe.html', import.meta.url), 'utf8');

// Firefox's recorded background shape: focus() updates activeElement without dispatching focusin.
// This VM runs only the fixture script, with a manual clock and no browser, engine or native input.
function page({ focusEvents = false } = {}) {
  const listeners = new Map(), timers = [], document = { activeElement: null };
  const elements = Object.fromEntries(['memo', 'reference', 'evidence', 'move'].map(id => [id, {
    id, value: id === 'reference' ? 'reference stays' : '', textContent: '',
    replaceChildren(...children) { this.textContent = children.map(child => child.textContent).join('\n'); },
    focus() { document.activeElement = this; if (focusEvents) dispatch('focusin', this); },
    addEventListener(type, fn) { listeners.set(`${id}:${type}`, fn); },
  }]));
  function dispatch(type, target) { for (const fn of listeners.get(type) ?? []) fn({ type, target }); }
  document.getElementById = id => elements[id];
  document.createElement = () => ({ textContent: '' });
  document.addEventListener = (type, fn, capture) => {
    assert.equal(capture, true, 'focus and blur must be captured on document');
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  };
  const window = {};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document, window, crypto: { randomUUID },
    setInterval: (fn, ms) => timers.push({ fn, ms }) });
  const snapshot = () => JSON.parse(JSON.stringify(window.sf6Probe.snapshot()));
  return { snapshot, evidenceText: () => elements.evidence.textContent,
    published: () => parseEvidence(elements.evidence.textContent),
    silentFocus: field => { document.activeElement = elements[field] ?? { id: '' }; },
    notify: type => dispatch(type, document.activeElement),
    tick: () => { for (const timer of timers) { assert.equal(timer.ms, 100); timer.fn(); } },
    move: () => listeners.get('move:click')(),
    input: field => {
      elements[field].focus(); dispatch('keydown', elements[field]); dispatch('beforeinput', elements[field]);
      elements[field].value = 'cobalt heron 47'; dispatch('input', elements[field]);
    } };
}

test('recovery evidence survives a 512-character cap per AX static text block', () => {
  const p = page(); p.move(); p.input('memo');
  const expected = p.snapshot();
  assert.ok(JSON.stringify(expected, null, 2).length > 512);
  const blocks = p.evidenceText().split('\n');
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every(block => block.length < 512));
  const ax = blocks.map((block, i) => `\t${38 + i} text ${block.slice(0, 512)}`).join('\n');
  assert.deepEqual(parseEvidence(ax), expected);
  const before = p.evidenceText(); p.tick();
  assert.equal(p.evidenceText(), before, 'unchanged samples keep the published revision');
  assert.deepEqual(runtime.parseDriverEvidence(axEvidence(expected).replace(
    `38 text ${JSON.stringify(expected)}`, ax)), { ...expected, axFocus: { element: 11, field: 'memo' } });
});

test('chunked evidence refuses missing, duplicate, reordered, mixed and corrupted blocks', () => {
  const p = page(); p.move(); p.input('memo');
  const blocks = p.evidenceText().split('\n');
  const other = page().evidenceText().split('\n');
  for (const bad of [blocks.slice(1), blocks.slice(0, -1), [...blocks, blocks[0]], [...blocks].reverse(),
    [blocks[0], ...blocks.slice(1).map(block => block.replace(/^(SF6\/1:[^:]+):\d+:/, '$1:999:'))],
    [...blocks.slice(0, -1), other.at(-1)], blocks.map(block => block.slice(0, -1)),
    [blocks[0] + 'broken', ...blocks.slice(1)], [...blocks, 'SF6/1:malformed']])
    assert.throws(() => parseEvidence(bad.join('\n')), /fixture evidence chunks/i);
  assert.throws(() => parseEvidence(p.evidenceText() + '\n' + JSON.stringify(page().snapshot())), /ambiguous/i);
});

test('a silent focus move is published on the next 100 ms sample without an input event', () => {
  const p = page();
  p.silentFocus('reference');
  p.tick();
  assert.equal(p.published().focus, 'reference');
  assert.deepEqual(p.published().events, [
    { index: 0, phase: 'before-refusal', type: 'focus-observed', field: 'memo' },
    { index: 1, phase: 'before-refusal', type: 'focus-observed', field: 'reference' },
  ]);
  p.tick();
  assert.equal(p.published().events.length, 2);
});

for (const type of ['focus', 'blur']) test(`${type} capture republishes every activeElement change`, () => {
  const p = page();
  for (const field of ['reference', '', 'memo']) { p.silentFocus(field); p.notify(type); }
  const evidence = p.published();
  assert.deepEqual(evidence.events.map(e => [e.index, e.type, e.field]), [
    [0, 'focus-observed', 'memo'], [1, 'focus-observed', 'reference'],
    [2, 'focus-observed', ''], [3, 'focus-observed', 'memo'],
  ]);
  assert.deepEqual(parseEvidence(JSON.stringify(evidence)), evidence);
});

function axEvidence(snapshot, field = snapshot.focus) {
  const body = name => `text field (settable) ${name === 'memo' ? 'Memo' : 'Reference'}`;
  return `Window: "SF6R focus probe", App: Firefox.\n10 HTML Content URL: 127.0.0.1/owned/\n\t11 ${body('memo')}\n\t12 ${body('reference')}\n` +
    `\t38 text ${JSON.stringify(snapshot)}\nThe focused UI element is ${field === 'memo' ? 11 : 12} ${body(field)}`;
}

test('an immediate AX read catches silent focus before any event or timer can republish', () => {
  const p = page();
  p.silentFocus('reference');
  const stale = p.published();
  assert.equal(stale.focus, 'memo');
  assert.throws(() => runtime.parseDriverEvidence(axEvidence(stale, 'reference')), /AX.*focus.*disagree/i);
  p.tick();
  assert.equal(runtime.parseDriverEvidence(axEvidence(p.published(), 'reference')).axFocus.field, 'reference');
});

test('AX focus must be unique, identify a fixture field and match its tree row', () => {
  const p = page(), text = axEvidence(p.published());
  assert.equal(runtime.parseDriverEvidence(text).axFocus.element, 11);
  for (const altered of [text.replace(/\nThe focused UI element.*/, ''),
    text + '\nThe focused UI element is 12 text field (settable) Reference',
    text.replace('The focused UI element is 11 text field (settable) Memo', 'The focused UI element is 1 container SF6R focus probe'),
    text.replace('11 text field (settable) Memo\n', '11 text field (settable) Reference\n')])
    assert.throws(() => runtime.parseDriverEvidence(altered), /AX.*focus/i);
});

test('the parser rejects two otherwise identical snapshots from different documents', () => {
  const first = page().published(), second = { ...first, documentId: randomUUID() };
  assert.throws(() => parseEvidence(JSON.stringify(first) + '\n' + JSON.stringify(second)), /ambiguous/i);
});

test('a silent round trip between samples leaves no evidence of the intermediate focus', () => {
  const p = page(), before = p.published();
  p.silentFocus('reference'); p.silentFocus('memo'); p.tick();
  assert.deepEqual(p.published(), before);
});

test('background fixture records activeElement observations without inventing focusin events', () => {
  const p = page(), before = p.snapshot();
  assert.deepEqual(before.events, [{ index: 0, phase: 'before-refusal', type: 'focus-observed', field: 'memo' }]);
  assert.match(before.documentId, /^[a-f0-9-]{36}$/);
  p.move();
  const boundary = p.published();
  assert.equal(boundary.focus, 'reference'); assert.equal(boundary.phase, 'after-refusal');
  assert.deepEqual(boundary.events, [...before.events, { index: 1, phase: 'after-refusal', type: 'focus-observed', field: 'reference' }]);
  assert.deepEqual(p.snapshot(), boundary); assert.deepEqual(p.snapshot(), boundary);
  assert.equal(boundary.documentId, before.documentId);
  p.input('memo');
  const final = p.published();
  assert.equal(final.events[2].type, 'focus-observed'); assert.equal(final.events[2].field, 'memo');
  assert.deepEqual(final.events.slice(3).map(e => e.type), ['keydown', 'beforeinput', 'input']);
  assert.deepEqual(parseEvidence('38 text ' + JSON.stringify(final)), final);
});

test('foreground focus notifications do not duplicate activeElement transitions', () => {
  const p = page({ focusEvents: true }); p.move(); p.input('memo');
  assert.deepEqual(p.snapshot().events.filter(e => e.type === 'focus-observed').map(e => e.field), ['memo', 'reference', 'memo']);
});

test('recorded moved journal stays inconclusive and never continues with empty history', async () => {
  const recorded = journals.moved;
  assert.deepEqual(recorded.snapshots.map(e => e.snapshot.events), [[], [], []]);
  const calls = [], snapshots = recorded.snapshots.map(e => e.snapshot);
  const row = await runControl('moved', { snapshot: async () => snapshots.shift(),
    turn: async text => { calls.push(text); return { stopped: true }; },
    refusal: async () => recorded.refusal, move: async () => calls.push('move'),
    cleanup: async () => recorded.cleanup, finish: async () => ({}) });
  assert.equal(row.status, 'inconclusive'); assert.ok(!calls.includes('Continue the original memo task.'));
  const [initial, afterRefusal, boundary] = recorded.snapshots.map(e => e.snapshot);
  const graded = gradeControl({ control: 'moved', ...recorded, initial, afterRefusal, boundary });
  assert.equal(graded.checks.focusBoundary.status, 'inconclusive');
  assert.equal(graded.checks.evidence.status, 'inconclusive');
  assert.equal(recorded.refusal.order < recorded.stopped.order && recorded.stopped.order < recorded.boundaryOrder, true);
});

test('recorded multiline AX reads already contain empty event arrays before parsing', () => {
  for (const [i, read] of journals.moved.axReads.entries()) {
    assert.equal(read.code, 'await sf6Driver.getAXState({disableDiffing:true});');
    const text = read.result.content[0].text;
    const raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    assert.deepEqual(raw, journals.moved.snapshots[i].snapshot);
    assert.throws(() => parseEvidence(text), /snapshot unavailable/i, 'legacy empty history cannot satisfy the repaired schema');
  }
});

for (const control of ['moved', 'unchanged']) test(`${control}: repaired recorder crosses the journal-shaped stop boundary`, async () => {
  const p = page(); let turns = 0;
  const row = await runControl(control, { snapshot: async () => p.snapshot(),
    turn: async () => { turns++; p.input('memo'); return { stopped: true }; },
    refusal: async () => ({ ...journals.moved.refusal, stopped: true }), move: async () => p.move(),
    cleanup: async () => journals.moved.cleanup, finish: async () => ({}) });
  assert.equal(turns, 1); assert.equal(row.checks.focusBoundary.status, 'pass');
  assert.equal(row.checks.evidence.status, 'pass'); assert.equal(row.checks.inputTargets.status, 'pass');
  assert.equal(row.status, 'inconclusive', 'a recorder replay provides no model trace or provenance');
  for (const [check, mutate] of [['evidence', r => r.final.documentId = randomUUID()], ['evidence', r => r.final.events = []],
    ['focusBoundary', r => r.boundary.events.pop()], ['evidence', r => delete r.final.documentId],
    ['focusBoundary', r => r.boundaryOrder = r.stopped.order]]) {
    const broken = structuredClone(row); mutate(broken);
    assert.equal(gradeControl(broken).checks[check].status, 'inconclusive');
  }
});

test('both benchmark clients use allowlisted session approvals independent of idle presence', () => {
  const env = runtimeEnvironment('/tmp/lane-claude-fixture', '/tmp/sf6-trace', { SLEIGHT_REMOTE_APPROVALS: '1' });
  assert.equal(env.SLEIGHT_REMOTE_APPROVALS, '0');
  let reads = 0;
  const options = remoteApprovalOptions(env, () => { reads++; return { idleSeconds: 999, locked: true }; });
  assert.equal(options.remoteApprovals, undefined); assert.equal(reads, 0);
  const card = { mcp_server_name: 'plugin:sleight:computer', message: 'Allow Computer Use to use "Firefox"?',
    requested_schema: { type: 'object', properties: {} } };
  assert.deepEqual(benchmarkDecision(card, env).hookSpecificOutput, { hookEventName: 'Elicitation', action: 'accept', content: {} });
  for (const changed of [{ message: 'Allow Computer Use to use "Terminal"?' }, { mcp_server_name: 'other' },
    { requested_schema: { required: ['remember'], properties: { remember: { enum: ['Always'] } } } },
    { message: 'Allow Computer Use to use "Owner Firefox"?' }])
    assert.equal(benchmarkDecision({ ...card, ...changed }, env).hookSpecificOutput.action, 'decline');
  const plan = modelPlan({ command: 'fake', cwd: '/tmp/fake', config: '/tmp/lane-claude-fixture', dir: '/tmp/fake', url: 'http://127.0.0.1:1234/owned/' });
  assert.equal(plan.env.SLEIGHT_REMOTE_APPROVALS, '0');
});

test('recorded unchanged refusal preserves engine text and never reads or starts a model', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'sf6-refusal-replay-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const calls = [];
  const row = await liveControl('unchanged', { dir: join(bank, 'control'), config: '/tmp/lane-claude-fake', command: 'fake',
    signal: new AbortController().signal, gate: async () => {} }, {
    engineRead: () => ({ version: 'recorded-engine', at: new Date().toISOString() }),
    launchBrowser: async plan => ({ ...plan, pid: 123, stop: async () => ({ browserClosed: true, profileDeleted: true }) }),
    connect: async options => {
      assert.equal(options.env.SLEIGHT_REMOTE_APPROVALS, '0');
      assert.equal(options.approve({ message: 'Allow Computer Use to use "Firefox"?', requestedSchema: { properties: {} } }).action, 'accept');
      return { call: async (_name, args) => { calls.push(args.code); return journals.unchanged.acquire.result; },
        close: async () => true, cleanupReceipt: () => ({ groupCollected: true }) };
    },
    startSession: () => { throw Error('model must not start'); }, inspectWindows: async () => [],
  });
  assert.deepEqual(calls, ['var app = await cua.getApp("org.mozilla.firefox");']);
  assert.equal(row.status, 'inconclusive');
  assert.match(row.error, /Driver app acquisition refused.*Approval requires physical input/);
  assert.ok(Object.values(row.cleanup).every(value => value === true));
});

for (const [error, reads, readError = false] of [
  ['getAXState failed on first read', 1],
  ['App acquisition denied', 0],
  ['Approval requires physical input. The card remains open.', 0],
  ['getAXState failed on first read', 1, true],
]) test(`driver acquisition compatibility: ${error}; full read error=${readError}`, async t => {
  const bank = mkdtempSync(join(tmpdir(), 'sf6-acquire-replay-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  let ownedURL, readCount = 0;
  const snapshot = page().published();
  const row = await liveControl('unchanged', { dir: join(bank, 'control'), config: process.env.CLAUDE_CONFIG_DIR,
    command: 'fake', signal: new AbortController().signal, gate: async () => {} }, {
    engineRead: () => ({ version: 'recorded-engine', at: new Date().toISOString() }),
    launchBrowser: async (plan, options) => {
      ownedURL = options.initialPage.url;
      return { ...plan, pid: 123, stop: async () => ({ browserClosed: true, profileDeleted: true }) };
    },
    connect: async () => ({ call: async (_name, args) => {
      if (args.code === 'var app = await cua.getApp("org.mozilla.firefox");')
        return { isError: true, content: [{ type: 'text', text: error }] };
      if (args.code.includes('.typeText(')) throw Error('offline test stops after initial evidence');
      assert.equal(args.code, 'await app.getAXState({disableDiffing:true});'); readCount++;
      if (readError) return { isError: true, content: [{ type: 'text', text: 'getAXState failed again' }] };
      return { content: [{ type: 'text', text: axEvidence(snapshot).replace('127.0.0.1/owned/', ownedURL) }] };
    }, close: async () => true, cleanupReceipt: () => ({ groupCollected: true }) }),
    startSession: () => ({ events: [], turn: async () => { throw Error('offline test stops after initial evidence'); },
      close: async () => ({ code: 0, groupClean: true }) }), inspectWindows: async () => [],
  });
  assert.equal(readCount, reads === 1 && !readError ? 2 : reads);
  assert.equal(!!row.initial, reads === 1 && !readError);
  assert.equal(row.status, 'inconclusive');
  assert.ok(Object.values(row.cleanup).every(value => value === true));
});
