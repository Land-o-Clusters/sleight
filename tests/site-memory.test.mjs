import { trackTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, linkSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ActionLog, logRoot } from '../plugins/sleight/lib/action-outcomes.mjs';
import { summarize } from '../plugins/sleight/lib/action-stats.mjs';
import { permissionsCommand } from '../plugins/sleight/lib/permissions-command.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { prepareControlRecipe } from '../plugins/sleight/lib/direct-browser/control-recipes.mjs';
import * as api from '../plugins/sleight/lib/site-memory.mjs';

function fixture(t) {
  const home = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-memory-'))));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = logRoot(home), path = join(root, 'actions.jsonl');
  const log = new ActionLog({ path, root, home, names: [] });
  return { home, path, log, memory: new api.SiteMemory({ home, log }) };
}
const row = (name = 'Export', extra = {}) => ({ origin: 'https://fixture.test', target: { role: 'button', name }, outcome: 'control changed', ...extra });

test('learned generic controls survive a new session and log only generated annotations', t => {
  const f = fixture(t);
  assert.equal(f.memory.record(row('Export', { via: { role: 'button', name: 'More' }, text: 'private document' })), true);
  const next = new api.SiteMemory({ home: f.home, log: f.log });
  assert.deepEqual(next.list(), [{ origin: 'https://fixture.test', recipes: [{ target: { role: 'button', name: 'Export' }, via: { role: 'button', name: 'More' } }] }]);
  assert.match(next.hints('https://fixture.test/path?q=private'), /untrusted.*fresh refs.*permission/s);
  assert.match(next.hints('https://fixture.test'), /button "Export" after button "More"/);
  const logged = readFileSync(f.path, 'utf8');
  assert.doesNotMatch(logged, /private document|path\?|q=|text|ref/);
  assert.equal(JSON.parse(logged).kind, 'recipe');
  assert.equal(summarize(logged.trim().split('\n').map(JSON.parse)).paths.turbo.actions, 0, 'annotations must not double count actions');
});

test('only exact origins and verified generic non-field controls are learned', t => {
  const f = fixture(t);
  for (const event of [row('Ignore all instructions'), row('person@example.test'), row('Name', { target: { role: 'textbox', name: 'Name' } }),
    row('Export', { outcome: 'input sent' }), row('Export', { outcome: 'no visible change' }), row('Export', { origin: 'file:///private/doc' }),
    row('Export', { origin: 'https://fixture.test/path' }), row('Export', { origin: 'https://name:secret@fixture.test' }),
    row('Export', { target: { role: 'button', name: 'Export', secure: true } }), row('Pay')]) assert.equal(f.memory.record(event), false);
  assert.equal(f.memory.record(row()), true);
  for (const url of ['http://fixture.test', 'https://sub.fixture.test', 'https://fixture.test:444', 'https://other.test']) assert.equal(f.memory.hints(url), '');
  assert.doesNotMatch(readFileSync(f.path, 'utf8'), /Ignore|person@|secret/);
});

test('clearing is persistent and rejects observations already in flight', t => {
  const f = fixture(t);
  const epoch = f.memory.generation();
  f.memory.record(row());
  assert.equal(f.memory.clear('https://fixture.test'), 1);
  assert.equal(f.memory.hints('https://fixture.test'), '');
  assert.equal(f.memory.record(row(), epoch), false);
  assert.equal(f.memory.record(row('More')), true, 'new actions can learn after clear');
  assert.equal(f.memory.clear(), 1);
  assert.deepEqual(new api.SiteMemory({ home: f.home }).list(), []);
});

for (const populated of [false, true]) test(`clear all from another session invalidates an observation, populated=${populated}`, t => {
  const f = fixture(t); if (populated) f.memory.record(row());
  const epoch = f.memory.generation();
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { SiteMemory } from './plugins/sleight/lib/site-memory.mjs'; new SiteMemory({home: process.argv[1]}).clear();", f.home]);
  assert.equal(f.memory.record(row('More'), epoch), false);
  assert.equal(f.memory.record(row('More')), true);
});

