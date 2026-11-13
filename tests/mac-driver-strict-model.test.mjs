import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import assert from 'node:assert/strict';
import { MicroBoard, ConditionalBoard } from './fixtures/strict-text-model.mjs';

test('CB1 A specification: a copy inside the final check/clear boundary is unrecoverable by a legacy journal', () => {
  for (const phase of ['stage', 'restore']) {
    const board = new MicroBoard(), original = board.read(), journal = { original: original.bytes, staged: 'T' };
    if (phase === 'restore') { board.clear(); board.write('T'); }
    const expected = board.read().version;
    assert.equal(board.version, expected);
    board.clear(() => board.external('U')); // after the actual final check
    board.write(phase === 'stage' ? 'T' : 'O');
    assert.notEqual(board.bytes, 'U'); assert.equal(journal.original, 'O'); assert.notEqual(journal.original, 'U');
  }
});
test('CB1 B specification: identical empty recovery observations require retaining both originals without a write', () => {
  const ownClear = new MicroBoard(), userClear = new MicroBoard(), journal = { original: 'O', stage: 'T' };
  ownClear.clear(); userClear.external('');
  assert.deepEqual({ bytes: ownClear.bytes, version: ownClear.version }, { bytes: userClear.bytes, version: userClear.version });
  const retained = [structuredClone(journal), structuredClone(journal)];
  assert.equal(retained.length, 2); assert.equal(ownClear.writes + userClear.writes, 0);
  assert.equal(ownClear.bytes, ''); assert.equal(userClear.bytes, '');
});
test('CB1 C specification: a clipboard-manager marker replay is a fresh external version', () => {
  const board = new MicroBoard(); board.clear(); board.write('T+markers');
  const staged = board.read(); board.external(staged.bytes);
  assert.equal(board.bytes, staged.bytes); assert.notEqual(board.version, staged.version);
  assert.match(board.writer, /^external:/);
  // An equality-based restore would erase this deliberately selected version.
  const before = board.writer; board.clear(); board.write('O'); assert.notEqual(board.writer, before);
});
test('micro failures expose empty and partial states; conditional publication is a separate hypothetical interface', () => {
  const raw = new MicroBoard(); raw.clear(); assert.equal(raw.bytes, '');
  assert.equal(raw.write('T', true), false); assert.equal(raw.bytes, '');
  raw.write('partial'); assert.equal(raw.bytes, 'partial');
  const atomic = new ConditionalBoard();
  assert.throws(() => atomic.replaceIfVersion(40, 'T', 'id', { loseReply: true }), /reply lost/);
  assert.deepEqual(atomic.replaceIfVersion(40, 'T', 'id'), { committed: true, version: 41 });
  assert.deepEqual(atomic.replaceIfVersion(40, 'O', 'other'), { conflict: true });
  assert.deepEqual(atomic.value, { bytes: 'T', version: 41 });
});
const liveCases = [
  { name: 'selection replacement', before: 'abc old xyz', selected: [4, 3], text: 'new', after: 'abc new xyz', range: [7, 0] },
  { name: 'non-BMP Unicode', before: 'old', selected: [0, 3], text: '😀', after: '😀', range: [2, 0] },
  { name: 'combining text', before: 'old', selected: [0, 3], text: 'e\u0301', after: 'e\u0301', range: [2, 0] },
  { name: 'IME composition', requirement: 'Refuse a request requiring composition before input; never switch input sources or choose clipboard paste.' },
  { name: 'multiline', before: 'old', selected: [0, 3], text: 'A\nB', after: 'A\nB', range: [3, 0] },
  { name: 'undo', before: 'abc old xyz', selected: [4, 3], text: 'new', afterUndo: 'abc old xyz' },
  { name: 'app input events', requirement: 'Record AX and Unicode event traces separately. Declare observed undo/input events; require zero clipboard calls and no engine/menu fallback.' },
];
for (const fixture of liveCases) {
  test(`live qualification: ${fixture.name}`, { skip: 'Needs real fixture apps in a disposable login or VM; this lane is offline and has no qualified targets.' }, () => {
    // Unskipping requires supplying and checking real target evidence. A named
    // case with no implementation must never turn into a passing live receipt.
    assert.fail(`Missing real fixture evidence for ${JSON.stringify(fixture)}`);
  });
}

