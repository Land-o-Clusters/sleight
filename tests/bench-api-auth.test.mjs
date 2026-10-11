import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSpend, benchAuth, monthSpend, prepareConfigDir, readKey } from '../bench/api-auth.mjs';

const KEY = 'sk-ant-api03-abc_DEF-123';
function keyFile(content = KEY, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-key-'));
  const file = join(dir, 'anthropic-api-key');
  writeFileSync(file, content); chmodSync(file, mode);
  return { dir, file };
}

test('a private key file is read; a missing one means no key', () => {
  assert.equal(readKey(keyFile(`${KEY}\n`).file), KEY);
  assert.equal(readKey(join(tmpdir(), 'no-such-bench-key')), undefined);
});

test('the key file must be private, the owner\'s, a regular file and one key', () => {
  assert.throws(() => readKey(keyFile(KEY, 0o644).file), /readable by others/);
  assert.throws(() => readKey(keyFile(KEY).file, { uid: process.getuid() + 1 }), /owned by you/);
  assert.throws(() => readKey(keyFile('not a key').file), /one Anthropic API key/);
  assert.throws(() => readKey(keyFile(`${KEY}\n${KEY}`).file), /one Anthropic API key/);
  const { dir, file } = keyFile();
  const link = join(dir, 'link');
  symlinkSync(file, link);
  assert.throws(() => readKey(link), /not a link/);
});

test('spend adds up within a month and starts over in the next', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'bench-ledger-')), 'spend.json');
  const oct = new Date('2026-10-10T05:00:00Z'), nov = new Date('2026-11-01T00:00:00Z');
  assert.equal(monthSpend(ledger, oct), 0);
  addSpend(0.25, ledger, oct); addSpend(1.5, ledger, oct);
  assert.equal(addSpend(undefined, ledger, oct), 1.75);
  assert.equal(monthSpend(ledger, oct), 1.75);
  assert.equal(monthSpend(ledger, nov), 0);
  assert.equal(addSpend(2, ledger, nov), 2);
});

test('auto uses the key when present, api requires it, login never uses it, and the cap refuses', () => {
  const { file } = keyFile();
  const ledger = join(mkdtempSync(join(tmpdir(), 'bench-ledger-')), 'spend.json');
  const now = new Date('2026-10-10T05:00:00Z');
  const configDir = join(mkdtempSync(join(tmpdir(), 'bench-config-')), 'claude-config');
  const prepared = [];
  const api = benchAuth({ keyFile: file, ledgerFile: ledger, now, configDir, prepare: options => prepared.push(options.dir) });
  assert.equal(api.mode, 'api');
  assert.deepEqual(api.env, { ANTHROPIC_API_KEY: KEY, CLAUDE_CONFIG_DIR: configDir });
  assert.deepEqual(prepared, [configDir]);
  assert.deepEqual(api.unset, ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
  assert.equal(benchAuth({ mode: 'login', keyFile: file, ledgerFile: ledger, now }).mode, 'login');
  const missing = join(tmpdir(), 'no-such-bench-key');
  assert.equal(benchAuth({ keyFile: missing, ledgerFile: ledger, now }).mode, 'login');
  assert.throws(() => benchAuth({ mode: 'api', keyFile: missing, ledgerFile: ledger, now }), /needs a key/);
  assert.throws(() => benchAuth({ mode: 'other' }), /auto, api or login/);
  addSpend(150, ledger, now);
  assert.throws(() => benchAuth({ keyFile: file, ledgerFile: ledger, now, capUsd: 150 }), /\$150 cap/);
  assert.equal(benchAuth({ mode: 'login', keyFile: file, ledgerFile: ledger, now, capUsd: 150 }).mode, 'login');
});

test('run cost comes from token counts at API prices, and an unknown model keeps the reported cost', async () => {
  const { runCost } = await import('../bench/api-auth.mjs');
  // The tiny Haiku run of 2026-10-10: Claude Code reported $0.0639814.
  const haiku = { total_cost_usd: 0.0639814, modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 3387, cacheCreationInputTokens: 7902, costUSD: 0.0639814 } } };
  assert.equal(runCost(haiku), 0.0016165);
  const mixed = { modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1e6, outputTokens: 0 }, 'claude-future-9': { costUSD: 0.5 } } };
  assert.equal(runCost(mixed), 2.5);
  assert.equal(runCost({ total_cost_usd: 0.3 }), 0.3);
  assert.equal(runCost(undefined), undefined);
});

test('the arms\' config folder links the owner\'s settings and plugins but not their login', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-config-'));
  const source = join(root, 'claude'), dir = join(root, 'claude-config');
  mkdirSync(join(source, 'plugins'), { recursive: true });
  writeFileSync(join(source, 'settings.json'), '{}');
  writeFileSync(join(source, '.credentials.json'), '{}');
  writeFileSync(join(source, 'history.jsonl'), '');
  prepareConfigDir({ dir, source });
  prepareConfigDir({ dir, source });
  assert.equal(readlinkSync(join(dir, 'settings.json')), join(source, 'settings.json'));
  assert.equal(readlinkSync(join(dir, 'plugins')), join(source, 'plugins'));
  assert.equal(existsSync(join(dir, '.credentials.json')), false);
  assert.equal(existsSync(join(dir, 'history.jsonl')), false);
  assert.equal(existsSync(join(dir, 'skills')), false);
  assert.equal(lstatSync(dir).mode & 0o077, 0);
});
