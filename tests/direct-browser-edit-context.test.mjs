import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import * as v3 from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { check as rulesCheck } from '../plugins/sleight/lib/direct-browser/rules.mjs';

const api = await import('../plugins/sleight/lib/direct-browser/edit-context.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});

function fixture() {
  const sandbox = createContext({});
  runInContext(`
    const elements = new WeakMap(), contexts = new WeakMap();
    class HTMLElement {
      get editContext() { if (!elements.has(this)) throw Error('brand'); return elements.get(this).context; }
      focus() { doc.activeElement = this; }
    }
    class EditContext {
      attachedElements() { if (!contexts.has(this)) throw Error('brand'); return contexts.get(this).attached; }
      get selectionStart() { if (!contexts.has(this)) throw Error('brand'); return contexts.get(this).start; }
      get selectionEnd() { if (!contexts.has(this)) throw Error('brand'); return contexts.get(this).end; }
      get text() { throw Error('context text is not a whole document'); }
    }
    const view = { frameElement: null }; view.top = view;
    let doc = { nodeType: 9, activeElement: null, defaultView: view };
    const style = { display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible' };
    function make(attrs = {}, parent = null) {
      const el = new HTMLElement(), context = new EditContext();
      elements.set(el, { context, attrs: { role: 'textbox', ...attrs }, parent, connected: true, style: {...style}, rect: { width: 0, height: 18 } });
      contexts.set(context, { attached: [el], start: 0, end: 0 }); return el;
    }
    function read(node, key) {
      const data = elements.get(node);
      if (!data) return node?.[key];
      if (key === 'isConnected') return data.connected;
      if (key === 'getAttribute') return name => data.attrs[name] ?? null;
      if (key === 'hasAttribute') return name => Object.hasOwn(data.attrs, name);
      if (key === 'parentElement' || key === 'parentNode') return data.parent;
      if (key === 'getRootNode') return () => data.document ?? doc;
      if (key === 'ownerDocument') return data.document ?? doc;
      if (key === 'localName') return 'div';
      if (key === 'getBoundingClientRect') return () => data.rect;
      if (key === 'matches') return selector => selector === ':disabled' && Object.hasOwn(data.attrs, 'disabled');
      return undefined;
    }
    function getComputedStyle(el) { return elements.get(el).style; }
    const parent = make(), el = make({}, parent); doc.activeElement = el;
  `, sandbox);
  const invoke = (name, arg) => {
    assert.equal(typeof api[name], 'function', `${name} must exist`);
    sandbox.arg = arg;
    const fn = api[name];
    return runInContext(`(() => { ${(fn.helpers ?? []).map(helper => helper.toString()).join('\n')}; return (${fn.toString()})(el, arg, read); })()`, sandbox);
  };
  return { sandbox, invoke, run: source => runInContext(source, sandbox) };
}

function inputFixture({ native = true, width = 0, clipboardIO } = {}) {
  const f = fixture(), events = [], page = new EventEmitter(), state = { snapshotNo: 1, submitUnconfirmed: false };
  f.run(`elements.get(el).rect.width = ${width}; ${native ? '' : 'elements.get(el).context = null;'}
    elements.get(el).localName = '${native ? 'div' : 'input'}';`);
  let live = true, afterSelect = () => {}, afterInput = () => {}, beforeRead = () => {};
  const frame = { url: () => 'https://fixture.invalid/editor' };
  const inspected = () => ({ tag: native ? 'div' : 'input', role: 'textbox', kind: 'text', connected: true,
    visible: width > 0, enabled: true, payment: false, submit: false, form: false, formPayment: false });
  const utility = { world: 'utility', async evaluateExpression(source, unused, args) {
    const name = /function (\w+)/.exec(source)[1]; beforeRead(name);
    if (name === 'inspectElement') return { ...inspected(), ...f.risk };
    if (name === 'readPaymentPage') return { origin: 'https://fixture.invalid', name: 'Editor' };
    if (name === 'forwardInfo') return { label: false, areas: [] };
    const fn = api[name] ?? v3[name];
    assert.equal(typeof fn, 'function', name);
    f.sandbox.arg = args[1];
    return runInContext(`(() => { ${(fn.helpers ?? []).map(helper => helper.toString()).join('\n')}; return (${fn.toString()})(el, arg, read); })()`, f.sandbox);
  }, async evaluateExpressionHandle(source) {
    if (/function ownDocument/.test(source)) return f.run('doc');
    assert.match(source, /function retainNativeEditContext/); return f.invoke('retainNativeEditContext');
  } };
  const frameImpl = { utilityContext: async () => utility, _page: { delegate: { _sessionForFrame: () => ({ _client: { _sendMayFail: async () => ({ node: { shadowRoots: [] } }) } }) } } };
  const impl = { _objectId: 'fixture-node', _frame: frameImpl };
  const handle = { ownerFrame: async () => frame, dispose: async () => {},
    fill: async (value, options) => events.push({ op: 'fill', value, options }),
    evaluate: () => assert.fail('MAIN world cannot supply input authority'),
  };
  handle._connection = { toImpl: value => value === frame ? frameImpl : impl };
  page.keyboard = {
    async press(key) {
      events.push({ op: 'press', key });
      if (key === 'ControlOrMeta+A') {
        f.run('contexts.get(elements.get(el).context).start = 0; contexts.get(elements.get(el).context).end = 6;');
        await afterSelect();
      }
      if (key === 'Backspace') {
        f.run('contexts.get(elements.get(el).context).start = 0; contexts.get(elements.get(el).context).end = 0;');
        await afterInput();
      }
    },
    async insertText(value) {
      events.push({ op: 'insertText', value });
      f.run(`contexts.get(elements.get(el).context).start = ${value.length}; contexts.get(elements.get(el).context).end = ${value.length};`);
      await afterInput();
    },
  };
  const binding = v3.createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text: 'Replace the editor text' }, () => live);
  const ctx = v3.createV3Context({ binding, browser: 'fixture', clipboardIO });
  const target = { page, state, locator: { elementHandle: async () => handle }, ref: 'e1', do: 'type' };
  return { ...f, events, page, frame, ctx, target, risk: f.risk = {},
    afterSelect: callback => { afterSelect = callback; }, beforeRead: callback => { beforeRead = callback; },
    afterInput: callback => { afterInput = callback; },
    revoke: () => { live = false; },
  };
}

