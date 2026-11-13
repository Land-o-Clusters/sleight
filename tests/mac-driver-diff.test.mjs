import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAC_DRIVER_ROLES, compareMacElement, createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { GUARD_MARK, GUARD_END, GUARD_OMIT_MARK } from '../plugins/sleight/lib/compact-reads.mjs';
import { keyboardArguments } from '../plugins/sleight/lib/mac-driver/keys.mjs';

const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.example.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true };
const header = 'Window: "Draft", App: Editor.\n0 standard window Draft';
const before = header + '\n\t1 button Add\n\t2 text Ready\n\t3 button Cancel, ID: cancel';
const banner = header + '\n\t1 button Add\n\t2 text Ready\n\t3 button Undo Banner $500, ID: banner\n\t4 button Cancel, ID: cancel';
const row = (readId, text = before, patch = {}) => ({ window, readId, text, truncated: false, ...patch });
const params = (readId, target = 3) => ({ windowId: '101', processStart: '100.25', readId, args: [target] });
const fault = { code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' };
const content = text => [{ type: 'text', text }];
const deliver = (state, snapshots, text = snapshots.at(-1).text) => state.endCell(content(text), snapshots);

for (const state of ['down', 'up']) test(`INT22G validated modifiers ${state} survive a delivered read`, () => {
  const reads = createMacReadState(), first = reads.read(row(1)); deliver(reads, [first]);
  const options = { keys: ['meta'], state }, request = params(1, options);
  assert.deepEqual(keyboardArguments('modifiers', request.args), options);
  assert.equal(typeof reads.assertCurrent('modifiers', request), 'function');
  assert.deepEqual(request.args, [options]);
  reads.read(row(2, banner));
  assert.equal(typeof reads.assertCurrent('modifiers', { ...request, readId: 2 }), 'function');
  assert.throws(() => reads.assertCurrent('modifiers', request), fault);
});

test('INT22G modifiers cannot carry element selectors through the option exemption', () => {
  const reads = createMacReadState(), first = reads.read(row(1)); deliver(reads, [first]);
  for (const target of [{ label: 'Add' }, { id: 'cancel' }, { line: 1 }, { focused: true }, { target: 1 }]) {
    const request = params(1, { keys: ['meta'], state: 'down', ...target });
    assert.throws(() => keyboardArguments('modifiers', request.args), { code: 'INVALID_PARAMS' });
    assert.throws(() => reads.assertCurrent('modifiers', request), { code: 'INVALID_PARAMS' });
  }
  reads.read(row(2, banner));
  assert.throws(() => reads.assertCurrent('modifiers', { ...params(2, { keys: ['meta'], state: 'up' }), target: 3 }), fault);
  assert.throws(() => reads.assertCurrent('modifiers', params(2, { label: 'Add' })), { code: 'INVALID_PARAMS' });
});

function focusedInvariant(factory, method) {
  const initial = header + '\n\t1 text field (focused, settable) Name, Value: draft\n\t2 button Add';
  const state = factory(), first = state.read(row(1, initial)); deliver(state, [first]);
  const args = { ...params(1), args: [{ focused: true }, ...method === 'click' ? [] : ['new']] };
  assert.equal(typeof state.assertCurrent(method, args), 'function');
  assert.deepEqual(args.args[0], { focused: true });
  state.read(row(2, initial.replace('text field (focused, settable)', 'text field (settable)').replace('2 button Add', '2 button (focused) Add')));
  assert.throws(() => state.assertCurrent(method, { ...args, readId: 2 }), fault);
}
for (const method of ['click', 'setValue', 'selectText']) test(`UC2D ${method} focused target retains the numbered invariant`, () => {
  focusedInvariant(createMacReadState, method);
});

test('UC2D focused-target refusals detect bypassed focused-target detection', async () => {
  const url = new URL('../plugins/sleight/lib/mac-driver/diff.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8').replaceAll(/from '(\.\.?\/[^']+)'/g,
    (_, path) => `from '${new URL(path, url).href}'`);
  const needle = 'Object.keys(rawTarget).length === 1 && rawTarget.focused === true;';
  assert.equal(source.split(needle).length, 2);
  const broken = await import('data:text/javascript;base64,' + Buffer.from(source.replace(needle, 'false;')).toString('base64'));
  for (const method of ['click', 'setValue', 'selectText']) {
    focusedInvariant(createMacReadState, method);
    assert.throws(() => focusedInvariant(broken.createMacReadState, method), error => ['ERR_ASSERTION','STALE_READ'].includes(error.code));
  }
});

test('UC2D a focused consequential target still binds every tree line', () => {
  const initial = header + '\n\t1 button (focused) Confirm\n\t2 text Alice';
  const state = createMacReadState(), first = state.read(row(1, initial)); deliver(state, [first]);
  state.read(row(2, initial.replace('Alice', 'Bob')));
  assert.throws(() => state.assertCurrent('click', params(2, { focused: true })), fault);
});

test('reading alone never makes a number eligible for input', () => {
  const state = createMacReadState(); state.read(row(1));
  assert.throws(() => state.assertCurrent('click', params(1)), fault);
});

test('post-action insertion cannot rebind a delivered number to a banner inside the cell', () => {
  const state = createMacReadState(), first = row(1);
  const snapshot = state.read(first); deliver(state, [snapshot ?? first]);
  state.assertCurrent('click', params(1, 1));
  state.read(row(2, banner));
  assert.throws(() => state.assertCurrent('click', params(2)), fault);
  assert.throws(() => state.assertCurrent('click', params(2, 4)), fault);
  state.assertCurrent('click', params(2, 1));
});

test('hidden reads and sliced prints do not advance the delivered baseline', () => {
  const state = createMacReadState(), first = row(1), second = row(2, banner);
  const one = state.read(first); deliver(state, [one ?? first]);
  const two = state.read(second); deliver(state, [two ?? second], banner.slice(0, 100));
  assert.throws(() => state.assertCurrent('click', params(2)), fault);
  assert.equal(state.fullTree(params(2)), banner);
});

test('only an exact parent observation delivered at cell end enables new numbers', () => {
  const state = createMacReadState(), first = state.read(row(1));
  assert.equal(typeof state.endCell, 'function');
  state.endCell(content(before), [first]); state.assertCurrent('click', params(1));
  const second = state.read(row(2, banner));
  state.endCell(content(banner), [{ ...second }]); // Worker-created lookalikes carry no authority.
  assert.throws(() => state.assertCurrent('click', params(2)), fault);
  state.endCell(content(banner), [second]); state.assertCurrent('click', params(2));
  state.assertCurrent('click', params(2, 4));
});

