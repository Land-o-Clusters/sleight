import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DesktopDriver } from '../bench/world/arms/cursor-cu/desktop.mjs';
import { CursorUI, RUN_SELECTION } from '../bench/world/arms/cursor-cu/ui.mjs';
import { armPaths, composerPlan, CURSOR_PIN } from '../bench/world/arms/cursor-cu/contract.mjs';
import { runDesktop } from '../bench/world/arms/cursor-cu/run.mjs';
import { scrubCursor } from '../bench/world/arms/cursor-cu/scrub.mjs';
import { loginReadiness } from '../bench/world/arms/cursor-cu/setup.mjs';
import { isComputerUseTool } from '../bench/world/arms/cursor-cu/state.mjs';
import { answerCards } from '../bench/world/arms/cursor-cu/host.mjs';
import { recover } from '../bench/world/arms/cursor-cu/recover.mjs';

const previous = { model: 'Other model', effort: 'Medium', speed: 'Normal', attachment: 'None', target: 'Cloud' };
const owner = { pid: 42, bundleId: CURSOR_PIN.bundleId, executable: '/Applications/Cursor.app/Contents/MacOS/Cursor', launchAt: 1000 };
function fixture(t, { priorAX = false, occupied = false } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'cu2r-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = armPaths({ home: dir }), plan = composerPlan({ paths, prompt: 'Edit.', ownerSaysCursorFree: true });
  let selection = structuredClone(previous), enabled = priorAX, snapshot = { composers: [], bubbles: {} };
  const actions = [], ui = {
    window: 7, composerId: 'owner-chat', bind: async () => {}, bindCurrentChat: async () => {},
    readiness: async () => ({ loggedIn: true, busy: false }),
    accessibilityState: async () => enabled,
    setAccessibility: async value => { enabled = value; actions.push(['accessibility', value]); },
    selection: async () => structuredClone(selection),
    select: async value => { selection = structuredClone(value); actions.push(['selection', value]); },
    newChat: async () => {
      snapshot = { composers: [{ composerId: 'run-chat', status: 'completed', generatingBubbleIds: [], fullConversationHeadersOnly: occupied ? [{ bubbleId: 'human' }] : [] }],
        bubbles: { 'run-chat': occupied ? [{ bubbleId: 'human', type: 1, text: 'Owner text' }] : [] } };
    },
    bindChat: async id => { ui.composerId = id; }, fill: async () => actions.push('fill'),
  };
  const d = new DesktopDriver({ ui, inspect: () => CURSOR_PIN, readiness: async () => ({ authStored: true }),
    processes: async () => [owner], readState: async () => snapshot, exists: () => false });
  d.guard = async () => {};
  return { dir, paths, plan, d, ui, actions, selection: () => selection, enabled: () => enabled };
}

test('selection changes have a private durable journal and a leftover refuses the next start', async t => {
  const f = fixture(t); await f.d.open(f.plan, { calibration: true });
  await f.d.setup(f.plan);
  const journals = readdirSync(f.paths.root).filter(p => p.endsWith('.json'));
  assert.equal(journals.length, 1);
  const file = join(f.paths.root, journals[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file)).selection, previous);
  const next = new DesktopDriver({ processes: () => assert.fail('leftover must refuse before host access') });
  await assert.rejects(next.open(f.plan, { calibration: true }), /journal.*recover/i);
  assert.equal(await f.d.close(), true);
  assert.deepEqual(f.selection(), previous); assert.equal(f.enabled(), false); assert.equal(existsSync(file), false);
});

for (const priorAX of [false, true]) test(`accessibility restores prior ${priorAX} after an open failure`, async t => {
  const f = fixture(t, { priorAX }); f.ui.selection = async () => { throw Error('selection unavailable'); };
  await assert.rejects(f.d.open(f.plan, { calibration: true }), /selection unavailable/);
  assert.equal(await f.d.close(), true); assert.equal(f.enabled(), priorAX);
  assert.deepEqual(f.actions.filter(a => a[0] === 'accessibility').at(-1), ['accessibility', priorAX]);
});

