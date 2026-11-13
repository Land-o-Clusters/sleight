import { benchEvidencePath } from '../runtime-options.mjs';
// Reuse OD1's exact offline decision functions and frozen corpus membership.
// No caller source is executed. This imports no bench/run.mjs or live driver.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { benchGateOpen, writeBenchJson } from '../runtime-options.mjs';

const args = process.argv.slice(2);
assert.equal(args.length, 4, 'usage: --od1-root PATH --candidate COMMIT');
assert.equal(args[0], '--od1-root'); assert.equal(args[2], '--candidate');
const od1 = resolve(args[1]), candidate = args[3];
const reviewedCommit = 'bfcac3022c58db0f2f9014acf376a724c526733a';
const recordedCells = JSON.parse(readFileSync(new URL('../../tests/fixtures/ca5-catch-cells.json', import.meta.url)));
assert.match(candidate, /^[a-f0-9]{40}$/);
const hash = value => createHash('sha256').update(value).digest('hex');
const baselineBytes = readFileSync(join(od1, 'bench/code-ast/od1-results.json'));
const baseline = JSON.parse(baselineBytes);
// Refuse a drifted study helper rather than silently change OD1's comparison.
for (const file of ['od1-support.mjs', 'consumer-classifier.mjs', '../replay/write-effect-bank.mjs'])
  assert.equal(hash(readFileSync(join(od1, 'bench/code-ast', file))), baseline.harnessSources[file], file);
const { collectTranscript, stageRevision, moduleDecision, canonical, equal, classifyDifference } =
  await import(pathToFileURL(join(od1, 'bench/code-ast/od1-support.mjs')).href);