// The attack harness executes production Swift dispatch and lifecycle control
// flow with injected adapters, metadata inventory and a poison board.
const attacks = [
  { id: 1, name: 'death before snapshot or provider', ops: ['startup', 'dispatch', 'crash', 'restart'], failAt: 'check:1' },
  { id: 2, name: 'death during journal sync', ops: ['record:partial-sync', 'startup', 'dispatch', 'restart'], failAt: 'resolve:1' },
  { id: 3, name: 'copy after snapshot', ops: ['startup', 'dispatch', 'shutdown'], eventAt: 'resolve:1', event: 'copy:after-snapshot' },
  { id: 4, name: 'copy in final check/clear gap', ops: ['dispatch', 'shutdown'], eventAt: 'check:3', event: 'copy:unseen-at-clear' },
  { id: 5, name: 'legacy clear then crash', ops: ['copy:', 'record:clear-incomplete', 'startup', 'dispatch', 'restart'] },
  { id: 6, name: 'intentional user clear while down', ops: ['crash', 'copy:', 'restart', 'dispatch'] },
  { id: 7, name: 'lost publication reply', ops: ['record:publish-intent', 'dispatch', 'crash', 'restart'], failAt: 'admit:1' },
  { id: 8, name: 'partial failed write', ops: ['copy:partial', 'record:failed-partial', 'startup', 'dispatch'] },
  { id: 9, name: 'false reply after committed stage', ops: ['copy:T+markers', 'record:false-reply', 'restart', 'dispatch'] },
  { id: 10, name: 'unexpected count increment', ops: ['dispatch', 'shutdown'], eventAt: 'check:2', event: 'count' },
  { id: 11, name: 'same bytes with new count', ops: ['copy:O', 'dispatch', 'restart'], eventAt: 'admit:1', event: 'count' },
  { id: 12, name: 'identical text and markers', ops: ['dispatch', 'shutdown'], eventAt: 'send:1', event: 'copy:T+markers' },
  { id: 13, name: 'history marker replay', ops: ['copy:T+markers', 'startup', 'dispatch'], eventAt: 'observe:1', event: 'copy:T+markers' },
  { id: 14, name: 'original bytes copied anew', ops: ['dispatch', 'restart'], eventAt: 'send:1', event: 'copy:O' },
  { id: 15, name: 'copy in return check/clear gap', ops: ['record:return-intent', 'dispatch', 'restart'], eventAt: 'observe:1', event: 'copy:unseen-at-return' },
  { id: 16, name: 'death during return', ops: ['record:return-lost-reply', 'dispatch', 'crash', 'restart'], failAt: 'observe:1' },
  { id: 17, name: 'death during reclamation', ops: ['record:terminal-reclaim', 'restart', 'dispatch', 'crash', 'restart'] },
  { id: 18, name: 'concealed memory-only original', ops: ['copy:concealed', 'record:concealed-legacy', 'dispatch', 'shutdown'] },
  { id: 19, name: 'huge dead lazy provider', ops: ['copy:huge-lazy-promise', 'dispatch', 'shutdown'] },
  { id: 20, name: 'concurrent same-text sessions', ops: ['startup', 'dispatch', 'dispatch1', 'shutdown', 'restart'] },
  { id: 21, name: 'late timed-out writer', ops: ['dispatch', 'copy:late-writer', 'dispatch1', 'restart'], failAt: 'send:1' },
  { id: 22, name: 'browser after native crash', ops: ['record:runtime-prefix', 'dispatch', 'crash', 'restart', 'dispatch1'], failAt: 'check:2' },
  { id: 23, name: 'PID reuse or HOME alias', ops: ['record:stale-pid-home', 'restart', 'dispatch'], unqualified: true },
  { id: 24, name: 'server epoch reset with stale backup', ops: ['record:stale-backup', 'epoch', 'count', 'restart', 'dispatch'] },
  { id: 25, name: 'disk full or substituted corrupt journal', ops: ['record:corrupt-substitution', 'startup', 'dispatch', 'restart'], listFailure: true },
  { id: 26, name: 'timeout and retry exhaustion', ops: ['record:expired-unresolved', 'dispatch', 'restart', 'shutdown'], failAt: 'observe:1' },
  { id: 27, name: 'late target acknowledgment', ops: ['dispatch', 'restart', 'shutdown'], unknown: true },
  { id: 28, name: 'hidden adapter fallback or app side effect', ops: ['copy:target-side-effect', 'dispatch', 'shutdown'], unqualified: true },
].map((row, index) => ({ ...row, micro: ['factory', 'check', 'clear', 'write', 'provider'][index % 5] }));