test('intermediate full output can be delivered while the latest hidden read stays undelivered', () => {
  const state = createMacReadState(), first = state.read(row(1));
  state.read(row(2, banner));
  deliver(state, [first], before);
  state.assertCurrent('click', params(2, 1));
  assert.throws(() => state.assertCurrent('click', params(2)), fault);
});

for (const method of ['click', 'doubleClick', 'rightClick', 'scroll', 'setValue', 'selectText',
  'performSecondaryAction', 'drag', 'typeText', 'pressKey', 'paste', 'modifiers', 'hover', 'longPress', 'futureInput']) {
  test(`${method} cannot bypass stale numeric target checking`, () => {
    const state = createMacReadState(), first = row(1);
    const snapshot = state.read(first); deliver(state, [snapshot ?? first]); state.read(row(2, banner));
    assert.throws(() => state.assertCurrent(method, params(2)), fault);
  });
}

test('drag checks both endpoints and coordinate arrays are not element numbers', () => {
  const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
  state.read(row(2, banner));
  assert.throws(() => state.assertCurrent('drag', { ...params(2), args: [[1, 2], 3] }), fault);
  state.assertCurrent('drag', { ...params(2), args: [[1, 2], [3, 4]] });
  state.assertCurrent('resolveElement', { ...params(2), target: 1, args: undefined });
  assert.throws(() => state.assertCurrent('resolveElement', { ...params(2), target: 3, args: undefined }), fault);
});

test('numeric scroll counts are values, while unknown methods still check their first target', () => {
  const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
  state.assertCurrent('scroll', { ...params(1, 1), args: [1, 'down', 80] });
  state.read(row(2, banner));
  assert.throws(() => state.assertCurrent('futureInput', { ...params(2), args: [3, 80] }), fault);
});

test('same line beneath a changed ancestor refuses; unchanged duplicate labels keep their positions', () => {
  const state = createMacReadState();
  const a = header + '\n\t1 group Primary\n\t\t2 button OK';
  const first = state.read(row(1, a)); deliver(state, [first], a);
  state.read(row(2, a.replace('group Primary', 'group Replacement')));
  assert.throws(() => state.assertCurrent('click', params(2, 2)), fault);
  const duplicates = header + '\n\t1 button OK\n\t2 button OK';
  const third = state.read(row(3, duplicates)); deliver(state, [third], duplicates);
  state.assertCurrent('click', params(3, 2));
});

test('Bob inserted above Alice refuses the consequential Delete number', () => {
  const state = createMacReadState();
  const people = names => header + '\n\t1 list' + names.map((name, i) =>
    `\n\t\t${2 + i * 3} row\n\t\t\t${3 + i * 3} text ${name}\n\t\t\t${4 + i * 3} button Delete`).join('');
  const first = state.read(row(1, people(['Alice', 'Carol']))); deliver(state, [first]);
  state.assertCurrent('click', params(1, 4));
  state.read(row(2, people(['Bob', 'Alice', 'Carol'])));
  const moved = params(2, 4); assert.throws(() => state.assertCurrent('click', moved), fault); assert.equal(moved.args[0], 4);
});

test('every earlier structural line is bound, including whitespace', () => {
  for (const replacement of ['1 button Remove', '1 button Add ', '\t1 button Add']) {
    const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
    state.read(row(2, before.replace('1 button Add', replacement)));
    assert.throws(() => state.assertCurrent('click', params(2, 3)), fault);
  }
});

test('unchanged full tree allows every number, including root zero', () => {
  const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
  state.read(row(2));
  for (let target = 0; target <= 3; target++) state.assertCurrent('click', params(2, target));
});

test('the whole target subtree is bound but later siblings may change', () => {
  const original = header + '\n\t1 container Pane\n\t\t2 text Name\n\t\t3 button Save\n\t4 text Status\n\t5 button Close';
  for (const changed of [original.replace('text Name', 'text Other'),
    original.replace('\n\t4 text Status', '\n\t\t4 text Status'),
    original.replace('\n\t\t3 button Save', '') .replace('4 text', '3 text').replace('5 button', '4 button')]) {
    const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
    state.read(row(2, changed));
    assert.throws(() => state.assertCurrent('click', params(2, 1)), fault);
  }
  const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
  state.read(row(2, original.replace('text Status', 'text Saved') + '\n\t6 button Later'));
  state.assertCurrent('click', params(2, 1));
  assert.throws(() => state.assertCurrent('click', params(2, 3)), fault); // Save binds later siblings too.
  assert.throws(() => state.assertCurrent('click', params(2, 4)), fault);
});

test('focus then setValue on the same number allows a flags-only change', () => {
  const state = createMacReadState(), original = header + '\n\t1 text field (settable) Name';
  const first = state.read(row(1, original)); deliver(state, [first]);
  state.assertCurrent('click', params(1, 1));
  const focused = state.read(row(2, original.replace('(settable)', '(focused, settable)')));
  state.assertCurrent('setValue', { ...params(2, 1), args: [1, 'Alice'] });
  deliver(state, [focused]);
  state.assertCurrent('setValue', { ...params(2, 1), args: [1, 'Alice'] });
});

test('identically labeled ancestors cannot hide a target moving into another group', () => {
  const state = createMacReadState();
  const a = header + '\n\t1 group Pane\n\t\t2 button Help\n\t\t3 text Ready\n\t\t4 button Save\n\t5 group Pane';
  const b = header + '\n\t1 group Pane\n\t2 text Ready\n\t3 group Pane\n\t\t4 button Save';
  const first = state.read(row(1, a)); deliver(state, [first], a);
  state.assertCurrent('click', params(1, 4));
  state.read(row(2, b));
  assert.throws(() => state.assertCurrent('click', params(2, 4)), fault);
});

test('role, label and identifier replacements each revoke the delivered number', () => {
  for (const replacement of ['3 text Cancel, ID: cancel', '3 button Accept, ID: cancel', '3 button Cancel, ID: other']) {
    const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
    state.read(row(2, before.replace('3 button Cancel, ID: cancel', replacement)));
    assert.throws(() => state.assertCurrent('click', params(2)), fault);
  }
});

test('turn end revokes numbers and late delivery from the old turn cannot restore them', () => {
  const state = createMacReadState(), first = row(1);
  const snapshot = state.read(first); deliver(state, [snapshot ?? first]); state.endTurn();
  deliver(state, [snapshot ?? first], before);
  assert.throws(() => state.assertCurrent('click', params(1)), fault);
  const second = state.read(row(2)); deliver(state, [second], before);
  state.assertCurrent('click', params(2));
});

