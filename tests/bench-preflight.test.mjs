import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { assertLogin, assertSpend, probeSocket } from '../bench/preflight.mjs';
import { fowlPreflight, selectedTasks } from '../bench/fowl/preflight.mjs';
import { turboSetup } from '../bench/turbo/setup.mjs';

const config = join(tmpdir(), 'bench-isolated-config');
test('Haiku Chrome checks its isolated account login without API spend admission', async () => {
  const calls = [];
  await fowlPreflight({ tasks: [{ name: 'fixture', browser: 'chrome', surface: 'claude-in-chrome' }],
    model: 'haiku', world: true, home: '/fixture', env: {} }, {
    spend() { assert.fail('Chrome uses its account, not API funding'); },
    fowlSocket(browser) { calls.push(browser); }, engineSockets() { assert.fail('no engine task'); },
    login(plan) { calls.push([plan.command, plan.env.CLAUDE_CONFIG_DIR]); },
  });
  assert.deepEqual(calls, ['chrome', ['/fixture/.config/sleight-bench/world/arms/claude-in-chrome/node_modules/.bin/claude',
    '/fixture/.config/sleight-bench/world/arms/claude-in-chrome/claude-config']]);
});
for (const world of [false, true]) test(`turbo login preflight checks the actual launcher and config, world=${world}`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'sleight-preflight-')); t.after(() => removeTemp(home));
  const previous = process.env.HOME; process.env.HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  const task = { name: 'fixture', browser: 'chrome', surface: 'sleight-turbo', prompt: 'Read http://127.0.0.1:1234/' };
  const actual = turboSetup({ task, repo: new URL('..', import.meta.url).pathname, dir: join(home, 'out'), prompt: task.prompt,
    env: { HOME: home, PATH: '/usr/bin' } });
  let checked;
  await fowlPreflight({ tasks: [task], model: 'opus', world, home, env: {} }, {
    spend() { assert.fail('unexpected spend'); }, fowlSocket() { assert.fail('unexpected monitor'); }, engineSockets() {},
    login(plan) { checked = plan; },
  });
  assert.deepEqual({ command: checked.command, config: checked.env.CLAUDE_CONFIG_DIR },
    { command: actual.command, config: actual.env.CLAUDE_CONFIG_DIR });
});
for (const task of [
  { name: 'unsupported-browser', browser: 'helium', surface: 'claude-in-chrome' },
  { name: 'unsupported-client', browser: 'chrome', surface: 'codex-agent' },
]) test(`unsupported pair skips all preflight admission: ${task.name}`, async () => {
  const calls = [];
  await fowlPreflight({ tasks: selectedTasks([task], {}), model: 'opus', world: true, home: '/fixture' }, {
    spend() { calls.push('spend'); }, engineSockets() { calls.push('engine'); }, login() { calls.push('login'); },
    fowlSocket(browser) { calls.push(browser); throw Error('stale socket for unsupported pair'); },
  });
  assert.deepEqual(calls, []);
});
for (const surface of ['codex', 'codex-sol']) test(`${surface} checks the engine sockets like any Codex arm`, async () => {
  const calls = [];
  await fowlPreflight({ tasks: selectedTasks([{ name: 'engine', browser: 'chrome', surface }], {}), home: '/fixture' }, {
    spend() { calls.push('spend'); }, engineSockets() { calls.push('engine'); }, login() {}, fowlSocket() {},
  });
  assert.ok(calls.includes('engine') && !calls.includes('spend'));
});
for (const surface of ['codex-sleight', 'codex-sleight-sol']) test(`${surface} checks the engine sockets and asks for no Claude login or API spend`, async () => {
  const calls = [];
  await fowlPreflight({ tasks: selectedTasks([{ name: 'engine', browser: 'firefox', surface }], {}), home: '/fixture' }, {
    spend() { calls.push('spend'); }, engineSockets() { calls.push('engine'); }, login() { calls.push('login'); }, fowlSocket() {},
  });
  assert.ok(calls.includes('engine') && !calls.includes('spend') && !calls.includes('login'));
});
test('unsupported API arms do not change funding or socket admission for a runnable account task', async () => {
  const tasks = [{ name: 'login', browser: 'chrome', surface: 'claude-cu' },
    { name: 'unsupported', browser: 'native', surface: 'browser-use' },
    { name: 'unsupported-device', browser: 'helium', surface: 'claude-in-chrome' }];
  const calls = [];
  await fowlPreflight({ tasks, model: 'haiku', world: true, home: '/fixture' }, {
    spend() { assert.fail('unsupported API arm cannot require funding'); },
    fowlSocket(browser) { calls.push(browser); }, engineSockets() { assert.fail('no engine task'); },
    login(plan) { calls.push(plan.env.CLAUDE_CONFIG_DIR); },
  });
  assert.deepEqual(calls, ['chrome', '/fixture/.config/sleight-bench/world/arms/claude-cu/claude']);
  assert.equal(tasks.length, 3, 'runner must still receive unsupported tasks to write their rows');
});
test('login status uses the exact arm config and a credential-free environment, without a model call', () => {
  let checked = false;
  assertLogin({ command: '/arm/claude', env: { PATH: '/bin', HOME: '/owner', CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_SESSION: 'host' } },
  { run(command, args, options) {
    checked = true;
    assert.equal(command, '/arm/claude'); assert.deepEqual(args, ['auth', 'status', '--json']);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, config);
    assert.equal(options.timeout, 10000);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SESSION']) assert.equal(options.env[key], undefined);
    return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' });
  } });
  assert.ok(checked);
});
for (const status of ['{}', 'bad json', '{"loggedIn":false}', '{"loggedIn":true,"authMethod":"api_key"}', new Error('secret stderr')]) {
  test(`login failure gives one exact isolated login command: ${typeof status === 'string' ? status : 'CLI error'}`, () => {
    assert.throws(() => assertLogin({ command: "/arm/it's claude", env: { CLAUDE_CONFIG_DIR: config } }, { run() {
      if (status instanceof Error) throw status;
      return status;
    } }), error => {
      assert.match(error.message, /Fix: env -i .*CLAUDE_CONFIG_DIR=.*auth.*login/);
      assert.ok(error.message.includes(config));
      assert.ok(!error.message.includes('secret stderr'));
      return true;
    });
  });
}
test('login preflight never inspects the default owner config, including a symlink alias', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-preflight-')); t.after(() => removeTemp(dir));
  assert.throws(() => assertLogin({ command: 'claude', env: {} }, { run: () => assert.fail('must not run') }), /isolated/);
  assert.throws(() => assertLogin({ command: 'claude', env: { CLAUDE_CONFIG_DIR: '/owner/.claude' } },
    { home: '/owner', run: () => assert.fail('must not run') }), /isolated/);
  mkdirSync(join(dir, '.claude')); symlinkSync(join(dir, '.claude'), join(dir, 'alias'));
  assert.throws(() => assertLogin({ command: 'claude', env: { CLAUDE_CONFIG_DIR: join(dir, 'alias') } },
    { home: dir, run: () => assert.fail('must not run') }), /isolated/);
});
test('spend admission refuses unresolved markers across months and a current cap, without changing the ledger', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-preflight-')); t.after(() => removeTemp(dir));
  const file = join(dir, 'spend.json'), now = new Date('2026-10-14T00:00:00Z');
  assert.equal(assertSpend({ file, now }), 0);
  for (const value of [{ month: '2020-01', usd: 1, unpriced: true }, { month: '2026-10', usd: 190 }, { usd: 'bad' }]) {
    const bytes = JSON.stringify(value); writeFileSync(file, bytes);
    assert.throws(() => assertSpend({ file, capUsd: 190, now }), /Fix: .*nano/);
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
  writeFileSync(file, '{"month":"2020-01","usd":195}');
  assert.equal(assertSpend({ file, now, capUsd: 190 }), 0);
});