test('production strict dispatcher and metadata lifecycle resist the CB1 schedules', { skip: process.platform !== 'darwin', timeout: 600000 }, async t => {
  assert.equal(new Set(attacks.map(({ id, name, micro, ...sequence }) => JSON.stringify(sequence))).size, 28);
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-strict-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'strict.swift'), binary = join(root, 'strict');
  const composed = macDriverSource(), at = composed.lastIndexOf('\ndriverMain()');
  assert.ok(at > 0);
  const entry = await readFile(new URL('./fixtures/strict-text-runtime.swift', import.meta.url), 'utf8');
  await writeFile(source, composed.slice(0, at) + '\n' + entry);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary],
    { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 480000, maxBuffer: 65536 });
  assert.equal(compile.status, 0, JSON.stringify({ stderr: compile.stderr, signal: compile.signal, error: compile.error?.code }));
  t.diagnostic(`strictRuntimeBinaryBytes=${(await stat(binary)).size}`);
  const run = (plan, executable = binary) => {
    const child = spawnSync(executable, [], { input: JSON.stringify(plan) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 120000, maxBuffer: 65536 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, ''); return JSON.parse(child.stdout);
  };
  const verify = (row, plan) => {
    assert.deepEqual(row.operations, { factory: 0, check: 0, clear: 0, write: 0, provider: 0 }, JSON.stringify(row));
    assert.equal(row.writer, row.lastExternal, 'the last external version still owns the board');
    assert.ok(row.sends.every(n => n <= 1), JSON.stringify(row));
    assert.ok(row.records['snapshot-a']); assert.ok(row.records['runtime-snapshot-b']);
    for (const op of plan.ops.filter(op => op.startsWith('record:'))) assert.ok(row.records['snapshot-' + op.slice(7)]);
    if (plan.eventAt) assert.ok(row.trace.includes(plan.event), 'the scheduled boundary event executed');
    assert.equal(row.outcomes.length, plan.ops.filter(op => op.startsWith('dispatch')).length);
    if (plan.ops.includes('restart') || plan.ops.includes('startup')) assert.ok(row.metadataCalls > 0);
    if (plan.unknown || plan.failAt === 'observe:1') assert.equal(row.outcomes[0].delivery, 'unknown');
    if (plan.unqualified) assert.equal(row.sends.reduce((a, b) => a + b), 0);
  };
  for (const plan of attacks) await t.test(`CB1 attack ${plan.id}: ${plan.name}`, () => verify(run(plan), plan));
  await t.test('two-session exploration drives dispatch with injected adapters and metadata lifecycle', () => {
    const result = run({ explore: 6 }); t.diagnostic(JSON.stringify(result));
    assert.equal(result.violations, 0); assert.deepEqual(result.counterexamples, []);
    assert.ok(result.states > 1000); assert.ok(result.transitions > result.states);
    assert.ok(result.dispatchCalls > 0); assert.ok(result.lifecycleCalls > 0); assert.ok(result.terminalUnknown > 0);
  });
  await t.test('stage-specific production mutations are detected by attacks and the explorer', () => {
    // All mutations live only in this temporary translation unit. Runtime
    // selection isolates one point per run without seven full recompilations.
    const seams = [
      ['dispatch', '        guard text.utf8.prefix(1_048_577).count <= 1_048_576 else', '        try fixtureMutation("dispatch")\n'],
      ['send', '            try send(path)', '            try fixtureMutation("send")\n'],
      ['observe', '            var result = try observe(path)', '            try fixtureMutation("observe")\n'],
      ['startup', '    static func startup(fixture: DriverObject?) -> DriverSemantic? {', '\n        try? fixtureMutation("startup")', true],
      ['shutdown', '    func shutdown() {} // No clipboard state or recovery callback to drain.', '    func shutdown() { try? fixtureMutation("shutdown") }', 'replace'],
      ['scan', '    func scan() throws -> Int {', '\n        try fixtureMutation("scan")', true],
      ['after-copy', '            var result = try observe(path)', '\n            try fixtureMutation("after-copy")', true],
    ];
    let broken = composed.slice(0, at);
    for (const [stage, seam, insertion, after] of seams) {
      assert.equal(broken.split(seam).length, 2, `${stage}: mutation seam must be unique`);
      broken = broken.replace(seam, after === 'replace' ? insertion : after ? seam + insertion : insertion + seam);
    }
    const brokenSource = join(root, 'broken.swift'), brokenBinary = join(root, 'broken');
    writeFileSync(brokenSource, broken + '\n' + entry);
    const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), brokenSource, '-o', brokenBinary],
      { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 480000, maxBuffer: 65536 });
    assert.equal(compile.status, 0, compile.stderr);
    t.diagnostic(`mutantRuntimeBinaryBytes=${statSync(brokenBinary).size}`);
    for (const [stage] of seams) {
      const detected = { factory: 0, check: 0, clear: 0, write: 0, provider: 0 };
      let hits = 0, clean = 0;
      for (const plan of attacks) {
        const row = run({ ...plan, mutation: stage }, brokenBinary);
        if (row.mutationHits[stage] > 0) {
          hits++;
          assert.ok(row.operations[plan.micro] > 0, `${stage}: ${JSON.stringify(row)}`);
          assert.throws(() => verify(row, plan), { code: 'ERR_ASSERTION' }, `${stage}: attack ${plan.id} missed the regression`);
          detected[plan.micro]++;
          assert.ok(row.trace.includes(`mutation:${stage}`));
        } else { verify(row, plan); clean++; }
      }
      assert.ok(hits > 0, `${stage} must be reachable in attack plans`);
      const explored = run({ explore: 2, mutation: stage }, brokenBinary);
      assert.ok(explored.violations > 0, stage);
      assert.equal(explored.violationStages[stage], explored.violations);
      assert.ok(explored.counterexamples.every(trace => trace.includes(`mutation:${stage}`)));
      if (stage === 'after-copy') {
        assert.ok(explored.counterexamples.every(trace => trace.some(op => op.includes('copy:'))));
        const noCopy = run({ ops: ['startup', 'dispatch', 'shutdown'], mutation: stage }, brokenBinary);
        assert.deepEqual(noCopy.mutationHits, {});
        assert.deepEqual(noCopy.operations, { factory: 0, check: 0, clear: 0, write: 0, provider: 0 });
      }
      t.diagnostic(`mutation=${stage} attacksDetected=${hits}/28 unaffected=${clean} micro=${JSON.stringify(detected)} explorer=${JSON.stringify(explored)}`);
    }
  });
});
