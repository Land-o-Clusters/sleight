import test from 'node:test';
import { utilityLocator } from './direct-browser-utility-fixture.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';

for (const route of ['closed-root', 'native-edit-context']) for (const notice of [{ tab: 'tchild' }, { blocked: true }])
  test(`${route} refuses delegation when its inspection publishes a registry popup (${JSON.stringify(notice)})`, async t => {
    const page = new EventEmitter(), tab = { page, state: {}, popups: [] };
    let inputs = 0;
    page.getByRef = () => utilityLocator({ evaluate: async fn => {
      assert.equal(fn.name, 'inspect');
      tab.popups.push(notice);
      return { kind: 'text', tag: 'input', connected: true, nativeEditContext: route === 'native-edit-context' };
    } });
    const ctx = createV3Context({ browser: 'bfixture', binding: createV3TurnBinding({ source: 'user',
      session: 'fixture', turn: 'turn', id: 'request', text: 'Fill the form' }, () => true) });
    t.after(() => ctx.dispose());
    const fill = createFillFields({ check: () => 'allow', runSteps: async () => {
      inputs++; return { lines: ['1 type: input sent'], stoppedAt: null };
    } });
    const result = await fill(tab, [{ ref: route === 'closed-root' ? 's1' : 'e1', value: 'first' },
      { ref: 'e2', value: 'untouched' }], { submit: 'e3' }, ctx);
    assert.equal(inputs, 0);
    assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
    assert.match(result.rows[0].reason, notice.blocked ? /blocked/ : /popup/);
    assert.equal(result.submitted.status, 'not reached');
  });

for (const notice of [{ tab: 'tchild' }, { tab: 'tchild', closed: true }, { blocked: true }])
  test(`browser_fill reports its registry popup and the unexecuted fields (${JSON.stringify(notice)})`, async () => {
    const page = new EventEmitter(), tab = { page, state: { snapshotNo: 1 }, popups: [] };
    let inputs = 0;
    page.url = () => 'https://fixture.invalid/'; page.title = async () => 'Fixture';
    page.getByRef = () => utilityLocator({ evaluate: async fn => fn.name === 'inspect'
      ? { kind: 'text', tag: 'input', connected: true, matched: true } : {},
    fill: async () => { inputs++; tab.popups.push(notice); } });
    const runSteps = async () => assert.fail('submit must not run');
    const dispatcher = createToolDispatcher({ browser: 'bfixture', pages: { enqueue: async (_id, fn) => fn(tab) },
      runSteps, fillFields: createFillFields({ check: () => 'allow', inspectElement: function inspectTarget() {}, runSteps }),
      snapshot: async () => ({ text: 'opener page', number: 2 }) });
    const result = await dispatcher.call({ name: 'browser_fill', arguments: { tab: 't1',
      fields: [{ ref: 'e1', value: 'first' }, { ref: 'e2', value: 'untouched' }], submit: 'e3' } });
    assert.equal(result.isError, false, result.text);
    assert.equal(inputs, 1);
    assert.match(result.text, /e2: not reached/);
    assert.match(result.text, /submit: not reached/);
    assert.match(result.text, notice.blocked ? /blocked: DevTools endpoint/ : notice.closed ? /popup opened and closed itself/ : /popup tchild opened/);
    assert.match(result.text, /opener page/);
  });

for (const route of ['text', 'upload', 'closed-root', 'submit-choice'])
  for (const notice of [{ tab: 'tchild' }, { tab: 'tchild', closed: true }, { blocked: true }])
    test(`${route} fill stops on a registry popup and leaves remaining fields and submit untouched (${JSON.stringify(notice)})`, async () => {
      const page = new EventEmitter(), tab = { page, state: { snapshotNo: 1 }, popups: [] };
      let inputs = 0;
      const opened = () => { inputs++; tab.popups.push(notice); };
      page.getByRef = () => utilityLocator({ async evaluate(fn) {
        if (fn.name === 'inspect') return { kind: route === 'upload' ? 'file' : route === 'submit-choice' ? 'check' : 'text',
          type: '', tag: 'input', connected: true, checked: false, readonly: false, matched: true };
        return { tag: route === 'submit-choice' ? 'button' : 'input', submit: route === 'submit-choice' };
      }, fill: async () => opened() });
      const fill = createFillFields({ check: () => 'allow', inspectElement: function inspectTarget() {},
        runSteps: async () => { opened(); return { lines: ['1 input: sent'], stoppedAt: 1 }; } });
      const result = await fill(tab, [{ ref: route === 'closed-root' ? 's1' : 'e1',
        value: route === 'upload' ? ['/fixture/file.txt'] : route === 'submit-choice' ? true : 'first' },
      { ref: 'e2', value: 'untouched' }], { submit: 'e3' }, {});
      assert.equal(inputs, 1, JSON.stringify(result));
      assert.deepEqual(result.rows.map(row => row.status), ['set', 'not reached']);
      assert.equal(result.submitted.status, 'not reached');
      assert.match(result.stopped, notice.blocked ? /blocked/i : notice.closed ? /closed itself/ : /tchild/);
      assert.equal(page.listenerCount('popup'), 0);
    });