test('full-tree repeat-read fallback preserves secure-field redaction', () => {
  const state = createMacReadState();
  const secure = header + '\n\t1 secure text field <redacted>\n\t2 text Ready';
  const first = state.read(row(1, secure)); deliver(state, [first], secure);
  const changed = secure.replace('text Ready', 'text Saved');
  const next = state.read(row(2, changed));
  assert.equal(next.text, changed);
  assert.equal(state.fullTree(params(2)), changed);
  assert.match(next.text, /1 secure text field <redacted>/);
  assert.doesNotMatch(next.text, /Password|Value:/);
  assert.doesNotMatch(next.text, /no change since|lines changed/);
});

test('failed reads, old read ids, truncated reads and eviction cannot authorize numbers', () => {
  const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
  assert.throws(() => state.read(row(1)), { code: 'DRIVER_PROTOCOL' });
  assert.throws(() => state.assertCurrent('click', params(1)), fault);
  const partial = state.read(row(2, before, { truncated: true })); deliver(state, [partial], before);
  assert.throws(() => state.assertCurrent('click', params(2)), fault);
  const third = state.read(row(3)); deliver(state, [third], before); state.invalidate(params(3));
  assert.throws(() => state.assertCurrent('click', params(3)), fault);
  state.read(row(4));
  for (let i = 0; i < 16; i++) state.read(row(5 + i, before, { window: { ...window, windowId: String(200 + i) } }));
  assert.equal(state.fullTree(params(4)), undefined);
  assert.throws(() => state.assertCurrent('click', params(4)), fault);
});

test('identical text from two certified windows is ambiguous delivery evidence', () => {
  const state = createMacReadState(), first = state.read(row(1));
  const other = state.read(row(2, before, { window: { ...window, windowId: '102' } }));
  deliver(state, [first, other], before);
  assert.throws(() => state.assertCurrent('click', params(1)), fault);
});

for (const [name, patch] of [
  ['unverified identity', { window: { ...window, identityVerified: false } }],
  ['mismatched header', { text: before.replace('App: Editor.', 'App: Other.') }],
  ['duplicate numbers', { text: before + '\n\t3 button Other' }],
  ['missing root', { text: 'Window: "Draft", App: Editor.\n1 button Pretend' }],
  ...[GUARD_MARK, GUARD_END, GUARD_OMIT_MARK].map((mark, i) => [`reserved marker ${i}`, { text: before + '\n' + mark }]),
]) test(`malformed observation revokes its binding: ${name}`, () => {
  const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
  assert.throws(() => state.read(row(2, before, patch)));
  assert.throws(() => state.assertCurrent('click', params(1)), fault);
});

test('reset revokes saved observation tokens and named targets stay delegated to the driver', () => {
  const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
  state.assertCurrent('click', params(1, { id: 'cancel' }));
  state.assertCurrent('click', params(1, { label: 'Cancel' }));
  state.reset(); state.read(row(2)); deliver(state, [first], before);
  assert.throws(() => state.assertCurrent('click', params(2)), fault);
});

const loadFixture = name => JSON.parse(readFileSync(new URL(`./fixtures/rt11d-${name}.json`, import.meta.url), 'utf8'));
const probeTree = lines => 'Window: "Draft", App: Editor.\n' + lines.map((line, i) =>
  line.replace(/^(\t*)/, `$1${i} `)).join('\n');
const complete = (state, method, args, readId = 1, cell = 'probe') =>
  state.assertCurrent(method, { ...params(readId), args }, cell)?.();

const legacyRemaps = new Map([
  ['RT11 banner inserted at 3, click(3)', 4], ['Leaf above gains a child (count), click(3)', 4],
  ['Calculator: Last Expression lines inserted, click(5)', 7],
  ['Twin groups swap children (RT11B review X5), click(4)', 6],
]);
// RT11H's whole-tree consequential binding supersedes these legacy allows/remaps.
const tightenedLegacy = new Set(['RT11B Bob inserted first, click(4)', 'RT11B Bob inserted first, click(7)',
  'Dave appended after Carol, click(7)', 'Own write on field 3 only, click(7)',
  'Form: setValue(1), setValue(2), click(3)', 'Form: autofill button inserted under field 1 after write, click(3)']);
for (const probe of loadFixture('probes')) {
  test(`R2c probe: ${probe.name} => ${tightenedLegacy.has(probe.name) ? 'refuse (RT11H)' : probe.expected}`, () => {
    const state = createMacReadState(), first = state.read(row(1, probeTree(probe.delivered)));
    deliver(state, [first]);
    let readId = 1, intermediate = [...probe.delivered];
    for (const [target, value] of probe.ownWrites) {
      complete(state, 'setValue', [target, value], readId);
      intermediate[target] = probe.current[target];
      state.read(row(++readId, probeTree(intermediate)));
    }
    state.read(row(++readId, probeTree(probe.current)));
    const act = () => state.assertCurrent('click', params(readId, probe.target), 'probe');
    if (tightenedLegacy.has(probe.name)) assert.throws(act, fault);
    else if (legacyRemaps.has(probe.name)) {
      const request = params(readId, probe.target); state.assertCurrent('click', request, 'probe');
      assert.equal(request.args[0], legacyRemaps.get(probe.name));
    } else if (probe.expected === 'allow' && !probe.name.startsWith('Menu item above')) assert.doesNotThrow(act);
    else assert.throws(act, fault);
  });
}

for (const name of ['calculator-display', 'notes-own-write', 'dropdown-shift', 'calendar-shift', 'word-table-size', 'notes-popup-subtree']) {
  const recorded = loadFixture(name);
  test(`R2c transcript: ${name} => ${recorded.expected}`, () => {
    const match = /^Window: "(.*)", App: (.*?)\.$/.exec(recorded.delivered.split('\n')[0]);
    const binding = { ...window, title: match[1], app: match[2] };
    const state = createMacReadState(), first = state.read(row(1, recorded.delivered, { window: binding }));
    deliver(state, [first]);
    let readId = 1, intermediate = recorded.delivered.split('\n');
    const currentLines = recorded.current.split('\n');
    for (const [target, value] of recorded.ownWrites) {
      complete(state, 'setValue', [target, value], readId);
      intermediate[target + 1] = currentLines[target + 1];
      state.read(row(++readId, intermediate.join('\n'), { window: binding }));
    }
    state.read(row(++readId, recorded.current, { window: binding }));
    const act = () => state.assertCurrent('click', params(readId, recorded.target), 'probe');
    if (recorded.expected === 'allow') assert.doesNotThrow(act);
    else assert.throws(act, fault);
    if (name === 'dropdown-shift') assert.equal(compareMacElement(recorded.delivered, recorded.current, recorded.target).refuse, 'surface');
  });
}

