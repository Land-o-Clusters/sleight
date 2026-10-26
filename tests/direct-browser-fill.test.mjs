import test from 'node:test';
import { utilityLocator } from './direct-browser-utility-fixture.mjs';
import assert from 'node:assert/strict';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';
import { readOptions, moveList, pickElement, findPopup } from '../plugins/sleight/lib/direct-browser/pick-option.mjs';
import { AIRPORTS, label, virtualList } from './fixtures/virtual-list.mjs';
import { withMT } from './fixtures/mt-env.mjs';
import { createSessionPause } from '../plugins/sleight/lib/session-pause.mjs';

test('pause during a field fill drops the remaining fields and submit', async () => {
  const pause = createSessionPause();
  const h = harness({ e1: element(), e2: element() }, { mutate() { pause.set(true); pause.set(false); } });
  const result = await h.fill([{ ref: 'e1', value: 'first' }, { ref: 'e2', value: 'second' }], { submit: 'e3', pauseCheck: pause.checkpoint() });
  assert.equal(h.input.length, 1); assert.equal(result.rows[0].status, 'set');
  assert.equal(result.rows[1].status, 'failed'); assert.match(result.rows[1].reason, /Paused by the user/);
  assert.equal(result.submitted.status, 'not reached');
});
test('file-field upload receives the same pause checkpoint as every other field action', async () => {
  const pause = createSessionPause(), check = pause.checkpoint(); let sent = 0;
  const h = harness({ e1: element('INPUT', { type: 'file' }) }, { submit: async (_tab, _steps, _ctx, options) => {
    pause.set(true); pause.set(false); options?.pauseCheck?.(); sent++;
    return { lines: ['1 upload e1: input sent'], stoppedAt: null };
  } });
  const result = await h.fill([{ ref: 'e1', value: ['/tmp/user-fixture.txt'] }], { pauseCheck: check });
  assert.equal(sent, 0); assert.equal(result.paused, true);
});
test('pause just before the optional submit is reported with its actionable pause state', async () => {
  const pause = createSessionPause();
  const h = harness({ e1: element() }, { mutate() { pause.set(true); } });
  const result = await h.fill([{ ref: 'e1', value: 'first' }], { submit: 'e2', pauseCheck: pause.checkpoint() });
  assert.equal(result.rows[0].status, 'set'); assert.equal(result.paused, true);
  assert.match(result.submitted.reason, /Paused by the user/);
});
test('delegated closed-root fields preserve a pause returned by the action runner', async () => {
  const h = harness({}, { submit: async () => ({ paused: true, lines: ["1 check s1: not run: Paused by the user. Wait for them to resume; don't retry."] }) });
  const result = await h.fill([{ ref: 's1', value: true }]);
  assert.equal(result.paused, true); assert.equal(result.rows[0].status, 'failed');
});

for (const mode of [undefined, '0']) for (const verdict of ['confirm', 'refuse'])
  test(`MTb fill ${verdict} stops every field and submit, switch=${mode}`, async () => withMT(mode, async () => {
    const h = harness({ e1: element(), e2: element() }, { check: () => ({ verdict }) });
    const result = await h.fill([{ ref: 'e1', value: 'first' }, { ref: 'e2', value: 'second' }], { submit: 'e3' });
    assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
    assert.equal(result.rows[0].reason, (verdict === 'confirm' ? 'confirmation required' : 'rules refused input')
      + (mode === '0' ? '; use the engine browser path' : ''));
    assert.equal(result.submitted.status, 'not reached');
    assert.deepEqual(h.input, []);
  }));

test('MTb missing guarded-submit result reports capability loss and uncertain input', async () => {
  const node = element('BUTTON', { role: 'checkbox', type: 'submit' }); node.closest = () => ({});
  const loc = utilityLocator({ evaluate: async (fn, arg) => fn(node, arg) });
  let delegated = 0;
  const fill = createFillFields({ check: () => 'allow', inspectElement: () => ({ tag: 'button', kind: 'button', submit: true }),
    runSteps: async () => { delegated++; } });
  const result = await fill({ page: { on() {}, off() {}, getByRef: () => loc }, state: { snapshotNo: 1 } }, [{ ref: 'e1', value: true }]);
  assert.equal(result.rows[0].status, 'failed'); assert.equal(delegated, 1);
  assert.match(result.rows[0].reason, /guarded submit result unavailable.*may have changed.*use the engine browser path/);
});

function element(tag = 'INPUT', attrs = {}, value = '') {
  return { tagName: tag, type: attrs.type ?? 'text', value, checked: false, isConnected: true,
    disabled: false, readOnly: false, isContentEditable: false, options: [], children: [],
    labels: [], validity: { valid: true },
    getAttribute: key => attrs[key] ?? null,
    closest: () => null,
    matches: selector => selector === ':disabled' && false };
}
function harness(nodes, { check = () => 'allow', mutate, submit, event, sleep, now, backgroundClick, hand } = {}) {
  const listeners = new Map(), input = [], resolve = [];
  const emit = name => { for (const fn of listeners.get(name) ?? []) fn(event ?? page); };
  const locator = node => utilityLocator({
    async evaluate(fn, arg) { return fn(node, arg); },
    async count() { return node ? 1 : 0; },
    async fill(value) { assert.ok(['INPUT', 'TEXTAREA'].includes(node.tagName) || node.isContentEditable, 'Playwright fill needs an editable field'); input.push(['fill', node, value]); node.value = value; await mutate?.(node, 'fill', emit); },
    async setChecked(value) { input.push(['check', node, value]); node.checked = value; await mutate?.(node, 'check', emit); },
    async click() { input.push(['click', node]); node.checked = !node.checked; await mutate?.(node, 'click', emit); },
    async press(key) { input.push(['press', node, key]); await mutate?.(node, 'press', emit); },
    async selectOption(options) { input.push(['select', node, options]);
      node.options.forEach(o => { o.selected = options.some(w => w.value === o.value); });
      node.value = node.options.find(o => o.selected)?.value ?? ''; },
    async waitFor() { if (!node?.isConnected) throw Error('detached'); },
    async dragTo(target) { input.push(['drag', node, target.node]); await mutate?.(node, 'drag', emit, target.node); },
    node,
  });
  const page = {
    locator(selector) { assert.match(selector, /^aria-ref=(?:f\d+)?e\d+$/); resolve.push(selector); return locator(nodes[selector.slice(9)]); },
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    off(name, fn) { listeners.get(name)?.delete(fn); },
    mainFrame() { return page; },
    url() { return 'http://fixture.invalid/form'; },
  };
  const tab = { page, state: { snapshotNo: 1, submitUnconfirmed: false } };
  const fill = createFillFields({ check, sleep, now, backgroundClick, hand, runSteps: submit ?? (async () => { throw Error('unexpected submit'); }) });
  return { fill: (fields, options = {}) => fill(tab, fields, options, { userMessage: 'fill this form', consent: null, files: [] }),
    input, resolve, listeners, tab, locator, emit };
}

