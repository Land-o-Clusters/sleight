import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { stageRunGuard } from '../bench/hand/stage-live.mjs';

// Every named mutation runs separately and must fail a behavioral assertion.
const variant = process.env.CHV4K_BROKEN_VARIANT ?? process.env.CHV4G_BROKEN_VARIANT;
async function load(file, changes = {}) {
  const url = new URL('../bench/hand/' + file, import.meta.url);
  if (!changes[variant]) return import(url.href);
  let source = readFileSync(url, 'utf8');
  const [before, after] = changes[variant];
  assert.ok(source.includes(before), 'mutation site: ' + variant);
  source = source.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, q, path) => 'from ' + q + new URL(path, url).href + q).replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const sampler = await load('cost-sampler.mjs', {
  'drop-descendants': ['rssKb: tree.reduce((n, row) => n + row.rssKb, 0)', 'rssKb: root.rssKb'],
  'include-foreign': ['rows.filter(row => members.has(row.pid)).sort', 'rows.filter(row => true).sort'],
});
const meter = await load('stage-measurement.mjs', {
  'keep-decode': ['!decodeSample(s)', 'true'],
  'drop-parked': ['parkedEndpointTreeMiB: endpoint ? endpoint.rssKb / 1024 : null', 'parkedEndpointTreeMiB: null'],
});
const runner = await load('stage-renderer-rss.mjs', {
  'ignore-away': ['!ownerAwayFile || !exists(ownerAwayFile)', 'false'],
  'ignore-hold': ['if (hold)', 'if (false)'],
  'wrong-remainder': ['selfMiB - floorMiB - cacheUpperMiB', 'selfMiB - floorMiB'],
  'wrong-vmmap-column': ['residentMiB: memoryMiB(resident)', 'residentMiB: memoryMiB(virtual)'],
  'old-vmmap-regex': ['const m = row.exec(line);', String.raw`const m = /^\s*(.+?)\s+(\d+(?:\.\d+)?[BKMGTP]?)\s+(\d+(?:\.\d+)?[BKMGTP]?)\s+(\d+(?:\.\d+)?[BKMGTP]?)\s+(\d+(?:\.\d+)?[BKMGTP]?)(?:\s|$)/i.exec(line);`],
  'skip-script': ['await playSequence(sequence,', 'await playSequence({ steps: [] },'],
  'skip-vmmap': ['await vmmap(host.pid)', "'REGION TYPE VIRTUAL RESIDENT DIRTY SWAPPED\\nMALLOC 100M 20M 4M 0K'"],
  'uncapped-cache': ['Math.min(24 * MIB, [...files.values()].reduce((n, b) => n + b, 0))', '[...files.values()].reduce((n, b) => n + b, 0)'],
  'drop-exact-cache': ['cacheBytes: snapshot.cacheBytes', 'cacheBytes: undefined'],
  'ignore-downgrade': ['snapshot.size !== size', 'false'],
  'accept-foreign-snapshot': ['row.pid !== child.pid', 'false'],
  'allow-directory-marker': ['return lstatSync(path).isFile()', 'return true'],
  'malloc-case-sensitive': ['/^MALLOC(?:\\s|_|$)/i', '/^MALLOC(?:\\s|_|$)/'],
  'include-zone-table': ["if (/^\\s*MALLOC ZONE(?:\\s|$)/i.test(line)) break;", ''],
  'malloc-in-other': ['!malloc(n) && !cg(n) && !io(n)', '!cg(n) && !io(n)'],
  'ignore-textedit': ["if ((await live.appState('com.apple.TextEdit')).running)", 'if (false)'],
  'ignore-live-lock': ['error(e.message); return 3;', 'error(e.message); return 0;'],
  'disable-owner-watch': ['if (reason) guard.abort(Error(reason));', 'if (false) guard.abort(Error(reason));'],
  'mask-abort-reason': ['guard.signal.aborted ? guard.signal.reason : e', 'e'],
  'mask-collector-failure': ['if (failure) failure.hostExit = exit;', 'if (false) failure.hostExit = exit;'],
  'skip-sampler-cleanup': ['if (sampler) await sampler.stop({ finalSample: false });', ''],
  'skip-host-cleanup': ['const exit = await host.close();', 'const exit = { code: 0 };'],
  'skip-fixture-cleanup': ['await cleanup();', 'void cleanup;'],
  'unlock-before-cleanup': ['for (const cleanup of cleanups.reverse())', 'await unlock(); for (const cleanup of cleanups.reverse())'],
  'ignore-wait-check': ['do { check();', 'do { return; check();'],
});
const judge = await load('stage-cost.mjs', {
  'judge-filtered-peak': ["numeric('RSS and strip cache', metric('peakRssMiB')", "numeric('RSS and strip cache', 150"],
  'hide-memory-diagnostics': ["s.checks.find(c => c.name === 'RSS and strip cache')?.memoryDiagnostics?.[surface] ?? phase.memory", 'phase.memory'],
  'hide-renderer-figures': ["result.rendererRSS?.schema === 'sleight.renderer-rss/1'", 'false'],
  'drop-renderer-evidence': ['rendererRSS: evidence.rendererRSS ?? null', 'rendererRSS: null'],
  'omit-renderer-command': ['Collect it with node bench/hand/stage-renderer-rss.mjs --owner-away-file FILE --character DIR --out NEW_DIR; see renderer-rss.md.', ''],
});