async function waitForWindow() {
  while (!benchGateOpen() || existsSync('/tmp/sleight-hold')) await new Promise(resolve => setTimeout(resolve, 60000));
}
await waitForWindow();
assert.equal(baseline.A, 'ad5367d47f6dc6cae5a3c2aba495f0cf45f52e9f');
assert.equal(baseline.B, 'be330c709d2df60f137c0db6a6113c6fe2c80acb');
const provenance = baseline.corpus.provenance;
assert.equal(hash(JSON.stringify(provenance)), baseline.corpus.manifest);
const files = new Map(), records = [];
for (const [index, item] of provenance.entries()) {
  if (index % 500 === 0) await waitForWindow();
  const consumer = item.id.startsWith('consumers:');
  const arm = consumer ? item.id.split(':')[1] : 'bank';
  const root = arm === 'claude' ? join(homedir(), 'Library/Caches/sleight-bench/evidence')
    : join(benchEvidencePath('race-1017'), consumer ? '' : item.id.split(':')[0]);
  const file = join(root, item.file), key = `${consumer}:${file}`;
  if (!files.has(key)) {
    const source = readFileSync(file, 'utf8');
    files.set(key, { source, records: collectTranscript(source, { sleightOnly: !consumer }) });
  }
  const data = files.get(key);
  const observed = data.records.find(record => record.line === item.line &&
    (!item.callId || record.id === item.callId));
  let code = observed?.code;
  if (!observed && item.sourceSha256) {
    const row = JSON.parse(data.source.split('\n')[item.line - 1]);
    const call = row.item ?? row.message?.content?.find(block => block.type === 'tool_use' &&
      (!item.callId || block.id === item.callId));
    const input = call?.input ?? call?.arguments;
    code = input?.code ?? input?.command;
  }
  assert.equal(typeof code === 'string' ? hash(code) : null, item.sourceSha256, item.id);
  if (item.contextAvailable) assert.ok(observed, item.id);
  if (observed) {
    assert.equal(!!observed.overlap, item.overlap, item.id);
    assert.equal(!!observed.failed, item.failed, item.id);
  }
  records.push({ ...observed, ...item, code });
}
assert.equal(records.length, 8997);
assert.equal(records.filter(record => typeof record.code === 'string').length, 8749);
const staged = [];
try {
  for (const commit of [baseline.A, baseline.B, candidate, reviewedCommit]) staged.push(await stageRevision(commit));
  const [a, old, current, reviewed] = staged;
  const result = { offline: true, decisionsOnly: true, A: a.commit, oldB: old.commit, B: current.commit,
    baselineSha256: hash(baselineBytes), corpusManifest: baseline.corpus.manifest,
    calls: records.length, jsCells: 8749, nonJsCalls: 248,
    harnessSha256: hash(readFileSync(new URL(import.meta.url))),
    od1HarnessSources: baseline.harnessSources, candidateSources: current.files, reviewedCommit, modules: {} };
  for (const name of ['flow-rules', 'inspection']) {
    const original = baseline.modules[name];
    const expected = new Map(original.differences.map(item => [item.id, item]));
    const row = { baselineDifferences: 0, differences: 0, findings: 0,
      candidateChanges: 0, flowPolicyEqual: 0, exceptions: [0, 0, 0], changedCells: [], remainingFindings: [], recordedCells: [] };
    for (const [index, record] of records.entries()) {
      if (index % 500 === 0) await waitForWindow();
      const decisions = [a, old, current].map(arm => {
        arm.modules.ast?.clearCellCache();
        return moduleDecision(name, arm.modules, record);
      });
      decisions.forEach((value, arm) => { if (value?.threw) row.exceptions[arm]++; });
      const [before, prior, after] = decisions;
      const fixture = recordedCells.find(cell => record.callId === cell.callId || record.id.endsWith(':' + cell.callId));
      if (fixture) {
        assert.equal(record.code, fixture.code, fixture.callId);
        reviewed.modules.ast.clearCellCache();
        const reviewDecision = moduleDecision(name, reviewed.modules, record);
        const reviewFlow = name === 'inspection' ? reviewDecision.flow : reviewDecision;
        const currentFlow = name === 'inspection' ? after.flow : after;
        assert.equal(equal(reviewFlow.handles, currentFlow.handles), true, fixture.callId);
        row.recordedCells.push({ id: record.id, callId: fixture.callId, sourceSha256: record.sourceSha256,
          containsBareUndefined: /\bundefined\b/.test(fixture.code), handlesUnchanged: true,
          decisionUnchanged: equal(reviewDecision, after),
          reviewedHandles: canonical(reviewFlow.handles), candidateHandles: canonical(currentFlow.handles) });
      }
      if (!equal(before, prior)) {
        row.baselineDifferences++;
        assert.deepEqual(canonical(before), expected.get(record.id)?.A, record.id);
        assert.deepEqual(canonical(prior), expected.get(record.id)?.B, record.id);
      } else assert.equal(expected.has(record.id), false, record.id);
      const context = { code: record.code, A: a.modules, B: current.modules };
      if (!equal(before, after)) {
        row.differences++;
        const verdict = classifyDifference(name, before, after, context);
        if (!verdict.intended) {
          row.findings++;
          row.remainingFindings.push({ id: record.id, ...verdict, A: canonical(before), B: canonical(after) });
        }
      }
      if (!equal(prior, after)) {
        row.candidateChanges++;
        const flowA = name === 'inspection' ? before.flow : before;
        const flowOld = name === 'inspection' ? prior.flow : prior;
        const flowNew = name === 'inspection' ? after.flow : after;
        const onlyHandleStateChanged = equal({ ...flowOld, handles: flowNew.handles }, flowNew);
        assert.equal(onlyHandleStateChanged, true, record.id);
        assert.equal(equal(flowA.handles, flowNew.handles), true, record.id);
        row.changedCells.push({ id: record.id, sourceSha256: record.sourceSha256,
          matchesA: equal(before, after), handlesMatchA: equal(flowA.handles, flowNew.handles),
          onlyHandleStateChanged, A: canonical(before), oldB: canonical(prior), B: canonical(after) });
      }
      if (name === 'flow-rules' && typeof record.code === 'string' && equal(before?.violations, after?.violations)) row.flowPolicyEqual++;
    }
    assert.equal(row.baselineDifferences, original.differences.length);
    assert.equal(row.recordedCells.length, 3);
    assert.ok(row.recordedCells.every(cell => !cell.containsBareUndefined));
    result.modules[name] = row;
    console.log(JSON.stringify({ module: name, baselineDifferences: row.baselineDifferences,
      differences: row.differences, findings: row.findings, candidateChanges: row.candidateChanges,
      flowPolicyEqual: row.flowPolicyEqual, exceptions: row.exceptions,
      recordedHandleMapsUnchanged: row.recordedCells.filter(cell => cell.handlesUnchanged).length }));
  }
  writeBenchJson('code-ast/ca5f-results.json', result);
} finally { staged.forEach(arm => arm.cleanup()); }