const fieldTree = (value = 'Name') => header + `\n\t1 text field (settable) ${value}\n\t2 button Next`;
for (const attribute of ['Placeholder', 'ID', 'Description', 'Help', 'URL', 'Secondary Actions', 'Details']) {
  test(`own write preserves ${attribute} exactly`, () => {
    const original = fieldTree(`Value: old, Placeholder: Name, ID: name, Description: Editor, Help: Hint, URL: example.test, Secondary Actions: Confirm, Details: Detail`);
    const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
    complete(state, 'setValue', [1, 'Ann']);
    const written = original.replace('Value: old', 'Value: Ann');
    state.read(row(2, written)); state.assertCurrent('click', params(2, 2), 'probe');
    const changed = written.replace(new RegExp(`${attribute}: [^,]*`), `${attribute}: other`);
    state.read(row(3, changed));
    assert.throws(() => state.assertCurrent('click', params(3, 2), 'probe'), fault);
  });
}

test('own writes apply to the target and subtree in this cell but never the next cell', () => {
  const state = createMacReadState(), first = state.read(row(1, fieldTree())); deliver(state, [first]);
  complete(state, 'setValue', [1, 'Ann']); state.read(row(2, fieldTree('Value: Ann, Placeholder: Name')));
  state.assertCurrent('click', params(2, 2), 'probe');
  state.assertCurrent('click', params(2, 1), 'probe');
  state.assertCurrent('click', params(2, 0), 'probe');
  assert.throws(() => state.assertCurrent('click', params(2, 2), 'next-cell'), fault);
});

test('a checked but uncompleted write grants no exception', () => {
  const state = createMacReadState(), first = state.read(row(1, fieldTree())); deliver(state, [first]);
  state.assertCurrent('setValue', { ...params(1), args: [1, 'Ann'] }, 'probe');
  state.read(row(2, fieldTree('Value: Ann, Placeholder: Name')));
  assert.throws(() => state.assertCurrent('click', params(2, 2), 'probe'), fault);
});

for (const interruption of ['pressKey', 'getAXState', 'paste', 'setValue']) {
  test(`click and typeText association stops at ${interruption}`, () => {
    const state = createMacReadState(), first = state.read(row(1, fieldTree())); deliver(state, [first]);
    complete(state, 'click', [1]);
    complete(state, interruption, interruption === 'setValue' ? [1, 'other'] : ['x']);
    complete(state, 'typeText', ['Ann']);
    state.read(row(2, fieldTree('Value: Ann, Placeholder: Name')));
    assert.throws(() => state.assertCurrent('click', params(2, 2), 'probe'), fault);
  });
}

test('click and successive typeText calls accumulate the exact text written', () => {
  const state = createMacReadState(), first = state.read(row(1, fieldTree())); deliver(state, [first]);
  complete(state, 'click', [1]); complete(state, 'typeText', ['A']); complete(state, 'typeText', ['nn']);
  state.read(row(2, fieldTree('Value: Ann, Placeholder: Name')));
  state.assertCurrent('click', params(2, 2), 'probe');
});

test('numeric strings need a unique ID while untargeted numeric text remains text', () => {
  const state = createMacReadState(), first = state.read(row(1)); deliver(state, [first]);
  assert.throws(() => state.assertCurrent('click', { ...params(1), args: ['3'] }), error => error.code === 'STALE_READ' && error.message.includes('exactly one matching ID'));
  state.assertCurrent('typeText', { ...params(1), args: ['123'] });
  state.assertCurrent('pressKey', { ...params(1), args: ['1'] });
});

for (const [from, to] of [['Help: Value: old', 'Help: Value: new'], ['Help: (focused) hint', 'Help: (disabled) hint'],
  ['Description: Value: old', 'Description: Value: new'], ['button Value: label', 'button Value: other']]) {
  test(`state stripping preserves metadata and labels: ${from}`, () => {
    const original = header + `\n\t1 button Save, ${from}\n\t2 button Done`;
    const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
    state.read(row(2, original.replace(from, to)));
    assert.throws(() => state.assertCurrent('click', params(2, 2)), fault);
  });
}

test('turn end also revokes completed write evidence and late completion callbacks', () => {
  const state = createMacReadState(), first = state.read(row(1, fieldTree())); deliver(state, [first]);
  const completed = state.assertCurrent('setValue', { ...params(1), args: [1, 'Ann'] }, 'probe');
  state.endTurn(); completed();
  const next = state.read(row(2, fieldTree())); deliver(state, [next]);
  state.read(row(3, fieldTree('Value: Ann, Placeholder: Name')));
  assert.throws(() => state.assertCurrent('click', params(3, 2), 'probe'), fault);
});

test('own write refuses a lost settable flag, lost placeholder or duplicate value', () => {
  for (const changed of ['text field Value: Ann, Placeholder: Name', 'text field (settable) Value: Ann',
    'text field (settable) Value: Ann, Value: other, Placeholder: Name']) {
    const original = fieldTree('Value: old, Placeholder: Name');
    const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
    complete(state, 'setValue', [1, 'Ann']);
    state.read(row(2, rootField(changed)));
    assert.throws(() => state.assertCurrent('click', params(2, 2), 'probe'), fault);
  }
});
function rootField(field) { return header + `\n\t1 ${field}\n\t2 button Next`; }

test('state stripping preserves unknown attributes after a Value', () => {
  const original = header + '\n\t1 text Description: Status, Value: Ready, Custom: old\n\t2 button Done';
  const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
  state.read(row(2, original.replace('Value: Ready', 'Value: Saved').replace('Custom: old', 'Custom: other')));
  assert.throws(() => state.assertCurrent('click', params(2, 2)), fault);
});

test('completed writes stay bound to their certified window', () => {
  const state = createMacReadState(), other = { ...window, windowId: '102' };
  const first = state.read(row(1, fieldTree())); deliver(state, [first]);
  const second = state.read(row(1, fieldTree(), { window: other }));
  // Deliver separately because identical text from two windows is ambiguous.
  deliver(state, [second]); complete(state, 'setValue', [1, 'Ann']);
  state.read(row(2, fieldTree('Value: Ann, Placeholder: Name'), { window: other }));
  assert.throws(() => state.assertCurrent('click', { ...params(2, 2), windowId: '102' }, 'probe'), fault);
});