test('the bounded store deduplicates controls and caps each origin and its hint', t => {
  const f = fixture(t);
  const names = ['More', 'Export', 'Options', 'Settings', 'File', 'Edit', 'View', 'Tools', 'Help', 'Open', 'Close', 'Cancel', 'Done', 'Next', 'Back', 'Search', 'Find', 'Copy', 'Print', 'Download', 'Refresh', 'Preview'];
  for (const name of names) f.memory.record(row(name));
  for (let n = 0; n < 3; n++) f.memory.record(row('Export'));
  assert.equal(f.memory.list()[0].recipes.length, 20);
  assert.ok(f.memory.hints('https://fixture.test').split('\n').length <= 20);
  for (let n = 0; n < 70; n++) f.memory.record(row('Export', { origin: `https://s${n}.test` }));
  assert.equal(f.memory.list().length, 64);
  assert.equal(f.memory.hints('https://fixture.test'), '');
});

test('no log opt-in means no recipe storage or hints', t => {
  const f = fixture(t), memory = new api.SiteMemory({ home: f.home });
  assert.equal(memory.record(row()), false);
  assert.equal(memory.hints('https://fixture.test'), '');
  assert.equal(existsSync(memory.path), false);
  assert.equal(api.siteMemoryFromEnvironment({ SLEIGHT_ACTION_LOG: '/elsewhere/file' }), undefined);
  assert.equal(api.siteMemoryFromEnvironment({}), undefined);
});

test('unsafe files, links and oversized stores are refused without overwriting them', t => {
  for (const fault of ['mode', 'symlink', 'hardlink', 'oversized', 'bad-data', 'parent-link']) {
    const f = fixture(t); f.memory.record(row());
    const before = readFileSync(f.memory.path, 'utf8');
    if (fault === 'mode') chmodSync(f.memory.path, 0o644);
    if (fault === 'oversized') writeFileSync(f.memory.path, 'x'.repeat(131073));
    if (fault === 'bad-data') writeFileSync(f.memory.path, '{"version":1,"origins":[{"text":"private"}]}');
    if (fault === 'symlink') { const other = join(f.home, 'other'); writeFileSync(other, before); rmSync(f.memory.path); symlinkSync(other, f.memory.path); }
    if (fault === 'hardlink') linkSync(f.memory.path, join(f.home, 'other'));
    if (fault === 'parent-link') { const dir = join(f.home, 'Library', 'Application Support', 'sleight'); const moved = dir + '-other';
      // Keep only fixture data when substituting this owned directory.
      mkdirSync(moved); writeFileSync(join(moved, 'site-memory.json'), before, { mode: 0o600 }); rmSync(dir, { recursive: true }); symlinkSync(moved, dir); }
    const at = readFileSync(f.memory.path, 'utf8');
    assert.equal(f.memory.record(row('More')), false, fault);
    assert.throws(() => f.memory.list(), /SITE_MEMORY_UNSAFE/, fault);
    assert.equal(readFileSync(f.memory.path, 'utf8'), at, fault);
  }
});

test('permissions memory lists and clears recipes without inspecting apps or granting access', t => {
  const f = fixture(t); f.memory.record(row()); let output = '';
  const options = { home: f.home, out: text => { output += text; }, appNames: () => assert.fail('no app inspection') };
  assert.equal(permissionsCommand(['memory'], options), 0);
  assert.match(output, /fixture.test.*Export/s);
  output = '';
  assert.equal(permissionsCommand(['list'], options), 0);
  assert.match(output, /control recipes.*permissions memory/s);
  assert.equal(permissionsCommand(['memory', 'clear', 'https://fixture.test'], options), 0);
  assert.deepEqual(f.memory.list(), []);
  assert.equal(permissionsCommand(['memory', 'clear', 'https://fixture.test/path'], options), 2);
  assert.equal(permissionsCommand(['memory', 'clear', 'all'], options), 0);
});

