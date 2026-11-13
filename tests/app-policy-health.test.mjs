import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('the system secure-input provider calls the public HIToolbox API', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/DriverSession.swift', import.meta.url), 'utf8');
  const start = source.indexOf('static var system:');
  const end = source.indexOf('\nstruct DriverSessionSample', start);
  assert.ok(start > 0 && end > start);
  const system = source.slice(start, end);
  assert.match(system, /secureInput:\s*\{\s*IsSecureEventInputEnabled\(\)\s*\}/);
});

test('health reports changing secure input from fake providers in 20 of 20 samples', {
  skip: process.platform !== 'darwin', timeout: 300000,
}, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-policy-health-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'health.swift'), binary = join(root, 'health');
  const production = macDriverSource();
  const entry = production.indexOf('// Source: DriverMain.swift\n');
  assert.ok(entry > 0);
  // Only the public secure-input provider is fake. DriverSession's sampling,
  // DriverCore.health and JSON serialization are the production implementations.
  const fakeProviders = 'releaseSleep: { _ in 0 }, secureInput: { calls += 1; return held }))';
  const body = production.slice(0, entry);
  const patched = body.replace('releaseSleep: { _ in 0 }))', fakeProviders);
  assert.notEqual(patched, body);
  const harness = `
let core = DriverCore(fixture: [:])
while let line = readLine() {
    held = line == "true"
    var health = core.health()
    health["secureInputCalls"] = calls
    let data = try JSONSerialization.data(withJSONObject: health, options: [.sortedKeys])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
`;
  await writeFile(source, 'var held = false, calls = 0\n' + patched + harness);
  await promisify(execFile)('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], { maxBuffer: 65536 });
  t.diagnostic(`fake-only health binary ${(await stat(binary)).size} bytes`);
  const expected = Array.from({ length: 20 }, (_, i) => i % 2 === 0);
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { try { assert.equal(code, 0, stderr); assert.equal(stderr, ''); resolve(); } catch (error) { reject(error); } });
  });
  child.stdin.end(expected.join('\n') + '\n');
  await done;
  const replies = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 20);
  for (const [i, held] of expected.entries()) await t.test(`sample ${i + 1}: secureInput=${held}`, () => {
    assert.equal(replies[i].secureInput, held);
    assert.equal(replies[i].secureInputCalls, i + 1);
    assert.equal(replies[i].onConsole, true);
    assert.equal(replies[i].sessionLocked, false);
    assert.equal(replies[i].healthy, true);
  });
});
