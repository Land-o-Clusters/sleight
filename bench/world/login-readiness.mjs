// Read-only login readiness for the native world suite's Claude arms (owner, 2026-10-15: every
// benchmark Claude arm runs on the account login, never API credit). Each arm has its own isolated
// CLAUDE_CONFIG_DIR, so each needs its own login. The check is the one the fowl rounds use
// (assertLogin in ../preflight.mjs: `claude auth status --json` against that config). It starts no
// MCP server, no app and no model call.
//
//   node bench/world/login-readiness.mjs [--arm sleight,lcu,cua,peekaboo,claude-cu] [--json]
//
// Exit 1 when any arm is not logged in. run.mjs prints the same command when it refuses.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLogin, loginFix, quote } from '../preflight.mjs';
import { nativeArmPlan, isNativeArm } from './native-arms.mjs';
import { worldCLI } from './native-world.mjs';
import { loginReadiness as cursorLoginReadiness } from './arms/cursor-cu/setup.mjs';

export const LOGIN_ARMS = ['sleight', 'lcu', 'cua', 'peekaboo', 'claude-cu'];
export const defaultArmHome = (env = process.env, home = homedir()) => env.BENCH_ARM_HOME || join(home, 'Library', 'Caches', 'sleight-bench');

// The folder each arm runs from. run.mjs builds the same paths: its config dir is <folder>/claude.
export function armFolder(name, { armHome, env = process.env }) {
  if (name === 'sleight') return env.SLEIGHT_ARM_DIR || join(armHome, 'sleight-arm');
  if (name === 'lcu') return env.LCU_ARM_DIR || join(armHome, 'lcu-arm');
  if (name === 'claude-cu') return join(armHome, 'claude-cu');
  if (isNativeArm(name)) return nativeArmPlan(name, { armHome }).cwd;
  throw new Error(`${name} is not a Claude-driven native arm (${LOGIN_ARMS.join(', ')})`);
}

// claude-cu has its own pinned CLI inside its arm root. The other four share the world CLI.
export function loginTarget(name, { armHome, env = process.env }) {
  const folder = armFolder(name, { armHome, env });
  const own = name === 'claude-cu';
  return { arm: name, config: join(folder, 'claude'), command: own ? join(folder, 'node_modules/.bin/claude') : worldCLI(armHome),
    setup: own ? `sh bench/world/arms/claude-cu/setup.sh ${quote(folder)}` : 'node bench/world/native-world.mjs --setup' };
}

// Rows for the given arms. Codex is native Codex on its own login, so it has no row here.
export function worldLoginReadiness(arms = LOGIN_ARMS, { armHome = defaultArmHome(), env = process.env, home = homedir(),
  login = assertLogin, exists = existsSync, cursorReadiness = cursorLoginReadiness } = {}) {
  // USER and LOGNAME as the runs have them (armEnv keeps the host's): the keychain login is found by user.
  const base = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ...Object.fromEntries(['USER', 'LOGNAME'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]])) };
  return arms.filter(name => name !== 'codex').map(name => {
    if (name === 'cursor-cu') return cursorReadiness();
    const target = loginTarget(name, { armHome, env });
    const loginEnv = { ...base, CLAUDE_CONFIG_DIR: target.config };
    if (!exists(target.command)) return { ...target, loggedIn: false, reason: 'Claude CLI is not installed', fix: target.setup };
    try { login({ command: target.command, env: loginEnv }, { home }); return { ...target, loggedIn: true }; }
    catch (error) {
      if (!/^Not logged in/.test(error.message)) return { ...target, loggedIn: false, reason: error.message.split('\n')[0], fix: target.setup };
      return { ...target, loggedIn: false, reason: 'not logged in', fix: loginFix({ command: target.command, env: loginEnv }) };
    }
  });
}

export function formatReadiness(rows) {
  return rows.map(row => row.arm === 'cursor-cu' ? `cursor-cu  desktop login unverified\n  config: ${row.config}\n  Run: ${row.fix}` : `${row.arm.padEnd(10)} ${row.loggedIn ? 'logged in' : 'NOT LOGGED IN'}\n  config: ${row.config}` +
    (row.loggedIn ? '' : `\n  ${row.reason}. Run:\n  ${row.fix}`)).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--arm');
  const arms = i >= 0 ? process.argv[i + 1].split(',') : LOGIN_ARMS;
  const rows = worldLoginReadiness(arms);
  console.log(process.argv.includes('--json') ? JSON.stringify(rows, null, 2) : formatReadiness(rows));
  process.exitCode = rows.every(row => row.loggedIn === true) ? 0 : 1;
}
