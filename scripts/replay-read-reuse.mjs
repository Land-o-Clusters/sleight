// Offline replay of RT11D's collected cells. The recordings contain trees,
// not AX objects or observer history; fixture geometry and notifications are synthetic.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { recordedFixture } from '../tests/fixtures/mac-driver-recorded-tree.mjs';
import { trackTemp } from './temp-leftovers.mjs';

const rows = text => text.split('\n').filter(line => /^\t*\d+ /.test(line));
const body = line => line.replace(/^(\t*)\d+ /, '$1');
function applyRecordedDiff(text, diff) {
  const current = rows(text), removed = [], added = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('- ')) removed.push(line.slice(2));
    else if (line.startsWith('+ ') && /^\t*\d+ /.test(line.slice(2))) added.push(line.slice(2));
  }
  let from = 0;
  for (const line of removed) {
    const at = current.findIndex((value, index) => index >= from && body(value) === line);
    if (at < 0) {
      if (/^\t*[a-z][a-z ]*(?: \(|,| [A-Z0-9]|$)/.test(line)) return;
      continue;
    }
    current.splice(at, 1); from = at;
  }
  added.sort((a, b) => Number(/^\t*(\d+)/.exec(a)[1]) - Number(/^\t*(\d+)/.exec(b)[1]));
  for (const line of added) {
    const index = Number(/^\t*(\d+)/.exec(line)[1]);
    if (index > current.length) return;
    if (index < current.length && body(current[index]) === body(line)) current[index] = line;
    else current.splice(index, 0, line);
  }
  const numbered = current.map((line, index) => line.replace(/^(\t*)\d+ /, `$1${index} `));
  for (const line of added) if (numbered[Number(/^\t*(\d+)/.exec(line)[1])] !== line) return;
  return text.split('\n')[0] + '\n' + numbered.join('\n');
}
function complete(text) {
  const lines = rows(text);
  return lines.length >= 2 && lines.every((line, index) => Number(/^\t*(\d+)/.exec(line)[1]) === index);
}
export function readReuseReplayCells(cells) {
  const result = [];
  for (const cell of cells) {
    if (!cell.before || !cell.after) continue;
    let before = cell.before.text;
    for (const diff of cell.before.diffs ?? []) { before = before && applyRecordedDiff(before, diff); }
    if (!before || !complete(before)) continue;
    const after = cell.after.full ? cell.after.text : cell.after.diff ? applyRecordedDiff(before, cell.after.text) : undefined;
    if (!after || !complete(after)) continue;
    result.push({ task: cell.task, laterActions: Math.max(0, (cell.actions?.length ?? 0) - 1),
      before: recordedFixture(before), after: recordedFixture(after), recordedLinesEqual: rows(before).join('\n') === rows(after).join('\n') });
  }
  return result;
}
export function replayReadReuse(cells) {
  if (process.platform !== 'darwin') throw Error('Native fixture replay requires macOS; no apps are accessed.');
  const input = readReuseReplayCells(cells);
  if (!input.length) throw Error('No usable recorded tree pairs.');
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-reuse-replay-')));
  try {
    const source = join(directory, 'replay.swift'), binary = join(directory, 'replay');
    writeFileSync(source, macDriverSource().replace(/\ndriverMain\(\)\s*$/, '\n') +
      readFileSync(new URL('../tests/fixtures/mac-driver-read-reuse-replay.swift', import.meta.url), 'utf8'));
    const build = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES',
      '-module-cache-path', join(directory, 'modules'), source, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
    if (build.status !== 0) throw Error(`swiftc ${build.status}: ${build.stderr}`);
    const run = spawnSync('/usr/bin/nice', ['-n', '20', binary],
      { input: JSON.stringify(input), encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 });
    if (run.status !== 0) throw Error(`fixture replay ${run.status}: ${run.stderr}`);
    const rows = JSON.parse(run.stdout);
    if (rows.length !== input.length) throw Error('Native replay omitted a recorded pair.');
    const reused = rows.filter(row => row.reused);
    return { collectedCells: cells.length, usableCells: input.length, laterActions: input.reduce((n, row) => n + row.laterActions, 0),
      admissionsReplayed: input.length, recordedIntermediateReads: 0,
      baselineWalks: input.length * 2, replayWalks: rows.reduce((n, row) => n + row.walks, 0),
      reused: reused.length, reusedTextEqual: reused.filter(row => row.equal).length,
      allTextEqual: rows.every(row => row.equal), binaryBytes: readFileSync(binary).length,
      evidence: 'Native reader and digest over reconstructed AX fixtures; geometry and observer history are synthetic.', rows };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: node scripts/replay-read-reuse.mjs CELLS_JSON');
  const report = replayReadReuse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(report, null, 2));
  if (!report.allTextEqual) process.exitCode = 1;
}
