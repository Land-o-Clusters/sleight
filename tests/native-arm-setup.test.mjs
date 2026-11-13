// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeArmPlan, prepareNativeArm } from '../bench/world/native-arms.mjs';
import { installNative, setupPlan } from '../bench/world/native-setup.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

test('Cua proxy has an explicit private socket and cannot launch a global daemon', () => {
  const plan = nativeArmPlan('cua', { armHome: `${MAC_TMP}/arms` });
  const server = plan.mcp.mcpServers.cua;
  assert.match(server.command, /^\/private\/tmp\/arms\/mcp-cua-arm\/CuaDriver.app\/Contents\/MacOS\/cua-driver$/);
  assert.deepEqual(server.args, ['mcp', `--socket=${MAC_TMP}/arms/mcp-cua-arm/driver.sock`]);
  assert.equal(server.env.CUA_DRIVER_EMBEDDED, '1');
  assert.equal(server.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, '0');
  assert.equal(server.env.CUA_TELEMETRY_ENABLED, '0');
  assert.equal(server.env.CUA_DRIVER_RS_UPDATE_CHECK, 'false');
  assert.equal(plan.identity.version, '0.34.0');
});

test('Peekaboo runs the pinned local MCP binary without a runtime installer', () => {
  const plan = nativeArmPlan('peekaboo', { armHome: `${MAC_TMP}/arms` });
  const server = plan.mcp.mcpServers.peekaboo;
  assert.match(server.command, /mcp-peekaboo-arm\/package\/peekaboo$/);
  assert.deepEqual(server.args, ['mcp', 'serve']);
  assert.equal(plan.identity.version, '4.9.2');
});

for (const name of ['cua', 'peekaboo']) test(`${name} setup dry run pins an artifact, prints grants and writes nothing`, () => {
  const temp = mkdtempSync(join(tmpdir(), 'sleight-native-plan-'));
  try {
    const target = join(temp, 'uncreated');
    const output = execFileSync('/bin/sh', [new URL(`../bench/world/arms/${name}/setup.sh`, import.meta.url).pathname,
      '--dry-run', '--dir', target, '--tcc-host', 'Fixture Terminal'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    const plan = JSON.parse(output);
    assert.equal(plan.version, name === 'cua' ? '0.34.0' : '4.9.2');
    assert.ok(plan.artifact.digest.length > 40);
    assert.ok(plan.grants.every(grant => /Accessibility|Screen Recording/.test(grant.permission)));
    assert.equal(plan.grants[0].app, name === 'cua' ? join(target, 'CuaDriver.app') : 'Fixture Terminal');
    assert.equal(existsSync(target), false);
    assert.equal(plan.installCommand, undefined);
    assert.equal(plan.ownerLogin[2], plan.world.setup.at(-1) + '/node_modules/.bin/claude');
    assert.match(plan.ownerLogin[1], /\/claude$/);
    assert.equal(plan.ownerLogin[1], `CLAUDE_CONFIG_DIR=${plan.env.CLAUDE_CONFIG_DIR}`);
    assert.equal(plan.world.ownerLogin, undefined);
    assert.equal(plan.mcp.mcpServers[name].env.DO_NOT_TRACK, '1');
    assert.equal(plan.runtimeUnaudited, true);
    assert.ok(Array.isArray(plan.runtimeWrites));
    if (name === 'cua') {
      assert.ok(plan.ownerStart.includes('--env'));
      for (const value of ['CUA_DRIVER_RS_TELEMETRY_ENABLED=0', 'CUA_TELEMETRY_ENABLED=0', 'CUA_DRIVER_RS_UPDATE_CHECK=false']) {
        assert.ok(plan.ownerStart.includes(value));
      }
      assert.ok(plan.untouched.includes('/Applications'));
      assert.ok(plan.untouched.includes('~/.local/bin'));
      assert.ok(plan.untouched.includes('shell rc files'));
      assert.ok(plan.runtimeWrites.some(path => path.endsWith('/.cua-driver')));
      assert.ok(plan.runtimeWrites.includes('$CUA_HOME/config.toml'));
      assert.ok(plan.runtimeWrites.some(path => path.endsWith('/.cua-driver/version_check.json')));
      assert.ok(plan.removal.includes(target));
      assert.ok(plan.removal.some(path => path.endsWith('/.cua-driver')));
    }
  } finally { removeTemp(temp); }
});

test('Peekaboo setup requires the exact operator hosting app before writing files', () => {
  assert.throws(() => execFileSync('/bin/sh', [new URL('../bench/world/arms/peekaboo/setup.sh', import.meta.url).pathname, '--dry-run'],
    { encoding: 'utf8', stdio: 'pipe' }), /--tcc-host/);
});

test('a bad checksum refuses before creating an arm or extracting anything', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'sleight-native-checksum-'));
  try {
    const plan = setupPlan('cua', ['--version', '0.34.0', '--dir', join(temp, 'arm')]);
    const calls = [];
    await assert.rejects(installNative(plan, { platform: 'darwin', download: async () => Buffer.from('wrong artifact'),
      run: command => { calls.push(command); throw new Error('outside git'); } }), /checksum/);
    assert.deepEqual(calls, ['/usr/bin/git']);
    assert.equal(existsSync(plan.cwd), false);
  } finally { removeTemp(temp); }
});