for (const value of ['new text', 'line one\nλ🙂\nline three', '']) test(`trusted EditContext type replaces through keyboard input (${JSON.stringify(value)})`, async () => {
  const f = inputFixture();
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
  await f.ctx.typeTarget(f.target, value, { timeout: 1000 });
  assert.deepEqual(f.events, [{ op: 'press', key: 'ControlOrMeta+A' }, value === '' ? { op: 'press', key: 'Backspace' } : { op: 'insertText', value }]);
  assert.equal(f.target.element.visible, false, 'keyboard evidence does not manufacture pointer geometry');
  await f.ctx.dispose();
});

for (const value of ['inserted', '']) for (const change of ['focus', 'context', 'document', 'turn']) {
  test(`${JSON.stringify(value)} followed by ${change} loss is unconfirmed without replay`, async () => {
    const f = inputFixture();
    assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
    f.afterInput(() => {
      if (change === 'focus') f.run('doc.activeElement = parent;');
      if (change === 'context') f.run('const next = new EditContext(); contexts.set(next, {attached:[el],start:0,end:0}); elements.get(el).context = next;');
      if (change === 'document') f.run('doc = {activeElement:el,defaultView:view};');
      if (change === 'turn') f.revoke();
    });
    const result = await f.ctx.typeTarget(f.target, value, {}).then(() => null, error => error);
    assert.ok(result instanceof Error, 'input whose recipient changed cannot report success');
    assert.notEqual(result.notRun, true, 'already-sent input must remain effect unconfirmed');
    assert.deepEqual(f.events, [{ op: 'press', key: 'ControlOrMeta+A' }, value ? { op: 'insertText', value } : { op: 'press', key: 'Backspace' }]);
    await f.ctx.dispose();
  });
}