// RT11F's exact attack trees and expectations, evaluated through the parent API.
import { attacks } from './fixtures/rt11f-attacks.mjs';
test('RT11F table contains exactly 120 distinct cases', () => {
  assert.equal(attacks.length, 120);
  assert.equal(new Set(attacks.map(p => p.id)).size, 120);
});
// Keep the study's 120 trees intact. GLR1 adds Trash to consequential labels,
// refuses ambiguous block alignments, and permits acted row sibling selection.
// Existing whole-read rules for consequential controls remain in force.
const tightenedAttacks = new Set(['S2', 'S6', 'T7', 'W1', 'W6', 'F3', 'R1', 'R2', 'R6', 'R8c', 'R21', 'R22', 'R24', 'R25', 'X2', 'R17c', ...attacks.filter(p => p.id.startsWith('I1-')).map(p => p.id)]);
for (const probe of attacks) test(`RT11F ${probe.id}: ${probe.name} => ${tightenedAttacks.has(probe.id) ? 'refuse (RT11H/RT11J)' : probe.expected}`, () => {
  const state = createMacReadState();
  const first = state.read(row(1, probeTree(probe.before))); deliver(state, [first]);
  for (const target of probe.acted) complete(state, 'click', [target]);
  for (const [target, value] of probe.writes) complete(state, 'setValue', [target, value]);
  state.read(row(2, probeTree(probe.after)));
  const request = params(2, probe.n);
  if (probe.expected === 'refuse' || tightenedAttacks.has(probe.id)) assert.throws(() => state.assertCurrent('click', request, 'probe'), fault);
  else {
    const done = state.assertCurrent('click', request, 'probe');
    const expected = probe.expected === 'allow' ? probe.n : Number(probe.expected.split(':')[1]);
    assert.equal(request.args[0], expected);
    if (expected !== probe.n) assert.match(done.notices.join(' '), new RegExp(`\\(${probe.n}\\) went to element ${expected}`));
    done?.();
  }
});

test('role vocabulary equals the native driver tables and fallback', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/DriverTree.swift', import.meta.url), 'utf8');
  const tables = source.slice(source.indexOf('let driverRoles ='), source.indexOf('func driverRoleName'));
  const roles = [...tables.matchAll(/"AX[^"\n]+": "([^"\n]+)"/g)].map(m => m[1]);
  assert.deepEqual([...MAC_DRIVER_ROLES].sort(), [...new Set([...roles, 'container'])].sort());
});

// GLS2 E1 plus E2b permits four Calculator remaps the archive refused.
// Keep the archived study unchanged and assert each exact target identity.
const gls2Remaps = new Map([['58:25',27],['63:19',21],['63:20',22],['63:25',27]]);
const replayRow = (tree, n) => tree.split('\n').find(line => Number(/^\t*(\d+) /.exec(line)?.[1]) === n)?.replace(/^(\t*)\d+ /,'$1');
const recordedReplay = JSON.parse(readFileSync(new URL('./fixtures/rt11f-replay.json', import.meta.url), 'utf8'));
test('RT11H recorded replay with evaluated-action evidence: 90 actions, GLR1 whole-read and E2 decisions, zero wrong numbers', t => {
  const counts = { actions: 0, refused: 0, remapped: 0, invariantRefused: 0, moved: 0, wrong: 0 };
  let movedAtOldNumber = 0, unmovedSentElsewhere = 0;
  const mismatches = [];
  for (const row of recordedReplay.actions) {
    const pair = recordedReplay.pairs[row.pair];
    // These are after-whole-cell trees. Include the evaluated action's own
    // effect only in replay evidence, never in the production pre-input check.
    const result = compareMacElement(pair.delivered, pair.current, row.n, {
      acted: [...row.acted, row.n], writes: new Map(row.writes),
    });
    const remap = gls2Remaps.get(`${row.pair}:${row.n}`);
    if (remap !== undefined) {
      assert.equal(result.to,remap);
      assert.equal(replayRow(pair.delivered,row.n),replayRow(pair.current,remap));
    }
    const expected = remap === undefined ? row.expected : `remap:${remap}`;
    const actual = result.to === undefined ? 'refuse' : result.to === row.n ? 'allow' : `remap:${result.to}`;
    if (actual !== expected) mismatches.push({ task: row.task, method: row.method, n: row.n, expected, actual, why: result.why });
    counts.actions++; if (!result.invariant) counts.invariantRefused++;
    if (result.to === undefined) counts.refused++;
    else if (result.to !== row.n) {
      counts.remapped++;
      if (expected !== `remap:${result.to}`) counts.wrong++;
    }
    if (row.moved) counts.moved++;
    if (row.moved && result.to === row.n) movedAtOldNumber++;
    if (!row.moved && result.to !== undefined && result.to !== row.n) unmovedSentElsewhere++;
  }
  t.diagnostic(JSON.stringify(counts));
  t.diagnostic(JSON.stringify(mismatches));
  assert.deepEqual(counts, { actions: 90, refused: 35, remapped: 15, invariantRefused: 50, moved: 37, wrong: 0 });
  assert.deepEqual({ movedAtOldNumber, unmovedSentElsewhere }, { movedAtOldNumber: 0, unmovedSentElsewhere: 0 });
  // The archived study predates GLR1. Its 11 extra refusals now keep written
  // values and consequential controls bound to the delivered read. Every sent
  // action still reaches its expected number, including GLS2's four remaps.
  assert.deepEqual(mismatches.map(({ task, method, n, expected, actual }) => ({ task, method, n, expected, actual })), [
    ['word-brief', 'setValue', 15], ['word-brief', 'setValue', 7], ['word-brief', 'click', 20],
    ['word-brief', 'click', 15], ['word-brief', 'click', 18], ['textedit-notes-table', 'click', 21],
    ['word-brief', 'setValue', 15], ['word-memo', 'click', 15], ['word-memo', 'click', 18],
    ['word-memo', 'click', 15], ['word-memo', 'click', 18],
  ].map(([task, method, n]) => ({ task, method, n, expected: 'allow', actual: 'refuse' })));

});

