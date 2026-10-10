import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, realpathSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intervalSeconds, routineApps, routinePlan, routineBeforeCall, routineCommand, RoutineStore } from '../plugins/sleight/lib/routines.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';

const step = code => ({ tool: 'js', args: { code }, positions: [] });
const task = { sleightReplay: 1, steps: [step('let app = await cua.getApp("com.apple.calculator");'), step('await app.click({"id":"Seven"});')] };
const grants = new PreapprovedApps({ version: 1, apps: [{ app: 'com.apple.calculator', riskLevel: 'medium' }] });
function fixture(t, options = {}) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-routines-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls = [], notices = [];
  const store = new RoutineStore({ home, confirm: async () => true,
    idle: async () => 120,
    host: async () => ({ state: async () => ({ idleSeconds: 120, apps: [{ name: 'Calculator', bundle: 'com.apple.calculator', pid: 123, windows: [{ title: 'Calculator' }] }] }) }),
    launchctl: async args => calls.push(args),
    preapproved: () => grants, replay: async () => ({ ok: true, steps: 2 }), notify: async value => notices.push(value), ...options });
  return { home, store, calls, notices };
}

test('intervals are bounded whole seconds and plans escape XML without writing', t => {
  assert.equal(intervalSeconds('15m'), 900);
  assert.equal(intervalSeconds('2h'), 7200);
  for (const bad of ['0', '59s', '-1h', '1.5m', '32d', '1h;touch x']) assert.throws(() => intervalSeconds(bad));
  const { home, calls } = fixture(t);
  const plan = routinePlan(task, '15m', { home, node: '/a&b/<node>' });
  assert.match(plan.plist, /<integer>900<\/integer>/);
  assert.match(plan.plist, /\/a&amp;b\/&lt;node&gt;/);
  assert.match(plan.plist, /routine-launcher.mjs/);
  assert.doesNotMatch(plan.plist, /RunAtLoad|KeepAlive/);
  assert.equal(existsSync(join(home, 'Library')), false);
  assert.deepEqual(calls, []);
});

test('only literal background calls with acquired handles and named selectors are accepted', () => {
  assert.deepEqual(routineApps(task), ['com.apple.calculator']);
  assert.deepEqual(routineApps({ sleightReplay: 1, steps: [task.steps[0], step('await app.setValue({"label":"Text"},"a);b");')] }), ['com.apple.calculator']);
  const bad = [
    'await app.click([1,2]);', 'await app.click(1);', 'await app.click({"id":"x", "x":1});',
    'await app.activate();', 'await app.drag({"id":"x"});', 'await app.pressKey("META TAB");',
    'await app.paste("x");', 'await app.click({"id":"x"}); process.exit();',
    'await app["click"]({"id":"x"});', 'await app.click({"id":`x`});', 'await other.click({"label":"OK"});',
  ];
  for (const code of bad) assert.throws(() => routineApps({ ...task, steps: [task.steps[0], step(code)] }), undefined, code);
  assert.throws(() => routineApps({ ...task, allowPositions: true }));
  assert.throws(() => routineApps({ ...task, steps: [{ ...task.steps[0], positions: ['screen coordinates'] }] }));
  assert.throws(() => routineApps({ sleightReplay: 1, steps: [step('let app = await cua.getApp("Terminal");')] }));
});

test('declined terminal confirmation makes no changes; confirmation installs and removal preserves logs', async t => {
  const { store, calls } = fixture(t);
  store.confirm = async () => false;
  const preview = await store.add(task, '15m');
  assert.equal(existsSync(preview.directory), false);
  assert.equal(calls.length, 0);
  store.confirm = async () => true;
  const installed = await store.add(task, '15m');
  assert.deepEqual(calls[0], ['bootstrap', `gui/${process.getuid()}`, installed.plistPath]);
  assert.deepEqual(store.list().map(r => r.id), [installed.id]);
  await store.run(installed.id);
  assert.equal(JSON.parse(readFileSync(installed.logPath, 'utf8')).result.ok, true);
  store.confirm = async () => false;
  await store.remove(installed.id);
  assert.equal(existsSync(installed.plistPath), true);
  store.confirm = async () => true;
  await store.remove(installed.id);
  assert.equal(existsSync(installed.directory), false);
  assert.equal(existsSync(installed.logPath), true);
});