test('a delegated field boundary stops fill even before a registry row arrives', async () => {
  const page = new EventEmitter();
  let inputs = 0;
  const fill = createFillFields({ check: () => 'allow', runSteps: async () => {
    inputs++; return { lines: ['1 type s1: input sent'], stoppedAt: 1 };
  } });
  const result = await fill({ page, state: {} }, [{ ref: 's1', value: 'first' }, { ref: 's2', value: 'untouched' }], { submit: 'e3' });
  assert.equal(inputs, 1);
  assert.deepEqual(result.rows.map(row => row.status), ['set', 'not reached']);
  assert.equal(result.submitted.status, 'not reached');
  assert.match(result.stopped, /read/);
});

test('a registry popup between range key presses stops the remaining keys, fields and submit', async () => {
  const page = new EventEmitter(), tab = { page, state: {}, popups: [] }, keys = [];
  page.getByRef = () => utilityLocator({ evaluate: async fn => fn.name === 'inspect'
    ? { kind: 'range', type: '', tag: 'div', connected: true, min: '0', max: '10', step: '1' }
    : {}, press: async key => { keys.push(key); tab.popups.push({ tab: 'tchild' }); } });
  const fill = createFillFields({ check: () => 'allow', inspectElement: function inspectTarget() {},
    runSteps: async () => assert.fail('submit must not run') });
  const result = await fill(tab, [{ ref: 'e1', value: 3 }, { ref: 'e2', value: 'untouched' }], { submit: 'e3' }, {});
  assert.deepEqual(keys, ['Home']);
  assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
  assert.match(result.rows[0].reason, /unconfirmed/);
  assert.match(result.stopped, /tchild/);
  assert.equal(result.submitted.status, 'not reached');
});

test('old registry popups do not stop a later fill', async () => {
  const page = new EventEmitter(), tab = { page, state: {}, popups: [{ tab: 'told' }, { blocked: true }] };
  let inputs = 0;
  page.getByRef = () => utilityLocator({ evaluate: async fn => fn.name === 'inspect'
    ? { kind: 'text', tag: 'input', connected: true, matched: true } : {}, fill: async () => { inputs++; } });
  const fill = createFillFields({ check: () => 'allow', inspectElement: function inspectTarget() {}, runSteps: async () => assert.fail('no submit') });
  const result = await fill(tab, [{ ref: 'e1', value: 'first' }, { ref: 'e2', value: 'second' }], {}, {});
  assert.equal(inputs, 2);
  assert.deepEqual(result.rows.map(row => row.status), ['set', 'set']);
  assert.equal(result.stopped, undefined);
});

for (const submit of [true, false]) for (const boundary of ['framenavigated', 'dialog', 'popup', 'close']) test(`${submit ? 'submit delegation' : 'authority consumption'} stops when ${boundary} arrives during final inspection`, async () => {
  const page = new EventEmitter(); let classified = 0, dispatched = 0, authorized = 0;
  const state = { snapshotNo: 1, submitUnconfirmed: false };
  const locator = utilityLocator({ async evaluate(fn) {
    if (fn.name === 'inspect') return { kind: 'check', type: '', connected: true, checked: false, readonly: false };
    assert.equal(fn.name, 'inspectTarget');
    if (++classified === 2) page.emit(boundary);
    return { tag: 'button', kind: 'button', connected: true, visible: true, enabled: true,
      payment: false, formPayment: false, form: true, submit };
  } });
  page.getByRef = () => locator;
  const fill = createFillFields({ inspectElement: function inspectTarget() {}, check: () => { authorized++; return 'allow'; },
    runSteps: async () => { dispatched++; return { lines: ['1 click e1: input sent'], stoppedAt: null }; } });
  const result = await fill({ page, state }, [{ ref: 'e1', value: true }, { ref: 'e2', value: 'untouched' }], {}, {});
  assert.equal(authorized, 0, 'the boundary must not consume authority');
  assert.equal(dispatched, 0, JSON.stringify({ dispatched, result }));
  assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
  assert.match(result.stopped, /new document|dialog|popup|tab closed/);
  assert.equal(state.actionPending, undefined);
  assert.equal(state.submitUnconfirmed, false);
});

for (const boundary of ['framenavigated', 'dialog', 'popup', 'close']) test(`upload delegation stops when ${boundary} arrives during the prior inspection`, async () => {
  const page = new EventEmitter(); let dispatched = 0, authorized = 0;
  const state = { snapshotNo: 1, submitUnconfirmed: false };
  page.getByRef = () => utilityLocator({ async evaluate(fn) {
    if (fn.name === 'inspect') return { kind: 'file', connected: true, readonly: false };
    assert.equal(fn.name, 'inspectTarget'); page.emit(boundary);
    return { tag: 'input', kind: 'file', connected: true, visible: true, enabled: true };
  } });
  const fill = createFillFields({ inspectElement: function inspectTarget() {}, check: () => { authorized++; return 'allow'; },
    runSteps: async () => { dispatched++; return { lines: ['1 upload: input sent'], stoppedAt: null }; } });
  const result = await fill({ page, state }, [{ ref: 'e1', value: ['/fixture/upload.txt'] }, { ref: 'e2', value: 'untouched' }], {}, {});
  assert.equal(dispatched, 0); assert.equal(authorized, 0);
  assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
  assert.match(result.stopped, /new document|dialog|popup|tab closed/);
});