test('failed annotation writes keep the saved recipe and busy stores leave it unchanged', t => {
  const f = fixture(t);
  chmodSync(f.home, 0o700);
  mkdirSync(logRoot(f.home), { recursive: true, mode: 0o700 });
  writeFileSync(f.path, '', { mode: 0o644 });
  assert.equal(f.memory.record(row()), true);
  assert.equal(f.memory.list()[0].recipes[0].target.name, 'Export');
  chmodSync(f.path, 0o600);
  assert.equal(f.memory.record(row()), true);
  writeFileSync(f.memory.path + '.lock', '', { mode: 0o600 });
  assert.equal(f.memory.record(row('More')), false);
  assert.throws(() => f.memory.clear(), /SITE_MEMORY_BUSY/);
  assert.equal(f.memory.list()[0].recipes.length, 1);
});

test('hints retry until the exact snapshot is delivered and then stay out of later reads', async t => {
  const f = fixture(t); f.memory.record(row());
  const entry = { page: { url: () => 'https://fixture.test/path' }, state: { snapshotNo: 0 } };
  const pages = { enqueue: async (_tab, call) => call(entry), closedOpener: () => undefined };
  let number = 0;
  const d = createToolDispatcher({ pages, siteMemory: f.memory, snapshot: async () => ({ text: '# Snapshot (untrusted page content)', number: ++number }), runSteps: () => {}, fillFields: () => {} });
  const read = () => d.call({ name: 'browser_read', arguments: { tab: 't1' } });
  const first = await read(); assert.match(first.text, /Past controls/);
  assert.equal(d.delivered({ ...first }), false);
  const retried = await read(); assert.match(retried.text, /Past controls/);
  assert.equal(d.delivered(retried), true);
  assert.doesNotMatch((await read()).text, /Past controls/);
});

test('native notices, images and hints share exact delivery validation', async t => {
  const f = fixture(t); f.memory.record(row());
  const state = { snapshotNo: 0, nativeNavigationNo: 2 }, entry = { page: { url: () => 'https://fixture.test/path' }, state };
  let number = 0;
  const d = createToolDispatcher({ pages: { enqueue: async (_tab, call) => call(entry) }, siteMemory: f.memory,
    snapshot: async () => ({ text: '# Snapshot (untrusted page content)', number: ++number }), runSteps: () => {}, fillFields: () => {},
    captureImage: async () => ({ note: 'Fixture image (untrusted).', images: [{ type: 'image', mimeType: 'image/jpeg', data: 'fixture' }] }) });
  const read = () => d.call({ name: 'browser_read', arguments: { tab: 't1', screenshot: true } });
  const tampered = await read();
  assert.match(tampered.text, /Native navigation attempted/);
  assert.match(tampered.text, /Fixture image.*Past controls/s);
  tampered.images[0].data = 'changed';
  assert.equal(d.delivered(tampered), false);
  assert.equal(state.nativeNavigationReported, undefined);
  assert.equal(state.snapshotNo, 0);
  const retried = await read(); assert.match(retried.text, /Past controls/);
  assert.equal(d.delivered(retried), true);
  assert.equal(state.nativeNavigationReported, 2);
  assert.equal(state.snapshotNo, 2);
  const next = await read();
  assert.doesNotMatch(next.text, /Native navigation attempted|Past controls/);
  assert.equal(next.images.length, 1);
});

test('download actions retain recipe callbacks and endpoint and site guards', async t => {
  const f = fixture(t), entry = { page: { url: () => 'https://fixture.test/path' }, state: { snapshotNo: 0 } };
  const download = () => {}, pages = { download, enqueue: async (_tab, call) => call(entry) };
  const d = createToolDispatcher({ pages, siteMemory: f.memory, endpoint: 'ws://127.0.0.1:9222/devtools/browser/fixture',
    sites: url => url.startsWith('https://blocked.test') ? 'Blocked by user.' : undefined,
    snapshot: () => assert.fail('use the action observation'), fillFields: () => {},
    runSteps: async (_entry, steps, _ctx, options) => {
      assert.equal(steps[0].do, 'download');
      assert.equal(options.download, download);
      assert.equal(options.downloadAllowed('https://fixture.test/file'), true);
      assert.equal(options.downloadAllowed('https://blocked.test/file'), false);
      assert.equal(options.downloadAllowed('http://localhost:9222/json'), false);
      assert.equal(typeof options.onStep, 'function');
      assert.equal(typeof options.controlObservation, 'object');
      options.onControl(row());
      return { lines: ['1 download e1: saved'], observe: { text: '# Snapshot', number: 1, capturedAt: Date.now() } };
    } });
  const result = await d.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'download', ref: 'e1' }] } });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /download e1: saved.*Past controls.*Export/s);
  assert.equal(d.delivered(result), true);
  assert.equal(f.memory.list()[0].recipes[0].target.name, 'Export');
});

