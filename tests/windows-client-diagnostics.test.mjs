import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createWindowsDriverClient as publicClient } from '../plugins/sleight/lib/windows-driver/client.mjs';
import * as production from '../plugins/sleight/lib/driver-client.mjs';
import { windowsDiagnostics } from '../plugins/sleight/lib/windows-driver/diagnostics.mjs';
import * as collector from '../bench/windows/uc3f-collect.mjs';
import * as exporter from '../bench/windows/uc3f-export.mjs';
import { revision, rowObservations } from './fixtures/vm-row-observations.mjs';

let { projectReply, projectTrial } = collector;
let { exportRawLogs } = exporter;
if (process.env.WH1H_ROW_BROKEN) {
  const isCollector = process.env.WH1H_ROW_BROKEN === 'projection';
  assert.ok(isCollector || process.env.WH1H_ROW_BROKEN === 'export');
  const url = new URL(`../bench/windows/uc3f-${isCollector ? 'collect' : 'export'}.mjs`, import.meta.url);
  const source = readFileSync(url, 'utf8'), edit = isCollector ?
    ['return { ok: !error, ...r, ...windowsDiagnostics(input) };', 'return { ok: !error, ...r };'] :
    ["'counters', 'lifecycleEvents', 'identityChecks'", "'counters'"];
  assert.ok(source.includes(edit[0]));
  const changed = source.replace(...edit).replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`)
    .replace('if (isMain(import.meta.url))', 'if (false)').replaceAll('import.meta.url', JSON.stringify(url.href));
  const module = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
  if (isCollector) ({ projectReply, projectTrial } = module); else ({ exportRawLogs } = module);
}

const url = new URL('../plugins/sleight/lib/driver-client.mjs', import.meta.url);
const source = readFileSync(url, 'utf8');
let createClient = production.createWindowsDriverClient;
if (process.env.WH1H_CLIENT_BROKEN) {
  const edits = {
    drop: ['.map(key => [key, value.error[key]])), diagnostic);', '.map(key => [key, value.error[key]])));'],
    decide: ['const diagnostic = windowsDiagnostics(report);', "if (report?.lifecycleEvents?.capacity !== 64) return stop(g, fault('DRIVER_PROTOCOL', undefined, true));\nconst diagnostic = windowsDiagnostics(report);"],
    turn: ["['lifecycleEvents', 'identityChecks'].includes(key) || ", ''],
    unsanitized: ['const diagnostic = windowsDiagnostics(report);', "const diagnostic = Object.fromEntries(['lifecycleEvents', 'identityChecks'].filter(key => Object.hasOwn(report, key)).map(key => [key, report[key]]));"],
  };
  const edit = edits[process.env.WH1H_CLIENT_BROKEN]; assert.ok(edit && source.includes(edit[0]));
  const changed = source.replace(...edit).replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`);
  ({ createWindowsDriverClient: createClient } = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64')));
}
const event = { epoch: 7, kind: 32769, hwnd: '8', objectId: -4, childId: 0, pid: 123, thread: 456, className: null,
  rootRelation: 'retained-member', focusRelation: 'ancestor-of-focus', focusHwnd: '9', focusPathKnown: true };
const diagnostic = { lifecycleEvents: { rootHwnd: '7', focusHwnd: '9', focusPath: ['7', '8', '9'], capacity: 64,
  total: 1, overflow: false, events: [event] }, identityChecks: { count: 12, totalMs: 10.5, maxMs: 1.5 } };
const refusal = { code: 'IDENTITY_CHANGED', message: 'Changed.', unhealthy: false,
  delivery: 'not-sent', retry: 'safe', reason: 'identity-changed', typed: 0 };
function fixture(t, { ok = false, fields = diagnostic, factory = createClient } = {}) {
  const children = [], requests = [];
  const client = factory({ platform: 'win32', prepare: async () => ({ status: 'ready', build: 'b'.repeat(64), spawn({ nonce }) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const r = JSON.parse(bytes); requests.push(r); done();
      const success = ok || ['turn-start', 'turn-end'].includes(r.method);
      const result = ['turn-start', 'turn-end'].includes(r.method) ? { turn: r.params.turn, active: r.method === 'turn-start' } : { value: 1 };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: r.protocol, nonce, id: r.id, ok: success,
        ...success ? { result: { ...result, ...fields } } : { error: { ...refusal, ...fields } } }) + '\n'));
    } });
    child.signals = []; child.kill = signal => { child.signals.push(signal); queueMicrotask(() => child.emit('close')); };
    children.push(child); return child;
  } }) });
  t.after(() => client.close()); return { client, children, requests };
}
for (const factory of [createClient, publicClient]) test(`topology and check counters survive ${factory === publicClient ? 'public' : 'shared'} success and refusal`, async t => {
  const good = fixture(t, { ok: true, factory });
  assert.deepEqual(await good.client.request('getApp', {}), { value: 1, ...diagnostic });
  const bad = fixture(t, { factory });
  await assert.rejects(bad.client.request('getApp', {}), error => {
    for (const [key, value] of Object.entries({ ...refusal, ...diagnostic })) assert.deepEqual(error[key], value, key);
    assert.deepEqual(projectReply(error, true), { ok: false, unhealthy: false, typed: 0, code: 'IDENTITY_CHANGED',
      reason: 'identity-changed', delivery: 'not-sent', retry: 'safe', ...diagnostic });
    return true;
  });
  assert.deepEqual(bad.children[0].signals, []);
});

