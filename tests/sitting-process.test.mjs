import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retryDocumentBinding, jsonChild, startGuard, VM_IDENTITY_FIELDS } from '../bench/sitting-process.mjs';
import { bindProbeFixture } from '../bench/runtime-probe-live.mjs';

const failed = (code = 'FRAME_MISMATCH', pendingDocument = true) => ({ reply: 'bind-document',
  error: 'FIXTURE_BINDING_REQUIRED', bindCode: code, pendingDocument });
const success = { reply: 'bind-document', ok: true, bindCode: 'BOUND', pendingDocument: false };

test('startGuard arms each caller with the overlay flag only when that caller opts in', async () => {
  const arm = async options => {
    let row;
    const guard = startGuard('unused', { ...options, childFactory: () => ({
      call: async payload => { if (payload.op === 'arm') row = payload; return {}; },
      close: async () => {},
    }) });
    try { await guard.start(); } finally { await guard.close(); }
    return row;
  };
  const plain = await arm({ kind: 'vm' });
  assert.equal(plain.op, 'arm');
  assert.equal(plain.kind, 'vm');
  assert.equal(Object.hasOwn(plain, 'exemptSystemOverlay'), false);
  const opted = await arm({ kind: 'uc3f-away', blockSeconds: 9000, exemptSystemOverlay: true });
  assert.equal(opted.exemptSystemOverlay, true);
  const callers = [
    ['../bench/windows/rt31-sitting.mjs', "guard = makeGuard(join(options.tools, 'guard'), { kind: 'vm', onStop: stop });", false],
    ['../bench/windows/uc3f-maintenance.mjs', 'exemptSystemOverlay: true, onStop: code => { reason ??= code; controller.abort(); } });', true],
    ['../bench/runtime-owner-away.mjs', 'exemptSystemOverlay: true, onStop: code => {', true],
  ];
  for (const [file, needle, optedIn] of callers) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(text.includes(needle), true, file);
    assert.equal(text.includes('exemptSystemOverlay'), optedIn, file);
  }
  const source = readFileSync(new URL('../bench/sitting-process.mjs', import.meta.url), 'utf8');
  const always = source.replace('...(exemptSystemOverlay === true && { exemptSystemOverlay: true }),', 'exemptSystemOverlay: true,');
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(always.replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, new URL('../bench/sitting-process.mjs', import.meta.url)).href}'`)).toString('base64'));
  let row;
  const guard = loaded.startGuard('unused', { kind: 'vm', childFactory: () => ({
    call: async payload => { if (payload.op === 'arm') row = payload; return {}; },
    close: async () => {},
  }) });
  try { await guard.start(); } finally { await guard.close(); }
  assert.throws(() => { assert.equal(Object.hasOwn(row, 'exemptSystemOverlay'), false); }, assert.AssertionError);
});