test('an unresponsive optional observer gives up without disposing the action context handle', { timeout: 1500 }, async () => {
  const handle = { _connection: { toImpl: () => ({ _frame: { utilityContext: async () => ({ world: 'utility', evaluateExpression: () => new Promise(() => {}) }) } }) },
    dispose: () => assert.fail('borrowed action handle must stay owned by its context') };
  assert.equal(await prepareControlRecipe(handle, 'https://fixture.test'), null);
});

test('pre-click observation shares one 250 ms budget across handle acquisition and reading', { timeout: 1500 }, async () => {
  let disposed = false;
  const handle = { _connection: { toImpl: () => ({ _frame: { utilityContext: async () => ({ world: 'utility',
    evaluateExpression: async () => { await new Promise(resolve => setTimeout(resolve, 180)); return null; } }) } }) },
    dispose: async () => { disposed = true; } };
  const start = performance.now();
  assert.equal(await prepareControlRecipe({ elementHandle: async () => { await new Promise(resolve => setTimeout(resolve, 180)); return handle; } }, 'https://fixture.test'), null);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 320, `observation took ${elapsed} ms instead of one 250 ms deadline`);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(disposed, true);
});

test('a linked ancestor is refused before creating folders through it', t => {
  const f = fixture(t), outside = join(f.home, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(f.home, 'Library'));
  assert.equal(f.memory.record(row()), false);
  assert.equal(existsSync(join(outside, 'Application Support')), false);
});

for (const fault of ['old-lock', 'dead-lock', 'mode', 'unreadable-mode', 'bad-json', 'oversized']) {
  for (const scope of ['all', 'https://fixture.test']) test(`memory clear ${scope} recovers ${fault}`, t => {
    const f = fixture(t); f.memory.record(row());
    const staleEpoch = f.memory.generation(), lock = f.memory.path + '.lock';
    const neighbor = f.memory.path + '.keep'; writeFileSync(neighbor, 'keep');
    if (fault.endsWith('lock')) {
      writeFileSync(lock, JSON.stringify({ pid: fault === 'dead-lock' ? 2147483647 : process.pid }), { mode: 0o600 });
      if (fault === 'old-lock') utimesSync(lock, new Date(0), new Date(0));
    }
    if (fault === 'mode') chmodSync(f.memory.path, 0o644);
    if (fault === 'unreadable-mode') chmodSync(f.memory.path, 0o000);
    if (fault === 'bad-json') writeFileSync(f.memory.path, '{');
    if (fault === 'oversized') writeFileSync(f.memory.path, 'x'.repeat(131073));
    let output = '';
    const command = value => permissionsCommand(['memory', 'clear', value], { home: f.home, out: text => { output += text; } });
    if (scope !== 'all' && !fault.endsWith('lock')) {
      assert.equal(command(scope), 1);
      assert.ok(output.includes(f.memory.path), output);
      assert.match(output, /unreadable.*memory clear all/s);
      output = '';
    } else assert.equal(command(scope), 0, output);
    if (scope === 'all' || !fault.endsWith('lock')) {
      if (scope !== 'all') assert.equal(command('all'), 0, output);
      assert.equal(existsSync(f.memory.path), false, 'clear all removes the damaged file');
    }
    assert.equal(existsSync(lock), false);
    assert.equal(readFileSync(neighbor, 'utf8'), 'keep');
    assert.equal(f.memory.record(row(), staleEpoch), false, 'old observation cannot restore cleared data');
    assert.equal(f.memory.record(row('More')), true, 'a new observation can learn');
  });
}