test('RSS sampler includes grandchildren, separates self and preserves other hand isolation', async () => {
  const s = sampler.createCostSampler({ rootPid: 42, includeChildren: 'rss', ps: async () =>
    '42 1 0:01.00 102400 /bank/consent-host --hand\n' +
    '44 43 0:00.01 20480 /bank/consent-host --decode-sheet\n' +
    '43 42 0:00.02 12288 /bank/consent-host --stage-call-worker\n' +
    '99 1 0:03.00 999999 /other/consent-host --hand' });
  await s.sample();
  assert.deepEqual(Object.keys(s.samples[0].hosts), ['42']);
  const h = s.samples[0].hosts[42];
  assert.equal(h.rssKb, 135168); assert.equal(h.selfRssKb, 102400);
  assert.deepEqual(h.rssTree.map(r => [r.pid, r.kind]), [[42, 'host'], [43, 'worker'], [44, 'decode']]);
  const gone = sampler.createCostSampler({ rootPid: 42, includeChildren: 'rss', ps: async () => '' });
  await gone.sample(); assert.deepEqual(gone.samples[0].hosts, {});
});

const sample = (t, rss, children, pending, reply = 'status', self = rss - 12) => ({ t,
  hosts: { 42: { rssKb: rss * 1024, selfRssKb: self * 1024, tree: { liveChildren: children, startID: 'same' } } },
  status: { pid: 42, reply, pending } });
test('stage memory keeps 167 raw, 150 steady and the last parked endpoint including its worker', () => {
  const rows = [sample(0, 43, 0, 0), sample(1, 149, 1, 0), sample(2, 167, 2, 2),
    sample(3, 150, 1, undefined, 'tree'), sample(4, 150, 1, undefined, 'tree')];
  const m = meter.stageMemoryFigures(rows, rows[0], 42);
  assert.equal(m.treePeakMiB, 167); assert.equal(m.treePeakWithoutDecodeChildMiB, 150);
  assert.equal(m.parkedEndpointTreeMiB, 150); assert.equal(m.parkedEndpointSelfMiB, 138);
  assert.equal(m.excludedDecodeSamples, 1);
  assert.match(m.decodeClassification, /inferred/);
  const busyWorker = [sample(0, 168, 1, 2), ...rows.slice(-2)];
  assert.equal(meter.stageMemoryFigures(busyWorker, rows[0], 42).treePeakWithoutDecodeChildMiB, 168);
  const noEndpoint = meter.stageMemoryFigures(rows.slice(0, 3), rows[0], 42);
  assert.equal(noEndpoint.parkedEndpointTreeMiB, null);
  assert.equal(noEndpoint.treePeakWithoutDecodeChildMiB, null);
});

