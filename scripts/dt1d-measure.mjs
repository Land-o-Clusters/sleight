// Offline payload accounting. No benchmark runner, desktop APIs or image decoding.
// Synthesizes heading data from recorded tree attributes; missing styles/ranges stay absent.
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { recordedFixture } from '../tests/fixtures/mac-driver-recorded-tree.mjs';
import * as currentProjection from '../plugins/sleight/lib/repl/document-read.mjs';
import { trackTemp } from './temp-leftovers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value);
const versions = { before: 'e4027343167e5c2c00a27efdea553a866ea7768b', dt1d: '1b9a9b68f0016c623059a56b32ec32267f645f0e' };
const { documentReadText } = currentProjection;

// Load only the reviewed parser/projection sources. Never restore the worktree,
// import a benchmark runner, or accept an arbitrary Git revision as executable code.
export async function loadMeasurementVersion(root, version = 'current') {
  if (!['current', 'before', 'dt1d'].includes(version)) throw Error('MEASUREMENT_VERSION');
  let source = macDriverSource(), projection = currentProjection;
  if (version !== 'current') {
    const revision = versions[version];
    try { await run('/usr/bin/git', ['cat-file', '-e', revision + '^{commit}'], { cwd: root }); }
    catch { throw Error(`MEASUREMENT_REVISION_UNAVAILABLE: ${version} requires private history commit ${revision}; use --version current in this clone`); }
    for (const name of ['DriverDocument.swift', 'DriverTree.swift']) {
      const path = 'plugins/sleight/lib/mac-driver/native/' + name;
      const current = await readFile(join(root, path), 'utf8');
      const original = await run('/usr/bin/git', ['show', revision + ':' + path], { cwd: root });
      if (!source.includes(current)) throw Error('MEASUREMENT_SOURCE_MISMATCH');
      source = source.replace(current, original);
    }
    const original = await run('/usr/bin/git', ['show', revision + ':plugins/sleight/lib/repl/document-read.mjs'], { cwd: root });
    projection = await import('data:text/javascript;base64,' + Buffer.from(original).toString('base64'));
    source = source.replace(/^let driverBuild = "[a-f0-9]{64}"/, `let driverBuild = "${hash(source)}"`);
  }
  return { source, projection, revision: versions[version] ?? null, version };
}

export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : 0;
  return { median: at(0.5), p90: at(0.9), max: at(1), total: values.reduce((a, b) => a + b, 0) };
}