test('clear all removes an expired owned lock even when its mode prevents reading its metadata', t => {
  const f = fixture(t); f.memory.record(row());
  const lock = f.memory.path + '.lock';
  writeFileSync(lock, 'unreadable', { mode: 0o000 }); utimesSync(lock, new Date(0), new Date(0));
  assert.equal(f.memory.clear(), 1);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(f.memory.path), false);
});

test('clear refuses a live lock with its path and recovery advice', t => {
  const f = fixture(t); f.memory.record(row());
  const lock = f.memory.path + '.lock';
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let output = '';
  assert.equal(permissionsCommand(['memory', 'clear', 'all'], { home: f.home, out: text => { output += text; } }), 1);
  assert.ok(output.includes(lock), output);
  assert.match(output, /memory clear all/);
  assert.equal(existsSync(lock), true);
  assert.equal(f.memory.list()[0].recipes.length, 1);
});

test('clear all never removes a symlink, hardlink, or path through a linked parent', t => {
  for (const fault of ['store-symlink', 'store-hardlink', 'lock-symlink', 'lock-hardlink', 'parent-link']) {
    const f = fixture(t); f.memory.record(row());
    const lock = f.memory.path + '.lock', other = join(f.home, 'other');
    const path = fault.startsWith('lock') ? lock : f.memory.path;
    if (fault.startsWith('lock')) writeFileSync(lock, '', { mode: 0o600 });
    if (fault.endsWith('symlink')) { writeFileSync(other, 'keep'); rmSync(path); symlinkSync(other, path); }
    if (fault.endsWith('hardlink')) linkSync(path, other);
    if (fault === 'parent-link') { const dir = join(f.home, 'Library', 'Application Support', 'sleight');
      mkdirSync(other); writeFileSync(join(other, 'site-memory.json'), 'keep'); rmSync(dir, { recursive: true }); symlinkSync(other, dir); }
    const before = readFileSync(path, 'utf8');
    assert.throws(() => f.memory.clear(), /SITE_MEMORY_UNSAFE/, fault);
    assert.equal(readFileSync(path, 'utf8'), before, fault);
    if (fault.endsWith('symlink')) assert.equal(readFileSync(other, 'utf8'), 'keep');
  }
});

test('recipe annotations describe only a store save that already succeeded', t => {
  const f = fixture(t); let savedAtLog;
  f.memory.log = { write(rows) { savedAtLog = new api.SiteMemory({ home: f.home }).list(); return f.log.write(rows); } };
  assert.equal(f.memory.record(row()), true);
  assert.equal(savedAtLog[0]?.recipes[0]?.target.name, 'Export');
  const before = readFileSync(f.path, 'utf8');
  f.memory.update = () => { throw Error('simulated disk write failure'); };
  assert.equal(f.memory.record(row('More')), false);
  assert.equal(readFileSync(f.path, 'utf8'), before, 'failed saves have no annotation');
});

test('the byte cap evicts the least recently used origin before saving a new one', t => {
  const f = fixture(t); f.memory.record(row());
  const origins = Array.from({ length: 63 }, (_, n) => ({ origin: `https://s${n}.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(40)}.test`,
    recipes: Array.from({ length: 20 }, () => ({ target: { role: 'menuitem', name: 'Download' }, via: { role: 'button', name: 'Settings' } })) }));
  const data = { version: 1, epoch: f.memory.generation(), origins };
  while (Buffer.byteLength(JSON.stringify(data)) > 130950) origins.at(-1).recipes.pop();
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 131072);
  writeFileSync(f.memory.path, JSON.stringify(data));
  assert.equal(f.memory.record(row('Export', { origin: 'https://new0.test' })), true);
  assert.equal(f.memory.list().some(entry => entry.origin === origins[0].origin), false, 'byte cap reached before 64 origins');
  for (let n = 1; n < 4; n++) assert.equal(f.memory.record(row('Export', { origin: `https://new${n}.test` })), true);
  assert.ok(readFileSync(f.memory.path).length <= 131072);
  assert.equal(f.memory.list().some(entry => entry.origin === origins[0].origin), false);
  assert.equal(f.memory.list().at(-1).origin, 'https://new3.test');
});