test('offline stage judgment recomputes diagnostics from raw samples and judges 167 against the 160 MiB tree limit', () => {
  const rows = [sample(0, 43, 0, 0), sample(1, 149, 1, 0), sample(2, 167, 2, 2),
    sample(3, 150, 1, undefined, 'tree'), sample(4, 150, 1, undefined, 'tree')];
  const memory = { fixtureSample: rows[0], treePeakMiB: 167 };
  const phase = { peakRssMiB: 167, memory };
  const result = judge.stageVerdict({ runs: [{ round: 1, sizes: { medium: { phases: { quiet: phase, changing: phase }, samples: { quiet: rows, changing: rows } } } }] });
  const rss = result.runs[0].sizes.medium.checks.find(c => c.name === 'RSS and strip cache');
  assert.equal(rss.value, 167); assert.equal(rss.limit, 160);
  const report = judge.reportMarkdown(result);
  assert.match(report, /raw peak 167 MiB \(judged\); parked endpoint tree 150 MiB/);
  assert.match(report, /peak excluding transient decode-child samples 150 MiB \(1 excluded\)/);
});

test('runner requires the explicit marker and hold absence, with dry run available offline', () => {
  assert.match(runner.rendererRefusal({ ownerAwayFile: undefined, platform: 'darwin', hold: false, exists: () => true }), /owner-away-file/);
  assert.match(runner.rendererRefusal({ ownerAwayFile: '/missing', platform: 'darwin', hold: false, exists: () => false }), /owner-away-file/);
  assert.match(runner.rendererRefusal({ ownerAwayFile: '/marker', platform: 'darwin', hold: true, exists: () => true }), /hold/);
  assert.equal(runner.rendererRefusal({ ownerAwayFile: '/marker', platform: 'darwin', hold: false, exists: () => true }), null);
  const directory = mkdtempSync(join(tmpdir(), 'renderer-marker-'));
  try { assert.match(runner.rendererRefusal({ ownerAwayFile: directory, platform: 'darwin', hold: false }), /owner-away-file/); }
  finally { rmSync(directory, { recursive: true, force: true }); }
  assert.throws(() => runner.parseArgs(['--owner-away']), /unknown/);
  assert.throws(() => runner.parseArgs(['--owner-away-file']), /path/);
  assert.throws(() => runner.parseArgs(['--size', 'giant']), /size/);
  const plan = runner.dryRunPlan(runner.parseArgs(['--dry-run', '--size', 'medium'])).join('\n');
  for (const text of ['--hand', '40 actions', 'TextEdit', 'vmmap --summary', 'empty host', 'NSRunningApplication', 'captures nothing']) assert.ok(plan.includes(text), text);
});

test('vmmap split uses resident bytes, preserves categories and refuses malformed summaries', () => {
  const raw = 'REGION TYPE                         VIRTUAL RESIDENT DIRTY SWAPPED\n' +
    'MALLOC                              1.0G 20.5M 4M 0K\n' +
    'CG image                            25M 12M 12M 0K\n' +
    'IOSurface                           16M 3M 3M 0K\n' +
    '__TEXT                              200M 50M 0K 0K\n';
  const split = runner.parseVmmapSummary(raw);
  assert.equal(split.malloc.residentMiB, 20.5); assert.equal(split.cgImage.residentMiB, 12);
  assert.equal(split.ioSurface.residentMiB, 3); assert.equal(split.other.residentMiB, 50);
  assert.equal(split.regions.length, 4);
  const wrapped = runner.parseVmmapSummary('                               VIRTUAL RESIDENT DIRTY SWAPPED\n' +
    'REGION TYPE                       SIZE SIZE SIZE SIZE\n' +
    'MALLOC                            1G 2M 1M 0K\nTOTAL 1G 2M 1M 0K');
  assert.equal(wrapped.malloc.residentMiB, 2); assert.equal(wrapped.regions.length, 1);
  assert.throws(() => runner.parseVmmapSummary('vmmap: cannot inspect process'), /summary/);
  assert.throws(() => runner.parseVmmapSummary('REGION TYPE VIRTUAL DIRTY\nMALLOC 20M 4M'), /RESIDENT/);
});