test('direct field strategies report started and failed input to the browser cursor without sharing field values', async () => {
  const events = [], token = {}, hand = { step(input) { events.push(['step', input.op, input.text]); return token; },
    finish(value, failed) { assert.equal(value, token); events.push(['finish', failed]); } };
  const h = harness({ e1: element(), e2: element() }, { hand, mutate: node => { if (node.value === 'fail-secret') throw Error('fixture input failed'); } });
  const result = await h.fill([{ ref: 'e1', value: 'first-secret' }, { ref: 'e2', value: 'fail-secret' }]);
  assert.deepEqual(result.rows.map(row => row.status), ['set', 'failed']);
  assert.deepEqual(events, [['step', 'type', undefined], ['finish', false], ['step', 'type', undefined], ['finish', true]]);
});

test('whole-form fill sets text, numbers, dates, checkbox and multi-select with one row per field', async () => {
  const nodes = { e1: element(), e2: element('INPUT', { type: 'number' }), e3: element('INPUT', { type: 'date' }),
    e4: element('INPUT', { type: 'checkbox' }), e5: element('SELECT', { multiple: '' }) };
  nodes.e5.multiple = true;
  nodes.e5.options = [{ value: 'ja', label: 'Japanese', selected: false, disabled: false }, { value: 'ko', label: 'Korean', selected: false, disabled: false }];
  const h = harness(nodes), r = await h.fill([{ ref: 'e1', value: 'Name' }, { ref: 'e2', value: 3 },
    { ref: 'e3', value: '2026-11-19' }, { ref: 'e4', value: true }, { ref: 'e5', value: ['Japanese', 'ko'] }]);
  assert.deepEqual(r.rows.map(row => row.status), ['set', 'set', 'set', 'set', 'set']);
  assert.equal(nodes.e1.value, 'Name'); assert.equal(nodes.e2.value, '3'); assert.equal(nodes.e3.value, '2026-11-19');
  assert.equal(nodes.e4.checked, true); assert.deepEqual(nodes.e5.options.map(o => o.selected), [true, true]);
  assert.equal(r.submitted.status, 'not requested');
});

test('native multi-select replaces prior choices and an empty array clears every option', async () => {
  const node = element('SELECT'); node.multiple = true;
  node.options = [
    { value: 'en', label: 'English', selected: true },
    { value: 'pt-BR', label: 'Portuguese (Brazil)', selected: true },
    { value: 'ja', label: 'Japanese', selected: false },
  ];
  const h = harness({ e1: node });
  assert.equal((await h.fill([{ ref: 'e1', value: ['Portuguese (Brazil)', 'Japanese'] }])).rows[0].status, 'set');
  assert.deepEqual(node.options.map(o => o.selected), [false, true, true]);
  assert.equal((await h.fill([{ ref: 'e1', value: [] }])).rows[0].status, 'set');
  assert.deepEqual(node.options.map(o => o.selected), [false, false, false]);
});

function multiList({ refuse, broken = false, disabled = false, duplicate = false, incomplete = false, boundary, guardRefusal, guardBoundary, guardPending } = {}) {
  const node = element('DIV', { role: 'listbox', 'aria-multiselectable': 'true' });
  const attrs = [
    { role: 'option', 'aria-selected': 'true' },
    { role: 'option', 'aria-selected': 'true' },
    { role: 'option', 'aria-selected': 'false', 'aria-disabled': String(disabled), ...(incomplete ? { 'aria-setsize': '100' } : {}) },
  ];
  const names = ['English', 'Portuguese (Brazil)', duplicate ? 'Portuguese (Brazil)' : 'Japanese'];
  node.children = names.map((textContent, i) => Object.assign(element('DIV', attrs[i]), { textContent, closest: () => node }));
  node.querySelectorAll = selector => { assert.equal(selector, '[role="option"]'); return node.children; };
  const clicks = [], checks = [], guards = [], h = harness({ e1: node }, { sleep: async () => {},
    backgroundClick: async (tab, locator, click, opts) => {
      assert.equal(tab, h.tab); assert.ok(!tab.state.actionPending);
      assert.equal(opts.modifier, process.platform === 'darwin' ? 'Meta' : 'Control');
      guards.push(locator);
      if (guardRefusal) throw Error(guardRefusal);
      if (guardBoundary) h.emit(guardBoundary);
      if (guardPending) tab.state.actionPending = guardPending;
      return click({ modifiers: ['ControlOrMeta'] });
    }, check: (ctx, kind, target) => {
    checks.push(target.element);
    return refuse ? { status: 'refuse', message: 'payment confirmation required' } : 'allow';
  } });
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => {
    const list = base(selector);
    list.getByRole = (role, opts) => {
      assert.equal(role, 'option'); assert.equal(opts.exact, true);
      const i = names.indexOf(opts.name);
        const option = h.locator(node.children[i]);
        option.click = async opts => {
          clicks.push([i, opts]);
          assert.deepEqual(opts.modifiers, ['ControlOrMeta', process.platform === 'darwin' ? 'Meta' : 'Control']);
          if (!broken) attrs[i]['aria-selected'] = String(attrs[i]['aria-selected'] !== 'true');
          if (boundary) h.emit(boundary);
        };
        return option;
    };
    return list;
  };
  return { ...h, node, attrs, clicks, checks, guards, selection: () => attrs.map(a => a['aria-selected']) };
}