for (const from of ['button lower (focused) Save', 'text field lower Value: alpha']) {
  test(`role parsing never strips label text: ${from}`, () => {
    const current = from.replace('(focused)', '(disabled)').replace('alpha', 'beta');
    const state = createMacReadState(), original = probeTree(['standard window W', '\t' + from, '\tbutton Go']);
    const first = state.read(row(1, original)); deliver(state, [first]);
    state.read(row(2, probeTree(['standard window W', '\t' + current, '\tbutton Go'])));
    assert.throws(() => state.assertCurrent('click', params(2, 2), 'probe'), fault);
  });
}
for (const identity of ['button Help: Hint', 'button Details: Hint', 'button Secondary Actions: Show'])
  test(`a remap needs a label, Description, ID, URL or Placeholder: ${identity}`, () => {
    const state = createMacReadState(), first = state.read(row(1, probeTree(['standard window W', '\t' + identity])));
    deliver(state, [first]); state.read(row(2, probeTree(['standard window W', '\ttext Added', '\t' + identity])));
    assert.throws(() => state.assertCurrent('click', params(2, 1), 'probe'), fault);
  });
for (const field of ['HTML content (focused) page', 'text field (focused) lower'])
  test(`driver role flags parse at the role boundary: ${field}`, () => {
    const state = createMacReadState(), first = state.read(row(1, probeTree(['standard window W', '\t' + field, '\tbutton Go'])));
    deliver(state, [first]); state.read(row(2, probeTree(['standard window W', '\t' + field.replace('(focused)', '(disabled)'), '\tbutton Go'])));
    state.assertCurrent('click', params(2, 2), 'probe');
  });

test('a remapped write stays keyed to the delivered number for a later neutral action', () => {
  const state = createMacReadState(), base = ['standard window W', '\ttext field (settable) Name', '\ttext field (settable) Email', '\tbutton Next'];
  const first = state.read(row(1, probeTree(base))); deliver(state, [first]);
  complete(state, 'setValue', [1, 'Ann']);
  const current = ['standard window W', '\ttext field (settable) Value: Ann, Placeholder: Name', '\t\tbutton AutoFill', '\ttext field (settable) Email', '\tbutton Next'];
  state.read(row(2, probeTree(current)));
  const request = { ...params(2), args: [2, 'a@b'] }, done = state.assertCurrent('setValue', request, 'probe');
  assert.equal(request.args[0], 3); done();
  current[3] = '\ttext field (settable) Value: a@b, Placeholder: Email'; state.read(row(3, probeTree(current)));
  const submit = params(3, 3); state.assertCurrent('click', submit, 'probe'); assert.equal(submit.args[0], 4);
});

test('repeat remaps use delivered numbers and do not grant unseen current numbers', () => {
  const state = createMacReadState(), base = ['standard window W', '\ttext A', '\tbutton Next'];
  const first = state.read(row(1, probeTree(base))); deliver(state, [first]);
  state.read(row(2, probeTree(['standard window W', '\ttext A', '\ttext Added', '\tbutton Next'])));
  for (let i = 0; i < 2; i++) {
    const request = params(2, 2); state.assertCurrent('click', request, 'probe')(); assert.equal(request.args[0], 3);
  }
  assert.throws(() => state.assertCurrent('click', params(2, 3), 'probe'), fault);
});

test('a failed second drag endpoint never mutates or authorizes its first endpoint', () => {
  const state = createMacReadState(), first = state.read(row(1, probeTree(['standard window W', '\timage file', '\tbutton Pay'])));
  deliver(state, [first]); state.read(row(2, probeTree(['standard window W', '\ttext Added', '\timage file', '\tbutton Pay'])));
  const request = { ...params(2), args: [1, 2] };
  assert.throws(() => state.assertCurrent('drag', request, 'probe'), fault); assert.deepEqual(request.args, [1, 2]);
});

for (const target of [1, 2]) test(`own writes bind a field title beside an explicit Value, target=${target}`, () => {
  const original = probeTree(['standard window W', '\ttext field (settable) Name, Value: old', '\tbutton Submit']);
  const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
  complete(state, 'setValue', [1, 'Ann']);
  state.read(row(2, original.replace('Name, Value: old', 'Recipient, Value: Ann')));
  assert.throws(() => state.assertCurrent('click', params(2, target), 'probe'), fault);
});
for (const method of ['resolveElement', 'hover', 'futureInput']) test(`${method} grants no acted-state exemption`, () => {
  const original = probeTree(['standard window W', '\tcheckbox Choice, Value: 0', '\tbutton Submit']);
  const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
  state.assertCurrent(method, { ...params(1), target: 1, args: undefined }, 'probe')();
  state.read(row(2, original.replace('Value: 0', 'Value: 1')));
  assert.throws(() => state.assertCurrent('click', params(2, 2), 'probe'), fault);
});

test('lowercase target labels have identity beyond the driver role', () => {
  const original = probeTree(['standard window W', '\tbutton cancel']);
  const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
  state.read(row(2, probeTree(['standard window W', '\ttext Added', '\tbutton cancel'])));
  const request = params(2, 1); state.assertCurrent('click', request, 'probe'); assert.equal(request.args[0], 2);
});

test('own write cannot add a new title beside a Value and matching Placeholder', () => {
  const state = createMacReadState(), original = fieldTree(), first = state.read(row(1, original)); deliver(state, [first]);
  complete(state, 'setValue', [1, 'Ann']);
  state.read(row(2, fieldTree('Recipient, Value: Ann, Placeholder: Name')));
  assert.throws(() => state.assertCurrent('click', params(2, 2), 'probe'), fault);
});
for (const label of ['USD 12', '12 CAD', '₹ 12', '$ -12', '12 CHF', 'CHF 12'])
  test(`inserted money figures refuse: ${label}`, () => {
    const state = createMacReadState(), first = state.read(row(1, probeTree(['standard window W', '\tbutton Next'])));
    deliver(state, [first]); state.read(row(2, probeTree(['standard window W', '\ttext ' + label, '\tbutton Next'])));
    assert.throws(() => state.assertCurrent('click', params(2, 1), 'probe'), fault);
  });

test('recorded Notes remaps setValue(18) to 19 and click(21) to 22', () => {
  const action = recordedReplay.actions.find(row => row.n === 21 && row.expected === 'remap:22');
  const pair = recordedReplay.pairs[action.pair], withHeader = tree => 'Window: "Draft", App: Editor.\n' + tree;
  const state = createMacReadState(), first = state.read(row(1, withHeader(pair.delivered))); deliver(state, [first]);
  complete(state, 'setValue', [10, 'amber']);
  const lines = pair.current.split('\n');
  // Reconstruct the state before the evaluated write from the after-cell pair.
  // The Replace field has not yet acquired that write's Value or Placeholder.
  lines[19] = pair.delivered.split('\n')[18].replace(/^(\t*)18 /, (_, tabs) => tabs + '19 ');
  state.read(row(2, withHeader(lines.join('\n'))));
  const write = { ...params(2), args: [18, 'violet'] };
  state.assertCurrent('setValue', write, 'probe')(); assert.equal(write.args[0], 19);
  state.read(row(3, withHeader(pair.current)));
  const click = params(3, 21); state.assertCurrent('click', click, 'probe'); assert.equal(click.args[0], 22);
});