test('malformed diagnostic fields are omitted and cannot replace an outcome or retire a child', async t => {
  const variants = [null, 'bad', [], { ...diagnostic.lifecycleEvents, capacity: 65 },
    { ...diagnostic.lifecycleEvents, total: 65 }, { ...diagnostic.lifecycleEvents, focusPath: ['private text'] },
    { ...diagnostic.lifecycleEvents, events: [{ ...event, title: 'private text' }] },
    { ...diagnostic.lifecycleEvents, events: [{ ...event, className: 'bad\nclass' }] }];
  for (const lifecycleEvents of variants) for (const ok of [true, false]) {
    const h = fixture(t, { ok, fields: { lifecycleEvents, identityChecks: { count: -1, totalMs: 'bad', maxMs: null } } });
    if (ok) assert.deepEqual(await h.client.request('getApp', {}), { value: 1 });
    else await assert.rejects(h.client.request('getApp', {}), error => {
      for (const [key, value] of Object.entries(refusal)) assert.equal(error[key], value);
      assert.equal(Object.hasOwn(error, 'lifecycleEvents'), false); assert.equal(Object.hasOwn(error, 'identityChecks'), false); return true;
    });
    assert.deepEqual(h.children[0].signals, []); assert.equal(h.children.length, 1);
  }
});

test('diagnostics cannot hide malformed safety fields and do not change absent-field outcomes', async t => {
  const plain = fixture(t, { fields: {} }); await assert.rejects(plain.client.request('getApp', {}), error => {
    assert.equal(error.code, 'IDENTITY_CHANGED'); assert.equal(Object.hasOwn(error, 'lifecycleEvents'), false); return true;
  });
  const unsafe = fixture(t, { fields: { ...diagnostic, delivery: 'not-sent', retry: 'read-first' } });
  await assert.rejects(unsafe.client.request('getApp', {}), { code: 'DRIVER_PROTOCOL' });
  assert.equal(unsafe.children[0].signals.length, 1);
});

test('optional diagnostics cannot fail strict turn responses', async t => {
  for (const fields of [diagnostic, { lifecycleEvents: 'malformed', identityChecks: null }]) {
    const h = fixture(t, { fields, ok: true });
    await h.client.request('typeText', {}); await h.client.endWindowsTurn();
    assert.deepEqual(h.requests.map(r => r.method), ['turn-start', 'typeText', 'turn-end']);
    assert.deepEqual(h.children[0].signals, []);
  }
});

test('diagnostic projection bounds the ring and accepts native overflow and null classes', () => {
  assert.deepEqual(windowsDiagnostics(diagnostic), diagnostic);
  const full = { ...diagnostic.lifecycleEvents, total: 65, overflow: true, events: Array.from({ length: 64 }, () => event) };
  assert.deepEqual(windowsDiagnostics({ lifecycleEvents: full }), { lifecycleEvents: full });
  for (const changed of [{ events: Array(65).fill(event) }, { focusPath: Array(4097).fill('7') }, { capacity: 128 }])
    assert.deepEqual(windowsDiagnostics({ lifecycleEvents: { ...full, ...changed } }), {});
});

test('a collected row retains diagnostic metadata without changing its exported evidence or grading', async () => {
  const trial = projectTrial({ driver: [{ tickMs: 10, replyTickMs: 12, method: 'typeText', raw: { ok: false, ...refusal, ...diagnostic } }] },
    { rowId: 'person-key-before', caseId: 'notepad', startTickMs: 10, endTickMs: 12 });
  assert.deepEqual(trial.driver[0].lifecycleEvents, diagnostic.lifecycleEvents);
  assert.deepEqual(trial.driver[0].identityChecks, diagnostic.identityChecks);
  const logs = await rowObservations('person-key-before'), before = exportRawLogs([logs], revision);
  for (const fields of [diagnostic, { lifecycleEvents: 'malformed', identityChecks: null }]) {
    const annotated = logs.trim().split('\n').map(line => {
      const record = JSON.parse(line);
      if (record.kind === 'trial') for (const reply of record.driver) Object.assign(reply, fields);
      return JSON.stringify(record);
    }).join('\n') + '\n';
    const after = exportRawLogs([annotated], revision);
    assert.deepEqual(after.bundle, before.bundle); assert.deepEqual(after.diagnostics, before.diagnostics);
  }
  assert.deepEqual(projectReply({ lifecycleEvents: 'malformed', identityChecks: null }), { ok: true });
});