test('guard forwards only fixed identity fields and preserves the first stop', async () => {
  for (const field of [...VM_IDENTITY_FIELDS, 'PRIVATE WINDOW TITLE', undefined]) {
    let record; const stops = [];
    const guard = startGuard('fake', { onStop: (...args) => stops.push(args), childFactory: (_tool, _args, hooks) => {
      record = hooks.onRecord;
      return { call: async () => ({}), close: async () => {} };
    } });
    try {
      await guard.start();
      record({ record: 'guard', stop: 'IDENTITY_CHANGED', identityField: field });
      record({ record: 'guard', stop: 'IDENTITY_CHANGED', identityField: 'PROCESS_START' });
      assert.deepEqual(stops, [['IDENTITY_CHANGED', VM_IDENTITY_FIELDS.includes(field) ? field : undefined]]);
    } finally { await guard.close(); }
  }
});
function harness(bind = retryDocumentBinding) {
  let time = 0, calls = 0, checks = 0;
  const attempts = [], waits = [];
  const options = { attempts, now: () => time, wait: async ms => { waits.push(ms); time += ms; }, check: async () => { checks++; } };
  return { attempts, waits, options, get calls() { return calls; }, get time() { return time; }, get checks() { return checks; },
    run: replies => bind(async () => {
      const reply = replies[Math.min(calls++, replies.length - 1)];
      if (reply.error) throw Object.assign(Error(reply.error), { reply });
      return reply;
    }, options) };
}
async function thirdAttempt(bind) {
  const h = harness(bind);
  assert.deepEqual(await h.run([failed('AX_WINDOWS_UNAVAILABLE'), failed(), success]), success);
  assert.equal(h.calls, 3); assert.equal(h.checks, 3); assert.equal(h.time, 200);
  assert.deepEqual(h.waits, [100, 100]);
  assert.deepEqual(h.attempts.map(a => [a.code, a.elapsedMs]), [['AX_WINDOWS_UNAVAILABLE', 0], ['FRAME_MISMATCH', 100], ['BOUND', 200]]);
}
async function deadline(bind) {
  const h = harness(bind);
  await assert.rejects(h.run([failed('AX_WINDOWS_UNAVAILABLE'), failed('CANDIDATE_COUNT')]), e => {
    assert.equal(e.message, 'FIXTURE_BINDING_REQUIRED'); assert.equal(e.bindCode, 'CANDIDATE_COUNT');
    assert.equal(e.bindingAttempts, h.attempts); return true;
  });
  assert.equal(h.calls, 30); assert.equal(h.time, 3000); assert.equal(h.attempts.length, 30);
  assert.equal(h.attempts.at(-1).code, 'CANDIDATE_COUNT');
  assert.ok(h.waits.every(ms => ms === 100));
}
test('bind succeeds on the third attempt and records both refusal codes', () => thirdAttempt(retryDocumentBinding));
test('bind stops at 3 seconds with the last refusal code and all 30 attempts', () => deadline(retryDocumentBinding));
test('no pending expectation stops after one attempt', async () => {
  const h = harness(); await assert.rejects(h.run([failed('NO_PENDING_DOCUMENT', false)]), /FIXTURE_BINDING_REQUIRED/);
  assert.equal(h.calls, 1); assert.equal(h.time, 0);
});
test('a non-binding error stops before a retry', async () => {
  const h = harness(); await assert.rejects(h.run([{ error: 'PERSON_ACTIVE' }]), /PERSON_ACTIVE/);
  assert.equal(h.calls, 1); assert.equal(h.attempts.length, 0);
});
test('guard boundary failure prevents the next bind', async () => {
  const h = harness(); h.options.check = async () => { if (h.time > 0) throw Error('GUARD_STALE'); };
  await assert.rejects(h.run([failed()]), /GUARD_STALE/); assert.equal(h.calls, 1);
});
test('a slow guard check cannot start another bind after the deadline', async () => {
  const h = harness();
  h.options.check = async () => { await h.options.wait(1000); };
  await assert.rejects(h.run([failed()]), /FIXTURE_BINDING_REQUIRED/);
  assert.equal(h.calls, 2);
  assert.ok(h.attempts.every(a => a.elapsedMs < 3000));
});
test('probe afterOpen retries the same request and lease before acquisition', async () => {
  const h = harness(), request = { bundle: 'com.apple.TextEdit', target: '/fixture/SIT1-owned.txt' }, lease = { pid: 7 };
  let calls = 0;
  await bindProbeFixture({ bindingAttempts: h.attempts, bindingRetryOptions: h.options, check: h.options.check,
    afterOpen: async (r, l) => {
      assert.equal(r, request); assert.equal(l, lease);
      if (++calls < 3) throw Object.assign(Error('FIXTURE_BINDING_REQUIRED'), { reply: failed() });
      return success;
    } }, request, lease);
  assert.equal(calls, 3); assert.equal(h.time, 200); assert.equal(h.attempts.at(-1).code, 'BOUND');
});
test('JSON child preserves the complete diagnostic reply on the error', async () => {
  const child = jsonChild(process.execPath, ['-e', `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', line => console.log(JSON.stringify({ ...JSON.parse(line), ...${JSON.stringify(failed('CANDIDATE_COUNT'))}, candidateCount: 2 })));
  `]);
  try {
    await assert.rejects(child.call({ op: 'bind-document' }), e => {
      assert.equal(e.message, 'FIXTURE_BINDING_REQUIRED');
      assert.equal(e.reply.bindCode, 'CANDIDATE_COUNT'); assert.equal(e.reply.candidateCount, 2);
      assert.equal(child.records.at(-1), e.reply); return true;
    });
  } finally { await child.close(); }
});
test('retry regressions fail on broken variants', async t => {
  const source = readFileSync(new URL('../bench/sitting-process.mjs', import.meta.url), 'utf8');
  for (const [name, before, after, verify] of [
    ['single attempt', 'reply?.pendingDocument !== true || remaining <= 0', 'true', thirdAttempt],
    ['wrong interval', 'Math.min(100, remaining)', 'Math.min(50, remaining)', thirdAttempt],
    ['short deadline', '>= 3000', '>= 2000', deadline],
    ['lost last code', 'failure.bindCode = code', "failure.bindCode = 'BROKEN'", deadline],
  ]) await t.test(name, async () => {
    assert.ok(source.includes(before));
    const module = await import('data:text/javascript;base64,' + Buffer.from(source.replace(before, after)).toString('base64'));
    await assert.rejects(verify(module.retryDocumentBinding));
  });
});