test('a new composer with an existing conversation refuses before fill or selection change', async t => {
  const f = fixture(t, { occupied: true }); await f.d.open(f.plan, { calibration: true });
  await assert.rejects(f.d.setup(f.plan), /empty|conversation/i);
  assert.deepEqual(f.selection(), previous); assert.ok(!f.actions.includes('fill')); assert.equal(await f.d.close(), true);
});

test('slow restore gets a fresh budget per step instead of the run operation deadline', async t => {
  const f = fixture(t); await f.d.open(f.plan, { calibration: true }); await f.d.setup(f.plan);
  f.d.operationTimeoutMs = 5;
  f.ui.select = async value => { await new Promise(r => setTimeout(r, 25)); f.ui.selection = async () => value; };
  assert.equal(await f.d.close(), true);
});

test('selection finishes its menu pick even if the run is aborted just after opening', async () => {
  let current = { ...RUN_SELECTION, model: 'Other model' }, menu = false;
  const controller = new AbortController(), actions = [];
  const ui = new CursorUI(async (_operation, data) => {
    actions.push(data.action);
    if (data.action === 'selection') return current;
    if (data.action === 'choose' && !data.menuOpen) { menu = true; controller.abort(); }
    if (data.action === 'choose' && data.menuOpen) { current = { ...RUN_SELECTION }; menu = false; }
    if (data.action === 'close-menu') menu = false;
    return { ok: true };
  });
  await assert.rejects(ui.select(RUN_SELECTION, { signal: controller.signal }), /abort/i);
  assert.equal(menu, false); assert.deepEqual(current, RUN_SELECTION);
  assert.equal(actions.filter(a => a === 'choose').length, 2);
});

test('a timed out menu pick closes the menu and records the verified selection', async () => {
  let menu = false;
  const ui = new CursorUI(async (_operation, data) => {
    if (data.action === 'selection') return previous;
    if (data.action === 'choose' && !data.menuOpen) { menu = true; return {}; }
    if (data.action === 'choose') throw Error('host timeout');
    if (data.action === 'close-menu') { menu = false; return {}; }
    assert.fail(data.action);
  });
  await assert.rejects(ui.select(RUN_SELECTION, { restore: true }), /timeout/);
  assert.equal(menu, false); assert.deepEqual(ui.lastVerifiedSelection, previous);
});

for (const tool of ['run_terminal_cmd', 'edit_file', 'workspace_search', 'unknown']) test(`run stops on ${tool} before another guard or approval`, async () => {
  let cancelled = 0, guards = 0;
  const snapshot = { composers: [{ composerId: 'chat', status: 'generating', latestChatGenerationUUID: 'turn',
    fullConversationHeadersOnly: [{ bubbleId: 'human' }, { bubbleId: 'tool' }],
    modelConfig: { selectedModels: [{ modelId: 'grok-4.7', parameters: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }] }] } }],
    bubbles: { chat: [{ bubbleId: 'human', type: 1, text: 'Edit.' }, { bubbleId: 'tool', type: 2, timingInfo: { clientStartTime: 1000 }, toolFormerData: { toolCallId: 'unsafe', tool } }] } };
  const result = await runDesktop({ prompt: 'Edit.', ownerSaysCursorFree: true, timeoutMs: 1 }, { now: () => 1000, driver: {
    open: async () => {}, setup: async () => ({ baselineIds: [] }), submit: async (_p, { onSubmit }) => onSubmit(),
    guard: async () => { if (++guards > 1) throw Error('guard ran before safety check'); }, readState: async () => snapshot,
    cancel: async () => { cancelled++; }, close: async () => true,
  } });
  assert.match(result.safetyStop, /non-Computer-Use tool/i); assert.equal(cancelled, 1); assert.equal(guards, 0);
});

test('saved Cursor evidence removes home paths and the owner name from keys and values', () => {
  const name = homedir().split('/').at(-1);
  const text = JSON.stringify(scrubCursor({ plan: { database: `${homedir()}/Library/Application Support/Cursor/state.vscdb` },
    answer: `Hello ${name}; ${['', 'Users', 'OtherOwner', 'work', 'file'].join('/')}`, [name]: name }));
  assert.ok(!text.includes(homedir())); assert.ok(!text.includes(name)); assert.doesNotMatch(text, /\/Users\/OtherOwner/);
  assert.match(text, /~\/Library/);
});

