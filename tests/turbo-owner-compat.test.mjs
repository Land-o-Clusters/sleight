import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as oldSetup from './fixtures/sealed-settings-int22/turbo-setup.mjs';
import * as setup from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { acceptedInstalledPackage, readInstalledConfig } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';

// The frozen writer has the same buildReceipt and store format as public 68efb315 (1.5.1).
// These packages are inert text fixtures. No executable, helper, app or real settings file is opened.
function fixture(t, { ownerVersion = '1.5.1', node = process.version } = {}) {
  const root = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-owner-compat-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text, mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode });
  };
  const owner = join(root, 'installed'), candidate = join(root, 'candidate');
  for (const [folder, version] of [[owner, ownerVersion], [candidate, '1.5.1']]) {
    put(join(folder, '.claude-plugin/plugin.json'), JSON.stringify({ version }));
    for (const file of ['lib/launch.mjs', 'bin/sleight-mcp', 'hooks/register.tsx', 'lib/direct-browser/host.mjs',
      'lib/direct-browser/native/peer-host.c', 'lib/direct-browser/native/consent-host.swift', 'lib/direct-browser/playwright-files.json']) {
      put(join(folder, file), `// inert ${folder === owner ? 'released' : 'development'} ${file}\n`);
    }
  }
  const home = join(root, 'home'), apps = join(root, 'Applications');
  put(join(apps, 'Google Chrome.app/Contents/MacOS/Google Chrome'), '#!/bin/sh\n', 0o755);
  const configPath = join(root, 'settings/turbo.json'), base = { configPath, home, apps, pluginRoot: candidate };
  // Only receipt metadata depends on process.version. Issue it with the frozen writer's own store path.
  const runtime = Object.getOwnPropertyDescriptor(process, 'version');
  try {
    Object.defineProperty(process, 'version', { ...runtime, value: node });
    assert.equal(oldSetup.ensureTurboConfig({ ...base, pluginRoot: owner }).action, 'wrote');
  } finally { Object.defineProperty(process, 'version', runtime); }
  const bytes = () => [configPath, setup.ownerPath(configPath)].map(file => readFileSync(file, 'utf8'));
  const edit = change => {
    const data = JSON.parse(readFileSync(configPath)); change(data);
    setup.writeConfigFile(configPath, data);
    setup.writeConfigFile(setup.ownerPath(configPath), { ...setup.readOwner(configPath),
      sha256: createHash('sha256').update(readFileSync(configPath)).digest('hex') });
  };
  return { root, owner, candidate, base, configPath, bytes, edit, before: bytes() };
}

function preserved(f, implementation = setup) {
  const data = JSON.parse(readFileSync(f.configPath));
  assert.equal(implementation.liveOtherOwner({ ...f.base, data })?.pluginRoot, f.owner);
  const result = implementation.ensureTurboConfig(f.base);
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'RECEIPT_FOR_OTHER_PACKAGE');
  assert.equal(result.owner, f.owner);
  assert.ok(result.message.includes(`belongs to sleight 1.5.1 at ${f.owner}, which is still installed`));
  assert.deepEqual(f.bytes(), f.before, 'both operator files must remain byte-for-byte unchanged');
  const diagnosis = implementation.turboDiagnosis(f.base);
  assert.equal(diagnosis.reason, 'RECEIPT_FOR_OTHER_PACKAGE');
  assert.equal(diagnosis.owner.pluginRoot, f.owner);
}

function takenOver(f, implementation = setup) {
  const result = implementation.ensureTurboConfig(f.base);
  assert.equal(result.action, 'wrote');
  assert.equal(setup.readOwner(f.configPath).pluginRoot, f.candidate);
  assert.equal(acceptedInstalledPackage(readInstalledConfig(f.configPath), { pluginRoot: f.candidate }).current(), true);
}

for (const node of [process.version, 'v24.22.1', 'v0.0.1']) {
  test(`a live 1.5.1 receipt issued by the old writer on ${node} stays with its owner`, t => {
    const f = fixture(t, { node });
    preserved(f);
    if (node !== process.version) {
      assert.throws(() => acceptedInstalledPackage(JSON.parse(f.before[0]), { pluginRoot: f.owner }), /DISTRIBUTION_ACCEPTANCE_REQUIRED/,
        'preserving ownership must not relax runtime acceptance');
    }
  });
}

for (const [name, change] of [
  ['unknown receipt field', data => { data.receipt.future = 1; }],
  ['older receipt without helperMode', data => { delete data.receipt.helperMode; }],
  ['unknown receipt protocol', data => { data.receipt.protocol = 2; }],
  ['unrecognized file records', data => { data.receipt.files = [{ name: 'legacy-inventory' }]; }],
  ['unrecognized entry hashes', data => { data.entryHashes = {}; }],
]) {
  test(`an unchanged other owner survives a validator that cannot judge ${name}`, t => {
    const f = fixture(t); f.edit(change); f.before = f.bytes(); preserved(f);
  });
}

