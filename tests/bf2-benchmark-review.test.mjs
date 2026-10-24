import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const patch = fs.readFileSync(path.join(root, 'bench/fowl/sleight-surface.patch'), 'utf8');
const hunks = [...patch.matchAll(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@[^\n]*\n([\s\S]*?)(?=^@@|$(?![\s\S]))/gm)];

test('BF2 world verification shares the same private output bank with and without --out', t => {
  // Execute only our harness patch's setup fragment, never the upstream runner.
  const main = hunks.find(hunk => hunk[5].includes('const verified = args.world'))[5];
  const added = main.split('\n').filter(line => line.startsWith('+') || line.startsWith(' ')).map(line => line.slice(1)).join('\n');
  const start = added.indexOf('  const stamp = '), end = added.indexOf('  fs.mkdirSync(out,', start);
  assert.ok(start >= 0 && end > start);
  const setup = new Function('args', 'fs', 'path', 'os', 'tasks', 'surfaceOf', 'verifyWorldAgents', 'openRemote', 'anySurface', 'ROOT', 'require', 'SLEIGHT_REPO', 'BROWSER_ARMS',
    added.slice(start, end).replace('await openRemote', 'openRemote').replaceAll('await loadRemoteCodex', 'loadRemoteCodex').replaceAll('await loadCodexAgent', 'loadCodexAgent') + '\nreturn {out,verified};');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf2-patch-bank-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [{ world: true }, { world: true, out: path.join(dir, 'chosen') }]) {
    let seen;
    const result = setup(args, fs, path, { tmpdir: () => dir }, [], () => 'fowlbrowser', (_tasks, options) => { seen = options.dir; return new Set(); },
      () => assert.fail('no remote connection'), () => false, root, () => ({ modelId: value => value }), root, []);
    assert.equal(seen, result.out);
    assert.equal(path.dirname(result.out), dir);
    if (!args.out) assert.ok(fs.statSync(result.out).isDirectory());
  }
});

test('BF2 patch hunk counts, offsets and reversible application stay valid without reading competitor code', t => {
  assert.ok(hunks.length > 10);
  const original = [];
  let delta = 0;
  for (const hunk of hunks) {
    const [, oldStart, oldCount, newStart, newCount, body] = hunk;
    const lines = body.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const oldLines = lines.filter(line => line[0] === '-' || line[0] === ' ').map(line => line.slice(1));
    const newLines = lines.filter(line => line[0] === '+' || line[0] === ' ');
    assert.equal(oldLines.length, Number(oldCount));
    assert.equal(newLines.length, Number(newCount));
    assert.equal(Number(newStart), Number(oldStart) + delta);
    while (original.length < Number(oldStart) - 1) original.push(`// omitted upstream line ${original.length + 1}`);
    original.push(...oldLines);
    delta += Number(newCount) - Number(oldCount);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf2-patch-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tools'));
  const file = path.join(dir, 'tools/rounds.mjs'), before = original.join('\n') + '\n';
  fs.writeFileSync(file, before);
  const filePatch = path.join(root, 'bench/fowl/sleight-surface.patch');
  for (const flags of [['--check'], [], ['--reverse']]) {
    execFileSync('/usr/bin/git', ['apply', ...flags, filePatch], { cwd: dir });
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('BF2 historical gate prose differs from its published page only by the pin label', () => {
  const file = 'docs/benchmarks/2026-10-13-gate.md';
  const before = execFileSync('/usr/bin/git', ['show', `ccacf304^:${file}`], { cwd: root, encoding: 'utf8' });
  const current = fs.readFileSync(path.join(root, file), 'utf8');
  const label = 'These results used `8b68924` (baseline). The next race targets `6a12d60` (head).\n\n';
  assert.ok(current.includes(label));
  assert.equal(current.replace(label, ''), before);
});