test('using hints refreshes origin recency at the origin cap', t => {
  const f = fixture(t);
  f.memory.record(row('Export', { origin: 'https://hot.test' }));
  f.memory.record(row('More', { origin: 'https://cold.test' }));
  for (let n = 0; n < 62; n++) f.memory.record(row('Export', { origin: `https://s${n}.test` }));
  assert.match(f.memory.hints('https://hot.test'), /Export/);
  f.memory.record(row('More', { origin: 'https://new.test' }));
  assert.equal(f.memory.list().some(entry => entry.origin === 'https://hot.test'), true);
  assert.equal(f.memory.list().some(entry => entry.origin === 'https://cold.test'), false);
});

test('recipes expire after 90 unused days, including across sessions, while hints refresh their use', t => {
  const f = fixture(t), day = 86400000; let time = 1800000000000;
  const options = { home: f.home, log: f.log, now: () => time };
  const memory = new api.SiteMemory(options);
  memory.record(row('Export'));
  time += 89 * day;
  assert.match(new api.SiteMemory(options).hints('https://fixture.test'), /Export/);
  memory.record(row('More'));
  time += 89 * day;
  assert.equal(new api.SiteMemory(options).list()[0].recipes.length, 2);
  time += 2 * day;
  assert.equal(new api.SiteMemory(options).hints('https://fixture.test'), '');
  assert.deepEqual(new api.SiteMemory(options).list(), []);
  assert.deepEqual(JSON.parse(readFileSync(memory.path, 'utf8')).origins, [], 'expired recipes are pruned from disk on access');
});

test('using 19 rendered hints does not renew the twentieth recipe that was omitted', t => {
  const f = fixture(t), day = 86400000; let time = 1800000000000;
  const memory = new api.SiteMemory({ home: f.home, log: f.log, now: () => time });
  for (const name of api.RECIPE_NAMES.slice(0, 20)) memory.record(row(name));
  time += 89 * day;
  const hints = memory.hints('https://fixture.test');
  assert.doesNotMatch(hints, /button "More"/);
  time += 2 * day;
  assert.equal(memory.list()[0].recipes.length, 19);
  assert.equal(memory.list()[0].recipes.some(item => item.target.name === 'More'), false);
});

test('legacy recipes use the old file time and expire without an unrelated write renewing them', t => {
  const f = fixture(t), day = 86400000, created = 1800000000000; let time = created + 89 * day;
  f.memory.record(row());
  writeFileSync(f.memory.path, JSON.stringify({ version: 1, epoch: f.memory.generation(), origins: [{ origin: 'https://fixture.test', recipes: [{ target: { role: 'button', name: 'Export' } }] }] }));
  utimesSync(f.memory.path, new Date(created), new Date(created));
  const memory = new api.SiteMemory({ home: f.home, log: f.log, now: () => time });
  memory.record(row('More', { origin: 'https://other.test' }));
  time += 2 * day;
  assert.equal(memory.hints('https://fixture.test'), '');
  assert.equal(memory.list()[0].origin, 'https://other.test');
});

for (const args of [['revoke', 'https://fixture.test'], ['block', 'https://fixture.test'], ['revoke', 'all']]) {
  test(`permissions ${args.join(' ')} clears affected recipes and in-flight observations`, t => {
    const f = fixture(t); f.memory.record(row()); f.memory.record(row('More', { origin: 'https://other.test' }));
    if (args[0] === 'revoke' && args[1] !== 'all') assert.equal(permissionsCommand(['sites', 'only', 'https://fixture.test', 'https://other.test'], { home: f.home, out: () => {} }), 0);
    const epoch = f.memory.generation(); let output = '';
    assert.equal(permissionsCommand(args, { home: f.home, out: text => { output += text; } }), 0, output);
    assert.equal(f.memory.hints('https://fixture.test'), '');
    assert.equal(f.memory.record(row(), epoch), false);
    assert.equal(f.memory.list().length, args[1] === 'all' ? 0 : 1);
    if (args[0] === 'block') {
      // An already blocked site can acquire recipes from an older session, and repeated blocking must erase those too.
      f.memory.record(row());
      assert.equal(permissionsCommand(args, { home: f.home, out: () => {} }), 0);
      assert.equal(f.memory.hints('https://fixture.test'), '');
    }
  });
}