for (const node of [process.version, 'v24.22.1']) {
  for (const retirement of ['lower version', 'orphaned', 'deleted', 'changed', 'added file', 'removed file']) {
    test(`a ${retirement} owner hands over a ${node} receipt`, t => {
      const f = fixture(t, { node, ownerVersion: retirement === 'lower version' ? '1.5.0' : '1.5.1' });
      if (retirement === 'orphaned') writeFileSync(join(f.owner, '.orphaned_at'), 'fixture\n');
      if (retirement === 'deleted') rmSync(f.owner, { recursive: true });
      if (retirement === 'changed') writeFileSync(join(f.owner, 'lib/launch.mjs'), '// changed\n');
      if (retirement === 'added file') writeFileSync(join(f.owner, 'new.txt'), 'new\n');
      if (retirement === 'removed file') rmSync(join(f.owner, 'lib/launch.mjs'));
      takenOver(f);
    });
  }
}

for (const retirement of ['lower version', 'orphaned', 'deleted']) {
  test(`an unfamiliar receipt still hands over for a ${retirement} owner`, t => {
    const f = fixture(t, { ownerVersion: retirement === 'lower version' ? '1.5.0' : '1.5.1' });
    f.edit(data => { data.receipt.protocol = 2; });
    if (retirement === 'orphaned') writeFileSync(join(f.owner, '.orphaned_at'), 'fixture\n');
    if (retirement === 'deleted') rmSync(f.owner, { recursive: true });
    takenOver(f);
  });
}

test('the same copy can refresh its own Node receipt', t => {
  const f = fixture(t, { node: 'v24.22.1' });
  const result = setup.ensureTurboConfig({ ...f.base, pluginRoot: f.owner });
  assert.equal(result.action, 'wrote'); assert.equal(result.reason, 'node-changed');
  assert.equal(setup.readOwner(f.configPath).pluginRoot, f.owner);
});

test('explicit turbo on still moves a live older-runtime receipt', t => {
  const f = fixture(t, { node: 'v24.22.1' });
  assert.equal(setup.turboCommand(['on'], { ...f.base, out() {} }), 0);
  assert.equal(setup.readOwner(f.configPath).pluginRoot, f.candidate);
});

// Each broken implementation must violate an observable ownership or handover contract.
// Only this module's source is changed in memory. Dependencies remain the real production modules.
const setupURL = new URL('../plugins/sleight/lib/direct-browser/turbo-setup.mjs', import.meta.url);
const source = readFileSync(setupURL, 'utf8');
const variants = [
  ['startup bypasses Node changes', "if (seen.state === 'stale') {", "if (seen.reason === 'package-changed') {",
    f => {}, preserved, { node: 'v24.22.1' }],
  ['doctor bypasses Node changes', "const owner = seen.state === 'stale' ?", "const owner = seen.reason === 'package-changed' ?",
    f => {}, preserved, { node: 'v24.22.1' }],
  ['ownership requires this runtime', 'receipt: { ...data?.receipt, node: process.version }', 'receipt: data?.receipt',
    f => writeFileSync(join(f.owner, 'lib/launch.mjs'), '// changed\n'), takenOver, { node: 'v24.22.1' }],
  ['unfamiliar receipts lose their owner', 'catch { return owner; } // An unfamiliar receipt',
    'catch { return undefined; } // An unfamiliar receipt',
    f => { f.edit(data => { data.receipt.protocol = 2; }); f.before = f.bytes(); }, preserved],
  ['changed packages retain ownership', 'return inventory.current() ? owner : undefined;', 'return owner;',
    f => writeFileSync(join(f.owner, 'lib/launch.mjs'), '// changed\n'), takenOver],
  ['lower versions retain ownership', "if (order !== null && order < 0 || existsSync(join(owner.pluginRoot, '.orphaned_at')))",
    "if (existsSync(join(owner.pluginRoot, '.orphaned_at')))", f => {}, takenOver, { ownerVersion: '1.5.0' }],
  ['orphaned copies retain ownership', "if (order !== null && order < 0 || existsSync(join(owner.pluginRoot, '.orphaned_at')))",
    'if (order !== null && order < 0)',
    f => { f.edit(data => { data.receipt.protocol = 2; }); writeFileSync(join(f.owner, '.orphaned_at'), 'fixture\n'); }, takenOver],
  ['deleted unknown owners retain ownership', "return error.code === 'ENOENT' ? undefined : owner;", 'return owner;',
    f => { f.edit(data => { data.receipt.protocol = 2; }); rmSync(f.owner, { recursive: true }); }, takenOver],
];
for (const [name, before, after, prepare, contract, options] of variants) {
  test(`broken variant is caught: ${name}`, async t => {
    assert.equal(source.split(before).length, 2, 'mutation anchor must occur exactly once');
    const mutated = source.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
      (_match, _quote, path) => `from '${new URL(path, setupURL).href}'`);
    const implementation = await import(`data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}`);
    const f = fixture(t, options); prepare(f);
    assert.throws(() => contract(f, implementation), { code: 'ERR_ASSERTION' });
  });
}