// Count only quoted document strings that also occur in the tree, once per
// emitted occurrence. Formatting, offsets and coincidental shared words do not
// count as duplicated page text. This is a conservative lower bound.
export function duplicateBytes(tree, block) {
  let count = 0;
  for (const match of block.matchAll(/\b(?:para (?:H[1-6]|P)(?: style "(?:[^"\\]|\\.)*")?(?: align \w+)?|selection) ("(?:[^"\\]|\\.)*")/g)) {
    const value = JSON.parse(match[1]);
    if (value && tree.includes(value)) count += bytes(value);
  }
  return count;
}

export function treesIn(value, path = '$') {
  const out = [];
  if (typeof value === 'string') {
    // Require an actual numbered window, excluding API examples without trees.
    const pattern = /^Window: [^\n]+\n0 standard window[^\n]*(?:\n(?!Window: )[^\n]*)*/gm;
    for (const match of value.matchAll(pattern)) {
      const lines = match[0].split('\n');
      const footer = lines.findIndex(line => /^The focused UI element |^sleight: no element/.test(line));
      const annotation = lines.findIndex(line => /^(?:Handle:|API:|Code:|\[sleight:|## )/.test(line));
      // Old engine AXValues contain literal line breaks. Preserve those
      // continuations instead of silently cutting at the first unnumbered line.
      const footerEnd = footer < 0 || lines.slice(footer + 1).every(line => line === '') ? lines.length : footer + 1;
      const end = Math.min(footerEnd, annotation < 0 ? lines.length : annotation);
      const tree = lines.slice(0, end);
      if (tree.length > 1) out.push({ locator: path + ':' + match.index, tree: tree.join('\n'),
        complete: !/^sleight: (?:lines changed|no changes? since)|^[+-]\s+\d+ |…\(\d+\)/m.test(match[0]) });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => out.push(...treesIn(item, path + '[' + i + ']')));
  } else if (value && typeof value === 'object') {
    // A native reply's text is one read, with its own document channel.
    if (typeof value.text === 'string' && value.document !== undefined && value.window) {
      for (const row of treesIn(value.text, path + '.text')) out.push({ ...row,
        complete: row.complete && value.truncated !== true, document: value.document, window: value.window });
      for (const [key, item] of Object.entries(value)) if (!['text', 'document', 'window'].includes(key)) out.push(...treesIn(item, path + '.' + key));
    } else for (const [key, item] of Object.entries(value)) out.push(...treesIn(item, path + '.' + key));
  }
  return out;
}

export function restoreHeadingLevels(fixture) {
  let restored = 0;
  const visit = node => {
    // Engine heading Value: 1..6 is an explicit level, never infer from text,
    // font, heading order or app name. The ordinary fixture adapter omits it.
    if (node.AXRole === 'AXHeading' && /^[1-6]$/.test(String(node.AXValue ?? ''))) {
      node.AXHeadingLevel = Number(node.AXValue); restored++;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fixture.trees['7']); return restored;
}

export function documentReplayFixture(tree) {
  const fixture = recordedFixture(tree);
  // The captured engine text has no bundle identity. Supply the fake app's
  // matching identity so Cua exercises its ordinary verification unchanged.
  fixture.windows[0].bundleId = fixture.apps[0].id;
  return { fixture, levels: restoreHeadingLevels(fixture) };
}

export function compareMeasurements(before, after) {
  if (before.rows.length !== after.rows.length) throw Error('RECORDED_READ_SET_CHANGED');
  let changedBlocks = 0, smallerBlocks = 0, largerBlocks = 0, replayedReadsCompared = 0;
  for (const [i, row] of after.rows.entries()) {
    const old = before.rows[i];
    if (old.id !== row.id || old.recordedTreeHash !== row.recordedTreeHash) throw Error('RECORDED_READ_SET_CHANGED');
    if (old.replayAvailable !== row.replayAvailable) throw Error('RECORDED_READ_SET_CHANGED');
    if (old.treeHash !== row.treeHash) throw Error('CANONICAL_TREE_CHANGED');
    if (row.treeHash !== null) replayedReadsCompared++;
    if (old.blockBytes !== row.blockBytes) changedBlocks++;
    if (old.blockBytes > row.blockBytes) smallerBlocks++;
    if (old.blockBytes < row.blockBytes) largerBlocks++;
  }
  return { readsCompared: after.rows.length, replayedReadsCompared, changedTrees: 0, changedBlocks, smallerBlocks, largerBlocks,
    savedBlockBytes: before.replay.blockBytes.total - after.replay.blockBytes.total,
    savedRepeatBlockBytes: before.replay.repeatBlockBytes.total - after.replay.repeatBlockBytes.total };
}

export async function collectRecorded(root) {
  const records = [], parseFailures = [], excludedFixtureFiles = [];
  let files = 0;
  async function visit(folder) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(?:json|jsonl|txt)$/.test(entry.name)) {
        files++;
        const raw = await readFile(file, 'utf8');
        let values;
        try { values = entry.name.endsWith('.jsonl') ? raw.split('\n').filter(Boolean).map(line => JSON.parse(line)) : [entry.name.endsWith('.json') ? JSON.parse(raw) : raw]; }
        catch { parseFailures.push(relative(root, file)); continue; }
        const source = relative(root, file);
        // These fixtures retain captured engine trees. Other unit fixtures may
        // contain invented windows, so do not mix them into the recorded cohort.
        const recorded = !source.startsWith('tests/fixtures/') ||
          /^tests\/fixtures\/(?:rt11d-|sf[67](?:-|\/)|safari-|browser-open-|cursor-typing-settle\.|excel-reacquire\.|dropdown-stale-number\.|calculator-tree\.|mdn-418-tree\.|native-list-pick-pl1\.|payment-gate\/|verified-results(?:-review)?\.|replay\/(?:native|claude)\.jsonl)/.test(source);
        for (const [i, value] of values.entries()) for (const row of treesIn(value)) {
          if (!recorded) { if (!excludedFixtureFiles.includes(source)) excludedFixtureFiles.push(source); continue; }
          records.push({ ...row, source, id: hash(source + ':' + i + ':' + row.locator).slice(0, 24) });
        }
      }
    }
  }
  for (const folder of ['bench', 'tests/fixtures', 'docs/benchmarks']) await visit(join(root, folder));
  return { files, parseFailures, excludedFixtureFiles, records };
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const stop = () => child.kill('SIGINT'); // This script owns this child and waits for close.
    process.once('SIGINT', stop);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { process.removeListener('SIGINT', stop); reject(error); });
    child.once('close', code => {
      process.removeListener('SIGINT', stop);
      if (code !== 0) reject(Error('OFFLINE_CHILD_FAILED ' + code + ': ' + stderr.slice(-3000)));
      else resolveRun(stdout);
    });
    if (child.stdin) child.stdin.end(options.input ?? '');
  });
}

