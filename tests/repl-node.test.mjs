import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { realpathSync, readFileSync } from 'node:fs';
import { createReplNodeSelector } from '../plugins/sleight/lib/repl/node.mjs';
import { createReplClient, replWorkerArguments, REPL_NODE_UNSUPPORTED } from '../plugins/sleight/lib/repl/client.mjs';

const flags = new Set(['--permission', '--allow-net']);
const bundled = { execPath: '/fixture/bundled-node', version: 'v24.22.1', allowedNodeEnvironmentFlags: new Set(['--permission']) };
const modern = { version: 'v26.12.1', permission: true, net: true };
const file = values => ({ uid: 501, mode: 0o100755, dev: 1, ino: 2, mtimeMs: 3, size: 4,
  isFile: () => true, ...values });
function fixture(options = {}) {
  const probes = [], paths = [];
  const select = createReplNodeSelector({ node: bundled, platform: 'darwin', uid: 501,
    env: { PATH: '/fixture/bin', NODE_OPTIONS: '--require=hostile' }, home: () => '/fixture/home',
    realpath(path) {
      paths.push(path);
      if (path === '/fixture/bin/node') return '/fixture/real-node';
      throw Error('ENOENT');
    },
    stat: () => file(),
    lstat: () => ({ uid: 0, mode: 0o40755, isDirectory: () => true }),
    magic: () => Buffer.from('cffaedfe', 'hex'),
    exec(...args) { probes.push(args); return JSON.stringify(modern); }, ...options });
  return { select, probes, paths };
}
const driver = () => ({ async restart() {}, async close() {} });
function client(t, options = {}) {
  const forks = [];
  const repl = createReplClient({ platform: 'darwin', driver: driver(), environment: () => ({ FIXTURE: '1' }),
    spawn(...args) {
      forks.push(args);
      const child = new EventEmitter();
      child.stdout = child.stderr = { resume() {} };
      child.connected = true;
      child.kill = () => { queueMicrotask(() => child.emit('close', 0)); };
      child.send = message => queueMicrotask(() => child.emit('message', {
        type: 'result', id: message.id, result: { isError: false, content: [] },
      }));
      return child;
    }, ...options });
  t.after(() => repl.close());
  return { repl, forks };
}

test('bundled Node missing flags forks the worker with the qualifying PATH real execPath', async t => {
  const f = fixture(), c = client(t, { selectNode: f.select });
  assert.equal((await c.repl.execute({ code: '1' })).isError, false);
  assert.equal(c.forks[0][2].execPath, '/fixture/real-node');
  assert.deepEqual(c.forks[0][2].execArgv, replWorkerArguments(flags, 'darwin'));
  assert.deepEqual(c.forks[0][1], ['darwin']);
  assert.equal(f.probes.length, 1);
  assert.equal(f.probes[0][0], '/fixture/real-node');
});

for (const field of ['dev', 'ino', 'mtimeMs', 'size']) {
  test(`GL2B rechecks ${field} before every fork and reselects an upgraded Node once`, async t => {
    let changed = false;
    const f = fixture({ stat: () => file(changed ? { [field]: 99 } : {}) });
    const c = client(t, { selectNode: f.select });
    assert.equal((await c.repl.execute({ code: '1' })).isError, false);
    await c.repl.reset(); changed = true;
    assert.equal((await c.repl.execute({ code: '2' })).isError, false);
    assert.equal(c.forks.length, 2);
    assert.equal(f.probes.length, 2);
    assert.equal(f.select().identity[field], 99);
  });
}

test('GL2B removed pinned Node selects a new real path before the next fork', async t => {
  let removed = false;
  const f = fixture({
    realpath(path) { if (path === '/fixture/bin/node') return removed ? '/fixture/new-node' : '/fixture/real-node'; throw Error('ENOENT'); },
    stat(path) { if (removed && path === '/fixture/real-node') throw Object.assign(Error('gone'), { code: 'ENOENT' }); return file(); },
  });
  const c = client(t, { selectNode: f.select });
  await c.repl.execute({ code: '1' }); await c.repl.reset(); removed = true;
  assert.equal((await c.repl.execute({ code: '2' })).isError, false);
  assert.equal(c.forks[1][2].execPath, '/fixture/new-node');
  assert.equal(f.probes.length, 2);
});

