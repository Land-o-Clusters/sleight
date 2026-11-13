import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PreapprovedApps, addPreapproved, listPreapproved, loadPreapproved, preapprovedFile, removePreapproved,
  preapprovedDoctorLine, sessionPreapproved, withPreapprovedLock, livePreapproved, PREAPPROVED_PROBLEM_NOTICE, PREAPPROVED_DUPLICATE_NOTICE }
  from '../plugins/sleight/lib/preapproved.mjs';
import { doctor } from '../plugins/sleight/lib/launch.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { permissionsCommand, permissionsMenu, applyMenuEvent } from '../plugins/sleight/lib/permissions-command.mjs';
import { offlineDoctor } from './fixtures/preapproved-storage.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const config = apps => ({ version: 1, apps });
const entry = (app, riskLevel = 'low') => ({ app, riskLevel });
function fixture(t, apps = [entry('com.apple.finder')]) {
  const home = registerTemp(t, trackTemp(fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-pa1-')))));
  const file = preapprovedFile(home);
  fs.mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config(apps)), { mode: 0o600 });
  const io = { ...fs, lstatSync: () => fs.lstatSync(file), openSync: (_path, ...args) => fs.openSync(file, ...args), realpathSync: path => path };
  return { home, file, io };
}

for (const levels of [['low', 'high'], ['high', 'low'], ['medium', 'medium'], ['high', 'medium', 'low']]) {
  test(`duplicates use the lowest ceiling in every order: ${levels}`, t => {
    const f = fixture(t, levels.map(risk => entry('com.apple.finder', risk)));
    const list = loadPreapproved(f.io), lowest = levels.includes('low') ? 'low' : 'medium';
    assert.equal(list.size, 1); assert.equal(list.duplicates, true);
    assert.equal(list.allows('com.apple.finder', lowest), true);
    assert.equal(list.allows('com.apple.finder', 'high'), false);
    assert.deepEqual(listPreapproved({ home: f.home }), [entry('com.apple.finder', lowest)]);
    assert.match(preapprovedDoctorLine(f.io), /PROBLEM.*Duplicate.*lowest risk.*allow remove/);
    const before = fs.readFileSync(f.file, 'utf8');
    assert.equal(addPreapproved('com.apple.finder', 'low', { home: f.home }), false);
    assert.notEqual(fs.readFileSync(f.file, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).apps.length, 1);
  });
}

test('duplicate repair never hides another invalid entry or resurrects it on a write', t => {
  const f = fixture(t, [entry('A'), entry('A'), entry('B', 'critical')]);
  const session = sessionPreapproved({ load: () => loadPreapproved(f.io), live: apps => apps });
  assert.equal(session.preapproved.size, 0);
  assert.throws(() => addPreapproved('C', 'low', { home: f.home }), /invalid/);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).apps.length, 3);
});
test('an unrelated Always allow write cleans every duplicated ID without raising its ceiling', t => {
  const f = fixture(t, [entry('A', 'high'), entry('B'), entry('A'), entry('B', 'medium')]);
  assert.equal(addPreapproved('C', 'low', { home: f.home, now: new Date('2026-11-01T12:00:00Z') }), true);
  assert.deepEqual(listPreapproved({ home: f.home }), [entry('A'), entry('B'),
    { app: 'C', riskLevel: 'low', added: '2026-11-01', source: 'always-allow' }]);
  assert.equal(loadPreapproved(f.io).duplicates, false);
});
test('a write beyond the reader size limit leaves existing grants intact', t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  assert.throws(() => addPreapproved('x'.repeat(1024 * 1024), 'low', { home: f.home }), /exceeds 1 MiB/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(f.file + '.lock'), false);
});

