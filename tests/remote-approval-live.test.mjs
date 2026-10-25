import { remoteGuardDecision } from '../bench/remote-approval-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { remotePlan, runRemoteApproval, gradeRemote } from '../bench/remote-approval-live.mjs';

test('dry-run has no live effects, fixes TextEdit, loads the mod and uses an interactive session', async () => {
  const result = await runRemoteApproval({ dryRun: true }, new Proxy({}, { get: () => () => assert.fail('dry-run touched live IO') }));
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.app, 'TextEdit');
  assert.equal(result.plan.interactive, true);
  assert.ok(result.plan.args.includes('--plugin-dir'));
  assert.ok(!result.plan.args.includes('-p'));
  assert.equal(result.plan.approvals, 'empty arm store; no persistent writes');
});

test('live requires owner-away, takes and releases only its own lock, waits on hold, and scrubs evidence', async () => {
  const order = [], written = [];
  const plan = remotePlan();
  const turns = [
    { firstToolAt: 100, noticeAt: 250, text: '"TextEdit" needs approval on the Mac. Ask the user to reply: allow TextEdit', grants: [], complete: false },
    { text: 'Please reply: allow TextEdit', grants: [], complete: false },
    { text: 'RA1 fixture complete', grants: ['com.apple.TextEdit'], complete: true },
    { text: 'Please reply: allow TextEdit, Mail', grants: [], complete: false },
  ];
  const io = {
    hold: async () => { order.push('hold'); },
    lock: async () => { order.push('lock'); return async () => order.push('unlock'); },
    prepare: async () => ({ fixture: 'RA1 fixture', mail: 'Mail', bank: '/fixture/bank' }),
    fixture: async () => { order.push('fixture'); },
    session: async () => ({ submit: async text => { order.push(text); return turns.shift(); }, close: async () => { order.push('close'); return { clean: true }; } }),
    cleanup: async () => { order.push('cleanup'); return true; },
    write: (path, value) => written.push({ path, value }),
    now: () => new Date('2026-10-25T01:02:03Z'),
  };
  await assert.rejects(runRemoteApproval({}, io), /owner-away/);
  const result = await runRemoteApproval({ ownerAway: true }, io);
  assert.equal(result.passed, true);
  assert.ok(order.indexOf('hold') < order.indexOf('fixture'));
  assert.ok(order.indexOf('lock') < order.indexOf('fixture'));
  assert.ok(order.indexOf('close') < order.indexOf('cleanup'));
  assert.ok(order.indexOf('cleanup') < order.indexOf('unlock'));
  assert.ok(order.includes('yes')); assert.ok(order.includes('allow TextEdit'));
  assert.equal(written.length, 1);
  assert.match(written[0].path, /docs\/benchmarks\/2026-10-25-remote-approval-/);
  assert.equal(plan.app, 'TextEdit');
});

test('grading rejects hangs, a yes grant, missing mail app, model-only completion and a wrong typed grant', () => {
  const notice = { firstToolAt: 0, noticeAt: 10001, text: '"TextEdit" needs approval on the Mac. Ask the user to reply: allow TextEdit' };
  const yes = { grants: [] }, typed = { grants: ['com.apple.TextEdit'], complete: true };
  assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail' }).passed, false);
  notice.noticeAt = 9000;
  assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail' }).passed, true);
  for (const changes of [{ yes: { grants: ['com.apple.TextEdit'] } }, { typed: { grants: [], complete: true } },
    { typed: { grants: ['com.apple.TextEdit'], complete: false } }, { upfront: { text: 'allow TextEdit' } }]) {
    assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail', ...changes }).passed, false);
  }
});

test('failed child collection or fixture cleanup retains the live lock and writes failure evidence', async () => {
  let released = false, writes = 0, saved;
  const io = { hold: async () => {}, lock: async () => async () => { released = true; },
    prepare: async () => ({ fixture: 'RA1 fixture', mail: 'Mail' }), fixture: async () => {},
    session: async () => ({ submit: async () => { throw Error('fixture refusal sk-ant-fixture123'); }, close: async () => ({ clean: false }) }),
    cleanup: async () => true, write: (_path, value) => { writes++; saved = value; }, now: () => new Date('2026-10-25T01:02:03Z') };
  const result = await runRemoteApproval({ ownerAway: true }, io);
  assert.equal(result.passed, false); assert.equal(result.lockRetained, true);
  assert.equal(released, false); assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(saved), /sk-ant-fixture123/);
  assert.match(saved.error, /redacted/);
});

for (const [code, expected] of [
  ['let app = await cua.getApp("TextEdit")', true],
  ['let app = await cua.getApp("com.apple." + "Text" + "Edit")', true],
  ['nodeRepl.write(await app.getAXState({disableDiffing:true}))', true],
  ['let state = await app.getAXState(); nodeRepl.write(state)', true],
  ['await cua.getApp("Mail")', false], ['await app.click(1)', false],
  ['await cua.getState()', false], ['let app = await cua.getApp("TextEdit"); await app.typeText("x")', false],
  ['nodeRepl.write(await fetch("https://example.test"))', false], ['let state = await app.getAXState({ x: shell() })', false],
]) test(`live arm read guard: ${code}`, () => {
  const event = { tool_name: 'mcp__plugin_sleight_computer__js', tool_input: { code } };
  assert.equal(remoteGuardDecision(event), expected);
  assert.equal(remoteGuardDecision(event, { upfront: true }), false);
});