test('a visible ordinary ref cannot silently repin a replacement native EditContext', async () => {
  const f = inputFixture({ width: 200 });
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
  f.run('const next = new EditContext(); contexts.set(next, {attached:[el],start:0,end:0}); elements.get(el).context = next;');
  await assert.rejects(f.ctx.typeTarget(f.target, 'not rebound', {}));
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'refuse');
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

test('ordinary typing preserves the pinned fill path and options', async () => {
  const f = inputFixture({ native: false, width: 200 }), options = { timeout: 1000 };
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
  await f.ctx.typeTarget(f.target, 'ordinary', options);
  assert.deepEqual(f.events, [{ op: 'fill', value: 'ordinary', options }]);
  await f.ctx.dispose();
});

for (const change of ['focus', 'context', 'document', 'turn', 'readonly', 'hidden', 'payment']) test(`SelectAll followed by ${change} change sends no replacement or replay`, async () => {
  const f = inputFixture();
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
  f.afterSelect(() => {
    if (change === 'focus') f.run('doc.activeElement = parent;');
    if (change === 'context') f.run('const next = new EditContext(); contexts.set(next, {attached:[el],start:0,end:6}); elements.get(el).context = next;');
    if (change === 'document') f.run('doc = {activeElement:el,defaultView:view};');
    if (change === 'turn') f.revoke();
    if (change === 'readonly') f.run("elements.get(el).attrs['aria-readonly'] = 'true';");
    if (change === 'hidden') f.run("elements.get(parent).style.display = 'none';");
    if (change === 'payment') f.risk.payment = true;
  });
  await assert.rejects(f.ctx.typeTarget(f.target, 'replacement', {}));
  assert.deepEqual(f.events, [{ op: 'press', key: 'ControlOrMeta+A' }]);
  await f.ctx.dispose();
});

test('a checked safe key cannot authorize a different native activation key', async () => {
  const f = inputFixture(); f.target.key = 'ArrowLeft';
  assert.equal((await f.ctx.check('press', f.target)).verdict, 'allow');
  await assert.rejects(f.ctx.pressTarget(f.target, 'Enter', {}));
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

test('ordinary single-line input still refuses text containing line breaks', async () => {
  const f = inputFixture({ native: false, width: 200 });
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
  await assert.rejects(f.ctx.typeTarget(f.target, 'line one\nline two', {}));
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

test('a changed native selection after capture refuses insertion', async () => {
  const f = inputFixture(); let selected = 0;
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
  f.afterSelect(() => f.beforeRead(name => {
    if (name === 'checkedNativeEditContextSelection' && ++selected === 2) f.run('contexts.get(elements.get(el).context).end = 2;');
  }));
  await assert.rejects(f.ctx.typeTarget(f.target, 'replacement', {}));
  assert.deepEqual(f.events, [{ op: 'press', key: 'ControlOrMeta+A' }]);
  await f.ctx.dispose();
});

for (const change of ['focus', 'document']) test(`a ${change} change in the final native read prevents replacement`, async () => {
  const f = inputFixture(); let checks = 0;
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
  f.beforeRead(name => {
    if (name === 'checkedNativeEditContextSelection' && ++checks === 3)
      f.run(change === 'focus' ? 'doc.activeElement = parent;' : 'doc = {activeElement:el,defaultView:view};');
  });
  await assert.rejects(f.ctx.typeTarget(f.target, 'no wrong receiver', {}));
  assert.deepEqual(f.events, [{ op: 'press', key: 'ControlOrMeta+A' }]);
  await f.ctx.dispose();
});

for (const kind of ['click', 'hover', 'drag']) test(`native EditContext does not make zero-area ${kind} actionable`, async () => {
  const f = inputFixture();
  f.target.keyboardOnly = true; f.target.element = { visible: true, keyboardOnly: true };
  assert.equal((await f.ctx.check(kind, f.target)).verdict, 'refuse');
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

for (const key of ['ArrowLeft', 'Meta+A', 'Backspace']) test(`native keyboard-only field permits guarded ${key}`, async () => {
  const f = inputFixture(); f.target.key = key;
  assert.equal((await f.ctx.check('press', f.target)).verdict, 'allow');
  await f.ctx.pressTarget(f.target, key, {});
  assert.deepEqual(f.events, [{ op: 'press', key }]); await f.ctx.dispose();
});

for (const key of ['Enter', 'Space', 'Shift+Enter']) test(`zero-area native field cannot bypass activation rules with ${key}`, async () => {
  const f = inputFixture(); f.target.key = key;
  assert.equal((await f.ctx.check('press', f.target)).verdict, 'refuse');
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

for (const risk of ['payment', 'submit', 'formPayment']) test(`zero-area native typing refuses final ${risk} classification`, async () => {
  const f = inputFixture(); f.risk[risk] = true;
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'refuse');
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

test('a genuine readonly EditContext never falls back to ordinary fill', async () => {
  const f = inputFixture({ width: 200 }); f.run("elements.get(el).attrs.readonly = '';");
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'refuse');
  await assert.rejects(f.ctx.typeTarget(f.target, 'replacement', {}));
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

for (const risk of ['payment', 'submit', 'formPayment']) test(`zero-area native typing preserves prior ${risk} risk`, async () => {
  const f = inputFixture();
  f.target.prior = { tag: 'div', role: 'textbox', kind: 'text', payment: false, submit: false, formPayment: false, [risk]: true };
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'refuse');
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

test('ordinary invisible input cannot supply its own native keyboard authorization', async () => {
  const f = inputFixture({ native: false }); f.target.keyboardOnly = true;
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'refuse');
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

test('a failed prepare revokes previously granted private keyboard eligibility', async () => {
  const f = inputFixture();
  assert.equal((await f.ctx.check('type', f.target)).verdict, 'allow');
  assert.equal(rulesCheck({}, 'type', f.target).verdict, 'allow');
  f.run("elements.get(el).attrs.readonly = '';");
  await assert.rejects(f.ctx.prepareTarget(f.target));
  assert.equal(rulesCheck({}, 'type', f.target).verdict, 'refuse');
  await assert.rejects(f.ctx.typeTarget(f.target, 'no replay', {}));
  assert.deepEqual(f.events, []); await f.ctx.dispose();
});

test('native EditContext evidence identifies a zero-area textbox without reading document text', () => {
  const f = fixture(), result = f.invoke('readNativeEditContext');
  assert.equal(result.native, true); assert.equal(result.eligible, true);
  assert.equal(result.role, 'textbox'); assert.equal(result.zeroArea, true);
  const context = f.invoke('retainNativeEditContext');
  assert.equal(f.invoke('sameNativeEditContext', context), true);
  assert.deepEqual({ ...f.invoke('nativeEditContextSelection', context) }, { start: 0, end: 0 });
});

test('native getters ignore hostile own EditContext and attachedElements properties', () => {
  const f = fixture();
  f.run(`Object.defineProperty(el, 'editContext', {get() { throw Error('MAIN getter'); }});
    Object.defineProperty(elements.get(el).context, 'attachedElements', {get() { throw Error('MAIN method'); }});`);
  assert.equal(f.invoke('readNativeEditContext').eligible, true);
});

test('a role and forged object cannot supply native EditContext evidence', () => {
  const f = fixture();
  f.run(`elements.get(el).context = { attachedElements() { return [el]; }, selectionStart: 0, selectionEnd: 0 };`);
  assert.equal(f.invoke('readNativeEditContext').native, false);
  assert.equal(f.invoke('retainNativeEditContext'), null);
});

test('a real context with changed attachment or identity cannot pass the retained binding', () => {
  const f = fixture(), context = f.invoke('retainNativeEditContext');
  f.run(`elements.get(el).context = elements.get(parent).context;`);
  assert.equal(f.invoke('readNativeEditContext').eligible, false);
  assert.equal(f.invoke('sameNativeEditContext', context), false);
  assert.equal(f.invoke('nativeEditContextSelection', context), null);
});

for (const attribute of ['readonly', 'disabled', 'hidden', 'inert', 'aria-readonly', 'aria-disabled', 'aria-hidden']) {
  for (const where of ['el', 'parent']) test(`${attribute} on ${where} refuses native keyboard input`, () => {
    const f = fixture(); f.run(`elements.get(${where}).attrs['${attribute}'] = '${attribute.startsWith('aria-') ? 'true' : ''}';`);
    const result = f.invoke('readNativeEditContext');
    assert.equal(result.native, true); assert.equal(result.eligible, false);
  });
}

for (const [property, value] of [['display', 'none'], ['visibility', 'hidden'], ['visibility', 'collapse'], ['opacity', '0'], ['contentVisibility', 'hidden']]) {
  test(`hidden ancestor CSS ${property}:${value} refuses input`, () => {
    const f = fixture(); f.run(`elements.get(parent).style.${property} = '${value}';`);
    assert.equal(f.invoke('readNativeEditContext').eligible, false);
  });
}

for (const change of ["elements.get(el).connected = false", "elements.get(el).attrs.role = 'button'", "contexts.get(elements.get(el).context).attached = [el, parent]"]) {
  test(`native context eligibility refuses ${change}`, () => {
    const f = fixture(); f.run(change); assert.equal(f.invoke('readNativeEditContext').eligible, false);
  });
}

for (const hidden of [false, true]) test(`native eligibility checks the iframe owner's ancestors (hidden=${hidden})`, () => {
  const f = fixture();
  f.run(`const outerView = {frameElement:null}; outerView.top = outerView;
    const outerDoc = {nodeType:9,defaultView:outerView}, frame = make();
    elements.get(frame).document = outerDoc; view.frameElement = frame;
    ${hidden ? "elements.get(frame).style.display = 'none';" : ''}`);
  assert.equal(f.invoke('readNativeEditContext').eligible, !hidden);
});

function pasteFixture({ onStage, ...options } = {}) {
  let board = { count: 1, items: [[{ type: 'public.utf8-plain-text', data: 'b2xk' }]] };
  const events = [];
  const clipboardIO = async request => {
    events.push(request.op);
    if (request.op === 'read') return structuredClone(board);
    if (request.op === 'write') {
      assert.equal(request.expectedCount, board.count);
      board = { count: board.count + 1, items: request.items };
      if (board.count === 2) onStage?.(f);
    }
    return { count: board.count };
  };
  const f = inputFixture({ width: 20, ...options, clipboardIO });
  f.target.do = 'paste';
  return { ...f, clipboardEvents: events, board: () => board,
    copy() { board = { count: board.count + 1, items: [[{ type: 'external', data: '' }]] }; } };
}
test('paste stages after shield preparation and final ready, restoring before shield cleanup', async () => {
  const f = pasteFixture({ native: false });
  assert.equal((await f.ctx.check('paste', f.target)).verdict, 'allow');
  let stageCount;
  f.beforeRead(name => { if (name === 'inspectElement') stageCount = f.board().count; });
  await f.ctx.pasteTarget(f.target, 'text', async send => {
    assert.equal(f.board().count, 1, 'shield preparation sees the user clipboard');
    await send();
    assert.equal(f.board().count, 3, 'restoration finishes before disarm/settle');
  });
  assert.equal(stageCount, 2, 'focus and field are checked again after staging');
  await f.ctx.dispose();
});
test('a copy during the post-stage field read prevents input and is preserved', async () => {
  const f = pasteFixture({ native: false });
  assert.equal((await f.ctx.check('paste', f.target)).verdict, 'allow');
  f.beforeRead(name => { if (name === 'inspectElement' && f.board().count === 2) f.copy(); });
  await assert.rejects(f.ctx.pasteTarget(f.target, 'text', send => send()), /restoration unconfirmed/);
  assert.equal(f.events.length, 0);
  assert.equal(f.board().items[0][0].type, 'external');
  await f.ctx.dispose();
});
for (const change of ['focus', 'readonly']) test('post-stage ' + change + ' change prevents Meta down', async () => {
  const f = pasteFixture({ native: false, onStage(f) {
    if (change === 'focus') f.run('doc.activeElement = parent;');
    else f.risk.enabled = false;
  } });
  assert.equal((await f.ctx.check('paste', f.target)).verdict, 'allow');
  f.page.keyboard.down = async () => assert.fail('no Meta down');
  await assert.rejects(f.ctx.pasteTarget(f.target, 'text', send => send({ between: async () => {} })), /FOCUS|checked text field/);
  assert.equal(f.events.length, 0); assert.equal(f.board().count, 3);
  await f.ctx.dispose();
});
test('paste uses the between-frame lock and releases every pressed key on failure', async () => {
  const f = pasteFixture({ native: false }), keys = [];
  assert.equal((await f.ctx.check('paste', f.target)).verdict, 'allow');
  f.page.keyboard.down = async key => keys.push('down ' + key);
  f.page.keyboard.up = async key => keys.push('up ' + key);
  await assert.rejects(f.ctx.pasteTarget(f.target, 'text', send => send({ between: async () => {
    keys.push('between'); throw Error('new frame refused');
  } })), /new frame refused/);
  assert.deepEqual(keys, ['down ControlOrMeta', 'down V', 'between', 'up V', 'up ControlOrMeta']);
  assert.equal(f.board().count, 3); await f.ctx.dispose();
});
test('a copy after the modifier goes down prevents V and survives restoration', async () => {
  const f = pasteFixture({ native: false }), keys = [];
  assert.equal((await f.ctx.check('paste', f.target)).verdict, 'allow');
  f.page.keyboard.down = async key => { keys.push('down ' + key); f.copy(); };
  f.page.keyboard.up = async key => keys.push('up ' + key);
  await assert.rejects(f.ctx.pasteTarget(f.target, 'text', send => send({ between: () => assert.fail('no keydown') })), /restoration unconfirmed/);
  assert.deepEqual(keys, ['down ControlOrMeta', 'up ControlOrMeta']);
  assert.equal(f.board().items[0][0].type, 'external'); await f.ctx.dispose();
});
for (const change of ['focus', 'context', 'document', 'turn']) test(`paste final EditContext read refuses a post-press ${change} change`, async () => {
  const f = pasteFixture();
  assert.equal((await f.ctx.check('paste', f.target)).verdict, 'allow');
  f.page.keyboard.press = async key => {
    f.events.push({ op: 'press', key });
    if (change === 'focus') f.run('doc.activeElement = parent;');
    if (change === 'context') f.run('elements.get(el).context = elements.get(parent).context;');
    if (change === 'document') f.run('doc = {activeElement:el,defaultView:view};');
    if (change === 'turn') f.revoke();
  };
  await assert.rejects(f.ctx.pasteTarget(f.target, 'text', send => send()), /FOCUS|EDIT_CONTEXT/);
  assert.equal(f.events.length, 1, 'never replay input');
  assert.equal(f.board().count, 3, 'restore even after failed final ready');
  await f.ctx.dispose();
});