for (const kind of ['json', 'shape', 'mode', 'symlink', 'owner', 'unreadable', 'replacement']) {
  test(`${kind}: startup grants nothing, doctor explains repair, first result has exactly one notice`, async t => {
    const f = fixture(t);
    if (kind === 'json') fs.writeFileSync(f.file, '{');
    if (kind === 'shape') fs.writeFileSync(f.file, JSON.stringify(config([entry('A'), entry('B', 'critical')])));
    if (kind === 'mode') fs.chmodSync(f.file, 0o666);
    if (kind === 'symlink') { fs.renameSync(f.file, f.file + '.target'); fs.symlinkSync(f.file + '.target', f.file); }
    if (kind === 'owner') { const stat = f.io.lstatSync(); f.io.lstatSync = () => ({ ...stat, uid: stat.uid + 1, isFile: () => true, isSymbolicLink: () => false }); }
    if (kind === 'unreadable') f.io.openSync = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
    if (kind === 'replacement') f.io.fstatSync = fd => { const stat = fs.fstatSync(fd); stat.ino++; return stat; };
    const session = sessionPreapproved({ load: () => loadPreapproved(f.io), live: apps => apps });
    assert.equal(session.preapproved.size, 0); assert.equal(session.preapproved.allows('com.apple.finder', 'low'), false);
    assert.equal(preapprovedDoctorLine(f.io), 'PROBLEM   ' + PREAPPROVED_PROBLEM_NOTICE);
    const lines = [], none = () => [];
    await doctor({ ...offlineDoctor, preapprovedIO: f.io, env: { CODEX_HOME: join(f.home, 'missing') }, log: text => lines.push(text),
      runtime: () => ({ selected: 'engine', ok: true, lines: [] }), documentation() {}, turbo: none,
      codex: none, cursor: none, grok: none, grokbot: none });
    assert.equal(lines.filter(line => line.includes(PREAPPROVED_PROBLEM_NOTICE)).length, 1);
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough(), replies = [];
    clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, preapproved: session.preapproved,
      changeReview: false, onClientReply: session.appendNotice });
    t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
    serverOut.write(JSON.stringify({ id: 0, result: { tools: [] } }) + '\n');
    for (const id of [1, 2]) {
      clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(1)' } } }) + '\n');
      serverOut.write(JSON.stringify({ id, result: { isError: true, content: [{ type: 'text', text: 'offline result' }] } }) + '\n');
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.filter(reply => reply.result?.content?.some(item => item.text === PREAPPROVED_PROBLEM_NOTICE)).length, 1);
    assert.equal(replies.find(reply => reply.id === 1).result.content.at(-1).text, PREAPPROVED_PROBLEM_NOTICE);
  });
}

test('healthy sessions emit no notice; duplicate notices have no file-controlled text', t => {
  for (const apps of [[], [entry('A')], [entry('UNTRUSTED APP'), entry('UNTRUSTED APP')]]) {
    const session = sessionPreapproved({ load: () => new PreapprovedApps(config(apps)), live: apps => apps });
    const message = { result: { content: [] } }; session.appendNotice(message); session.appendNotice(message);
    assert.deepEqual(message.result.content, apps.length === 2 ? [{ type: 'text', text: PREAPPROVED_DUPLICATE_NOTICE }] : []);
    assert.doesNotMatch(JSON.stringify(message), /UNTRUSTED APP/);
  }
});

for (const route of ['allow', 'permissions', 'menu', 'all']) test(`${route} revokes every duplicate and preserves other ceilings`, t => {
  const f = fixture(t, [entry('A', 'high'), entry('B'), entry('A')]);
  const options = { home: f.home, uid: userInfo().uid, appNames: () => [], out() {}, grants: () => ({ list: () => [], remove: () => false }) };
  if (route === 'allow') assert.equal(removePreapproved('A', options), true);
  if (route === 'permissions') assert.equal(permissionsCommand(['revoke', 'A'], options), 0);
  if (route === 'menu') {
    const menu = permissionsMenu(options);
    assert.ok(menu.payload.problems.includes(PREAPPROVED_DUPLICATE_NOTICE));
    assert.equal(menu.payload.grants.filter(row => row.target === 'app:A').length, 1);
    assert.equal(applyMenuEvent({ permissions: 'revoke', target: 'app:A' }, menu.offered, options), true);
  }
  if (route === 'all') assert.equal(permissionsCommand(['revoke', 'all'], options), 0);
  assert.deepEqual(listPreapproved(options), route === 'all' ? [] : [entry('B')]);
});

test('invalid list appears in the menu with no standing app grants', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{');
  const menu = permissionsMenu({ home: f.home, grants: () => ({ list: () => [] }) });
  assert.deepEqual(menu.payload.grants, []);
  assert.deepEqual(menu.payload.problems, [PREAPPROVED_PROBLEM_NOTICE]);
});