test('ARIA multi-select sets exactly the requested texts through option clicks, then clears', async () => {
  const h = multiList();
  const result = await h.fill([{ ref: 'e1', value: ['Portuguese (Brazil)', 'Japanese'] }]);
  assert.equal(result.rows[0].status, 'set', JSON.stringify(result));
  assert.deepEqual(h.selection(), ['false', 'true', 'true']);
  assert.deepEqual(h.clicks.map(([i]) => i), [0, 2]);
  assert.equal(h.checks.length, 2);
  assert.equal(h.guards.length, 2);
  assert.equal((await h.fill([{ ref: 'e1', value: [] }])).rows[0].status, 'set');
  assert.deepEqual(h.selection(), ['false', 'false', 'false']);
});

for (const reason of ['modified target contains a link', 'modified target is inside a control',
  'modified target has a window.open handler', 'focus is held inside a frame (a card field)'])
  test('ARIA multi-select stops before input when backgroundClick refuses: ' + reason, async () => {
    const h = multiList({ guardRefusal: reason }), before = h.selection();
    const result = await h.fill([{ ref: 'e1', value: ['Japanese'] }]);
    assert.equal(result.rows[0].status, 'failed');
    assert.equal(h.guards.length, 1); assert.deepEqual(h.clicks, []); assert.deepEqual(h.checks, []);
    assert.deepEqual(h.selection(), before); assert.equal(h.tab.state.actionPending, undefined);
  });

for (const guardBoundary of ['framenavigated', 'dialog', 'popup', 'close']) test('ARIA modifier preparation respects a new boundary: ' + guardBoundary, async () => {
  const h = multiList({ guardBoundary }), before = h.selection();
  assert.equal((await h.fill([{ ref: 'e1', value: ['Japanese'] }])).rows[0].status, 'failed');
  assert.deepEqual(h.clicks, []); assert.deepEqual(h.checks, []); assert.deepEqual(h.selection(), before);
});

test('ARIA modifier preparation cannot consume authority after another input becomes pending', async () => {
  const pending = {}, h = multiList({ guardPending: pending });
  assert.equal((await h.fill([{ ref: 'e1', value: ['Japanese'] }])).rows[0].status, 'failed');
  assert.deepEqual(h.clicks, []); assert.deepEqual(h.checks, []); assert.equal(h.tab.state.actionPending, pending);
});

for (const opts of [{ disabled: true }, { duplicate: true }, { incomplete: true }]) test('ARIA multi-select refuses unavailable choices before changing any option: ' + JSON.stringify(opts), async () => {
  const h = multiList(opts), before = h.selection();
  const result = await h.fill([{ ref: 'e1', value: ['Japanese'] }]);
  assert.equal(result.rows[0].status, 'failed');
  assert.deepEqual(h.selection(), before); assert.deepEqual(h.clicks, []);
});

test('ARIA multi-select leaves an already correct set alone and rejects missing or repeated texts', async () => {
  const h = multiList();
  assert.equal((await h.fill([{ ref: 'e1', value: ['English', 'Portuguese (Brazil)'] }])).rows[0].status, 'set');
  for (const value of [['Korean'], ['Japanese', 'Japanese']])
    assert.equal((await h.fill([{ ref: 'e1', value }])).rows[0].status, 'failed');
  assert.deepEqual(h.clicks, []);
});

test('ARIA multi-select guards option input and reports a page that ignores a toggle as failed', async () => {
  const blocked = multiList({ refuse: true });
  assert.equal((await blocked.fill([{ ref: 'e1', value: [] }])).rows[0].status, 'failed');
  assert.equal(blocked.checks.length, 1); assert.deepEqual(blocked.clicks, []);
  const broken = multiList({ broken: true });
  assert.equal((await broken.fill([{ ref: 'e1', value: [] }])).rows[0].status, 'failed');
  assert.equal(broken.clicks.length, 1, 'a failed toggle must never be retried');
});

