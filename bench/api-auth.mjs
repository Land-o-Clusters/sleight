// The benchmark's Claude arms can run on an Anthropic API key instead of the owner's login.
// Runs on the login shared a rate limit with the owner's usage meter (OpenUsage got 429s after
// each pass, 2026-10-10), so the owner put the benchmark on their monthly API credit with a cap.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEY_FILE = join(homedir(), '.config', 'sleight-bench', 'anthropic-api-key');
export const LEDGER_FILE = join(homedir(), 'Library', 'Logs', 'sleight', 'bench-api-spend.json');
export const DEFAULT_CAP_USD = 200;

const month = (now = new Date()) => now.toISOString().slice(0, 7);

// The key file must be the owner's, a regular file, and readable by nobody else.
export function readKey(file = KEY_FILE, { uid = process.getuid() } = {}) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw new Error(`benchmark API key file ${file} can't be opened (${err.code}); it must be a regular file, not a link`);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`benchmark API key file ${file} isn't a regular file`);
    if (info.uid !== uid) throw new Error(`benchmark API key file ${file} isn't owned by you`);
    if (info.mode & 0o077) throw new Error(`benchmark API key file ${file} is readable by others; run chmod 600 on it`);
    const key = readFileSync(fd, 'utf8').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(key)) throw new Error(`benchmark API key file ${file} doesn't hold one Anthropic API key`);
    return key;
  } finally { closeSync(fd); }
}

export function monthSpend(file = LEDGER_FILE, now = new Date()) {
  try {
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    return ledger.month === month(now) && Number.isFinite(ledger.usd) ? ledger.usd : 0;
  } catch { return 0; }
}

export function addSpend(usd, file = LEDGER_FILE, now = new Date()) {
  if (!Number.isFinite(usd) || usd <= 0) return monthSpend(file, now);
  const total = monthSpend(file, now) + usd;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ month: month(now), usd: Math.round(total * 1e6) / 1e6 }) + '\n');
  renameSync(`${file}.tmp`, file);
  return total;
}

// mode: 'auto' uses the key when its file exists, 'api' requires it, 'login' never uses it.
// API mode refuses to start once this month's recorded spend reaches the cap, rather than falling
// back to the login without saying so.
export function benchAuth({ mode = 'auto', capUsd = DEFAULT_CAP_USD, keyFile = KEY_FILE, ledgerFile = LEDGER_FILE, now } = {}) {
  if (!['auto', 'api', 'login'].includes(mode)) throw new Error(`--auth must be auto, api or login, not ${mode}`);
  if (mode === 'login') return { mode: 'login', env: {}, unset: [] };
  const key = readKey(keyFile);
  if (!key) {
    if (mode === 'api') throw new Error(`--auth api needs a key in ${keyFile}`);
    return { mode: 'login', env: {}, unset: [] };
  }
  const spent = monthSpend(ledgerFile, now);
  if (spent >= capUsd) {
    throw new Error(`benchmark API spend this month is $${spent.toFixed(2)}, at the $${capUsd} cap ` +
      '(SLEIGHT_BENCH_API_CAP_USD). Raise the cap, or run on the login with --auth login.');
  }
  // An auth token or OAuth token in the environment would win over the key, so the arms drop them.
  return { mode: 'api', env: { ANTHROPIC_API_KEY: key }, unset: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], spent, capUsd };
}