test('Swift approval press pins exact English session title and scopes UI controls to the composer', () => {
  const source = readFileSync(new URL('../bench/world/arms/cursor-cu/macos.swift', import.meta.url), 'utf8');
  assert.match(source, /attr\(node, "AXTitle"\) as\? String == "Allow in this chat"/);
  assert.match(source, /requested\["button"\] as\? String == "Allow in this chat"/);
  assert.doesNotMatch(source, /PerformAction\(buttons\[[01]\]/);
  assert.match(source, /nodes = try subtree\(composer/);
  assert.match(source, /action == "close-menu"/);
  const exact = source.match(/attr\(node, "AXTitle"\) as\? String == "([^"]+)" \{ buttons\.append\(node\) \}/)?.[1];
  assert.equal(exact, 'Allow in this chat');
  for (const titles of [['Always Allow', 'Allow in this chat'], ['Allow in this chat', 'Always Allow'],
    ['Toujours autoriser', 'Autoriser dans cette discussion'], ['in this chat Allow', 'Allow always']]) {
    assert.deepEqual(titles.filter(title => title === exact), titles.includes('Allow in this chat') ? ['Allow in this chat'] : []);
  }
});

test('a child crash after setting leaves the original selection journal and blocks a new process', t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'cu2r-crash-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ['tests/fixtures/cursor-cu-crash.mjs', dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 23, r.stderr);
  const paths = armPaths({ home: dir });
  assert.deepEqual(JSON.parse(readFileSync(join(paths.root, 'owner-selection-journal.json'))).selection, previous);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'simulated-selection.json'))), RUN_SELECTION);
  const next = spawnSync(process.execPath, ['tests/fixtures/cursor-cu-crash.mjs', dir, 'restart'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(next.status, 24, next.stderr);
});

test('explicit recovery verifies recorded selection and accessibility before clearing a leftover', async t => {
  const f = fixture(t); await f.d.open(f.plan, { calibration: true }); await f.d.setup(f.plan);
  const recovery = new DesktopDriver({ ui: f.ui, processes: f.d.processes, readState: f.d.stateReader, exists: () => false });
  assert.equal(await recovery.recover(f.plan, { previousRunStopped: true }), true);
  assert.deepEqual(f.selection(), previous); assert.equal(f.enabled(), false);
  assert.equal(existsSync(join(f.paths.root, 'owner-selection-journal.json')), false);
});

test('owner flag gates even the readonly login metadata path', () => {
  assert.throws(() => loginReadiness({ authPresent: () => assert.fail('auth read without owner flag') }), /owner-says-cursor-free/);
});

test('failed selection restore retains the journal while restoring accessibility and reporting observed state', async t => {
  const f = fixture(t); await f.d.open(f.plan, { calibration: true }); await f.d.setup(f.plan);
  f.ui.select = async () => { throw Error('host timeout'); };
  assert.equal(await f.d.close(), false); assert.equal(f.enabled(), false);
  assert.deepEqual(f.d.restoration.selection, RUN_SELECTION);
  assert.equal(existsSync(join(f.paths.root, 'owner-selection-journal.json')), true);
});

test('recovery refuses missing confirmation and a changed Cursor launch before mutation', async t => {
  const f = fixture(t); await f.d.open(f.plan, { calibration: true }); await f.d.setup(f.plan);
  const actions = f.actions.length;
  const recovery = new DesktopDriver({ ui: f.ui, processes: async () => [{ ...owner, launchAt: 2000 }] });
  await assert.rejects(recovery.recover(f.plan), /previous run stopped/);
  await assert.rejects(recovery.recover(f.plan, { previousRunStopped: true }), /process changed/);
  assert.equal(f.actions.length, actions); assert.equal(existsSync(join(f.paths.root, 'owner-selection-journal.json')), true);
  await f.d.close();
});