test('ARIA multi-select stops toggling when a page boundary arrives', async () => {
  const h = multiList({ boundary: 'dialog' });
  const result = await h.fill([{ ref: 'e1', value: [] }, { ref: 'e2', value: 'untouched' }]);
  assert.equal(h.clicks.length, 1);
  assert.equal(result.rows[0].status, 'failed', 'a partial selection must not be reported as set');
  assert.equal(result.rows[1].status, 'not reached'); assert.match(result.stopped, /dialog/);
});
test('field failure preserves prior results and leaves later fields and submit not reached', async () => {
  const a = element(), b = element(), c = element(); b.readOnly = true;
  const h = harness({ e1: a, e2: b, e3: c });
  const r = await h.fill([{ ref: 'e1', value: 'a' }, { ref: 'e2', value: 'b' }, { ref: 'e3', value: 'c' }], { submit: 'e4' });
  assert.deepEqual(r.rows.map(row => row.status), ['set', 'failed', 'not reached']);
  assert.match(r.rows[1].reason, /readonly/i); assert.equal(c.value, ''); assert.equal(r.submitted.status, 'not reached');
});
test('rules refuse a field before physical input', async () => {
  const a = element(); const h = harness({ e1: a }, { check: (ctx, kind, target) => {
    assert.equal(kind, 'type'); assert.equal(target.ref, 'e1'); assert.equal(target.tab.state.snapshotNo, 1);
    return { status: 'refuse', message: 'user approval required' };
  } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(h.input.length, 0); assert.equal(a.value, '');
});
test('protected fill and action errors never print field values or Playwright call logs', async () => {
  const secret = '4242424242424242', node = element('INPUT', { id: 'cardNumber' });
  const h = harness({ f2e1: node }, { mutate() { throw Error('fill("' + secret + '") timed out'); } });
  const r = await h.fill([{ ref: 'f2e1', value: secret }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(h.input.length, 1);
  assert.doesNotMatch(JSON.stringify(r), /4242424242424242/); assert.match(r.rows[0].reason, /may have changed/i);
});
test('frame-prefixed refs use Playwright frame routing and child fields cannot fall back to a parent ref', async () => {
  const child = element(), parent = element(); const h = harness({ f7e2: child, e2: parent });
  const r = await h.fill([{ ref: 'f7e2', value: 'child' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(child.value, 'child'); assert.equal(parent.value, '');
  assert.deepEqual(h.resolve, ['aria-ref=f7e2']);
});
test('submit delegates exactly once to the guarded action layer after fields succeed', async () => {
  const seen = [], h = harness({ e1: element() }, { submit: async (tab, steps, ctx) => {
    seen.push(steps); assert.equal(ctx.userMessage, 'fill this form');
    return { lines: ['1 click e9: done'], stoppedAt: null, observe: 'diff' };
  } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }], { submit: 'e9' });
  assert.deepEqual(seen, [[{ do: 'click', ref: 'e9' }]]); assert.equal(r.submitted.status, 'done');
});
test('a submit refusal is reported without turning already set fields into failures', async () => {
  const h = harness({ e1: element() }, { submit: async () => { throw Error('SUBMIT_UNCONFIRMED'); } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }], { submit: 'e9' });
  assert.equal(r.rows[0].status, 'set'); assert.equal(r.submitted.status, 'failed');
  assert.match(r.submitted.reason, /SUBMIT_UNCONFIRMED/);
});
test('navigation after a field stops the rest and removes event listeners', async () => {
  const h = harness({ e1: element(), e2: element() }, { mutate(node, kind, emit) { emit('framenavigated'); } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }, { ref: 'e2', value: 'y' }], { submit: 'e9' });
  assert.equal(r.rows[1].status, 'not reached'); assert.equal(r.submitted.status, 'not reached'); assert.equal(h.input.length, 1);
  assert.ok([...h.listeners.values()].every(v => v.size === 0));
});
test('a page dialog after input is an observation and stops remaining fields', async () => {
  const h = harness({ e1: element(), e2: element() }, { mutate(node, kind, emit) { emit('dialog'); } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }, { ref: 'e2', value: 'y' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(r.rows[1].status, 'not reached'); assert.match(r.stopped, /dialog/i);
});
test('formatted text is observed without a false failure or an input retry', async () => {
  const node = element('INPUT', { id: 'phone' }); const h = harness({ e1: node }, { mutate(n) { n.value = '(555) 555-1212'; } });
  const r = await h.fill([{ ref: 'e1', value: '5555551212' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(h.input.length, 1); assert.match(r.rows[0].note, /formatted/i);
});
for (const fields of [[], Array.from({ length: 61 }, () => ({ ref: 'e1', value: 'x' })), [{ ref: 'e1', value: {} }],
  [{ ref: 'e1', value: Infinity }], [{ ref: '#anything', value: 'x' }], [{ ref: 'e1', value: ['a', 2] }]]) {
  test('invalid whole-form input is rejected before any physical action: ' + JSON.stringify(fields).slice(0, 70), async () => {
    const h = harness({ e1: element() });
    await assert.rejects(h.fill(fields), /fields|value|ref/i); assert.equal(h.input.length, 0);
  });
}
test('all 60 permitted fields are filled', async () => {
  const node = element(), h = harness({ e1: node });
  const r = await h.fill(Array.from({ length: 60 }, (_, i) => ({ ref: 'e1', value: String(i) })));
  assert.equal(r.rows.length, 60); assert.ok(r.rows.every(row => row.status === 'set')); assert.equal(node.value, '59');
});
test('a closed-shadow host checked getter uses a single click and verifies its state', async () => {
  const node = element('CUSTOM-SWITCH'), h = harness({ e1: node });
  const r = await h.fill([{ ref: 'e1', value: true }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.checked, true); assert.equal(h.input.length, 1);
});
test('unsupported file input requires the upload action and is never treated as text', async () => {
  const h = harness({ e1: element('INPUT', { type: 'file' }) });
  const r = await h.fill([{ ref: 'e1', value: '/tmp/page-supplied.txt' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.match(r.rows[0].reason, /upload/i); assert.equal(h.input.length, 0);
});

test('autocomplete waits for the exact suggestion and confirms it without submitting on Enter', async () => {
  const node = element('INPUT', { role: 'combobox', 'aria-controls': 'choices' }), option = element('LI');
  const h = harness({ e1: node }); let clicked = 0;
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => {
    const loc = base(selector);
    loc.elementHandle = async () => ({ _connection: loc._connection, ownerFrame: async () => ({ locator: selector => {
      assert.equal(selector, '[id="choices"]');
      return { getByRole(role, opts) { assert.equal(role, 'option'); assert.deepEqual(opts, { name: '123 Test Street', exact: true });
        return utilityLocator({ async evaluate(fn, arg) { return fn(option, arg); }, async waitFor() {}, async count() { return 1; }, async click() { clicked++; node.value = '123 Test Street'; } }); } };
    } }), async dispose() {} });
    return loc;
  };
  const r = await h.fill([{ ref: 'e1', value: '123 Test Street' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(clicked, 1); assert.equal(node.value, '123 Test Street');
  assert.equal(h.input.filter(a => a[0] === 'press').length, 0);
});
test('ambiguous autocomplete refuses to pick either suggestion and does not retry text entry', async () => {
  const node = element('INPUT', { role: 'combobox', 'aria-controls': 'choices' }), h = harness({ e1: node });
  const base = h.tab.page.locator; let clicks = 0;
  h.tab.page.locator = selector => { const loc = base(selector);
    loc.elementHandle = async () => ({ _connection: loc._connection, ownerFrame: async () => ({ locator: () => ({ getByRole: () => ({
      async waitFor() {}, async count() { return 2; }, async click() { clicks++; }
    }) }) }), async dispose() {} }); return loc; };
  const r = await h.fill([{ ref: 'e1', value: 'duplicate' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(clicks, 0); assert.equal(h.input.filter(a => a[0] === 'fill').length, 1);
});
function nativeRange({ min = '0', max = '100', step = '1', value = '0' } = {}) {
  const node = element('INPUT', { type: 'range' }, value), events = [];
  Object.assign(node, { min, max, step });
  class Input {}
  Object.defineProperty(Input.prototype, 'value', { set(next) { Object.defineProperty(this, 'value', { value: next, writable: true, configurable: true }); } });
  node.ownerDocument = { defaultView: { getComputedStyle: () => ({}), HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } } } };
  node.dispatchEvent = event => { events.push(event.type); };
  return { node, events };
}
test('a native range takes a number directly with input and change events and no key presses', async () => {
  const { node, events } = nativeRange(), h = harness({ e1: node });
  const r = await h.fill([{ ref: 'e1', value: 37 }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, '37'); assert.deepEqual(events, ['input', 'change']);
  assert.equal(h.input.length, 0);
});
test('a native range takes the numeric string a model usually sends', async () => {
  const { node, events } = nativeRange({ value: '50' }), h = harness({ e1: node });
  const r = await h.fill([{ ref: 'e1', value: '82' }, ]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, '82'); assert.deepEqual(events, ['input', 'change']); assert.equal(h.input.length, 0);
});
test('a native range with no step attribute, a decimal step or step any is set to a value that fits', async () => {
  for (const [attrs, value, expected] of [[{ step: '' }, '7', '7'], [{ min: '1', max: '2', step: '0.25' }, '1.75', '1.75'], [{ step: 'any' }, '33.3', '33.3'], [{ min: '10', max: '20', step: '5' }, 15, '15']]) {
    const { node } = nativeRange(attrs), h = harness({ e1: node }), r = await h.fill([{ ref: 'e1', value }]);
    assert.equal(r.rows[0].status, 'set', JSON.stringify(attrs)); assert.equal(node.value, expected);
  }
});
test('a range value that is off its step names the nearest valid values and sends no input', async () => {
  const { node, events } = nativeRange({ min: '0', max: '10', step: '3' }), h = harness({ e1: node });
  let r = await h.fill([{ ref: 'e1', value: 4 }]);
  assert.equal(r.rows[0].status, 'failed'); assert.match(r.rows[0].reason, /off its step of 3 from 0; nearest valid values are 3 and 6/);
  r = await h.fill([{ ref: 'e1', value: '10' }]);
  assert.match(r.rows[0].reason, /nearest valid values are 9$/);
  assert.equal(h.input.length, 0); assert.deepEqual(events, []); assert.equal(node.value, '0');
});
test('a range value outside its bounds or not a number is refused with the bounds before any action', async () => {
  const { node, events } = nativeRange(), h = harness({ e1: node });
  for (const [value, reason] of [[101, /101 is outside 0 to 100/], [-1, /outside 0 to 100/], ['abc', /needs a number/], ['', /needs a number/]]) {
    const r = await h.fill([{ ref: 'e1', value }]);
    assert.equal(r.rows[0].status, 'failed'); assert.match(r.rows[0].reason, reason);
  }
  assert.equal(h.input.length, 0); assert.deepEqual(events, []);
});
test('a custom slider with no native value property is still moved by keys and read back', async () => {
  const node = element('DIV', { role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '10' });
  let now = 0;
  node.getAttribute = key => key === 'role' ? 'slider' : key === 'aria-valuemin' ? '0' : key === 'aria-valuemax' ? '10' : key === 'aria-valuenow' ? String(now) : null;
  const h = harness({ e1: node }, { mutate(n, kind) { if (kind === 'press') now = h.input.at(-1)[2] === 'Home' ? 0 : now + 1; } });
  const r = await h.fill([{ ref: 'e1', value: '4' }]);
  assert.equal(r.rows[0].status, 'set'); assert.deepEqual(h.input.map(a => a[2]), ['Home', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight']);
});
test('reorder validates a permutation, drags each misplaced row and observes the final order', async () => {
  const node = element('UL'), names = ['Alpha', 'Beta', 'Gamma'];
  node.children = names.map(name => ({ textContent: name, getAttribute(key) { return key === 'draggable' ? 'true' : key === 'aria-label' ? name : null; } }));
  const h = harness({ e1: node }, { mutate(n, kind, emit, target) {
    if (kind === 'drag') { const from = node.children.indexOf(n), to = node.children.indexOf(target); node.children.splice(from, 1); node.children.splice(to, 0, n); }
  } });
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector);
    loc.locator = selector => { assert.equal(selector, ':scope > li'); return { nth: i => h.locator(node.children[i]) }; };
    return loc; };
  const r = await h.fill([{ ref: 'e1', value: ['Gamma', 'Alpha', 'Beta'] }]);
  assert.equal(r.rows[0].status, 'set'); assert.deepEqual(node.children.map(n => n.textContent), ['Gamma', 'Alpha', 'Beta']);
});
test('an invalid reorder permutation never starts a drag', async () => {
  const node = element('UL'); node.children = [{ textContent: 'Alpha', getAttribute: key => key === 'draggable' ? 'true' : null }];
  const h = harness({ e1: node }); const r = await h.fill([{ ref: 'e1', value: ['Wrong'] }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(h.input.length, 0);
});

test('field inspection errors cannot leak private values before input', async () => {
  const node = element(); Object.defineProperty(node, 'value', { get() { throw Error('private-field-123456'); } });
  const h = harness({ e1: node }); const r = await h.fill([{ ref: 'e1', value: 'private-field-123456' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.doesNotMatch(JSON.stringify(r), /private-field-123456/);
});
test('an action-layer submit that did not run is not reported as done', async () => {
  const h = harness({ e1: element() }, { submit: async () => ({ lines: ['1 click e9: not run: payment confirmation required'], stoppedAt: 1, observe: undefined }) });
  const r = await h.fill([{ ref: 'e1', value: 'x' }], { submit: 'e9' });
  assert.equal(r.submitted.status, 'failed');
});
test('file fields delegate user-named paths to the guarded upload action', async () => {
  const seen = [], h = harness({ e1: element('INPUT', { type: 'file' }) }, { submit: async (tab, steps) => {
    seen.push(steps); return { lines: ['1 upload e1: input sent; observation below'], stoppedAt: null };
  } });
  const r = await h.fill([{ ref: 'e1', value: ['/tmp/user-fixture.txt'] }]);
  assert.equal(r.rows[0].status, 'set'); assert.deepEqual(seen, [[{ do: 'upload', ref: 'e1', paths: ['/tmp/user-fixture.txt'] }]]);
});

test('closed-root snapshot refs delegate to the action layer without guessing a parent selector', async () => {
  const seen = [], h = harness({}, { submit: async (tab, steps) => { seen.push(steps); return { lines: ['1 check s1: input sent; observation below'], stoppedAt: null }; } });
  const r = await h.fill([{ ref: 's1', value: true }]);
  assert.equal(r.rows[0].status, 'set'); assert.deepEqual(seen, [[{ do: 'check', ref: 's1' }]]); assert.equal(h.resolve.length, 0);
});
// A list handle and option handle in the unit harness's bridge. The page functions are told apart by identity.
function listHandles(loc, sim, { onClick, popup = true } = {}) {
  const option = (index, text) => ({ _connection: loc._connection, click: async () => { sim.pick(index); onClick?.(text); }, async dispose() {}, asElement() { return this; } });
  const list = { _connection: loc._connection, async dispose() {}, asElement() { return this; },
    evaluate: async (fn, arg) => fn === readOptions ? sim.read() : fn === moveList ? sim.move(arg) : loc.evaluate(fn, arg),
    async evaluateHandle(fn, arg) { assert.equal(fn, pickElement);
      const rows = (await sim.read()).rows, row = rows[arg.index]; return row && row.t === arg.t ? option(arg.index, row.t) : { asElement: () => null, async dispose() {} }; } };
  return popup ? list : null;
}
test('a listbox row is found by its text over a virtual list and clicked once', async () => {
  const items = AIRPORTS.map(label), sim = virtualList(items, { marks: true }), node = element('DIV', { role: 'listbox' }), clicked = [];
  const h = harness({ e1: node }), base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector); const list = listHandles(loc, sim, { onClick: text => clicked.push(text) });
    loc.elementHandle = async () => list; return loc; };
  const r = await h.fill([{ ref: 'e1', value: AIRPORTS[301].name + ' ' + AIRPORTS[301].code }]);
  assert.equal(r.rows[0].status, 'set', JSON.stringify(r)); assert.deepEqual(clicked, [items[301]]); assert.equal(sim.chosen, items[301]);
  assert.equal(r.rows[0].note, 'chose "' + items[301] + '"'); assert.ok(sim.calls.read < 20, 'reads ' + sim.calls.read);
});
test('a listbox with no matching row fails with the closest rows and clicks nothing', async () => {
  const sim = virtualList(AIRPORTS.map(label)), node = element('DIV', { role: 'listbox' }), h = harness({ e1: node }), base = h.tab.page.locator; let clicks = 0;
  h.tab.page.locator = selector => { const loc = base(selector); const list = listHandles(loc, sim, { onClick: () => clicks++ }); loc.elementHandle = async () => list; return loc; };
  const r = await h.fill([{ ref: 'e1', value: 'Harcliff Nowhere (QQQ)' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(clicks, 0);
  assert.match(r.rows[0].reason, /^no option matches "Harcliff Nowhere \(QQQ\)"; closest: "/); assert.deepEqual(h.input, []);
});
test('a listbox row clicked but not shown as selected fails when other rows are', async () => {
  const items = AIRPORTS.map(label), sim = virtualList(items, { marks: true }), node = element('DIV', { role: 'listbox' }), h = harness({ e1: node }), base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector); const list = listHandles(loc, sim, { onClick: () => {} });
    const click = list.evaluateHandle; list.evaluateHandle = async (fn, arg) => { const handle = await click(fn, arg); handle.click = async () => sim.pick(Math.max(0, arg.index - 1)); return handle; };
    loc.elementHandle = async () => list; return loc; };
  const r = await h.fill([{ ref: 'e1', value: items[100] }]);
  assert.equal(r.rows[0].status, 'failed'); assert.match(r.rows[0].reason, /clicked but is not shown as selected/);
});
test('a combobox types the text, finds the row in its popup by words, and reads the input back', async () => {
  const items = AIRPORTS.map(label), sim = virtualList(items), node = element('INPUT', { role: 'combobox', 'aria-controls': 'popup' }), clicked = [];
  const h = harness({ e1: node }), base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector); const list = listHandles(loc, sim, { onClick: text => { clicked.push(text); node.value = text; } });
    loc.elementHandle = async () => ({ ...list, ownerFrame: async () => ({ locator: () => ({ getByRole: () => ({ waitFor: async () => { throw Error('timeout'); } }) }) }) });
    loc.evaluateHandle = async fn => { assert.equal(fn, findPopup); return list; };
    return loc; };
  const want = AIRPORTS[250].name + ' ' + AIRPORTS[250].code, r = await h.fill([{ ref: 'e1', value: want }]);
  assert.equal(r.rows[0].status, 'set', JSON.stringify(r)); assert.deepEqual(clicked, [items[250]]); assert.equal(node.value, items[250]);
  assert.deepEqual(h.input.map(a => a[0]), ['fill'], 'one fill of the typed text'); assert.equal(h.input[0][2], want);
});
test('a combobox whose popup never lists the text types the shorter queries, restores the asked text and says so', async () => {
  const sim = virtualList(AIRPORTS.map(label)), node = element('INPUT', { role: 'combobox', 'aria-controls': 'popup' }), h = harness({ e1: node }), base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector); const list = listHandles(loc, sim);
    loc.elementHandle = async () => ({ ...list, ownerFrame: async () => ({ locator: () => ({ getByRole: () => ({ waitFor: async () => { throw Error('timeout'); } }) }) }) });
    loc.evaluateHandle = async () => list; return loc; };
  const r = await h.fill([{ ref: 'e1', value: 'Harcliff Nowhere Airport (QQQ)' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.match(r.rows[0].reason, /no option matches.*; the field holds the text typed while searching/);
  assert.deepEqual(h.input.map(a => a[2]), ['Harcliff Nowhere Airport (QQQ)', 'Harcliff Nowhere Airport', 'Harcliff Nowhere', 'Harcliff Nowhere Airport (QQQ)']);
});
test('a combobox that opens no popup says so instead of reporting a changed field', async () => {
  const node = element('INPUT', { role: 'combobox' }), h = harness({ e1: node }), base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector); loc.evaluateHandle = async () => ({ asElement: () => null, async dispose() {} }); return loc; };
  const r = await h.fill([{ ref: 'e1', value: 'x' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.match(r.rows[0].reason, /opened no option list/);
});

test('field input matches V6 operation-kind, element and verdict interface', async () => {
  const h = harness({ e1: element() }, { check(ctx, kind, target) {
    assert.equal(kind, 'type'); assert.equal(target.element.tag, 'input'); assert.equal(target.state.snapshotNo, 1);
    return { verdict: 'allow' };
  } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }]); assert.equal(r.rows[0].status, 'set');
});

test('a custom toggle that is also a payment submit cannot bypass the trusted inspector', async () => {
  const node = element('CUSTOM-TOGGLE'); let clicks = 0;
  const page = { on() {}, off() {}, getByRef: () => utilityLocator({ evaluate: async (fn, arg) => fn(node, arg), click: async () => { clicks++; } }) };
  const fill = createFillFields({ inspectElement: () => ({ tag: 'button', kind: 'button', connected: true, visible: true, enabled: true,
    submit: true, payment: true, formPayment: true, form: true }),
    check: (ctx, kind, target) => target.element.payment ? { verdict: 'confirm', terms: {} } : { verdict: 'allow' }, runSteps: async () => {} });
  const r = await fill({ page, state: { snapshotNo: 1, submitUnconfirmed: false } }, [{ ref: 'e1', value: true }], {}, {});
  assert.equal(r.rows[0].status, 'failed'); assert.equal(clicks, 0);
});

test('a native color field sets a validated color without opening the platform picker', async () => {
  const node = element('INPUT', { type: 'color' }, '#000000'), events = [];
  node.ownerDocument = { defaultView: { getComputedStyle: () => ({}), Event: class { constructor(type) { this.type = type; } } } };
  class Input {}
  Object.defineProperty(Input.prototype, 'value', { set(value) { Object.defineProperty(this, 'value', { value, writable: true, configurable: true }); } });
  node.ownerDocument.defaultView.HTMLInputElement = Input;
  node.dispatchEvent = event => { events.push(event.type); };
  const h = harness({ e1: node }); const r = await h.fill([{ ref: 'e1', value: '#123abc' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, '#123abc'); assert.deepEqual(events, ['input', 'change']);
  assert.equal(h.input.length, 0);
});

test('a noneditable combobox opens its option list and never attempts text fill', async () => {
  const node = element('BUTTON', { role: 'combobox', 'aria-controls': 'choices', type: 'button' }, 'Choose'), option = element('LI');
  const h = harness({ e1: node }); const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector);
    loc.elementHandle = async () => ({ _connection: loc._connection, ownerFrame: async () => ({ locator: () => ({ getByRole: () => utilityLocator({
      async evaluate(fn, arg) { return fn(option, arg); }, async waitFor() {}, async count() { return 1; }, async click() { node.value = 'Exact'; }
    }) }) }), async dispose() {} }); return loc;
  };
  const r = await h.fill([{ ref: 'e1', value: 'Exact' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, 'Exact'); assert.deepEqual(h.input.map(row => row[0]), ['click']);
});

test('a dependent disabled select waits for its new options before any selection input', async () => {
  const node = element('SELECT'); node.disabled = true;
  node.options = [{ value: '', label: 'Loading', disabled: false, selected: true }];
  let waits = 0, time = 0;
  const h = harness({ e1: node }, { now: () => time, sleep: async ms => {
    time += ms; waits++; node.disabled = false;
    node.options = [{ value: 'Osaka', label: 'Osaka', disabled: false, selected: false }];
  } });
  const r = await h.fill([{ ref: 'e1', value: 'Osaka' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(waits, 1); assert.equal(node.value, 'Osaka');
  assert.equal(h.input.filter(a => a[0] === 'select').length, 1);
});
test('a clipped native radio uses its associated label without attempting or retrying setChecked', async () => {
  const node = element('INPUT', { type: 'radio' }), label = element('LABEL'); node.labels = [label];
  node.ownerDocument = { defaultView: { getComputedStyle: () => ({ clip: 'rect(0px, 0px, 0px, 0px)' }) } };
  let nativeAttempts = 0;
  const h = harness({ e1: node }, { mutate(n, kind) { if (n === label && kind === 'click') node.checked = true; } });
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector);
    loc.setChecked = async () => { nativeAttempts++; throw Error('clipped native radio'); };
    loc.evaluateHandle = async fn => ({ asElement: () => h.locator(fn(node)), async dispose() {} });
    return loc;
  };
  const r = await h.fill([{ ref: 'e1', value: true }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.checked, true); assert.equal(nativeAttempts, 0);
  assert.equal(h.input.filter(a => a[0] === 'click').length, 1);
});

test('submit-capable check fields delegate one physical click and retain the shared retry marker', async () => {
  const node = element('BUTTON', { role: 'checkbox', type: 'submit' }); node.closest = () => ({});
  let h, dispatches = 0, delegated = 0;
  h = harness({ e1: node }, { mutate(n) { n.checked = false; throw Error('dispatch timed out'); },
    submit: async (tab, steps) => {
      delegated++; assert.deepEqual(steps, [{ do: 'click', ref: 'e1' }]);
      if (tab.state.submitUnconfirmed) return { lines: ['1 click e1: not run: submit unconfirmed'], stoppedAt: 1 };
      tab.state.submitUnconfirmed = { startedAt: 1000, snapshotNo: 1, settledAt: 6000 };
      try { dispatches++; await tab.page.locator('aria-ref=e1').click(); } catch {}
      return { lines: ['1 click e1: effect unconfirmed; read before retrying'], stoppedAt: 1 };
    }
  });
  const first = await h.fill([{ ref: 'e1', value: true }]), second = await h.fill([{ ref: 'e1', value: true }]);
  assert.equal(first.rows[0].status, 'failed'); assert.equal(second.rows[0].status, 'failed');
  assert.equal(h.input.filter(row => row[0] === 'click').length, 1); assert.equal(dispatches, 1); assert.equal(delegated, 2);
  assert.ok(h.tab.state.submitUnconfirmed); assert.equal(h.tab.state.snapshotNo, 1);
});
test('an existing pending action fences the first field and keeps the suffix untouched', async () => {
  const h = harness({ e1: element(), e2: element() }); h.tab.state.actionPending = true;
  const result = await h.fill([{ ref: 'e1', value: 'x' }, { ref: 'e2', value: 'y' }], { submit: 'e9' });
  assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
  assert.match(result.rows[0].reason, /pending/i); assert.equal(h.input.length, 0); assert.equal(h.resolve.length, 0);
  assert.equal(result.submitted.status, 'not reached'); assert.equal(h.tab.state.actionPending, true);
});
test('input that becomes pending during the final read is fenced before checks consume consent', async () => {
  const h = harness({ e1: element() }); let inspections = 0, checks = 0;
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector), evaluate = loc.evaluate;
    loc.evaluate = async (fn, arg) => { const result = await evaluate(fn, arg); if (++inspections === 3) h.tab.state.actionPending = true; return result; }; return loc;
  };
  const fill = createFillFields({ check() { checks++; return { verdict: 'allow' }; }, runSteps: async () => { throw Error('unexpected delegation'); } });
  const result = await fill(h.tab, [{ ref: 'e1', value: 'x' }], {}, {});
  assert.equal(result.rows[0].status, 'failed'); assert.equal(checks, 0); assert.equal(h.input.length, 0);
});
test('ordinary nonsubmit fields remain usable while a submit only needs a delivered read', async () => {
  const node = element(), h = harness({ e1: node }); h.tab.state.submitUnconfirmed = { startedAt: 1000, snapshotNo: 1, settledAt: 6000 };
  const r = await h.fill([{ ref: 'e1', value: 'ordinary' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, 'ordinary'); assert.ok(h.tab.state.submitUnconfirmed);
});

test('a direct fill holds its input gate until its exact promise settles', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const h = harness({ e1: element() }, { mutate: () => held });
  const first = h.fill([{ ref: 'e1', value: 'first' }]);
  while (!h.input.length) await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.tab.state.actionPending);
  const second = await h.fill([{ ref: 'e1', value: 'second' }]);
  assert.equal(second.rows[0].status, 'failed'); assert.equal(h.input.length, 1);
  release(); const result = await first;
  assert.equal(result.rows[0].status, 'set'); assert.equal(h.tab.state.actionPending, false);
});
test('a settled direct fill cannot clear a replacement pending owner', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const h = harness({ e1: element() }, { mutate: () => held });
  const pending = h.fill([{ ref: 'e1', value: 'first' }]);
  while (!h.input.length) await new Promise(resolve => setImmediate(resolve));
  const replacement = {}; h.tab.state.actionPending = replacement;
  release(); await pending; assert.equal(h.tab.state.actionPending, replacement);
});

test('a payment submit consumes confirmation only in the delegated physical operation', async () => {
  const node = element('BUTTON', { role: 'checkbox', type: 'submit' }); node.closest = () => ({});
  let consumed = 0, clicks = 0;
  const consume = () => ++consumed === 1 ? { verdict: 'allow' } : { verdict: 'confirm' };
  const loc = utilityLocator({ evaluate: async (fn, arg) => fn(node, arg), click: async () => { clicks++; node.checked = true; } });
  const page = { on() {}, off() {}, getByRef: () => loc };
  const fill = createFillFields({ inspectElement: () => ({ tag: 'button', kind: 'button', connected: true,
    visible: true, enabled: true, submit: true, payment: true, formPayment: true, form: true }),
    check: consume, runSteps: async (tab, steps) => {
      assert.deepEqual(steps, [{ do: 'click', ref: 'e1' }]);
      if (consume().verdict !== 'allow') return { lines: ['1 click e1: not run: payment confirmation required'], stoppedAt: 1 };
      await loc.click(); return { lines: ['1 click e1: done'], stoppedAt: null };
    } });
  const r = await fill({ page, state: { snapshotNo: 1 } }, [{ ref: 'e1', value: true }], {}, {});
  assert.equal(r.rows[0].status, 'set'); assert.equal(clicks, 1); assert.equal(consumed, 1);
});