for (const operation of ['all', 'origin', 'matching']) test(`clear ${operation} on absent memory creates no files or folders`, t => {
  const f = fixture(t);
  const clear = () => operation === 'matching' ? f.memory.clearMatching(() => true) : f.memory.clear(operation === 'all' ? undefined : 'https://fixture.test');
  assert.equal(clear(), 0);
  assert.deepEqual(readdirSync(f.home), []);
  mkdirSync(join(f.home, 'Library/Application Support/sleight'), { recursive: true, mode: 0o700 });
  assert.equal(clear(), 0);
  assert.deepEqual(readdirSync(join(f.home, 'Library/Application Support/sleight')), []);
});

for (const populated of [false, true]) test(`record skips a held lock without blocking, populated=${populated}`, t => {
  const f = fixture(t);
  if (populated) assert.equal(f.memory.record(row()), true);
  else f.memory.directory(true);
  const before = populated ? readFileSync(f.memory.path, 'utf8') : undefined;
  const lock = f.memory.path + '.lock', owner = JSON.stringify({ pid: process.pid });
  writeFileSync(lock, owner, { mode: 0o600 });
  const wait = t.mock.method(Atomics, 'wait', () => { throw Error('blocking wait attempted'); });
  const acquire = t.mock.method(f.memory, 'tryAcquire');
  assert.equal(f.memory.record(row('More')), false);
  assert.equal(wait.mock.callCount(), 0, 'optional recording must never block the event loop');
  assert.equal(acquire.mock.callCount(), 1, 'optional recording makes one lock attempt');
  assert.equal(readFileSync(lock, 'utf8'), owner);
  if (populated) assert.equal(readFileSync(f.memory.path, 'utf8'), before);
  else assert.equal(existsSync(f.memory.path), false);
});

test('a live writer gets a brief bounded wait before BUSY', t => {
  const f = fixture(t); f.memory.record(row());
  writeFileSync(f.memory.path + '.lock', JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const start = performance.now();
  assert.throws(() => f.memory.clear(), /SITE_MEMORY_BUSY/);
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 150, `writer was not given time: ${elapsed} ms`);
  assert.ok(elapsed < 500, `writer wait exceeded budget: ${elapsed} ms`);
});

test('clear acquires a live lock released during its 200 ms wait', async t => {
  const { Worker } = await import('node:worker_threads');
  const f = fixture(t); f.memory.record(row());
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    fs.writeFileSync(workerData, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    parentPort.postMessage('locked');
    setTimeout(() => fs.unlinkSync(workerData), 80);`, { eval: true, workerData: f.memory.path + '.lock' });
  const exited = new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  try { assert.equal(f.memory.clear(), 1); } finally { assert.equal(await exited, 0); }
  assert.equal(existsSync(f.memory.path), false);
});

test('one pre-click timeout disables further optional observations in its observation scope', { timeout: 1500 }, async () => {
  let reads = 0;
  const handle = { _connection: { toImpl: () => ({ _frame: { utilityContext: async () => ({ world: 'utility',
    evaluateExpression: () => { reads++; return new Promise(() => {}); } }) } }) } };
  const observation = {};
  assert.equal(await prepareControlRecipe(handle, 'https://fixture.test', observation), null);
  assert.equal(await prepareControlRecipe(handle, 'https://fixture.test', observation), null);
  assert.equal(reads, 1, 'later clicks must skip observation after the stall cap');
});

test('a matching clear does not recreate a store removed by the preceding writer', async t => {
  const { Worker } = await import('node:worker_threads');
  const f = fixture(t); f.memory.record(row());
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    fs.writeFileSync(workerData + '.lock', JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    parentPort.postMessage('locked');
    setTimeout(() => { fs.unlinkSync(workerData); fs.unlinkSync(workerData + '.lock'); }, 80);`, { eval: true, workerData: f.memory.path });
  const exited = new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  try { assert.equal(f.memory.clearMatching(() => true), 0); } finally { assert.equal(await exited, 0); }
  assert.equal(existsSync(f.memory.path), false);
  assert.equal(existsSync(f.memory.path + '.lock'), false);
});