test('restore retries one failed pick with a fresh per-step host budget', async () => {
  let current = { ...RUN_SELECTION, model: 'Other model' }, attempts = 0, menusClosed = 0;
  const ui = new CursorUI(async (_operation, data, options) => {
    assert.equal(options.timeoutMs, 60000);
    await new Promise(r => setTimeout(r, 8));
    if (data.action === 'selection') return current;
    if (data.action === 'choose' && data.menuOpen) {
      if (++attempts === 1) throw Error('host timeout');
      current = { ...RUN_SELECTION };
    }
    if (data.action === 'close-menu') menusClosed++;
    return {};
  });
  await ui.select(RUN_SELECTION, { restore: true });
  assert.deepEqual(ui.lastVerifiedSelection, RUN_SELECTION); assert.equal(attempts, 2); assert.equal(menusClosed, 1);
});

test('web accessibility admission supplies account full names for evidence redaction', async () => {
  const ui = new CursorUI(async () => ({ enabled: false, privateNames: ['Example Person'] }));
  assert.equal(await ui.accessibilityState(), false);
  assert.equal(scrubCursor('EXAMPLE Person and person'), '[owner] and [owner]');
});

test('Computer Use tool admission refuses conflicting discriminators and arbitrary nested mentions', () => {
  for (const row of [{ tool: 'computer_use' }, { toolCall: { tool: { case: 'computerUseToolCall' } } },
    { params: { providerIdentifier: 'cursor-computer-use', toolName: 'get_app_state' } }, { toolName: 'mcp__cursor-computer-use__get_app_state' }]) assert.equal(isComputerUseTool(row), true);
  for (const row of [{ tool: 'shell', params: { providerIdentifier: 'cursor-computer-use' } },
    { toolCall: { tool: { case: 'editFileToolCall' } }, tool: 'computer_use' },
    { tool: 'computer_use', params: { providerIdentifier: 'workspace' } },
    { result: { text: 'computer_use' } }, {}]) assert.equal(isComputerUseTool(row), false);
});

test('localized, reordered or Always Allow titles never reach a press even beside a valid session card', async () => {
  const card = { owner, title: 'Allow Cursor to use TextEdit?', name: 'TextEdit', bundleId: 'com.apple.TextEdit', source: 'Computer Use', button: 'Allow in this chat' };
  const requests = [{ bundleId: card.bundleId, name: card.name, toolCallId: 't', generationId: 'g' }];
  let pressed = 0;
  for (const button of ['Always Allow', 'always allow', 'Allow always', 'in this chat Allow', 'Autoriser dans cette discussion', 'Allow in this chat ']) {
    for (const cards of [[card, { ...card, button }], [{ ...card, button }, card]])
      await assert.rejects(answerCards({ allowedApps: [card.bundleId] }, [owner], { read: async () => cards, press: async () => pressed++ }, requests), /approval stop/);
  }
  assert.equal(pressed, 0);
});

test('a refusal before opening a menu sends no Escape into an owner dialog', async () => {
  const actions = [];
  const ui = new CursorUI(async (_operation, data) => {
    actions.push(data.action);
    if (data.action === 'selection') return previous;
    if (data.action === 'choose') throw Object.assign(Error('Cursor UI dialog requires the owner'), { mutationAttempted: false });
    if (data.action === 'close-menu') return {};
    assert.fail(data.action);
  });
  await assert.rejects(ui.select(RUN_SELECTION), /dialog/);
  assert.ok(!actions.includes('close-menu'));
});

test('recovery entry requires both explicit flags before opening a journal or host', async () => {
  for (const args of [[], ['--owner-says-cursor-free'], ['--previous-run-stopped'],
    ['--owner-says-cursor-free', '--owner-says-cursor-free']])
    await assert.rejects(recover(args, { recover: async () => assert.fail('recovery without both flags') }), /requires/);
  const result = await recover(['--previous-run-stopped', '--owner-says-cursor-free'], {
    restoration: { accessibility: false }, recover: async (plan, options) => {
      assert.equal(plan.ownerSaysCursorFree, true); assert.equal(options.previousRunStopped, true); return true;
    },
  });
  assert.deepEqual(result, { clean: true, restoration: { accessibility: false }, liveLock: 'unchanged' });
});