export async function measure(root, { version = 'current' } = {}) {
  const loaded = await loadMeasurementVersion(root, version);
  const { files, parseFailures, excludedFixtureFiles, records } = await collectRecorded(root);
  if (!records.length) throw Error('NO_RECORDED_READS');
  const temp = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-dt1d-measure-')));
  try {
    const source = join(temp, 'driver.swift'), binary = join(temp, 'driver');
    await writeFile(source, loaded.source);
    await run('/usr/bin/xcrun', ['swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES', '-module-cache-path', join(temp, 'modules'), source, '-o', binary]);
    const cache = new Map(), rows = [];
    for (const record of records) {
      const key = hash(record.tree);
      let replay = record.complete ? cache.get(key) : { treeBytes: null, blockBytes: null, duplicateBytes: null,
        blockUnits: null, repeatBlockBytes: null, restoredHeadingLevels: null, treeHash: null };
      if (record.complete && !replay) {
        const { fixture, levels } = documentReplayFixture(record.tree);
        const file = join(temp, 'fixture.json'); await writeFile(file, JSON.stringify(fixture));
        const nonce = 'd'.repeat(64), params = { windowId: '7', processStart: '1.2' };
        const input = [1, 2].map(id => JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce, id,
          method: 'getAXState', params, deadline: Date.now() + 30000 }) + '\n').join('');
        const raw = await run(binary, ['--fixture', file], { env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce }, input });
        const replies = raw.trim().split('\n').map(JSON.parse);
        if (replies.length !== 2 || replies.some(row => !row.ok)) throw Error('OFFLINE_READ_FAILED ' + record.id + ': ' + JSON.stringify(replies.map(row => row.error)));
        const read = replies[0].result, block = loaded.projection.documentReadText(read);
        const display = loaded.projection.createDocumentDisplay?.();
        display?.prepare(read).commit(); // Controlled successful delivery, not observed session frequency.
        const repeat = display ? display.prepare(replies[1].result).text : loaded.projection.documentReadText(replies[1].result);
        replay = { treeBytes: bytes(read.text), blockBytes: bytes(block), duplicateBytes: duplicateBytes(read.text, block),
          blockUnits: block.length, repeatBlockBytes: bytes(repeat), restoredHeadingLevels: levels, treeHash: hash(read.text) };
        cache.set(key, replay);
      }
      const observedBlock = record.document ? documentReadText({ text: record.tree, document: record.document }) : '';
      rows.push({ id: record.id, source: record.source, recordedTreeBytes: bytes(record.tree), recordedTreeHash: hash(record.tree),
        recordedBlockBytes: bytes(observedBlock), recordedDuplicateBytes: duplicateBytes(record.tree, observedBlock),
        recordedDocumentChannel: record.document !== undefined, replayAvailable: record.complete, ...replay });
    }
    const summary = field => distribution(rows.map(row => row[field]));
    const replayRows = rows.filter(row => row.replayAvailable), replaySummary = field => distribution(replayRows.map(row => row[field]));
    const withBlock = replayRows.filter(row => row.blockBytes > 0);
    return { schema: 1, method: 'synthetic-heading-replay-production-parser', version, sourceRevision: loaded.revision,
      sourceHash: hash(loaded.source), files, parseFailures, excludedFixtureFiles, reads: rows.length, uniqueTrees: cache.size,
      recorded: { readsWithDocumentChannel: rows.filter(row => row.recordedDocumentChannel).length,
        readsWithBlock: rows.filter(row => row.recordedBlockBytes > 0).length,
        treeBytes: summary('recordedTreeBytes'), blockBytes: summary('recordedBlockBytes'), duplicateBytes: summary('recordedDuplicateBytes') },
      replay: { reads: replayRows.length, partialReadsNotReplayed: rows.length - replayRows.length,
        readsWithBlock: withBlock.length, readsWithRestoredHeadingLevels: replayRows.filter(row => row.restoredHeadingLevels > 0).length,
        duplicatePercent: replaySummary('blockBytes').total ? Math.round(replaySummary('duplicateBytes').total / replaySummary('blockBytes').total * 10000) / 100 : 0,
        treeBytes: replaySummary('treeBytes'), blockBytes: replaySummary('blockBytes'), blockUnits: replaySummary('blockUnits'), duplicateBytes: replaySummary('duplicateBytes'),
        blockBearingBytes: distribution(withBlock.map(row => row.blockBytes)),
        blockBearingDuplicateBytes: distribution(withBlock.map(row => row.duplicateBytes)),
        repeatBlockBytes: replaySummary('repeatBlockBytes') },
      limits: ['No live apps or timing claims.', 'Heading levels are synthesized from recorded tree Value fields, not native document payloads.',
        'The before parser also synthesizes paragraph text from the tree adapter.', 'Missing attributed styles and selection ranges are not reconstructed.',
        'Diffs and clipped trees retain recorded byte counts but are not replayed as full native trees.',
        'Each extracted full-tree occurrence counts once; mirrored fixtures are not independent sessions.',
        'Repeat cost is a controlled second read of each frozen window, not a recorded consecutive pair.',
        'Duplicated bytes count complete quoted strings found verbatim in the canonical tree, a lower bound.'], rows };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--output', '--compare', '--version'].includes(args[i]) || !args[i + 1] || options.has(args[i]))
      throw Error('Use --output FILE [--compare FILE] [--version before|dt1d|current]');
    options.set(args[i], args[i + 1]);
  }
  if (!options.has('--output')) throw Error('Use --output FILE [--compare FILE] [--version before|dt1d|current]');
  const result = await measure(resolve(fileURLToPath(new URL('..', import.meta.url))), { version: options.get('--version') ?? 'current' });
  if (options.has('--compare')) result.comparison = compareMeasurements(JSON.parse(await readFile(options.get('--compare'), 'utf8')), result);
  await writeFile(options.get('--output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { rows, ...summary } = result; process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}
