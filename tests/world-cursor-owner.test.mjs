import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { armPaths, composerPlan, guardLive, CURSOR_PIN } from '../bench/world/arms/cursor-cu/contract.mjs';
import { makeCalibration } from '../bench/world/arms/cursor-cu/selection.mjs';
import { DesktopDriver } from '../bench/world/arms/cursor-cu/desktop.mjs';
import { runDesktop } from '../bench/world/arms/cursor-cu/run.mjs';
import { answerCards } from '../bench/world/arms/cursor-cu/host.mjs';
import { parseOptions, nativePlan, nativeMain } from '../bench/world/arms/cursor-cu/suite.mjs';

const paths = armPaths({ home: '/private/tmp/cu2-owner-fixture' });
const identity = { pid: 42, bundleId: CURSOR_PIN.bundleId, executable: '/Applications/Cursor.app/Contents/MacOS/Cursor', launchAt: 1000 };
const previous = { model: 'Other model', effort: 'Medium', speed: 'Normal', attachment: 'None', target: 'Cloud' };
const desired = { model: 'Grok 4.7 High', effort: 'High', speed: 'Normal', attachment: 'Computer Use', target: 'This Mac' };
const selectedComposer = () => ({ modelConfig: { selectedModels: [{ modelId: 'grok-4.7', parameters: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }] }] }, contextAttachments: [{ type: 'computer-use' }], target: { type: 'local' } });
const plan = () => ({ ...composerPlan({ prompt: 'Edit.', paths }), ownerSaysCursorFree: true });
const fixtureHomes = [];
process.once('exit', () => { for (const home of fixtureHomes) rmSync(home, { recursive: true, force: true }); });
function fixture({ failSelection = false, authenticated = true, rows = [identity] } = {}) {
  const home = mkdtempSync('/private/tmp/cu2-owner-');
  const localPlanPaths = armPaths({ home });
  fixtureHomes.push(home);
  const calls = []; let selection = structuredClone(previous), state = { composers: [], bubbles: {} };
  let accessibility = false;
  const ui = {
    window: 7, composerId: 'original', bindCurrentChat: async () => {},
    accessibilityState: async () => accessibility, setAccessibility: async value => { accessibility = value; },
    bind: async () => calls.push('bind'), bindChat: async id => calls.push(['bind chat', id]), readiness: async () => ({ loggedIn: authenticated, busy: false }),
    selection: async () => structuredClone(selection),
    select: async value => { calls.push(['select', structuredClone(value)]); selection = structuredClone(value); if (failSelection && value.model === desired.model) throw Error('selection failed'); },
    newChat: async () => { calls.push('new chat'); state = { composers: [{ composerId: 'new', fullConversationHeadersOnly: [], generatingBubbleIds: [], ...selectedComposer() }], bubbles: { new: [] } }; },
    fill: async () => calls.push('fill'), submit: async () => calls.push('submit'),
    cancel: async () => { calls.push('cancel'); return true; }, idle: async () => true,
  };
  const d = new DesktopDriver({ inspect: () => ({ ...CURSOR_PIN, signatureVerified: true }), processes: async () => rows,
    readiness: async () => ({ authStored: authenticated }), calibrationReader: () => makeCalibration(selectedComposer(), { settled: true, ownerModelLabel: 'Grok 4.7 High' }), ui, readState: async () => state, exists: () => false });
  const preflight = d.preflight.bind(d);
  d.preflight = (p, opts) => preflight({ ...p, paths: localPlanPaths }, opts);
  return { d, calls, ui, selection: () => selection };
}