test('recorded Calculator display remaps element 7 to 5 after block removal', () => {
  const action = recordedReplay.actions.find(row => row.n === 7 && row.expected === 'remap:5');
  const pair = recordedReplay.pairs[action.pair], withHeader = tree => 'Window: "Draft", App: Editor.\n' + tree;
  const state = createMacReadState(), first = state.read(row(1, withHeader(pair.delivered))); deliver(state, [first]);
  for (const n of action.acted) complete(state, 'click', [n]);
  state.read(row(2, withHeader(pair.current)));
  const request = params(2, 7); state.assertCurrent('click', request, 'probe'); assert.equal(request.args[0], 5);
});

for (const kind of ['cell', 'row']) for (const target of ['Confirm', 'Next'])
  test(`RT11H clicking an Amount ${kind} cannot free its Recipient sibling before ${target}`, () => {
    const original = probeTree(['standard window W', '\ttable', `\t\t${kind} Description: Amount, Value: 5`,
      `\t\t${kind} Description: Recipient, Value: Alice`, '\tbutton ' + target]);
    const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
    complete(state, 'click', [2]);
    state.read(row(2, original.replace('Value: Alice', 'Value: Bob')));
    assert.throws(() => state.assertCurrent('click', params(2, 4), 'probe'), fault);
  });

test('RT11H clicking an Amount cell with an unchanged Recipient still allows Confirm', () => {
  const original = probeTree(['standard window W', '\ttable', '\t\tcell Description: Amount, Value: 5',
    '\t\tcell Description: Recipient, Value: Alice', '\tbutton Confirm']);
  const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
  complete(state, 'click', [2]); state.read(row(2, original));
  state.assertCurrent('click', params(2, 4), 'probe');
});

for (const kind of ['radio button', 'tab', 'toggle button'])
  test(`GLR1 E2 same-parent ${kind} selection flags may change, sibling Value stays bound`, () => {
    const original = probeTree(['standard window W', '\tcontainer Choices', `\t\t${kind} (selected) A, Value: 1`,
      `\t\t${kind} B, Value: 0`, '\tbutton Next']);
    const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
    complete(state, 'click', [3]);
    state.read(row(2, original.replace('(selected) A, Value: 1', 'A, Value: 1').replace('B, Value: 0', '(selected) B, Value: 1')));
    state.assertCurrent('click', params(2, 4), 'probe');
    state.read(row(3, original.replace('(selected) A, Value: 1', 'A, Value: 0').replace('B, Value: 0', '(selected) B, Value: 1')));
    assert.throws(() => state.assertCurrent('click', params(3, 4), 'probe'), fault);
  });

for (const kind of ['text', 'button', 'link', 'menu item', 'cell', 'row'])
  for (const flag of ['selected', 'checked', 'expanded', 'collapsed'])
    test(`GLR1 ${kind === 'menu item' && flag === 'selected' ? 'E3 refuses' : 'E2 permits'} acted ${kind} ${flag} state`, () => {
      const original = probeTree(['standard window W', '\t' + kind + ' Choice', '\tbutton Next']);
      const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
      complete(state, 'click', [1]);
      state.read(row(2, original.replace(kind + ' Choice', `${kind} (${flag}) Choice`)));
      for (const target of [1, 2]) {
        const act = () => state.assertCurrent('click', params(2, target), 'probe');
        if (kind === 'menu item' && flag === 'selected') assert.throws(act, fault);
        else assert.doesNotThrow(act);
      }
    });

for (const kind of ['checkbox', 'check box', 'radio button', 'switch', 'toggle button', 'pop up button', 'menu button',
  'disclosure triangle', 'tab', 'slider', 'stepper', 'scroll bar', 'value indicator', 'progress indicator', 'splitter',
  'text field', 'text area', 'text entry area', 'search field', 'search text field', 'combo box'])
  test(`RT11H E2 still permits an acted ${kind} state change before Next`, () => {
    const original = probeTree(['standard window W', '\t' + kind + ' Description: Choice, Value: 0', '\tbutton Next']);
    const state = createMacReadState(), first = state.read(row(1, original)); deliver(state, [first]);
    complete(state, 'click', [1]);
    state.read(row(2, original.replace(kind + ' Description: Choice, Value: 0', `${kind} (selected, checked, expanded) Description: Choice, Value: 1`)));
    state.assertCurrent('click', params(2, 2), 'probe');
  });

const consequentialLabels = ['Pay now', 'Donate', 'Subscribe', 'Checkout', 'Purchase', 'Upgrade', 'Charge',
  'Confirm', 'Submit', 'Send', 'Transfer', 'Order', 'Place order', 'Place your order', 'Book', 'Buy', 'Delete',
  'Save', 'Finish', 'Complete', 'Reserve', 'Confirm reservation'];
for (const label of consequentialLabels)
  test(`RT11H ${label} binds the whole tree and never remaps`, () => {
    const original = ['standard window W', '\ttext Ready', '\tbutton ' + label, '\ttext Description: Total, Value: $5'];
    const unchanged = compareMacElement(probeTree(original), probeTree(original), 2);
    assert.equal(unchanged.to, 2);
    for (const current of [original.map(l => l.replace('Value: $5', 'Value: $500')),
      [...original, '\ttext Later'], original.slice(0, -1),
      [original[0], '\ttext Added', ...original.slice(1)],
      original.map(l => l.replace('text Ready', 'text (focused) Ready'))]) {
      const state = createMacReadState(), first = state.read(row(1, probeTree(original))); deliver(state, [first]);
      state.read(row(2, probeTree(current)));
      const request = params(2, 2);
      assert.throws(() => state.assertCurrent('click', request, 'probe'), error => {
        assert.equal(error.code, 'STALE_READ'); assert.equal(error.delivery, 'not-sent');
        assert.equal(error.retry, 'safe'); assert.match(error.message, /next=read-again/); return true;
      });
      assert.equal(request.args[0], 2);
    }
  });

