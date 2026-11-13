// Headless resolvePoint comparison. Run under the lane's external load gate.
// The fixture owns and closes its browser, private profile and loopback server.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, skip } from '../tests/fixtures/cr4-real.mjs';
import { trackTemp } from './temp-leftovers.mjs';

process.env.SLEIGHT_POINT_INPUT = '1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rounds = Number(process.argv[2] ?? 40), output = process.argv[3];
assert.ok(Number.isSafeInteger(rounds) && rounds >= 30 && rounds <= 1000, '30 to 1000 rounds required');
assert.equal(skip, false, 'SLEIGHT_LIVE_DOM_TEST=1 and pinned headless Chromium are required');
const base = '8247f1fee94c06a51b8d8cd97435acadd78739bf';
const fl4 = '7d0d5894ce30fef4173dd0778698f9e307070cf3';
const directory = 'plugins/sleight/lib/direct-browser';
const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fl4c-latency-')));
const after = [], rows = [];
const t = { after: fn => after.push(fn), diagnostic: message => process.stderr.write(message + '\n') };
function git(...args) {
  const result = spawnSync('/usr/bin/git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
function stage(name, revision) {
  const destination = join(bank, name);
  mkdirSync(destination);
  if (revision) {
    const archive = git('archive', revision, directory);
    const result = spawnSync('/usr/bin/tar', ['-x', '-C', destination], { input: archive });
    assert.equal(result.status, 0, result.stderr?.toString());
  } else cpSync(join(root, directory), join(destination, directory), { recursive: true });
  // Keep non-browser dependencies identical in every arm. Browser files come
  // from each full historical directory, never a hand-picked old function.
  const lib = join(root, 'plugins/sleight/lib'), stagedLib = join(destination, 'plugins/sleight/lib');
  for (const sibling of readdirSync(lib)) if (sibling !== 'direct-browser')
    symlinkSync(join(lib, sibling), join(stagedLib, sibling));
  symlinkSync(join(root, 'plugins/sleight/vendor'), join(destination, 'plugins/sleight/vendor'));
  symlinkSync(join(root, 'node_modules'), join(destination, 'node_modules'));
  writeFileSync(join(destination, 'package.json'), '{"type":"module"}\n');
  return join(destination, directory);
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
try {
  const arms = [];
  for (const [name, revision] of [['baseA', base], ['baseB', base], ['fl4', fl4], ['fl4c', null]]) {
    const path = stage(name, revision);
    arms.push({ name, revision: revision ?? git('rev-parse', 'HEAD').toString().trim(),
      pointsSha256: createHash('sha256').update(readFileSync(join(path, 'points.mjs'))).digest('hex'),
      ...await import(pathToFileURL(join(path, 'points.mjs'))),
      ...await import(pathToFileURL(join(path, 'snapshot.mjs'))) });
  }
  const f = await fixture(t, '<style>section,article,div{position:absolute;inset:0}button{position:absolute;left:30px;top:30px;width:160px;height:60px}</style>' +
    '<section><article><div><button id="plain" type="button">Plain</button></div></article></section>' +
    '<script>window.inputs=[];window.pays=0;for(const type of ["pointermove","pointerdown","click"])document.addEventListener(type,()=>inputs.push(type));' +
    'for(const el of document.querySelectorAll("section,article,div"))el.addEventListener("click",()=>{});</script>');
  const page = f.entry.page;
  async function run(arm, round, warmup) {
    const read = await arm.snapshot(page);
    assert.equal(arm.acknowledgeSnapshot(page, read.number), true);
    const start = performance.now();
    const handle = await arm.resolvePoint(page, { x: 70, y: 50, view: read.viewSignature });
    const ms = performance.now() - start;
    try { assert.equal(await handle.evaluate(el => el.id), 'plain'); }
    finally { await handle.dispose(); }
    if (!warmup) rows.push({ round, arm: arm.name, ms });
  }
  for (let round = 0; round < 5; round++) for (const arm of arms) await run(arm, round, true);
  // Rotate and reverse complete blocks so each arm occupies every position.
  for (let round = 0; round < rounds; round++) {
    const order = arms.map((_, i) => arms[(i + round) % arms.length]);
    if (Math.floor(round / arms.length) % 2) order.reverse();
    for (const arm of order) await run(arm, round, false);
  }
  assert.deepEqual(await page.evaluate(() => ({ pays, inputs })), { pays: 0, inputs: [] });
  const summary = Object.fromEntries(arms.map(arm => {
    const values = rows.filter(row => row.arm === arm.name).map(row => row.ms);
    return [arm.name, { runs: values.length, medianMs: median(values), p90Ms: percentile(values, 0.9),
      revision: arm.revision, pointsSha256: arm.pointsSha256 }];
  }));
  const baseMedianMs = (summary.baseA.medianMs + summary.baseB.medianMs) / 2;
  const noiseMs = Math.abs(summary.baseA.medianMs - summary.baseB.medianMs);
  const pairedBaseSpread = Array.from({ length: rounds }, (_, round) => Math.abs(
    rows.find(row => row.round === round && row.arm === 'baseA').ms - rows.find(row => row.round === round && row.arm === 'baseB').ms));
  const result = { rounds, warmupsPerArm: 5, summary, baseMedianMs, noiseMs,
    noiseDefinition: 'absolute difference between interleaved baseA and baseB medians',
    pairedBaseAbsoluteSpreadP90Ms: percentile(pairedBaseSpread, 0.9),
    fl4cDeltaMs: summary.fl4c.medianMs - baseMedianMs,
    flatWithinNoise: summary.fl4c.medianMs <= baseMedianMs + noiseMs, rows };
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ ...result, rows: undefined }, null, 2) + '\n');
  assert.equal(result.flatWithinNoise, true, 'FL4C median exceeds base by more than base-vs-base median noise');
} finally {
  try { for (const close of after) await close(); }
  finally { rmSync(bank, { recursive: true, force: true }); }
}