test('calibrate CLI dry-run exits zero with no host, write or network permission', () => {
  const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', 'bench/world/arms/cursor-cu/calibrate.mjs', '--dry-run'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.signal, null);
  assert.equal(JSON.parse(r.stdout).paths.app, '/Applications/Cursor.app');
  assert.doesNotMatch(r.stderr, /unsettled top-level await/);
});
test('desktop dependency graph does not import the running calibration entry', () => {
  const source = readFileSync(new URL('../bench/world/arms/cursor-cu/desktop.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\/calibrate\.mjs/);
});
test('owner paths use installed Cursor and its existing profile without a launch plan', () => {
  assert.equal(paths.app, '/Applications/Cursor.app');
  assert.equal(paths.userData, '/private/tmp/cu2-owner-fixture/Library/Application Support/Cursor');
  for (const key of ['home', 'extensions']) assert.equal(paths[key], undefined);
});
test('explicit owner free flag is required before any host read', async () => {
  assert.throws(() => guardLive({ ownerAway: true }, { exists: () => assert.fail('host read') }), /owner-says-cursor-free.*owner/i);
  const f = fixture(); await assert.rejects(f.d.open({ ...plan(), ownerSaysCursorFree: false }), /owner-says-cursor-free/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(nativeMain(['--owner-away', '--tasks', 'textedit-edit'], { preflight: () => assert.fail('host read') }), /owner-says-cursor-free/);
  const p = nativePlan(parseOptions(['--owner-says-cursor-free'])); assert.equal(p.ownerSaysCursorFree, true);
});
test('admission requires the installed running process and an existing login', async () => {
  for (const options of [{ rows: [] }, { rows: [{ ...identity, executable: '/scratch/Cursor.app/Contents/MacOS/Cursor' }] }, { authenticated: false }]) {
    const f = fixture(options); await assert.rejects(f.d.open(plan(), { calibration: true }), /running|installed|login/i);
    assert.ok(!f.calls.includes('new chat'));
  }
});
test('owner selections restore after success and after partial selection failure, without quit or close', async () => {
  for (const failSelection of [false, true]) {
    const f = fixture({ failSelection }); await f.d.open(plan(), { calibration: true });
    f.d.guard = async () => {};
    if (failSelection) await assert.rejects(f.d.setup(plan()), /selection failed/);
    else { await f.d.setup(plan()); assert.deepEqual(f.selection(), desired); }
    assert.equal(await f.d.close(), true); assert.deepEqual(f.selection(), previous);
    assert.ok(f.calls.includes('new chat')); assert.ok(!f.calls.includes('quit'));
  }
});
test('SIGINT during a run cancels only its chat and restores the owner selection', async () => {
  const f = fixture(), ctl = new AbortController(); f.d.guard = async () => {};
  f.ui.submit = async () => { f.calls.push('submit'); ctl.abort(); };
  const result = await runDesktop(plan(), { driver: f.d, signal: ctl.signal });
  assert.equal(result.is_error, true); assert.equal(result.groupClean, true);
  assert.ok(f.calls.includes('cancel')); assert.deepEqual(f.selection(), previous);
});
test('restore failure remains unclean and cannot release a run as clean', async () => {
  const f = fixture(); await f.d.open(plan(), { calibration: true }); f.d.guard = async () => {}; await f.d.setup(plan());
  f.ui.select = async () => { throw Error('restore refused'); };
  assert.equal(await f.d.close(), false);
});
test('whole card snapshot refuses Always Allow and unlisted apps before any press', async () => {
  const safe = { owner: identity, title: 'Allow Cursor to use TextEdit?', name: 'TextEdit', bundleId: 'com.apple.TextEdit', source: 'Computer Use', button: 'Allow in this chat' };
  const requests = [{ bundleId: safe.bundleId, name: safe.name, generationId: 'turn', toolCallId: 'tool' }];
  let presses = 0;
  for (const unsafe of [{ ...safe, button: 'Always Allow' }, { ...safe, bundleId: 'com.apple.Terminal' }]) {
    await assert.rejects(answerCards({ ...plan(), allowedApps: [safe.bundleId] }, [identity], { read: async () => [safe, unsafe], press: async () => presses++ }, requests), /approval stop/);
  }
  assert.equal(presses, 0);
});

test('calibrate live entry without owner flag refuses promptly before host discovery', () => {
  const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', 'bench/world/arms/cursor-cu/calibrate.mjs'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 1, r.stderr); assert.equal(r.signal, null);
  assert.match(r.stderr, /requires --owner-says-cursor-free/);
  assert.doesNotMatch(r.stderr, /unsettled top-level await/);
});

test('selection adapter changes only differing controls and verifies the final selection', async () => {
  const { CursorUI, SELECTION_CONTROLS } = await import('../bench/world/arms/cursor-cu/ui.mjs');
  let selection = structuredClone(previous); const actions = [];
  const ui = new CursorUI(async (op, data) => {
    assert.equal(op, 'ui'); actions.push(data.action);
    if (data.action === 'bind') return { window: 7 };
    assert.equal(data.window, 7); assert.equal(data.owner.pid, identity.pid);
    if (data.action === 'selection') return structuredClone(selection);
    assert.equal(data.action, 'choose');
    if (data.menuOpen) selection[Object.keys(SELECTION_CONTROLS).find(k => SELECTION_CONTROLS[k] === data.control)] = data.value;
    return { ok: true };
  });
  await ui.bind(identity, paths); await ui.select(desired); assert.deepEqual(selection, desired);
  assert.equal(actions.filter(x => x === 'choose').length, 8);
  await ui.select(previous); assert.deepEqual(selection, previous);
  await assert.rejects(ui.select({ ...previous, model: '' }), /selection controls/);
});

test('profile reads select only the run composer and never query owner bubbles', async () => {
  const { readCursorState } = await import('../bench/world/arms/cursor-cu/state.mjs');
  const queries = [];
  const state = readCursorState(paths, { composerId: 'run-chat', exists: () => true, open: (_file, options) => {
    assert.equal(options.readOnly, true);
    return { close() {}, prepare(sql) { return { all(...params) { queries.push([sql, params]);
      return sql.includes('key = ?') ? [{ value: JSON.stringify({ composerId: 'run-chat' }) }] : [];
    } }; } };
  } });
  assert.equal(state.composers[0].composerId, 'run-chat');
  assert.deepEqual(queries[0][1], ['composerData:run-chat']);
  assert.ok(queries[1][0].includes('bubbleId:run-chat:'));
  assert.ok(queries.every(([sql]) => !sql.includes("LIKE 'composerData:%'")));
});

test('selection timeout collects its pending action before restoring, so late work cannot overwrite restoration', async () => {
  const f = fixture(); await f.d.open(plan(), { calibration: true }); f.d.guard = async () => {};
  f.d.operationTimeoutMs = 10;
  let complete;
  const original = f.ui.select;
  f.ui.select = async value => {
    if (value.model === desired.model) await new Promise(resolve => { complete = resolve; });
    return original(value);
  };
  await assert.rejects(f.d.setup(plan()), /run selection timeout/);
  const closing = f.d.close();
  complete(); assert.equal(await closing, true); assert.deepEqual(f.selection(), previous);
});

test('old copy calibration cannot authorize an owner-session run', async () => {
  const { makeCalibration, validateCalibration } = await import('../bench/world/arms/cursor-cu/selection.mjs');
  const c = makeCalibration({ modelConfig: { selectedModels: [{ modelId: 'grok-4.7', parameters: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }] }] },
    contextAttachments: [{ type: 'computer-use' }], target: { type: 'local' } }, { settled: true, ownerModelLabel: 'Grok 4.7 High' });
  assert.equal(c.version, 2); assert.equal(c.session, 'owner-installed');
  const old = { ...c, version: 1 }; delete old.session;
  assert.throws(() => validateCalibration(old), /shape/);
});

test('low-level run also refuses a missing owner flag before an injected driver opens', async () => {
  let opened = 0;
  const result = await runDesktop({ ...plan(), ownerSaysCursorFree: false }, { driver: { open: async () => opened++ } });
  assert.match(result.reason, /owner-says-cursor-free/); assert.equal(opened, 0); assert.equal(result.groupClean, true);
});

test('a new persisted chat without a matching UI binding refuses before selection or prompt input', async () => {
  const f = fixture(); await f.d.open(plan(), { calibration: true });
  f.ui.bindChat = async () => { throw Error('chat UI binding unavailable'); };
  await assert.rejects(f.d.setup(plan()), /chat UI binding/);
  assert.deepEqual(f.selection(), previous); assert.ok(!f.calls.includes('fill'));
  assert.equal(await f.d.close(), true);
});