for (const target of ['button Confirm', 'button Pay now', 'button Submit'])
  test(`RT11H ${target} cannot use E1, E2 or E4 to waive any tree change`, () => {
    for (const [original, changed, evidence] of [
      [['standard window W', '\ttext field (settable) Value: old, Placeholder: Name', '\t' + target],
        ['standard window W', '\ttext field (settable) Value: Ann, Placeholder: Name', '\t' + target],
        { acted: [1], writes: new Map([[1, 'Ann']]) }],
      [['standard window W', '\tcheckbox Choice, Value: 0', '\t' + target],
        ['standard window W', '\tcheckbox (checked) Choice, Value: 1', '\t' + target], { acted: [1] }],
      [['standard window W', '\tscroll area ID: display;value:$5', '\t\ttext Description: Total, Value: $5', '\t' + target],
        ['standard window W', '\tscroll area ID: display;value:$500', '\t\ttext Description: Total, Value: $500', '\t' + target], {}],
    ]) assert.equal(compareMacElement(probeTree(original), probeTree(changed), original.length - 1, evidence).to, undefined);
  });

test('RT11H payment ancestors and credential targets bind later tree lines too', () => {
  for (const original of [
    ['standard window W', '\tcontainer Billing', '\t\tbutton Next', '\ttext Status'],
    ['standard window W', '\tcontainer Pane', '\t\ttext field (settable) Password', '\ttext Status'],
  ]) assert.equal(compareMacElement(probeTree(original), probeTree(original.map(l => l.replace('text Status', 'text Changed'))), 2).to, undefined);
});

test('RT11H replay fixtures contain no per-user home or temporary paths', () => {
  const fixture = readFileSync(new URL('./fixtures/rt11f-replay.json', import.meta.url), 'utf8');
  assert.equal(/\/var\/folders\/|\/Users\//.test(fixture), false);
});

test('RT11H submit words in secondary-action metadata do not rename a neutral field', () => {
  const original = probeTree(['standard window W', '\tcombo box (settable) Description: Replace With, Secondary Actions: Confirm', '\tbutton Next']);
  const current = original.replace('Description: Replace With', 'Value: Ann, Description: Replace With');
  assert.equal(compareMacElement(original, current, 1, { acted: [1], writes: new Map([[1, 'Ann']]) }).to, 1);
});

for (const [name, original, acted] of [
  ['different parents', ['standard window W', '\tcontainer First', '\t\tradio button A, Value: 1', '\tcontainer Second', '\t\tradio button B, Value: 0', '\tbutton Next'], 4],
  ['different roles', ['standard window W', '\tcontainer Choices', '\t\tradio button A, Value: 1', '\t\ttab B, Value: 0', '\tbutton Next'], 3],
  ['nonexclusive role', ['standard window W', '\tcontainer Choices', '\t\tcheckbox A, Value: 1', '\t\tcheckbox B, Value: 0', '\tbutton Next'], 3],
]) test(`RT11H E3 refuses siblings with ${name}`, () => {
  const before = probeTree(original), current = before.replace('A, Value: 1', 'A, Value: 0');
  assert.equal(compareMacElement(before, current, original.length - 1, { acted: [acted] }).to, undefined);
});

for (const target of ['button Description: Confirm', 'button Value: Submit', 'link Send', 'button (focused) Place your order', 'button bUy'])
  test(`RT11H consequential label parsing: ${target}`, () => {
    const original = probeTree(['standard window W', '\t' + target, '\ttext Later']);
    assert.equal(compareMacElement(original, original.replace('text Later', 'text Changed'), 1).to, undefined);
  });

test('RT11H an acted consequential target cannot change even its own focus or checked flag', () => {
  const original = probeTree(['standard window W', '\tbutton Confirm']);
  for (const flag of ['focused', 'checked', 'disabled']) {
    const current = original.replace('button Confirm', `button (${flag}) Confirm`);
    assert.equal(compareMacElement(original, current, 1, { acted: [1] }).to, undefined);
  }
});

for (const container of ['container Confirm', 'container Description: Reserve', 'container Description: Save'])
  test(`RT11H the existing submit rules cover a nearby ${container} label`, () => {
    const original = probeTree(['standard window W', '\t' + container, '\t\tbutton Next', '\ttext Later']);
    assert.equal(compareMacElement(original, original.replace('text Later', 'text Changed'), 2).to, undefined);
    const shifted = probeTree(['standard window W', '\ttext Added', '\t' + container, '\t\tbutton Next', '\ttext Later']);
    assert.equal(compareMacElement(original, shifted, 2).to, undefined);
  });

test('RT11H an unchanged consequential tree still rejects a Value on a secure field', () => {
  const original = probeTree(['standard window W', '\tsecure text field Value: exposed', '\tbutton Submit']);
  for (const target of [1, 2]) assert.equal(compareMacElement(original, original, target).to, undefined);
});

function coordinateEvidence(factory) {
  const initial=header+'\n\t1 text field (settable) Placeholder: Name\n\t2 container\n\t3 button Next';
  const state=factory(), first=state.read(row(1,initial)); deliver(state,[first]);
  state.assertCurrent('click',params(1,1),1)();
  state.assertCurrent('click',params(1,[40,30]),1);
  state.assertCurrent('typeText',{...params(1),args:['x']},1)();
  state.read(row(2,initial.replace('(settable) Placeholder: Name','(settable) Value: x, Placeholder: Name')));
  assert.throws(()=>state.assertCurrent('click',params(2,3),1),fault);
}
test('UC2D2 coordinates retire numbered click evidence before subsequent typing',()=>coordinateEvidence(createMacReadState));
test('UC2D2 click-evidence regression detects its individual mutation',async()=>{
  const url=new URL('../plugins/sleight/lib/mac-driver/diff.mjs',import.meta.url);
  const source=readFileSync(url,'utf8').replaceAll(/from '(\.\.?\/[^']+)'/g,(_,path)=>`from '${new URL(path,url).href}'`);
  const needle="if (actions && method !== 'typeText') actions.click = undefined;";
  assert.equal(source.split(needle).length,2);
  const broken=await import('data:text/javascript;base64,'+Buffer.from(source.replace(needle,"if (actions && method !== 'typeText' && !Array.isArray(params?.args?.[0])) actions.click = undefined;")).toString('base64'));
  assert.throws(()=>coordinateEvidence(broken.createMacReadState),{code:'ERR_ASSERTION'});
});
for(const target of [{id:'confirm'},{label:'Confirm'}]) test(`UC2D2 ${JSON.stringify(target)} shares the numbered consequential-target invariant`,()=>{
  const initial=header+'\n\t1 button Confirm, ID: confirm\n\t2 text Alice';
  const state=createMacReadState(),first=state.read(row(1,initial)); deliver(state,[first]);
  state.read(row(2,initial.replace('Alice','Bob')));
  assert.throws(()=>state.assertCurrent('click',params(2,target)),fault);
});