test('four-column summaries keep digits in names and all four sizes at the end', () => {
  const split = runner.parseVmmapSummary('REGION TYPE VIRTUAL RESIDENT DIRTY SWAPPED\n' +
    'App-Specific Tag 16 646.9M 5744K 5744K 0K\n' +
    'Tag 7 0 32 16 0\n');
  assert.deepEqual(split.regions, [
    { name: 'App-Specific Tag 16', virtualMiB: 646.9, residentMiB: 5744 / 1024,
      dirtyMiB: 5744 / 1024, swappedMiB: 0 },
    { name: 'Tag 7', virtualMiB: 0, residentMiB: 32 / 1024 ** 2,
      dirtyMiB: 16 / 1024 ** 2, swappedMiB: 0 },
  ]);
});

const capturedSummary = readFileSync(new URL('./fixtures/vmmap-summary-macos.txt', import.meta.url), 'utf8');
test('real macOS 27 summary counts all six mixed-case malloc region rows', () => {
  const split = runner.parseVmmapSummary(capturedSummary);
  const rows = split.regions.filter(r => r.name.startsWith('Malloc '));
  assert.deepEqual(rows.map(r => r.name), ['Malloc Guard Page', 'Malloc Metadata', 'Malloc Metadata metadata',
    'Malloc Small', 'Malloc Small (empty)', 'Malloc Tiny']);
  assert.equal(split.malloc.residentMiB, (0 + 176 + 272 + 3904 + 16 + 240) / 1024);
  assert.equal(split.malloc.residentMiB, rows.reduce((sum, r) => sum + r.residentMiB, 0));
  assert.ok(!capturedSummary.includes(['', 'Users', ''].join('/')));
});

test('real summary preserves numbered tags, stops at MALLOC ZONE and other excludes malloc', () => {
  const split = runner.parseVmmapSummary(capturedSummary);
  const regionTableOnly = runner.parseVmmapSummary(capturedSummary.split('MALLOC ZONE                         SIZE')[0]);
  assert.deepEqual(split, regionTableOnly);
  assert.ok(split.regions.every(r => !/DefaultMallocZone|objc-class_rw_t/.test(r.name)));
  assert.deepEqual(split.regions.find(r => r.name === 'App-Specific Tag 16'), {
    name: 'App-Specific Tag 16', virtualMiB: 646.9, residentMiB: 5744 / 1024,
    dirtyMiB: 5744 / 1024, swappedMiB: 0,
  });
  // Resident columns transcribed from the fixture, excluding the six Malloc rows.
  const otherMiB = (5744 + 0 + 16 + 0 + 16 + 176 + 0 + 1088 + 756 + 9293 +
    2473 + 889 + 1791 + 68 + 1410 + 32 + 245) / 1024 + (824 + 2352) / 1024 ** 2 +
    9.9 + 54.4 + 49.8 + 182.6;
  assert.ok(Math.abs(split.other.residentMiB - otherMiB) < 1e-9);
  assert.equal(split.cgImage.residentMiB, 0); assert.equal(split.ioSurface.residentMiB, 0);
});

test('stage report names measured renderer figures or gives the collection command without changing the judged bar', () => {
  const phase = { peakRssMiB: 167 };
  const evidence = { runs: [{ round: 1, sizes: { medium: { phases: { quiet: phase, changing: phase } } } }] };
  const absent = judge.reportMarkdown(judge.stageVerdict(evidence));
  assert.match(absent, /Renderer-only RSS is not measured\. Collect it with node bench\/hand\/stage-renderer-rss\.mjs --owner-away-file FILE --character DIR --out NEW_DIR/);
  const rendererRSS = { schema: 'sleight.renderer-rss/1', sizes: { medium: { selfMiB: 136, treeMiB: 148 } } };
  const result = judge.stageVerdict({ ...evidence, rendererRSS });
  const present = judge.reportMarkdown(result);
  assert.match(present, /Renderer-only RSS from bench\/hand\/stage-renderer-rss\.mjs: parked self 136 MiB; parked tree 148 MiB/);
  assert.doesNotMatch(present, /Renderer-only RSS is not measured/);
  assert.equal(result.runs[0].sizes.medium.checks.find(c => c.name === 'RSS and strip cache').value, 167);
  for (const bad of [{ selfMiB: null, treeMiB: 148 }, { selfMiB: -1, treeMiB: 148 }, { selfMiB: 136 }]) {
    const text = judge.reportMarkdown(judge.stageVerdict({ ...evidence, rendererRSS: { ...rendererRSS, sizes: { medium: bad } } }));
    assert.match(text, /Renderer-only RSS is not measured/);
  }
});

