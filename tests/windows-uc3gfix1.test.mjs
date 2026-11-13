import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as collector from '../bench/windows/uc3f-collect.mjs';
import { minimalWindowsEnv, collectorWindowsEnv, UC3F_ROWS } from '../bench/windows/driver-sitting.mjs';
import { runUC3FSitting, verifyNetwork } from '../bench/windows/uc3f-sitting.mjs';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';

const now = 1793642400000;
const grant = { row: 'person-key-before', presence: 'away', token: 'c'.repeat(32),
  issuedUtc: new Date(now).toISOString(), expiresUtc: new Date(now + 900000).toISOString() };
function command(t, execute, api = collector) {
  assert.equal(typeof api.powershellCall, 'function');
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'uc3gfix1-')));
  writeFileSync(join(bank, 'lease.json'), JSON.stringify(grant));
  return api.powershellCall({ bank, lease: grant, ownerAway: true }, { now: () => now, validateBank() {}, execute });
}

test('collector frames stdin with a blank line and accepts only a final completion marker', async t => {
  let scripts = 0;
  const call = command(t, async (exe, args, settings) => {
    scripts++;
    assert.match(exe, /powershell\.exe$/i);
    assert.deepEqual(args.slice(-2), ['-Command', '-']);
    assert.ok(settings.input.endsWith('\n\n'));
    assert.match(settings.input, /\n\[Console\]::Out\.WriteLine\('SLEIGHT_GUEST_OK'\)\n} catch/);
    return { status: 0, stdout: '\uFEFF{"confirmed":true}\r\nSLEIGHT_GUEST_OK\r\n' };
  });
  assert.deepEqual(await call('preflight'), { confirmed: true });
  assert.equal(scripts, 1);
});

test('collector refuses silent, echoed, misplaced and incomplete markers and preserves native failures', async t => {
  for (const stdout of ['', '{}\n', 'prefixSLEIGHT_GUEST_OK\n', 'SLEIGHT_GUEST_OKsuffix\n',
    "[Console]::Out.WriteLine('SLEIGHT_GUEST_OK')\n}\n", '{}\nSLEIGHT_GUEST_OK\ntrailing\n']) {
    await assert.rejects(command(t, async () => ({ status: 0, stdout }))('preflight'), /GUEST_COMMAND_NOT_RUN/);
  }
  for (const failure of [{ status: 1, stderr: 'WINDOWS_REQUIRED' }, { status: 0, signal: 'SIGTERM' },
    { status: 0, reason: 'CHILD_TIMEOUT' }, { status: 0, cleanup: 'tree-unconfirmed' }]) {
    await assert.rejects(command(t, async () => ({ stdout: '{}\nSLEIGHT_GUEST_OK\n', ...failure }))('preflight'),
      failure.stderr ? /WINDOWS_REQUIRED/ : /GUEST_OPERATION_FAILED/);
  }
});

test('minimal guest environment retains exactly the eight required Windows variables', () => {
  const required = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'OS', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
  const env = Object.fromEntries(required.map(k => [k, 'fixture-' + k]));
  assert.deepEqual(collectorWindowsEnv({ ...env, PATH: 'bad', NODE_OPTIONS: 'bad', PRIVATE_TOKEN: 'bad',
    SLEIGHT_ALLOW_FORBIDDEN_TARGETS: '1' }), env);
  assert.deepEqual(collectorWindowsEnv({ OS: 'Windows_NT', TEMP: 1 }), { OS: 'Windows_NT' });
  const source = readFileSync(new URL('../bench/windows/uc3f-fixtures.mjs', import.meta.url), 'utf8');
  const launcherKeys = /foreach \(\$key in @\(([^)]+)\)\)/.exec(source)[1].split(',').map(s => s.replaceAll("'", ''));
  assert.deepEqual(minimalWindowsEnv(env), Object.fromEntries(launcherKeys.map(k => [k, env[k]])));
  assert.deepEqual(launcherKeys, ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']);
  for (const name of launcherKeys) {
    const broken = launcherKeys.filter(k => k !== name);
    assert.throws(() => assert.deepEqual(minimalWindowsEnv(env), Object.fromEntries(broken.map(k => [k, env[k]]))), assert.AssertionError);
  }
  const names = [...source.matchAll(/\$env:([A-Za-z]+)|Env:([A-Za-z]+\(x86\))/g)].map(m => m[1] ?? m[2]);
  assert.deepEqual([...new Set(names)].sort(), ['LOCALAPPDATA', 'OS', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot']);
});

async function mutant(file, before, after) {
  const url = new URL('../bench/windows/' + file, import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(before).length, 2, 'one mutation target');
  const changed = source.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, url).href}'`).replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}

test('collector blank-line and marker-check broken variants fail their behavioral assertions', async t => {
  const brokenFrame = await mutant('uc3f-fixtures.mjs', 'env, input, timeout: 60000', 'env, input: input.trimEnd(), timeout: 60000');
  const probe = api => command(t, async (_exe, _args, settings) => {
    assert.ok(settings.input.endsWith('\n\n'));
    return { status: 0, stdout: '{}\nSLEIGHT_GUEST_OK\n' };
  }, api)('preflight');
  await probe(collector);
  await assert.rejects(probe(brokenFrame), assert.AssertionError);
  const brokenMarker = await mutant('uc3f-fixtures.mjs', 'const output = guestCommandOutput(result.stdout);', 'const output = result.stdout;');
  const silent = api => assert.rejects(command(t, async () => ({ status: 0, stdout: '' }), api)('preflight'), /GUEST_COMMAND_NOT_RUN/);
  await silent(collector);
  await assert.rejects(silent(brokenMarker), assert.AssertionError);
});

test('dropping each required environment variable is caught, including the launch-only variables', async () => {
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'OS', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    const api = await mutant('driver-sitting.mjs', `'${name}'`, 'null');
    assert.throws(() => assert.deepEqual(api.collectorWindowsEnv({ [name]: 'fixture' }), { [name]: 'fixture' }), assert.AssertionError);
  }
});

test('runbook SSH example passes the real validator and its accept-new broken variant refuses', () => {
  const doc = readFileSync(new URL('../bench/windows/driver-sitting-runbook.md', import.meta.url), 'utf8');
  const config = /```sshconfig\n([\s\S]+?)```/.exec(doc)?.[1];
  assert.equal(verifyNetwork(config), '192.168.64.8');
  assert.throws(() => verifyNetwork(config.replace('StrictHostKeyChecking yes', 'StrictHostKeyChecking accept-new')), /SSH_CONFIG_UNSAFE/);
});