test('GL2B a changed executable that no longer qualifies fails unavailable without forking or repeated selection', async t => {
  let changed = false, resolutions = 0;
  const f = fixture({ realpath(path) { resolutions++; if (path === '/fixture/bin/node') return '/fixture/real-node'; throw Error('ENOENT'); },
    stat: () => file(changed ? { ino: 99, mode: 0o100777 } : {}) });
  const c = client(t, { selectNode: f.select });
  await c.repl.execute({ code: '1' }); await c.repl.reset(); changed = true;
  const result = await c.repl.execute({ code: '2' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /REPL_NODE_UNSUPPORTED.*changed.*mode/);
  assert.equal(c.forks.length, 1);
  const attempts = resolutions;
  await c.repl.execute({ code: '3' });
  assert.equal(resolutions, attempts);
});

test('GL2B a second change during reselection refuses without a third probe', async t => {
  let inode = 2, unstable = false;
  const f = fixture({ stat: () => file({ ino: inode }), exec() {
    if (unstable) inode++;
    return JSON.stringify(modern);
  } });
  const c = client(t, { selectNode: f.select });
  await c.repl.execute({ code: '1' }); await c.repl.reset(); inode++; unstable = true;
  const result = await c.repl.execute({ code: '2' });
  assert.match(result.content[0].text, /REPL_NODE_UNSUPPORTED.*changed/);
  assert.equal(c.forks.length, 1);
});

for (const bytes of ['23212f62', '7f454c46', '00000000', 'cffaed']) {
  test(`GL2B refuses non Mach-O header ${bytes} before probing`, () => {
    const f = fixture({ magic: () => Buffer.from(bytes, 'hex') });
    assert.equal(f.select(), undefined); assert.equal(f.probes.length, 0);
    assert.equal(f.select.lastRefusal.reason, 'not Mach-O');
  });
}
for (const bytes of ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']) {
  test(`GL2B accepts thin or universal Mach-O header ${bytes}`, () => {
    assert.equal(fixture({ magic: () => Buffer.from(bytes, 'hex') }).select()?.execPath, '/fixture/real-node');
  });
}

test('GL2B skips relative and cwd-contained PATH entries, including symlink targets', () => {
  const paths = [], probes = [];
  const f = fixture({ cwd: () => '/project', env: { PATH: ':relative:.:/project:/project/bin:/alias:/project-other/bin' },
    realpath(path) { paths.push(path); return path === '/alias/node' ? '/project/node' : path; },
    exec(path) { probes.push(path); return JSON.stringify(modern); } });
  assert.equal(f.select()?.execPath, '/project-other/bin/node');
  assert.deepEqual(paths, ['/alias/node', '/project-other/bin/node']);
  assert.deepEqual(probes, ['/project-other/bin/node']);
});

for (const [label, values] of [
  ['nonsticky world writable', { mode: 0o40777 }], ['foreign owner', { uid: 502 }],
  ['not directory', { isDirectory: () => false }],
]) test(`GL2B refuses a ${label} ancestor before probing`, () => {
  const inspected = [];
  const f = fixture({ lstat(path) { inspected.push(path); return { uid: 0, mode: 0o40755, isDirectory: () => true,
    ...(path === '/fixture' ? values : {}) }; } });
  assert.equal(f.select(), undefined); assert.equal(f.probes.length, 0);
  assert.ok(inspected.includes('/fixture'));
});

test('GL2B checks every ancestor up to root and permits sticky or group-writable directories', () => {
  const inspected = [];
  const f = fixture({ realpath: () => '/a/b/c/node', lstat(path) {
    inspected.push(path);
    return { uid: path === '/a/b' ? 501 : 0, mode: path === '/a' ? 0o41777 : 0o40775, isDirectory: () => true };
  } });
  assert.equal(f.select()?.execPath, '/a/b/c/node');
  assert.ok(['/a/b/c', '/a/b', '/a', '/'].every(path => inspected.includes(path)));
});

for (const mode of [0o104755, 0o102755]) test(`GL2B refuses privilege bits ${mode.toString(8)}`, () => {
  const f = fixture({ stat: () => file({ mode }) });
  assert.equal(f.select(), undefined); assert.equal(f.probes.length, 0);
});

for (const [label, options, reason] of [
  ['version', { exec: () => JSON.stringify({ ...modern, version: 'v24.0.0' }) }, 'version'],
  ['flags', { exec: () => JSON.stringify({ ...modern, net: false }) }, 'flags'],
  ['mode', { stat: () => file({ mode: 0o100775 }) }, 'mode'],
  ['owner', { stat: () => file({ uid: 502 }) }, 'owner'],
  ['timeout', { exec: () => { throw Object.assign(Error('/secret/ancestor'), { code: 'ETIMEDOUT' }); } }, 'probe timeout'],
]) test(`GL2B records ${label} refusal and includes it in the unavailable result`, async t => {
  const f = fixture(options), c = client(t, { selectNode: f.select });
  const result = await c.repl.execute({ code: '1' });
  assert.equal(result.isError, true);
  assert.deepEqual(f.select.lastRefusal, { path: '/fixture/bin/node', reason });
  assert.ok(f.select.refusals.some(refusal => refusal.path === '/fixture/bin/node' && refusal.reason === reason));
  assert.ok(result.content[0].text.includes(`/fixture/bin/node: ${reason}`));
  assert.ok(!result.content[0].text.includes('/secret/ancestor'));
  assert.ok(result.content[0].text.length < 700);
});

test('GL2B probe discards stderr and limits all candidate probes to 6000 ms combined', () => {
  let elapsed = 0;
  const calls = [];
  const f = fixture({ env: { PATH: '/a:/b:/c:/d:/e' }, now: () => elapsed,
    realpath: path => path, exec(_path, _args, options) {
      calls.push(options); elapsed += options.timeout;
      throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' });
    } });
  assert.equal(f.select(), undefined);
  assert.equal(calls.length, 3); assert.equal(elapsed, 6000);
  for (const options of calls) assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
});

test('GL2B probe receives only the remaining total time budget', () => {
  let elapsed = 0;
  const calls = [];
  const f = fixture({ env: { PATH: '/a:/b:/c:/d' }, now: () => elapsed, realpath: path => path,
    exec(_path, _args, options) { calls.push(options.timeout); elapsed += 2500; return '{}'; } });
  assert.equal(f.select(), undefined);
  assert.deepEqual(calls, [2000, 2000, 1000]);
});

test('GL2B refusal output prioritizes an unsafe executable over absent PATH entries', async t => {
  const f = fixture({ env: { PATH: '/absent/a:/absent/b:/fixture/bin' },
    realpath(path) { if (path === '/fixture/bin/node') return '/fixture/real-node'; throw Object.assign(Error('gone'), { code: 'ENOENT' }); },
    stat: () => file({ mode: 0o100775 }) });
  const c = client(t, { selectNode: f.select });
  const result = await c.repl.execute({ code: '1' });
  assert.match(result.content[0].text, /\/fixture\/bin\/node: mode/);
  assert.equal(f.select.refusals.length, 6);
});

test('GL2B a home lookup failure stays inside selection and is cached', () => {
  let calls = 0;
  const f = fixture({ home() { calls++; throw Error('/private/account-data'); } });
  assert.doesNotThrow(() => assert.equal(f.select(), undefined));
  assert.equal(f.select(), undefined); assert.equal(calls, 1);
});

test('GL2B runtime install docs describe worker PATH fallback without a launcher override', () => {
  const text = readFileSync(new URL('../docs/runtime.md', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /does not retry with the PATH Node|never PATH fallback|SLEIGHT_CHATGPT_APP=\/nonexistent/);
  assert.match(text, /PATH[\s\S]{0,200}Homebrew/);
  assert.match(text, /6,000 ms/);
});

test('probe is bounded, shell-free and has a minimal environment', () => {
  const f = fixture(); f.select();
  const [, args, options] = f.probes[0];
  assert.equal(args[0], '-p');
  assert.match(args[1], /process.version/);
  assert.match(args[1], /--permission/); assert.match(args[1], /--allow-net/);
  assert.deepEqual(options, { timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 4096, env: {}, shell: false,
    stdio: ['ignore', 'pipe', 'ignore'] });
});

for (const [label, result] of [
  ['v24', { ...modern, version: 'v24.22.1' }],
  ['missing allow-net', { ...modern, net: false }],
  ['missing permission', { ...modern, permission: false }],
  ['malformed version', { ...modern, version: 'banana' }],
  ['nonboolean flags', { ...modern, net: 'true' }],
]) test(`refuses PATH Node ${label}`, () => {
  const f = fixture({ exec: () => JSON.stringify(result) });
  assert.equal(f.select(), undefined);
});

for (const [label, values] of [
  ['world-writable', { mode: 0o100757 }], ['group-writable', { mode: 0o100775 }],
  ['not executable', { mode: 0o100644 }], ['foreign owner', { uid: 502 }],
  ['not a regular file', { isFile: () => false }],
]) test(`refuses PATH Node ${label} before executing`, () => {
  const f = fixture({ stat: () => ({ uid: 501, mode: 0o100755, isFile: () => true, ...values }) });
  assert.equal(f.select(), undefined); assert.equal(f.probes.length, 0);
});

test('a symlink to a world-writable target is refused using the target stat', () => {
  const paths = [];
  const f = fixture({ stat(path) { paths.push(path); return { uid: 501, mode: 0o100777, isFile: () => true }; } });
  assert.equal(f.select(), undefined);
  assert.deepEqual(paths, ['/fixture/real-node']); assert.equal(f.probes.length, 0);
});

test('root-owned executables qualify', () => {
  const f = fixture({ stat: () => ({ uid: 0, mode: 0o100755, isFile: () => true }) });
  assert.equal(f.select().execPath, '/fixture/real-node');
});

test('a probe hanging past 2000 ms is refused and not retried', () => {
  const calls = [];
  const f = fixture({ exec(_path, _args, options) {
    calls.push(options);
    throw Object.assign(Error('timed out'), { code: 'ETIMEDOUT', signal: 'SIGKILL' });
  } });
  assert.equal(f.select(), undefined); assert.equal(f.select(), undefined); assert.equal(calls.length, 1);
  assert.equal(calls[0].timeout, 2000); assert.equal(calls[0].killSignal, 'SIGKILL');
});

test('failed and malformed probes are cached as unavailable', () => {
  for (const output of ['not json', '{}', 'null']) {
    let calls = 0;
    const f = fixture({ exec() { calls++; return output; } });
    assert.equal(f.select(), undefined); assert.equal(f.select(), undefined); assert.equal(calls, 1);
  }
});

test('selection probes once across clients, calls and worker resets in one relay', async t => {
  const f = fixture(), a = client(t, { selectNode: f.select }), b = client(t, { selectNode: f.select });
  for (const c of [a, b]) {
    await c.repl.execute({ code: '1' }); await c.repl.execute({ code: '2' });
    await c.repl.reset(); await c.repl.execute({ code: '3' });
  }
  assert.equal(f.probes.length, 1); assert.equal(f.paths.length, 1);
  assert.equal(a.forks.length, 2); assert.equal(b.forks.length, 2);
});

test('relay Node with the flags forks exactly as before without probing', async t => {
  const selectNode = fixture({ node: { ...bundled, allowedNodeEnvironmentFlags: flags },
    realpath: () => assert.fail('must not inspect candidates') }).select;
  const c = client(t, { selectNode }); await c.repl.execute({ code: '1' });
  assert.deepEqual(c.forks[0][2], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { FIXTURE: '1' },
    execArgv: replWorkerArguments(flags, 'darwin'), windowsHide: true });
});

test('no qualifying Node keeps the refusal and tells the user how to install Node', async t => {
  const c = client(t, { selectNode: fixture({ exec: () => '{}' }).select });
  const result = await c.repl.execute({ code: '1' });
  assert.equal(result.isError, true); assert.equal(c.forks.length, 0);
  assert.ok(result.content[0].text.startsWith(REPL_NODE_UNSUPPORTED));
  assert.match(result.content[0].text, /Install Node 25 or later.*nodejs.org or Homebrew/);
});

test('Windows never searches fallback Nodes and retains the original fork options', async t => {
  const paths = [];
  const f = fixture({ platform: 'win32', realpath(path) { paths.push(path); throw Error('ENOENT'); } });
  assert.equal(f.select(), undefined);
  assert.deepEqual(paths, []);
  const c = client(t, { platform: 'win32', selectNode: () => assert.fail('Windows must not select') });
  const result = await c.repl.execute({ code: '1' });
  if (!process.allowedNodeEnvironmentFlags.has('--allow-net') || !process.allowedNodeEnvironmentFlags.has('--permission')) {
    assert.match(result.content[0].text, /REPL_NODE_UNSUPPORTED: Windows/); assert.equal(c.forks.length, 0);
  } else {
    assert.equal(result.isError, false);
    assert.deepEqual(c.forks[0][2], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { FIXTURE: '1' },
      execArgv: replWorkerArguments(undefined, 'win32'), windowsHide: true });
  }
});