test('strip-cache bound deduplicates files and caps the decoded bytes at the product cache limit', () => {
  const row = (file, w, h, frames) => ({ file, cell: [w, h], frames });
  const first = row('a.png', 384, 416, 6);
  assert.equal(runner.stripCacheUpperBytes({ stage: { table: { a: first, b: first } } }), 3833856);
  const table = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, row(i + '.png', 384, 416, 6)]));
  assert.equal(runner.stripCacheUpperBytes({ stage: { table } }), 25165824);
  assert.throws(() => runner.stripCacheUpperBytes({ stage: { table: { bad: row('bad', -1, 2, 6) } } }), /dimensions/);
});

test('renderer table separates measured self and tree, bounds cache and never claims an exact remainder', () => {
  const figures = runner.rendererFigures({ floor: { selfRssKb: 40 * 1024 }, endpoint: { selfRssKb: 136 * 1024, rssKb: 148 * 1024 },
    cacheUpperBytes: 24 * 1024 ** 2 });
  assert.equal(figures.floorMiB, 40); assert.equal(figures.selfMiB, 136); assert.equal(figures.treeMiB, 148);
  assert.equal(figures.stripCacheMiB, null); assert.deepEqual(figures.stripCacheRangeMiB, [0, 24]);
  assert.deepEqual(figures.remainderRangeMiB, [72, 96]);
  const text = runner.reportMarkdown({ sizes: { stage: { ...figures, vmmap: { regions: [], malloc: { residentMiB: 20 }, cgImage: { residentMiB: 12 }, ioSurface: { residentMiB: 3 }, other: { residentMiB: 50 } } } } });
  for (const expected of ['## stage', 'empty host', 'Strip cache', '72', '96', 'MALLOC', 'CG image', 'IOSurface', 'unmeasured']) assert.ok(text.includes(expected), expected);
  const exact = runner.rendererFigures({ floor: { selfRssKb: 40 * 1024 }, endpoint: { selfRssKb: 136 * 1024, rssKb: 148 * 1024 },
    cacheBytes: 24 * 1024 ** 2 });
  assert.equal(exact.stripCacheMiB, 24); assert.equal(exact.remainderMiB, 72);
});

test('observer client rejects foreign PID and an incomplete reply, accepts split JSON and rejects concurrent requests', async () => {
  for (const fields of [{}, { pid: 99 }, { cacheBytes: null }]) {
    const child = new EventEmitter(); child.pid = 42;
    child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
    const snapshot = runner.rendererObserverClient(child);
    const pending = snapshot();
    await assert.rejects(snapshot(), /already pending/);
    const text = JSON.stringify({ pid: 42, loaded: true, cacheBytes: 123, pending: 0, ...fields });
    child.stdio[4].write(text.slice(0, 10)); child.stdio[4].write(text.slice(10) + '\n');
    if (Object.keys(fields).length) await assert.rejects(pending, /invalid/);
    else assert.equal((await pending).cacheBytes, 123);
  }
});