test('a permission-only change revokes a running session without requiring new content', t => {
  const f = fixture(t), removed = [];
  const live = livePreapproved(loadPreapproved(f.io), { io: fs, file: f.file, load: () => loadPreapproved(f.io) });
  live.onRemoved(apps => removed.push(...apps));
  assert.equal(live.allows('com.apple.finder', 'low'), true);
  fs.chmodSync(f.file, 0o666);
  assert.equal(live.allows('com.apple.finder', 'low'), false);
  assert.deepEqual(removed, ['com.apple.finder']);
});

function child(code, args = []) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', data => stderr += data); proc.stdout.resume();
  return { proc, closed: new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', (code, signal) => resolve({ code, signal, stderr })); }) };
}
const moduleURL = new URL('../plugins/sleight/lib/preapproved.mjs', import.meta.url).href;
for (const stale of [false, true]) test(`two simultaneous writers keep both edits and one copy per app, stale=${stale}`, async t => {
  const f = fixture(t, []);
  if (stale) {
    const dead = child(''); const exit = await dead.closed; assert.equal(exit.code, 0);
    fs.writeFileSync(f.file + '.lock', JSON.stringify({ pid: dead.proc.pid }), { mode: 0o600 });
  }
  const code = `import * as fs from 'node:fs'; import { addPreapproved } from ${JSON.stringify(moduleURL)};
    const home = process.argv[1], name = process.argv[2], rendezvous = process.argv[3];
    fs.writeFileSync(rendezvous + name, '');
    const pause = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 5000;
    while (!fs.existsSync(rendezvous + (name === 'A' ? 'B' : 'A'))) { if (Date.now() > deadline) throw Error('rendezvous timeout'); Atomics.wait(pause, 0, 0, 5); }
    const io = { ...fs, readFileSync(...args) { const value = fs.readFileSync(...args); Atomics.wait(pause, 0, 0, 75); return value; } };
    addPreapproved(name, 'low', { home, io }); addPreapproved('shared', 'low', { home, io });`;
  const children = ['A', 'B'].map(app => child(code, [f.home, app, join(f.home, 'ready-')]));
  for (const writer of children) assert.deepEqual(await writer.closed, { code: 0, signal: null, stderr: '' });
  assert.deepEqual(listPreapproved({ home: f.home }).map(e => e.app).sort(), ['A', 'B', 'shared']);
  assert.equal(fs.existsSync(f.file + '.lock'), false);
});
test('two simultaneous revokes cannot restore each other\'s app', async t => {
  const f = fixture(t, [entry('A'), entry('B'), entry('kept')]);
  const code = `import * as fs from 'node:fs'; import { removePreapproved } from ${JSON.stringify(moduleURL)};
    const home = process.argv[1], name = process.argv[2], rendezvous = process.argv[3];
    fs.writeFileSync(rendezvous + name, '');
    const pause = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 5000;
    while (!fs.existsSync(rendezvous + (name === 'A' ? 'B' : 'A'))) { if (Date.now() > deadline) throw Error('rendezvous timeout'); Atomics.wait(pause, 0, 0, 5); }
    const io = { ...fs, readFileSync(...args) { const value = fs.readFileSync(...args); Atomics.wait(pause, 0, 0, 75); return value; } };
    removePreapproved(name, { home, io });`;
  const writers = ['A', 'B'].map(app => child(code, [f.home, app, join(f.home, 'ready-')]));
  for (const writer of writers) assert.deepEqual(await writer.closed, { code: 0, signal: null, stderr: '' });
  assert.deepEqual(listPreapproved({ home: f.home }), [entry('kept')]);
});

test('a live owner is never evicted and a failed mutation releases its lock', t => {
  const f = fixture(t);
  assert.throws(() => withPreapprovedLock(f.file, () => { throw Error('failed change'); }), /failed change/);
  assert.equal(fs.existsSync(f.file + '.lock'), false);
  fs.writeFileSync(f.file + '.lock', JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  assert.throws(() => withPreapprovedLock(f.file, () => assert.fail('busy'), { timeoutMs: 20 }), /writer busy/);
  assert.equal(fs.existsSync(f.file + '.lock'), true);
});

test('symlinked writer locks never touch their target', t => {
  const f = fixture(t), target = join(f.home, 'target'); fs.writeFileSync(target, 'private'); fs.symlinkSync(target, f.file + '.lock');
  assert.throws(() => addPreapproved('B', 'low', { home: f.home }), /unsafe writer lock/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'private');
});
