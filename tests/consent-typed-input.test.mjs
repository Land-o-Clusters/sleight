import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');

test('typed consent runs only inside the native card and preserves GB12 button guards', () => {
  assert.match(source, /class ConsentWordField: NSTextField/);
  assert.match(source, /let typing = ConsentTyping\(actions\)/, 'NSAlert installs typed confirmation');
  assert.match(source, /typing = ConsentTyping\(actions\)/, 'styled card installs typed confirmation');
  assert.match(source, /typing\?\.invalidate\(\)/, 'dismissal destroys typed authority');
  assert.match(source, /personInput\(event.cgEvent\)/);
  assert.doesNotMatch(source, /CGEventPost|AXUIElementSetAttributeValue|\.post\(/);
});

test('real NSAlert and AskCardPanel events route Return to the typed choice without ordering windows', { skip: macCommandSkip('xcrun') }, t => {
  assert.match(source, /class ConsentWordField: NSTextField/, 'typed confirmation is missing');
  const blocks = ['PERSON INPUT', 'APP FRAME', 'ASK CARD'].map(name => {
    const block = source.split(`// BEGIN ${name}\n`)[1]?.split(`// END ${name}`)[0];
    assert.ok(block, name);
    // Headless seams supply hardware provenance and key-window/current-event state only.
    // Real NSEvents, window association, key equivalents and responder dispatch stay intact.
    return block.replaceAll('window.isKeyWindow', '(window === fixtureKeyWindow)')
      .replaceAll('personInput(event.cgEvent)', 'fixturePersonInput(event)');
  });
  const dir = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-typed-input-'))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import AppKit\nimport Foundation\nimport CoreFoundation\nimport QuartzCore\nimport Carbon.HIToolbox\nimport ObjectiveC\nimport Darwin\nimport os.log\n' + blocks.join('\n') + readFileSync(new URL('./fixtures/consent-typed-input.swift', import.meta.url), 'utf8'));
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, `${run.error ?? run.signal ?? ''}\n${run.stderr}${run.stdout}`);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.failures, []);
  for (const route of ['window', 'application', 'equivalent']) assert.ok(result.dispatches[route] > 0, route);
  assert.ok(result.checks >= 50, 'security and accessibility cases executed');
  assert.equal(result.visible, false);
  t.diagnostic(`${result.checks} native assertions; no window shown and no event posted`);
});