test('size collector plays all 40 actions after its floor, parks, samples descendants, vmmap once and closes on failure', async () => {
  for (const fail of [false, true]) {
    let clock = 0, closes = 0, maps = 0, loaded = false;
    const lines = [], events = [];
    const samples = [];
    const host = { pid: 42, snapshot: async () => ({ pid: 42, loaded, cacheBytes: loaded ? 24 * 1024 ** 2 : 0, pending: 0, shown: loaded,
      size: loaded ? 'stage' : null, requestedSize: 'stage' }), write: line => { const value = JSON.parse(line); lines.push(value); if (value.hand === 'character') loaded = true; },
      close: async () => { closes++; events.push('close'); return { code: 0 }; } };
    const result = runner.measureRendererSize({ size: 'stage', character: { frame: { hand: 'character' } },
      target: { pid: 7, id: 8, bounds: { x: 0, y: 0, width: 900, height: 600 } },
      startHost: async () => host, now: () => clock, wait: async ms => { clock += ms; },
      samplerFactory: options => {
        assert.equal(options.rootPid, 42); assert.equal(options.includeChildren, 'rss');
        const sample = async () => { samples.push({ t: clock, hosts: { 42: { selfRssKb: (loaded ? 136 : 40) * 1024, rssKb: (loaded ? 148 : 40) * 1024,
          rssTree: [{ pid: 42, kind: 'host' }, ...loaded ? [{ pid: 43, kind: 'worker' }] : []] } } }); events.push('sample'); };
        return { samples, sample, start: sample, pause: async () => {}, stop: async () => samples };
      }, vmmap: async pid => { assert.equal(pid, 42); maps++; events.push('vmmap'); if (fail) throw Error('map failed');
        return 'REGION TYPE VIRTUAL RESIDENT DIRTY SWAPPED\nMALLOC 100M 20M 4M 0K'; } });
    if (fail) await assert.rejects(result, /map failed/);
    else {
      const r = await result;
      assert.equal(r.floor.selfRssKb, 40 * 1024); assert.equal(r.endpoint.selfRssKb, 136 * 1024);
      assert.equal(r.stripCacheMiB, 24); assert.equal(r.remainderMiB, 72);
      assert.equal(r.actions.filter(a => a.frame.hand === 'act').length, 40);
      assert.ok(clock >= 128000); assert.equal(events.indexOf('vmmap'), events.length - 2);
    }
    assert.equal(lines.filter(l => l.hand === 'act').length, 40); assert.equal(maps, 1); assert.equal(closes, 1);
  }
});

test('collector closes a downgraded or hidden renderer instead of publishing a requested-size measurement', async () => {
  for (const changed of [{ size: 'medium' }, { shown: false }, { pending: 1 }]) {
    let loaded = false, clock = 0, closes = 0, maps = 0;
    const host = { pid: 42, snapshot: async () => ({ pid: 42, loaded, cacheBytes: loaded ? 1024 : 0, pending: 0,
      shown: loaded, size: 'stage', requestedSize: 'stage', ...loaded ? changed : {} }),
      write: line => { if (JSON.parse(line).hand === 'character') loaded = true; }, close: async () => { closes++; return { code: 0 }; } };
    const samples = [];
    const sample = async () => samples.push({ t: clock, hosts: { 42: { rssKb: 102400, selfRssKb: 102400, rssTree: [{ pid: 42, kind: 'host' }] } } });
    await assert.rejects(runner.measureRendererSize({ size: 'stage', character: { frame: { hand: 'character' } },
      target: { pid: 7, id: 8, bounds: { x: 0, y: 0, width: 900, height: 600 } }, startHost: async () => host,
      now: () => clock, wait: async ms => { clock += ms; }, vmmap: async () => { maps++; },
      samplerFactory: () => ({ samples, sample, start: sample, pause: async () => {}, stop: async () => {} }) }), /downgraded/);
    assert.equal(closes, 1); assert.equal(maps, 0);
  }
});

test('collector keeps the original collection error when closing the host returns SIGTERM', async () => {
  const events = [], failure = Error('owner-away marker lost');
  const host = { pid: 42, snapshot: async () => {}, close: async () => { events.push('host-close'); return { code: null, signal: 'SIGTERM' }; } };
  await assert.rejects(runner.measureRendererSize({ startHost: async () => host,
    samplerFactory: () => ({ stop: async () => events.push('sampler-stop') }),
    wait: async () => { throw failure; } }), error => {
    assert.equal(error, failure);
    assert.deepEqual(error.hostExit, { code: null, signal: 'SIGTERM' });
    return true;
  });
  assert.deepEqual(events, ['sampler-stop', 'host-close']);
});

