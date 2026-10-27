import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { createElectronConsent, createGrantStore } from '../plugins/sleight/lib/direct-browser/electron-consent.mjs';
import { instance } from './fixtures/electron-app.mjs';

const sourcePath = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');

test('protected consent buttons use the input guard on every native card', () => {
  assert.match(source, /BEGIN PERSON INPUT/);
  assert.equal((source.match(/personModal\(alert, choices:/g) ?? []).length, 3);
  assert.doesNotMatch(source, /\.post\(|CGEventPost|AXUIElementPerformAction|activate\(ignoringOtherApps/);
  const card = source.match(/\/\/ BEGIN ASK CARD\n([\s\S]*?)\/\/ END ASK CARD/)?.[1];
  assert.ok(card, 'styled shell card absent');
  assert.match(card, /if personChoice\(card.kind, choices\[index\]\) \{[\s\S]*actions.append\(ConsentInputAction\(button, mouseOnly: passive\)\)/);
  assert.match(card, /if kind == "app" \{[\s\S]*view\["scope"\][\s\S]*operation\["scope"\]/);
  assert.match(card, /choices == \["once", "cancel"\]/);
  assert.match(card, /NSGlassEffectView/);
  assert.match(card, /if passive \{ panel.orderFrontRegardless\(\) \} else \{ panel.makeKeyAndOrderFront\(nil\) \}/);
  assert.match(card, /NSSound\(named: "Glass"\)\?\.play\(\)/);
  assert.doesNotMatch(card, /keyEquivalent = "(?:\\r|\\n)"|\.runModal\(/);
  assert.match(card, /actions.removeAll\(\)/);
  assert.match(source, /closeAsk\(\); modal.close\(\); pending.removeAll\(\)/);
  assert.match(source, /Opening is independent[\s\S]*?showNextAsk\(\)/);
});

test('Swift consent input fixture refuses AX and posted input but admits a HID event seam', { skip: macCommandSkip('xcrun') }, async t => {
  const block = source.match(/\/\/ BEGIN PERSON INPUT\n([\s\S]*?)\/\/ END PERSON INPUT/);
  assert.ok(block, 'person input guard absent');
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-input-')))));
  const binary = join(dir, 'fixture'), swift = join(dir, 'main.swift');
  // Observe the production refusal function without changing any input or dispatch decision.
  assert.equal(block[1].split('proc_pidpath(').length, 2, 'one process-path lookup seam');
  const observed = block[1].replace('proc_pidpath(', 'fixtureProcPidPath(').replace('let reason = tooSoon ? "CONSENT_TOO_SOON" : "PERSON_INPUT_REQUIRED"',
    'let reason = tooSoon ? "CONSENT_TOO_SOON" : "PERSON_INPUT_REQUIRED"\n    fixtureRefusals.append(reason)');
  writeFileSync(swift, 'import AppKit\nimport Carbon.HIToolbox\nimport ObjectiveC\nimport Darwin\nimport os.log\nvar fixtureRefusals: [String] = []\n' + readFileSync(new URL('./fixtures/consent-person-path.swift', import.meta.url), 'utf8') + observed + readFileSync(new URL('./fixtures/consent-person-input.swift', import.meta.url), 'utf8'));
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const receipts = JSON.parse(run.stdout);
  assert.deepEqual(receipts, { refused: [], accepted: ['Always allow', 'Always allow', 'Allow this session', 'Decline', 'Always allow'],
    handoffRefusals: Array(5).fill('PERSON_INPUT_REQUIRED') });
  assert.ok(run.stderr.trim().split('\n').every(line => line === 'sleight consent refused: PERSON_INPUT_REQUIRED'));
  // Send only receipts that crossed the native action to the actual grant pipeline. A refused input emits none.
  const path = join(dir, 'grants.json'), store = createGrantStore({ path }), presented = [];
  const authenticated = new WeakSet();
  const ui = { authenticate: event => authenticated.delete(event), present(id, data, choices, deliver) { presented.push({ id, deliver }); } };
  const consent = createElectronConsent({ ui, store, engineApproval: () => 'approved' });
  const pending = consent.requestDebugger(instance, { session: 's1', turn: 't1' });
  const deliver = (index, choice) => {
    const card = presented[index], event = { id: card.id, choice };
    authenticated.add(event); card.deliver(event);
  };
  for (const choice of receipts.refused) deliver(0, choice);
  assert.equal(consent.pending(), 1);
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(path), false, 'AX and posted input write no pre-approval');
  deliver(0, receipts.accepted[2] === 'Allow this session' ? 'session' : 'invalid');
  assert.equal((await pending).grant.scope, 'session');
  assert.equal(existsSync(path), false, 'session AX never persists');
  const hid = consent.requestDebugger(instance, { session: 's2', turn: 't2' });
  deliver(1, receipts.accepted[0] === 'Always allow' ? 'always' : 'invalid');
  assert.equal((await hid).persisted, true);
  assert.equal(store.list().length, 1, 'HID seam reaches the persistent grant path');
});

test('the complete Swift consent helper compiles without launching it', { skip: macCommandSkip('xcrun') }, t => {
  const dir = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-consent-build-'))));
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), sourcePath.pathname, '-o', join(dir, 'consent-host')], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
});