test('revoked grants stop before the relay, notify and pause scheduled runs', async t => {
  let relayRuns = 0, approved = true;
  const { store, notices } = fixture(t, { preapproved: () => approved ? grants : new PreapprovedApps({ version: 1, apps: [] }),
    replay: async () => { relayRuns++; return { ok: true }; } });
  const plan = await store.add(task, '1m');
  approved = false;
  const stopped = await store.run(plan.id, { scheduled: true });
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /preapproved/);
  assert.equal(relayRuns, 0);
  assert.equal(notices.length, 1);
  approved = true;
  assert.equal((await store.run(plan.id, { scheduled: true })).paused, true);
  assert.equal(relayRuns, 0);
  assert.equal((await store.run(plan.id)).ok, true);
  assert.equal(relayRuns, 1);
});

test('unknown outcomes never retry and overlapping runs cannot start input', async t => {
  let release, runs = 0;
  const { store, notices } = fixture(t, { replay: () => { runs++; return new Promise(resolve => { release = resolve; }); } });
  const plan = await store.add(task, '1m');
  const pending = store.run(plan.id);
  await new Promise(resolve => setImmediate(resolve));
  const overlap = await store.run(plan.id);
  assert.equal(overlap.busy, true);
  assert.equal(runs, 1);
  release({ ok: false, step: 2, error: 'timeoutReached; input unknown' });
  assert.equal((await pending).ok, false);
  assert.equal(notices.length, 2);
  assert.equal(existsSync(join(plan.directory, 'running')), false);
});

test('unconfirmed relay cleanup preserves the run lock and pauses the routine', async t => {
  const { store } = fixture(t, { replay: async () => { throw Object.assign(new Error('owned group cleanup unconfirmed'), { cleanupUnconfirmed: true }); } });
  const plan = await store.add(task, '1m');
  const result = await store.run(plan.id);
  assert.equal(result.ok, false);
  assert.equal(result.cleanupUnconfirmed, true);
  assert.equal(existsSync(join(plan.directory, 'running')), true);
  assert.equal(store.list()[0].paused, true);
  assert.equal((await store.run(plan.id)).busy, true);
  await assert.rejects(store.remove(plan.id), /running/);
});

test('installation rollback and edited positional scripts fail closed', async t => {
  const { store } = fixture(t, { launchctl: async args => { if (args[0] === 'bootstrap') throw new Error('bootstrap failed'); } });
  const plan = routinePlan(task, '1m', store);
  await assert.rejects(store.add(task, '1m'), /bootstrap failed/);
  assert.equal(existsSync(plan.directory), false);
  assert.equal(existsSync(plan.plistPath), false);
  const safe = fixture(t);
  const installed = await safe.store.add(task, '1m');
  writeFileSync(join(installed.directory, 'script.json'), JSON.stringify({ ...task, steps: [step('await app.click([1,2]);')] }));
  assert.equal((await safe.store.run(installed.id)).ok, false);
  assert.throws(() => safe.store.list('../escape'));
});

test('uncertain launchctl cleanup preserves the exact installed files', async t => {
  const { store } = fixture(t, { launchctl: async () => { throw new Error('transport failed'); } });
  const plan = routinePlan(task, '1m', store);
  await assert.rejects(store.add(task, '1m'), /cleanup unconfirmed/);
  assert.equal(existsSync(plan.directory), true);
  assert.equal(existsSync(plan.plistPath), true);
});

test('dangling symlinks are refused and an invalid log destination releases the run lock', async t => {
  const { store, home } = fixture(t);
  const plan = await store.add(task, '1m');
  symlinkSync(join(home, 'missing-log'), plan.logPath);
  await assert.rejects(store.run(plan.id), /symlink/);
  assert.equal(existsSync(join(plan.directory, 'running')), false);
  assert.equal(lstatSync(plan.logPath).isSymbolicLink(), true);
});

test('damaged scripts remain removable and removal excludes new run-now input', async t => {
  let release, runs = 0;
  const { store } = fixture(t, { launchctl: async args => {
    if (args[0] === 'bootout') await new Promise(resolve => { release = resolve; });
  }, replay: async () => { runs++; return { ok: true }; } });
  const plan = await store.add(task, '1m');
  writeFileSync(join(plan.directory, 'script.json'), '{');
  const removing = store.remove(plan.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.run(plan.id)).busy, true);
  assert.equal(runs, 0);
  release(); await removing;
  assert.equal(existsSync(plan.directory), false);
});

