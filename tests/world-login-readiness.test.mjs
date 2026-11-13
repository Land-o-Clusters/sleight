import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { LOGIN_ARMS, loginTarget, worldLoginReadiness, formatReadiness } from '../bench/world/login-readiness.mjs';
import { assertLogin, loginFix } from '../bench/preflight.mjs';
import { worldCLI } from '../bench/world/native-world.mjs';

const armHome = '/bank/sleight-bench', home = '/bank/home';
const opts = extra => ({ armHome, home, env: {}, exists: () => true, ...extra });
const loggedIn = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' });

test('each Claude arm gets its own config folder under its arm folder, and Codex has none', () => {
  const targets = LOGIN_ARMS.map(name => loginTarget(name, { armHome, env: {} }));
  assert.deepEqual(targets.map(t => t.config), ['sleight-arm', 'lcu-arm', 'mcp-cua-arm', 'mcp-peekaboo-arm', 'claude-cu'].map(dir => `${armHome}/${dir}/claude`));
  assert.equal(new Set(targets.map(t => t.config)).size, 5);
  for (const target of targets.filter(t => t.arm !== 'claude-cu')) assert.equal(target.command, worldCLI(armHome));
  assert.equal(targets.find(t => t.arm === 'claude-cu').command, `${armHome}/claude-cu/node_modules/.bin/claude`);
  assert.equal(worldLoginReadiness(['codex'], opts()).length, 0);
  assert.throws(() => loginTarget('codex', { armHome, env: {} }), /not a Claude-driven native arm/);
});

test('the arm folder overrides match run.mjs', () => {
  const env = { SLEIGHT_ARM_DIR: '/x/sleight', LCU_ARM_DIR: '/x/lcu' };
  assert.equal(loginTarget('sleight', { armHome, env }).config, '/x/sleight/claude');
  assert.equal(loginTarget('lcu', { armHome, env }).config, '/x/lcu/claude');
});

test('readiness reports each arm from its own config and prints the one login command', () => {
  const seen = [];
  const rows = worldLoginReadiness(undefined, opts({ login(plan, options) {
    seen.push(plan);
    if (/lcu-arm|claude-cu/.test(plan.env.CLAUDE_CONFIG_DIR)) return assertLogin(plan, { ...options, run() { return JSON.stringify({ loggedIn: false }); } });
    return assertLogin(plan, { ...options, run: () => loggedIn });
  } }));
  assert.deepEqual(rows.map(r => [r.arm, r.loggedIn]), [['sleight', true], ['lcu', false], ['cua', true], ['peekaboo', true], ['claude-cu', false]]);
  assert.equal(new Set(seen.map(plan => plan.env.CLAUDE_CONFIG_DIR)).size, 5);
  const lcu = rows.find(r => r.arm === 'lcu');
  assert.equal(lcu.fix, loginFix({ command: worldCLI(armHome), env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CLAUDE_CONFIG_DIR: lcu.config } }));
  assert.match(lcu.fix, /^env -i .*'CLAUDE_CONFIG_DIR=\/bank\/sleight-bench\/lcu-arm\/claude'.* 'auth' 'login'$/);
  const text = formatReadiness(rows);
  assert.match(text, /sleight\s+logged in/);
  assert.match(text, /lcu\s+NOT LOGGED IN[\s\S]*Run:\n  env -i /);
});

test('a missing Claude CLI is reported with its setup command, not a login command', () => {
  const rows = worldLoginReadiness(['sleight', 'claude-cu'], opts({ exists: () => false, login: () => assert.fail('no CLI, no status call') }));
  assert.ok(rows.every(r => !r.loggedIn && r.reason === 'Claude CLI is not installed'));
  assert.equal(rows[0].fix, 'node bench/world/native-world.mjs --setup');
  assert.equal(rows[1].fix, `sh bench/world/arms/claude-cu/setup.sh '${armHome}/claude-cu'`);
});

test('readiness never admits an API-key status as logged in', () => {
  const rows = worldLoginReadiness(['sleight'], opts({ login: plan => assertLogin(plan, { home, run: () => JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) }) }));
  assert.equal(rows[0].loggedIn, false);
});

test('the readiness script given only Codex checks nothing and exits 0', () => {
  const result = spawnSync(process.execPath, ['bench/world/login-readiness.mjs', '--arm', 'codex'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('USER and LOGNAME reach the status check and the printed login command, because macOS finds the keychain login by user', () => {
  const seen = [];
  const rows = worldLoginReadiness(['sleight'], opts({ env: { USER: 'owner', LOGNAME: 'owner' }, login(plan, options) {
    seen.push(plan.env); return assertLogin(plan, { ...options, run: (cmd, args, o) => { seen.push(o.env); return JSON.stringify({ loggedIn: false }); } });
  } }));
  assert.equal(seen[0].USER, 'owner'); assert.equal(seen[1].USER, 'owner'); assert.equal(seen[1].LOGNAME, 'owner');
  assert.match(rows[0].fix, /^env -i 'HOME=\/bank\/home' 'USER=owner' 'LOGNAME=owner' /);
});