test('usual install paths follow PATH, deduplicate real targets and accept the first qualifier', () => {
  const seen = [];
  const f = fixture({ realpath(path) { return path === '/opt/homebrew/bin/node' ? '/fixture/bin/node' : path; },
    exec(path) { seen.push(path); return JSON.stringify({ ...modern, net: path === '/fixture/home/.local/bin/node' }); } });
  assert.equal(f.select().execPath, '/fixture/home/.local/bin/node');
  assert.deepEqual(seen, ['/fixture/bin/node', '/usr/local/bin/node', '/fixture/home/.local/bin/node']);
});

test('relative PATH entries are ignored and filesystem failures are cached', () => {
  const f = fixture({ env: { PATH: ':relative:.' }, realpath: path => { assert.ok(path.startsWith('/')); throw Error('ENOENT'); } });
  assert.equal(f.select(), undefined); assert.equal(f.select(), undefined);
});

test('current process.execPath passes the real bounded probe exactly when its version and flags qualify', () => {
  const executable = realpathSync(process.execPath);
  const select = createReplNodeSelector({ node: bundled, platform: 'darwin', env: { PATH: '' }, home: () => '/fixture',
    realpath(path) { if (path === '/opt/homebrew/bin/node') return executable; throw Error('ENOENT'); } });
  const result = select();
  const qualifies = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 25 &&
    process.allowedNodeEnvironmentFlags.has('--permission') && process.allowedNodeEnvironmentFlags.has('--allow-net');
  assert.equal(result?.execPath, qualifies ? executable : undefined);
});