// All paths and markers here are test-owned. No real app, compiler, sampler or live lock is used.
function mainFixture(t, mode) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-renderer-main-')));
  const marker = join(root, 'owner-away'), hold = join(root, 'hold'), out = join(root, 'out');
  if (mode !== 'missing-marker') writeFileSync(marker, '');
  if (mode === 'hold') writeFileSync(hold, '');
  const events = [], errors = [], logs = [];
  let work, guard;
  const args = ['--owner-away-file', marker, '--character', join(root, 'pack'), '--out', out, '--size', 'small'];
  const deps = {
    refuse: opts => runner.rendererRefusal({ ...opts, platform: 'darwin', hold: existsSync(hold) }),
    acquireLock: async () => {
      events.push('lock');
      if (mode === 'held-lock') throw Error('live lock held by another run');
      return async () => { events.push('unlock'); assert.ok(!work || !existsSync(work), 'work removed before unlock'); };
    },
    createGuard: options => {
      guard = stageRunGuard(options);
      return { ...guard, close: async () => { events.push('guard-close'); await guard.close(); } };
    },
    loadLive: async () => ({ appState: async bundle => {
      assert.equal(bundle, 'com.apple.TextEdit'); events.push('app-state');
      return { running: mode === 'textedit' };
    } }),
    prepare: async context => {
      events.push('prepare'); work = context.work;
      t.after(() => rmSync(work, { recursive: true, force: true }));
      context.cleanups.push(async () => { assert.ok(existsSync(work)); events.push('fixture-first'); },
        async () => { assert.ok(existsSync(work)); events.push('fixture-second'); });
      return { character: { identity: { fixture: true } } };
    },
    error: text => errors.push(text), log: text => logs.push(text),
  };
  return { root, marker, hold, out, events, errors, logs, args, deps, get guard() { return guard; }, get work() { return work; } };
}

for (const [mode, code, reason, events] of [
  ['missing-marker', 2, /owner-away-file/, []],
  ['hold', 2, /sleight-hold exists/, []],
  ['textedit', 1, /TextEdit is already running; left untouched/, ['lock', 'app-state', 'guard-close', 'unlock']],
  ['held-lock', 3, /live lock held/, ['lock']],
]) test(`main refuses ${mode} before preparation or collection`, async t => {
  const f = mainFixture(t, mode);
  f.deps.collect = async () => { assert.fail('collection must not start'); };
  assert.equal(await runner.main(f.args, f.deps), code);
  assert.match(f.errors.join('\n'), reason);
  assert.deepEqual(f.events, events);
  assert.equal(existsSync(f.out), false);
});

for (const mode of ['marker-loss', 'hold-arrives']) test(`main owner watch aborts on ${mode}, keeps its reason and awaits cleanup`, async t => {
  const f = mainFixture(t, mode);
  f.deps.collect = async () => runner.measureRendererSize({
    startHost: async () => ({ pid: 42, snapshot: async () => {}, close: async () => {
      f.events.push('host-close'); return { code: null, signal: 'SIGTERM' };
    } }),
    samplerFactory: () => ({ stop: async () => { f.events.push('sampler-stop'); } }),
    wait: async () => {
      f.events.push('collect-wait');
      if (mode === 'marker-loss') rmSync(f.marker); else writeFileSync(f.hold, '');
      // The actual 250 ms owner watch must abort even during an operation that does not call check().
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); f.guard.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1500);
        f.guard.signal.addEventListener('abort', finish, { once: true });
      });
      throw Error('renderer closed before snapshot');
    },
  });
  assert.equal(await runner.main(f.args, f.deps), 1);
  const reason = mode === 'marker-loss' ? /owner-away-file/ : /sleight-hold exists/;
  const saved = JSON.parse(readFileSync(join(f.out, 'renderer-rss.json'), 'utf8'));
  assert.match(saved.error, reason); assert.deepEqual(saved.sizes, {});
  assert.match(f.errors.join('\n'), reason);
  assert.doesNotMatch(saved.error, /SIGTERM|renderer closed/);
  assert.deepEqual(f.events, ['lock', 'app-state', 'prepare', 'collect-wait', 'sampler-stop', 'host-close',
    'guard-close', 'fixture-second', 'fixture-first', 'unlock']);
  assert.equal(existsSync(f.work), false);
});

test('main guarded wait checks marker loss without waiting for the owner watch', async t => {
  const f = mainFixture(t, 'wait-marker-loss');
  f.deps.collect = async ({ wait }) => {
    rmSync(f.marker);
    await wait(0);
    throw Error('guarded wait accepted a missing marker');
  };
  assert.equal(await runner.main(f.args, f.deps), 1);
  assert.match(f.errors.join('\n'), /owner-away-file/);
  assert.deepEqual(f.events.slice(-4), ['guard-close', 'fixture-second', 'fixture-first', 'unlock']);
});
