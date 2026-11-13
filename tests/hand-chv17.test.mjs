import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { passingPhase, passingPacing } from './fixtures/stage-cost-evidence.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { cursorCommand } from '../plugins/sleight/lib/hand/cursor-command.mjs';
import { cursorMenuModel } from '../plugins/sleight/lib/hand/cursor-picker.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';
import { checkBuiltinCharacter, resolveCharacterStates } from '../plugins/sleight/lib/hand/character.mjs';

// Run each old behavior independently. These imports preserve the real module's dependencies.
const variant = process.env.CHV17_BROKEN_VARIANT;
async function load(path, changes = {}) {
  const url = new URL(path, import.meta.url);
  if (!changes[variant]) return import(url.href);
  const [before, after] = changes[variant];
  let source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), `mutation site: ${variant}`);
  source = source.replaceAll(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  source = source.replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const settings = await load('../plugins/sleight/lib/hand/settings.mjs', {
  'old-default': ["DEFAULT_CHARACTER_SIZE = 'medium'", "DEFAULT_CHARACTER_SIZE = 'small'"],
});
const judge = await load('../bench/hand/stage-cost.mjs', {
  'old-rss': ['rssMiB: 160', 'rssMiB: 96'],
});
const live = await load('../bench/hand/stage-live.mjs', {
  'old-h5-scope': ["sizes.includes('stage') ? ['edge-lie', 'front-sit'] : []", "['edge-lie', 'front-sit']"],
});
const progress = await load('../bench/hand/stage-progress.mjs', {
  'old-h5-plan': ["return sizes.includes('stage') ? [...units, 'capture/edge-lie', 'capture/front-sit'] : units;",
    "return [...units, 'capture/edge-lie', 'capture/front-sit'];"],
});

test('CHV17 absent and legacy settings choose medium; saved choices and unrelated writes survive', async t => {
  const dir = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-chv17-settings-'))));
  const path = join(dir, 'hand.json'), selected = [];
  const read = () => settings.handSetting({ platform: 'darwin', env: {}, path });
  assert.equal(settings.DEFAULT_CHARACTER_SIZE, 'medium');
  assert.equal(read().size, 'medium');
  for (const size of [undefined, 'small', 'medium', 'stage', 315]) {
    const data = { version: 1, enabled: false, ...size === undefined ? {} : { size } };
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    assert.equal(read().size, size ?? 'medium');
    const expected = size ?? 'medium';
    let output = '';
    const opts = { platform: 'darwin', env: {}, path, built: () => false, out: s => { output += s; } };
    assert.equal(await cursorCommand(['status'], opts), 0);
    assert.match(output, new RegExp(`size      ${expected}(?: pt)?\\n`));
    assert.equal(await cursorCommand(['lines', 'off'], opts), 0, output);
    assert.equal(read().size, expected);
    assert.deepEqual(JSON.parse(readFileSync(path)), { ...data, lines: 'off' });
    const rows = cursorMenuModel({ installed: [{ id: 'cat', name: 'Cat' }], style: 'sprite', character: 'cat', size });
    selected.push(rows.find(r => r.title === 'Character Size').children.filter(r => r.selected).map(r => r.size));
  }
  assert.deepEqual(selected, [['medium'], ['small'], ['medium'], ['stage'], []]);
});

test('CHV17 wire retains explicit small and stage instead of erasing a saved small choice', () => {
  const pack = checkBuiltinCharacter('tsugi');
  for (const size of ['small', 'medium', 'stage', 315]) {
    const wire = characterFrame(pack, { nonce: 'a'.repeat(64), seq: 1, resolve: resolveCharacterStates, size });
    assert.equal(wire.size, size);
  }
});

test('CHV17 host starts at medium, preserves explicit sizes and keeps each shrinking ladder', { skip: process.platform !== 'darwin' }, t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-chv17-host-')));
  const host = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  let options = host.slice(host.indexOf('struct StageOptions {'), host.indexOf('func stageWindowEdgeDifference'));
  if (variant === 'old-host-default') options = options.replace('var size = "medium"', 'var size = "small"');
  const ladder = host.slice(host.indexOf('    func ladder(_ world: StageWorld)'), host.indexOf('    mutating func place(_ world: StageWorld'));
  const source = join(dir, 'main.swift'), binary = join(dir, 'host-options');
  writeFileSync(source, `import Foundation
import CoreGraphics
import CoreFoundation
${options}
struct StageWorld {
    var usable = CGRect(x: 0, y: 0, width: 1800, height: 1200)
    var inputAge = 20.0, person: CGRect? = nil
    var base = Base(), stageAvailable = true
    struct Base { var window = CGRect(x: 200, y: 500, width: 900, height: 350) }
}
struct Probe {
    var options: StageOptions, artProvider: Bool? = true, stageArt = true
${ladder}
}
let rows: [[String: Any]] = [[:], ["size": "small"], ["size": "medium"], ["size": "stage"], ["size": 315]]
let result = rows.map { row -> [String: Any] in
    let options = StageOptions.parse(row)!
    return ["size": options.size, "enabled": options.enabled,
        "ladder": Probe(options: options).ladder(StageWorld()).map { [$0.0, $0.1] as [Any] }]
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result))
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), source, '-o', binary],
    { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.deepEqual(rows.map(r => r.size), ['medium', 'small', 'medium', 'stage', 'stage']);
  assert.deepEqual(rows.map(r => r.enabled), [true, false, true, true, true]);
  assert.deepEqual(rows[0].ladder, [['medium', 184], ['small', 92]]);
  assert.deepEqual(rows[1].ladder, [['small', 92]]);
  assert.deepEqual(rows[3].ladder, [['stage', 432], ['three-quarter', 324], ['medium', 184], ['small', 92]]);
  assert.deepEqual(rows[4].ladder, [['stage', 315], ['three-quarter', 236.25], ['medium', 184], ['small', 92]]);
});

test('CHV17 RSS accepts 160 MiB tree and rejects larger peaks without changing other limits', () => {
  for (const [peak, expected] of [[119, 'pass'], [158, 'pass'], [160, 'pass'], [160.01, 'fail']]) {
    const phases = Object.fromEntries(['quiet', 'changing'].map(surface => [surface, { ...passingPhase('medium', surface), peakRssMiB: peak }]));
    const bank = { runs: [{ round: 1, sizes: { medium: { phases, dump: { cacheBytes: 24 * 1024 ** 2, resident2xStrips: 4 } } } }] };
    const result = judge.stageVerdict(bank);
    const check = result.runs[0].sizes.medium.checks.find(c => c.name === 'RSS and strip cache');
    assert.equal(check.limit, 160); assert.equal(check.verdict, expected);
    const report = judge.reportMarkdown(result);
    assert.match(report, /160 MiB limit covers the whole process tree, including the microphone worker/);
    assert.doesNotMatch(report, /96 MiB/);
  }
  assert.equal(judge.STAGE_BUDGET.wsAvgPct, 3);
  assert.equal(judge.STAGE_BUDGET.wsPeakPct, 8);
  assert.match(judge.dryRunPlan({ size: 'small' }).join('\n'), /160 MiB for the whole process tree including the microphone worker/);
});

test('CHV17 non-stage collections omit H5 in execution and resumable plans; stage still captures both seats', async () => {
  const machine = { mac: 'offline', macOS: 'offline', maximumHz: 120, machineId: 'offline' };
  const identity = progress.stageIdentity('a'.repeat(40), { sha256: 'b'.repeat(64) }, machine);
  for (const sizes of [['small'], ['medium'], ['stage'], ['small', 'medium', 'stage']]) {
    const captures = [], snapshots = []; let clock = 0;
    const bank = await live.collectStageEvidence({
      machine: async () => machine, behavior: async () => ({ placements: [{ seed: 17 }] }),
      baseline: async () => ({ activeS: 62, wsAvgPct: 1, wsPeakPct: 2 }),
      phase: async (size, surface) => ({ figures: passingPhase(size, surface), dump: {} }),
      pacing: async (size, hz, ms, metadata) => passingPacing(hz, ms, metadata),
      capture: async seat => { captures.push(seat); return { seat, size: 'stage' }; },
      qualification: async () => ({ loadAverageMax: 2, puddleWindowHeld: false }),
      observeQualification: () => ({ loadAverageMax: 2, puddleWindowHeld: false }),
      checkpoint: async bank => { snapshots[0] = structuredClone(bank); }, close: async () => {},
    }, { identity, sizes, now: () => new Date(1700000000000 + clock++).toISOString() });
    assert.deepEqual(captures, sizes.includes('stage') ? ['edge-lie', 'front-sit'] : []);
    assert.deepEqual(bank.collection.units.map(u => u.id), progress.stageUnitOrder(sizes));
    assert.equal(progress.stageCollectionSummary(bank).notRun, 0);
    assert.doesNotThrow(() => progress.validateStageResume(snapshots[0], { identity, sizes }));
    if (!sizes.includes('stage')) {
      assert.equal(judge.stageVerdict(bank).behavior.find(c => c.name === 'H5 stage capture').verdict, 'not-measured');
      assert.match(judge.dryRunPlan({ size: sizes[0] }).join('\n'), /H5: not collected/);
    }
  }
});