test('setup refuses an existing arm, wrong pin and unknown architecture', async () => {
  assert.throws(() => setupPlan('cua', ['--version', 'latest']), /pin/);
  assert.throws(() => nativeArmPlan('cua', { armHome: '/tmp/arms', arch: 'unknown' }), /artifact/);
  const temp = mkdtempSync(join(tmpdir(), 'sleight-native-existing-'));
  try {
    const plan = setupPlan('cua', ['--version', '0.34.0', '--dir', temp]);
    await assert.rejects(installNative(plan, { platform: 'darwin', download: () => assert.fail('no download') }), /already exists/);
  } finally { removeTemp(temp); }
});

test('the installed receipt and executable bytes are verified before MCP preparation', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sleight-native-receipt-'));
  try {
    const plan = nativeArmPlan('peekaboo', { armHome: temp });
    const command = plan.mcp.mcpServers.peekaboo.command;
    mkdirSync(join(plan.cwd, 'package'), { recursive: true });
    writeFileSync(command, 'inert fixture', { mode: 0o700 });
    writeFileSync(join(plan.cwd, 'package/package.json'), JSON.stringify({ name: '@steipete/peekaboo', version: '4.9.2' }));
    writeFileSync(join(plan.cwd, '.mcp.json'), JSON.stringify(plan.mcp));
    writeFileSync(join(plan.cwd, 'native-receipt.json'), JSON.stringify({ version: '4.9.2', artifact: plan.artifact,
      executableHash: createHash('sha256').update('inert fixture').digest('hex') }));
    const arm = prepareNativeArm('peekaboo', { root: '/fixture', armHome: temp });
    assert.deepEqual(arm.servers, ['peekaboo']);
    assert.equal(arm.identity.version, '4.9.2');
    assert.match(arm.env.CLAUDE_CONFIG_DIR, /mcp-peekaboo-arm\/claude$/);
    writeFileSync(command, 'changed fixture');
    assert.throws(() => prepareNativeArm('peekaboo', { root: '/fixture', armHome: temp }), /receipt/);
    writeFileSync(command, 'inert fixture');
    writeFileSync(join(plan.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { foreign: { command } } }));
    assert.throws(() => prepareNativeArm('peekaboo', { root: '/fixture', armHome: temp }), /configuration/);
  } finally { removeTemp(temp); }
});

test('Cua socket state is excluded from executable provenance', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sleight-native-socket-'));
  try {
    const plan = nativeArmPlan('cua', { armHome: temp });
    const command = plan.mcp.mcpServers.cua.command;
    mkdirSync(join(plan.cwd, 'CuaDriver.app/Contents/MacOS'), { recursive: true });
    writeFileSync(command, 'inert fixture', { mode: 0o700 });
    writeFileSync(join(plan.cwd, 'driver.sock'), 'mutable socket fixture');
    writeFileSync(join(plan.cwd, '.mcp.json'), JSON.stringify(plan.mcp));
    writeFileSync(join(plan.cwd, 'native-receipt.json'), JSON.stringify({ version: '0.34.0', artifact: plan.artifact,
      executableHash: createHash('sha256').update('inert fixture').digest('hex') }));
    const arm = prepareNativeArm('cua', { root: '/fixture', armHome: temp });
    assert.equal(arm.identity.servers.cua.artifacts.length, 1);
  } finally { removeTemp(temp); }
});