test('unattended input requires a fresh readable window without dialogs or sheets', async () => {
  let reads = 0;
  for (const tree of ['Window: "TextEdit", App: TextEdit.\n0 sheet Save', 'Window: "App", App: App.\n0 dialog Confirm', 'unavailable']) {
    await assert.rejects(routineBeforeCall('js', { code: 'await app.click({"label":"OK"});' }, async () => {
      reads++; return { result: { content: [{ type: 'text', text: tree }] } };
    }), /before input/);
  }
  await routineBeforeCall('js', { code: 'await app.click({"id":"Seven"});' }, async () => ({ result: { content: [{ type: 'text', text: 'Window: "Calculator", App: Calculator.\n0 standard window Calculator' }] } }));
  assert.equal(reads, 3);
});

test('user return during replay skips, notifies once, and leaves the job unpaused', async t => {
  const snapshot = { result: { content: [{ type: 'text', text: 'Window: "Calculator", App: Calculator.\n0 standard window Calculator' }] } };
  let idleSeconds = 120, hosts = 0;
  const { store, notices } = fixture(t, {
    host: async () => {
      hosts++;
      return { state: async () => {
        const current = idleSeconds;
        idleSeconds = 0;
        return { idleSeconds: current, apps: [{ name: 'Calculator', bundle: 'com.apple.calculator', pid: 123, windows: [{ title: 'Calculator' }] }] };
      } };
    },
    replay: async (script, options) => {
      await options.beforeCall('js', { code: 'await app.click({"id":"Seven"});' }, async () => snapshot);
      return { ok: true };
    },
  });
  const plan = await store.add(task, '1m');
  const stopped = await store.run(plan.id, { scheduled: true });
  assert.deepEqual(stopped, { ok: false, skipped: 'active', interrupted: true });
  assert.equal(store.list()[0].paused, false);
  assert.equal(existsSync(join(plan.directory, 'paused.json')), false);
  assert.equal(notices[0].status, 'skipped: active');
  assert.equal(hosts, 1);
  store.host = async () => ({ state: async () => ({ idleSeconds: 120, apps: [{ name: 'Calculator', bundle: 'com.apple.calculator', pid: 123, windows: [{ title: 'Calculator' }] }] }) });
  store.runReplay = async () => ({ ok: true });
  assert.equal((await store.run(plan.id, { scheduled: true })).ok, true);
});

test('unlock asks in the terminal, refuses a live matching owner, and clears leftover receipts', async t => {
  const { store } = fixture(t);
  const plan = await store.add(task, '1m');
  mkdirSync(join(plan.directory, 'running'));
  writeFileSync(join(plan.directory, 'running/owner.json'), JSON.stringify({ pid: 99, startTime: 'old', groups: [], pendingLaunch: true }));
  store.alive = () => false;
  store.started = () => 'new';
  store.confirm = async () => false;
  await store.unlock(plan.id);
  assert.equal(existsSync(join(plan.directory, 'running')), true);
  store.confirm = async () => true;
  await store.unlock(plan.id);
  assert.equal(existsSync(join(plan.directory, 'running')), false);
  mkdirSync(join(plan.directory, 'running'));
  writeFileSync(join(plan.directory, 'running/owner.json'), JSON.stringify({ pid: 99, startTime: 'same', groups: [], pendingLaunch: false }));
  store.alive = pid => pid === 99;
  store.started = pid => pid === 99 ? 'same' : 'other';
  await assert.rejects(store.unlock(plan.id), /running/);
  await assert.rejects(routineCommand(['unlock', plan.id], { store, print: () => {} }), /running/);
  assert.equal(existsSync(join(plan.directory, 'running')), true);
});

test('routine batches flatten so each input gets its own unattended window check', async t => {
  let received;
  const { store } = fixture(t, { replay: async (script, options) => { received = { script, options }; return { ok: true }; } });
  const batch = { ...task, steps: [task.steps[0], step('await app.click({"id":"Seven"}); await app.click({"id":"Eight"});')] };
  const plan = await store.add(batch, '1m');
  await store.run(plan.id);
  assert.equal(received.script.steps.length, 3);
  assert.equal(typeof received.options.beforeCall, 'function');
});
