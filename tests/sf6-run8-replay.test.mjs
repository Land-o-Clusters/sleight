import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { constants, createContext, runInContext } from 'node:vm';
import { gradeControl, traceCalls } from '../bench/sf6-focus-probe.mjs';
import { differentFocusTarget, guardedCode } from '../plugins/sleight/lib/document-scope.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/sf6-run8.json', import.meta.url)));
const recoveryCode = 'await app.click(32);\nawait app.typeText("cobalt heron 47");';
const textAt = (trace, line) => trace.find(e => e.sourceLine === line).msg.result.content[0].text;

for (const [control, { trace, row }] of Object.entries(recorded.controls)) {
  test(`run 8 ${control}: the error reply fails recoveryArguments with valid arguments`, () => {
    assert.equal(trace.find(e => e.sourceLine === 25).msg.params.code, recoveryCode);
    const reply = trace.find(e => e.sourceLine === 39).msg;
    assert.equal(reply.id, 4);
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result._meta['codex/telemetry'].error_code, 'unknown');
    assert.equal(reply.result.content[0].text,
      'sleight stopped before typeText: another element has focus. Use app.setValue(32, <text>) instead.');
    const audit = traceCalls(trace);
    assert.equal(audit.complete, true);
    assert.deepEqual(audit.unknown, []);
    assert.deepEqual(audit.actions, row.recovery.actions.map(({ order, ...action }) => ({
      ...action, order: action.callId === 4 ? 2 : 6,
    })));
    assert.deepEqual(audit.actions.map(a => [a.method, a.valid, a.sent]), [
      ['click', true, false], ['typeText', true, false], ['setValue', true, true],
    ]);
    const graded = gradeControl({ ...row, recovery: {
      traceComplete: audit.complete, unknown: audit.unknown, actions: audit.actions,
    } });
    assert.equal(graded.status, 'fail');
    assert.deepEqual(Object.entries(graded.checks).filter(([, check]) => check.status !== 'pass')
      .map(([name, check]) => [name, check.status]), [['recoveryArguments', 'fail']]);
    assert.equal(Object.values(graded.checks).filter(c => c.status === 'pass').length, 11);
  });

  test(`run 8 ${control}: the recorded root content focus admits the editable click`, () => {
    const before = { number: 32, line: 'text field (settable) Memo', focus: '1 container SF6R focus probe' };
    for (const line of [23, 48]) {
      const text = textAt(trace, line);
      assert.equal(text.split('\n').filter(l => /^\t\d+ /.test(l)).length, 13);
      assert.equal(differentFocusTarget(text, before), undefined);
    }
  });

  test(`run 8 ${control}: the real guard admits call 4 with mocked AX reads`, async () => {
    const events = [];
    let clicked = false;
    const app = {
      getAXState: async () => textAt(trace, clicked ? 48 : 23),
      click: async n => { events.push(['click', n]); clicked = true; },
      typeText: async text => { events.push(['typeText', text]); },
    };
    const context = createContext({ app, cua: { getApp: async () => app },
      nodeRepl: { write() {} }, performance: { now: () => 1000 }, setTimeout: resolve => resolve() });
    const code = guardedCode(recoveryCode, { title: 'SF6R focus probe', app: 'Firefox', url: null },
      undefined, undefined, { quietEdits: true });
    await runInContext(`(async () => { ${code} })()`, context,
      { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    assert.deepEqual(events, [['click', 32], ['typeText', 'cobalt heron 47']]);
  });
}