function socketFixture({ silent = false, error = false, truncated = false } = {}) {
  const socket = new EventEmitter(); let destroyed = 0;
  socket.destroy = () => { destroyed++; };
  const writes = [];
  socket.write = frame => {
    const value = JSON.parse(frame.subarray(4)); writes.push(value);
    if (value.id && !silent) queueMicrotask(() => {
      const body = Buffer.from(JSON.stringify(error ? { id: value.id, error: { message: 'denied' } } : { id: value.id, result: [] }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      const reply = Buffer.concat([header, body]);
      socket.emit('data', reply.subarray(0, 3));
      if (!truncated) socket.emit('data', reply.subarray(3));
    });
  };
  return { socket, writes, destroyed: () => destroyed, connect: () => { queueMicrotask(() => socket.emit('connect')); return socket; } };
}
test('FowlBrowser preflight authenticates and waits for a read-only extension response, then closes its socket', async () => {
  const fixture = socketFixture();
  await probeSocket('/fixture/browser.sock', { token: 'private', connect: fixture.connect });
  assert.deepEqual(fixture.writes, [{ method: 'host.auth', params: { token: 'private' } }, { id: 1, method: 'tabs.listAll', params: {} }]);
  assert.equal(fixture.destroyed(), 1);
});
for (const options of [{ silent: true }, { error: true }, { truncated: true }]) {
  test(`a stale socket cannot pass from its filename or successful connection: ${JSON.stringify(options)}`, async () => {
    const fixture = socketFixture(options);
    await assert.rejects(probeSocket('/fixture/browser.sock', { token: 'private', connect: fixture.connect, timeoutMs: 15 }));
    assert.equal(fixture.destroyed(), 1);
  });
}
test('round selection applies task surfaces, only, swap and unattended takeover filtering', () => {
  assert.deepEqual(selectedTasks([{ name: 'a', browser: 'helium' }, { name: 'b', browser: 'chrome', surface: 'browser-use' },
    { name: 'c', browser: 'chrome', takeover: true }], { only: 'a,c', swap: true, surface: 'sleight' }),
  [{ name: 'a', browser: 'chrome', surface: 'sleight' }]);
});
test('Fowl preflights all selected monitor sockets before setup and checks login for every Claude arm', async () => {
  const calls = [];
  const tasks = [{ name: 'a', browser: 'helium', surface: 'sleight' }, { name: 'b', browser: 'chrome', surface: 'claude-cu' },
    { name: 'c', browser: 'chrome', surface: 'browser-use' }];
  await fowlPreflight({ tasks, model: 'haiku', home: '/fixture' }, {
    spend: () => calls.push('spend'), login: plan => calls.push(['login', plan.env.CLAUDE_CONFIG_DIR]),
    fowlSocket: browser => calls.push(browser), engineSockets: () => calls.push('engine'),
  });
  assert.ok(calls.includes('spend')); assert.ok(calls.includes('helium')); assert.ok(calls.includes('chrome'));
  assert.ok(calls.includes('engine'));
  assert.deepEqual(calls.filter(c => Array.isArray(c)), [['login', '/fixture/Library/Caches/sleight-bench/fowl-claude-config'],
    ['login', '/fixture/.config/sleight-bench/world/arms/claude-cu/claude']]);
});
test('an unpriced round or stale monitor socket prevents all task setup', async () => {
  let logins = 0;
  for (const which of ['spend', 'fowlSocket']) {
    await assert.rejects(fowlPreflight({ tasks: [{ name: 'a', browser: 'chrome', surface: 'sleight' },
      { name: 'b', browser: 'chrome', surface: 'browser-use' }], model: 'haiku', home: '/fixture' }, {
      spend: () => { if (which === 'spend') throw new Error('unpriced'); },
      fowlSocket: () => { if (which === 'fowlSocket') throw new Error('stale'); }, engineSockets() {}, login: () => logins++,
    }), new RegExp(which === 'spend' ? 'unpriced' : 'stale'));
  }
  assert.equal(logins, 0);
});
test('round wrapper runs preflights before touching its cache, lock or agent runner', () => {
  const source = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  const preflight = source.indexOf('node "$REPO/bench/fowl/preflight.mjs"');
  assert.ok(preflight >= 0);
  assert.ok(preflight < source.indexOf('[ -d "$DIR/.git" ]'));
  assert.ok(preflight < source.indexOf('mkdir /tmp/sleight-live.lock'));
});
test('the actual wrapper stops at an unresolved API marker before cloning, key lookup or locking', t => {
  const home = mkdtempSync(join(tmpdir(), 'sleight-preflight-')); t.after(() => removeTemp(home));
  const logs = join(home, 'Library/Logs/sleight'); mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'bench-api-spend.json'), '{"month":"2020-01","usd":0,"unpriced":true}');
  const tasks = join(home, 'tasks.json');
  writeFileSync(tasks, JSON.stringify([{ name: 'fixture', browser: 'chrome', surface: 'browser-use' }]));
  const result = spawnSync('/bin/sh', [new URL('../bench/fowl/rounds.sh', import.meta.url).pathname,
    '--model', 'haiku', '--tasks', tasks], { encoding: 'utf8', timeout: 10000,
    env: { HOME: home, PATH: process.env.PATH, USER: 'fixture' } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unpriced.*\nFix: 'nano'/);
  assert.equal(existsSync(join(home, 'Library/Caches/sleight-bench/fowlbrowser')), false);
});
test('a fresh Fowl cache gives the exact bootstrap command without cloning during preflight', t => {
  const home = mkdtempSync(join(tmpdir(), 'sleight-preflight-')); t.after(() => removeTemp(home));
  const result = spawnSync(process.execPath, [new URL('../bench/fowl/preflight.mjs', import.meta.url).pathname], {
    encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Fix: 'git' 'clone' '-q' 'https:\/\/github.com\/argofowl\/FowlBrowser'/);
  assert.equal(existsSync(join(home, 'Library/Caches/sleight-bench/fowlbrowser')), false);
});
test('relative round task paths resolve in the cache exactly as the runner resolves them', t => {
  const home = mkdtempSync(join(tmpdir(), 'sleight-preflight-')); t.after(() => removeTemp(home));
  const dir = join(home, 'Library/Caches/sleight-bench/fowlbrowser/tools/agents'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'empty.json'), '[]');
  const result = spawnSync(process.execPath, [new URL('../bench/fowl/preflight.mjs', import.meta.url).pathname,
    '--tasks', 'tools/agents/empty.json'], { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
});
