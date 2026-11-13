import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Each variant weakens one invariant. Run this same table against the loaded
// mutation, leaving the worktree and on-disk implementation untouched.
const mutations = {
  numeric: ['display && numericDisplayValue(shownValue(a.body)) && numericDisplayValue(shownValue(b.body))', 'display'],
  parent: ['other.parentIndex === expectedParent &&', 'true &&'],
  'open-menu': [' || row.parents.some(expandedMenu)', ''],
  history: ['(!movedBefore || stableIdentity)', 'true'],
  a: ["const bound = matchTarget(delivered, current, a.index, evidence);", "const bound = { to: b.index };"],
  b: ['const display = new Set();', "const display = new Set(lines.filter(row => row.role === 'text' && /\\b(?:Description|ID): /.test(row.body)));"],
  c: ['part.some(r => moneyOrSecret(r.body))', 'false'],
  d: ['const own = ctx.acted.has(i)', 'const own = ctx.acted.has(i) || buttonIdentityRole.test(a.role)'],
  e: ['own && buttonIdentityRole.test(a.role)', 'own'],
  f: ['if (!insert && !removableBlock(block, current, ctx, c.end)) continue;', ''],
  g: ['if (bound.to !== b.index) return {};', 'if (bound.to === undefined) return {}; return { to: b.index };'],
  h: ["const free = new Set(['focused', ...isTarget ? [] : ['disabled']]);", "const free = new Set(['focused', 'disabled']);"],
  i: ['if (surfaceChanged(delivered, current, ctx)) return', 'if (false) return'],
  j: ["if (row.parents.some(p => role(p) === 'web area')) continue;", ''],
  k: ["flags(r.body).some(f => ['settable', 'selected', 'checked'].includes(f))", 'false'],
};
let hook;
if (process.env.GLC2_BASELINE) {
  const target = new URL('../plugins/sleight/lib/mac-driver/diff.mjs', import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context); return url === target ? { ...loaded, source: readFileSync(process.env.GLC2_BASELINE, 'utf8') } : loaded;
  } });
} else if (process.env.GLC2_MUTANT) {
  const pair = mutations[process.env.GLC2_MUTANT]; assert.ok(pair, 'known variant');
  const target = new URL('../plugins/sleight/lib/mac-driver/diff.mjs', import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context); if (url !== target) return loaded;
    assert.ok(String(loaded.source).includes(pair[0]), 'variant anchor ' + process.env.GLC2_MUTANT);
    return { ...loaded, source: String(loaded.source).replace(pair[0], pair[1]) };
  } });
}
const { compareMacElement, createMacReadState } = await import('../plugins/sleight/lib/mac-driver/diff.mjs');
process.on('exit', () => hook?.deregister());
const window = { app: 'Calculator', title: 'Calculator', windowId: '101', pid: 120,
  processStart: '100.25', bundleId: 'com.apple.calculator', identityVerified: true };
const header = 'Window: "Calculator", App: Calculator.';
function tree(rows) {
  return header + '\n' + ['standard window Calculator', ...rows].map((r, i) => {
    const indent = /^\t*/.exec(r)[0]; return indent + i + ' ' + r.slice(indent.length);
  }).join('\n');
}
const captured = readFileSync(new URL('./fixtures/glc1-calculator-closed.txt', import.meta.url), 'utf8');
const capturedAfterSeven = readFileSync(new URL('./fixtures/glc2-calculator-after-seven.txt', import.meta.url), 'utf8');
function calculator(value, clear) {
  return captured.split('\n').filter(line => !/^\t*([67]) /.test(line)).map(line => {
    const row = /^(\t*)(\d+) (.*)$/.exec(line);
    if (!row) return line;
    let body = row[3].replace('StandardInputView;value:735', 'StandardInputView;value:' + value)
      .replace('Edit field, Value: 735', 'Edit field, Value: ' + value);
    if (clear) body = body.replace('All Clear, ID: AllClear', 'Clear, ID: Clear');
    return row[1] + (Number(row[2]) > 7 ? Number(row[2]) - 2 : row[2]) + ' ' + body;
  }).join('\n');
}
const cases = [];
function add(id, name, before, after, target, want, extras = {}) {
  cases.push({ id, name, before: Array.isArray(before) ? tree(before) : before,
    after: Array.isArray(after) ? tree(after) : after, target, want, ...extras });
}
const button = '\tbutton Open, ID: open';
add(1, 'recorded AllClear and Seven then One', captured, capturedAfterSeven, 22, 20, { idValue: 'One', label: '1', acted: [11, 14], labelWant: null });
add('1b', 'recorded Seven after AllClear becomes Clear', captured, capturedAfterSeven, 14, 12, { idValue: 'Seven', label: '7', acted: [11, 14], labelWant: null });
add(2, 'recorded AllClear then Seven', captured, calculator('0', false), 14, 12, { idValue: 'Seven', label: '7', acted: [11], labelWant: null });
add(3, 'E2b AllClear label change after Seven', calculator('0', false), calculator('7', true), 20, 20, { idValue: 'One', label: '1', acted: [12], labelWant: null });
for (const [id, before, after, target] of [
  [4, 'text Alice', 'text Bob', button],
  [5, 'text Recipient: Mom', 'text Recipient: Stranger', '\tbutton Apply, ID: open'],
  [6, 'checkbox (checked) Send to all', 'checkbox Send to all', '\tbutton Next, ID: open'],
  [8, 'text Description: Recipient, Value: Mom', 'text Description: Recipient, Value: Stranger', '\tbutton Apply, ID: open'],
  [12, 'row Invoice 12', 'row Invoice 13', button],
  [20, 'button Play, ID: play', 'button Pause, ID: pause', '\tbutton Next, ID: open'],
  [25, 'row Invoice 12', 'row Invoice 13', button],
]) add(id, 'prefix ' + before, ['\tcontainer', '\t\t' + before, '\t' + target], ['\tcontainer', '\t\t' + after, '\t' + target], 3, null, { acted: id === 25 ? [2] : [] });
add(7, 'moves between bare containers', ['\tcontainer', '\t\ttext Other', '\tcontainer', '\t\tbutton Open, ID: open'],
  ['\tcontainer', '\t\tbutton Open, ID: open', '\tcontainer', '\t\ttext Other'], 4, null);
for (const [group, want] of [['scroll area ID: Status', 3], ['group', null]]) add(9, 'named display in ' + group,
  ['\t' + group, '\t\ttext Description: Word count, Value: 12', button],
  ['\t' + group, '\t\ttext Description: Word count, Value: 13', button], 3, want);
add(10, 'money in viewport', ['\tscroll area ID: Status', '\t\ttext Description: Total, Value: $735', button],
  ['\tscroll area ID: Status', '\t\ttext Description: Total, Value: $7', button], 3, null);
for (const acted of [[], [3]]) add(11, 'selection swap acted=' + acted.length,
  ['\tcontainer', '\t\trow (selected) Invoice 12', '\t\trow Invoice 13', '\t\tbutton Open, ID: open'],
  ['\tcontainer', '\t\trow Invoice 12', '\t\trow (selected) Invoice 13', '\t\tbutton Open, ID: open'], 4, acted.length ? 4 : null, { acted });
add(13, 'sheet text changes', ['\tsheet', '\t\ttext Replace 3 files?', '\t\tbutton Continue, ID: open'],
  ['\tsheet', '\t\ttext Replace 300 files?', '\t\tbutton Continue, ID: open'], 3, null);
add(14, 'selector gains duplicate after target', [button], [button, button], 1, 1, { selectorWant: null });
for (const [name, before, after, want] of [
  ['target disables', button, '\tbutton (disabled) Open, ID: open', null],
  ['target enables', '\tbutton (disabled) Open, ID: open', button, null],
  ['sibling disables', '\tbutton Save', '\tbutton (disabled) Save', 2],
]) add(15, name, name.startsWith('sibling') ? [before, button] : [before], name.startsWith('sibling') ? [after, button] : [after], name.startsWith('sibling') ? 2 : 1, want);
for (const first of [false, true]) add(16, 'toolbar first=' + first,
  first ? [button, '\ttab (selected) a.txt'] : ['\ttab (selected) a.txt', button],
  first ? [button, '\ttab (selected) b.txt'] : ['\ttab (selected) b.txt', button], first ? 1 : 2, first ? 1 : null);
add(17, 'row reorder', ['\tcontainer', '\t\trow A', '\t\trow B, ID: open', '\t\trow C'],
  ['\tcontainer', '\t\trow B, ID: open', '\t\trow A', '\t\trow C'], 3, 2, { label: 'B' });
add(17, 'identical rows bind by position', ['\trow Item, ID: open', '\trow Item, ID: open', '\trow Item, ID: open'],
  ['\trow Item, ID: open', '\trow Item, ID: open', '\trow Item, ID: open'], 2, 2, { label: 'Item', selectorWant: null });
add(18, 'web text identity', ['\tweb area', '\t\ttext Order #12', '\t\tbutton View, ID: open'],
  ['\tweb area', '\t\ttext Order #13', '\t\tbutton View, ID: open'], 3, null);
add(18, 'web viewport value', ['\tweb area', '\t\tscroll area ID: Status', '\t\t\ttext Description: Status, Value: 12', button],
  ['\tweb area', '\t\tscroll area ID: Status', '\t\t\ttext Description: Status, Value: 13', button], 4, null);
add(19, 'sheet appears after target', [button], [button, '\tsheet'], 1, null);
add(20, 'acted Play becomes Pause', ['\tcontainer', '\t\tbutton Play, ID: play', '\t\tbutton Next, ID: open'],
  ['\tcontainer', '\t\tbutton Pause, ID: pause', '\t\tbutton Next, ID: open'], 3, 3, { acted: [2] });
for (const own of [false, true]) add(21, 'field written=' + own,
  ['\ttext field (settable) Amount, Value: 10', button], ['\ttext field (settable) Amount, Value: 1000', button], 2, own ? 2 : null,
  { acted: own ? [1] : [], writes: own ? new Map([[1, '1000']]) : new Map() });
add(22, 'ancestor identity', ['\tcontainer Inbox', '\t\tbutton Open, ID: open'], ['\tcontainer Archive', '\t\tbutton Open, ID: open'], 2, null);
add(23, 'new text after target', [button], [button, '\ttext New message'], 1, 1);
add(24, 'selector and alignment disagree', [button], ['\tbutton Other, ID: other', button], 1, 1, { acted: [1], selectorWant: null });
add(26, 'removed seen row', ['\ttext Alice', button], [button], 2, null);
add(27, 'inserted checked state', [button], ['\tcheckbox (checked) Also delete on server', button], 1, null);

// Extra edges of the same E1-E4 contract, independent of the numbered table.
for (const [name, viewport, child, replacement, want] of [
  ['no viewport ID', 'scroll area', 'text Description: Count, Value: 1', 'text Description: Count, Value: 2', null],
  ['unnamed viewport text', 'scroll area ID: status', 'text One', 'text Two', null],
  ['identified layout viewport', 'layout area ID: status;value:1', 'text ID: count, Value: 1', 'text ID: count, Value: 2', 3],
  ['web ancestor', 'web area', 'text Description: Count, Value: 1', 'text Description: Count, Value: 2', null],
]) add('E1', name, ['\t' + viewport, '\t\t' + child, button], ['\t' + viewport, '\t\t' + replacement, button], 3, want);
add('E1', 'whole viewport removed', ['\tscroll area ID: status', '\t\ttext Description: Count, Value: 1', button], [button], 3, 1);
add('E1', 'part of a viewport removed', ['\tscroll area ID: status', '\t\ttext Description: Count, Value: 1', button], ['\tscroll area ID: status', button], 3, null);
for (const [name, oldValue, newValue, want] of [
  ['recipient', 'Mom', 'Eve', null], ['email', 'mom@x.com', 'eve@evil.com', null],
  ['grouped money', '1,200.00', '12.00', null], ['money introduced', '12', '1,200.00', null],
  ['money removed', '1,200.00', '12', null], ['plain money', '12.00', '13.00', null],
  ['numeric to text', '12', 'Eve', null], ['text to numeric', 'Mom', '12', null],
  ['value appears', undefined, '12', null], ['value disappears', '12', undefined, null],
  ['blank value', '', '12', null], ['operator only', '+', '-', null],
  ['numeric residual Amount', '12', '12000', 3], ['decimal', '-1.5', '+2.5', 3],
  ['exponent', '1E+3', '2E-3', 3], ['operators', '12×3÷2', '12+3-2', 3],
  ['percent and spaces', ' 12% ', ' 13% ', 3],
]) {
  const field = value => '\t\ttext Description: ' + (name === 'recipient' ? 'Send to:' : 'Amount') + (value === undefined ? '' : ', Value: ' + value);
  add('E1', name, ['\tscroll area ID: Summary', field(oldValue), button],
    ['\tscroll area ID: Summary', field(newValue), button], 3, want);
}
add('E1', 'nested recipient', ['\tscroll area ID: Summary', '\t\tcontainer', '\t\t\ttext Description: Send to, Value: Mom', button],
  ['\tscroll area ID: Summary', '\t\tcontainer', '\t\t\ttext Description: Send to, Value: Eve', button], 4, null);
for (const title of ['Send', 'Pay', 'Save', 'Move to Trash', 'Confirm']) add('E1', 'numeric Amount before consequential ' + title,
  ['\tscroll area ID: Summary', '\t\ttext Description: Amount, Value: 12', '\tbutton ' + title + ', ID: open'],
  ['\tscroll area ID: Summary', '\t\ttext Description: Amount, Value: 12000', '\tbutton ' + title + ', ID: open'], 3, null, { label: title });
for (const [oldValue, newValue, want] of [['Mom', 'Eve', null], ['1,200.00', '12', null], ['12', '12000', 2]]) {
  add('E1', 'viewport ID suffix ' + oldValue, ['\tscroll area ID: Summary;value:' + oldValue, button],
    ['\tscroll area ID: Summary;value:' + newValue, button], 2, want);
  add('E1', 'viewport own Value ' + oldValue, ['\tscroll area ID: Summary, Value: ' + oldValue, button],
    ['\tscroll area ID: Summary, Value: ' + newValue, button], 2, want);
}
add('E1', 'whole nonnumeric viewport removed still follows GLR1', ['\tscroll area ID: status', '\t\ttext Description: Result, Value: Done', button], [button], 3, 1);
add('E2', 'acted row may change Value', ['\trow Item, ID: row, Value: 1', button], ['\trow Item, ID: row, Value: 2', button], 2, 2, { acted: [1] });
add('E2', 'acted button metadata outside label and state stays bound', ['\tbutton Play, Help: Plays audio, ID: play', button],
  ['\tbutton Pause, Help: Deletes audio, ID: pause', button], 2, null, { acted: [1] });
add('E4', 'inserted settable field', [button], ['\ttext field (settable) Name', button], 1, null);
add('E4', 'inserted selected row', [button], ['\trow (selected) Item', button], 1, null);
add('modal', 'later sheet subtree is context', [button, '\tsheet', '\t\ttext Replace 3 files?'],
  [button, '\tsheet', '\t\ttext Replace 300 files?'], 1, null);
add('14b', 'selector ambiguous in delivered read only', [button, button], [button], 1, 1, { selectorWant: null });

add('E4', 'removed control cannot reuse an already-aligned acted control', ['\tbutton B, ID: b', '\tbutton A, ID: a', button],
  ['\tbutton A, ID: a', button], 3, null, { acted: [1] });

add('E1', 'only the viewport ID suffix may drift', ['\tscroll area Description: Status;value:one, ID: status', '\t\ttext Description: Count, Value: 1', button],
  ['\tscroll area Description: Status;value:two, ID: status', '\t\ttext Description: Count, Value: 1', button], 3, null);

add('E4', 'removed row cannot move to another identical container', ['\tcontainer', '\t\trow A', '\tcontainer', '\t\tbutton Open, ID: open'],
  ['\tcontainer', '\tcontainer', '\t\tbutton Open, ID: open', '\t\trow A'], 4, null);
add('modal', 'expanded menu leaf after target stays bound', [button, '\tmenu (expanded)', '\t\tmenu item Original, ID: command'],
  [button, '\tmenu (expanded)', '\t\tmenu item Changed, ID: command'], 1, null);

function exercise(row, target) {
  const state = createMacReadState(), initial = state.read({ window, readId: 1, text: row.before });
  state.endCell([{ type: 'text', text: row.before }], [initial]);
  for (const i of row.acted ?? []) {
    const value = row.writes?.get(i), method = value === undefined ? 'click' : 'setValue';
    state.assertCurrent(method, { ...window, readId: 1, args: [i, ...value === undefined ? [] : [value]] }, 'cell')();
  }
  state.read({ window, readId: 2, text: row.after });
  const params = { ...window, readId: 2, args: [target] };
  try {
    const complete = state.assertCurrent('click', params, 'cell');
    return { to: typeof target === 'number' ? params.args[0] : true, notices: complete.notices };
  } catch (error) {
    assert.equal(error.code, 'STALE_READ'); assert.equal(error.delivery, 'not-sent'); assert.equal(error.retry, 'safe');
    assert.match(error.message, /next=read-again/); return { to: null };
  }
}
for (const row of cases) test(`GLR1 ${row.id}: ${row.name}`, () => {
  const decision = exercise(row, row.target); assert.equal(decision.to, row.want, 'number delivery');
  const numeric = compareMacElement(row.before, row.after, row.target, { acted: row.acted, writes: row.writes });
  assert.equal(numeric.to ?? null, row.want, 'numeric comparison');
  if (row.want !== null && row.want !== row.target) assert.match(decision.notices.join('\n'), /went to element/);
  const body = row.before.split('\n').find(line => new RegExp('^\\t*' + row.target + ' ').test(line));
  const label = row.label ?? /(?:button|row) (?:\([^)]*\) )?([^,]+)/.exec(body)?.[1];
  const id = row.idValue ?? /ID: ([^,]+)/.exec(body)?.[1];
  for (const selector of [{ id }, { label }]) {
    assert.equal(typeof Object.values(selector)[0], 'string', 'complete selector fixture');
    const expected = Object.hasOwn(selector, 'label') && Object.hasOwn(row, 'labelWant') ? row.labelWant : Object.hasOwn(row, 'selectorWant') ? row.selectorWant : row.want;
    assert.equal(exercise(row, selector).to, expected === null ? null : true, JSON.stringify(selector));
  }
});

test('GLR1 seeded numeric/selector agreement and forbidden context mutations, 1000 trees', () => {
  let seed = 0x61c2;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 1000; trial++) {
    const size = 4 + random(36), target = 2 + random(size - 2);
    const rows = Array.from({ length: size }, (_, i) => '\t' + (i + 1 === target ? 'button Open, ID: open' : `text Row ${i}`));
    const changed = [...rows], at = random(size), mutation = random(5);
    if (mutation === 0) changed[at] = changed[at].replace('text ', 'text Changed ');
    if (mutation === 1) changed[at] = changed[at].replace('text ', 'text (focused) ');
    if (mutation === 2) changed.push('\ttext Later');
    if (mutation === 3) changed.splice(at, 0, '\ttext Inserted');
    if (mutation === 4) changed.splice(at, 1);
    const row = { before: tree(rows), after: tree(changed), target };
    const numeric = compareMacElement(row.before, row.after, target).to ?? null;
    row.want = numeric;
    const selector = exercise(row, { id: 'open' }).to;
    assert.equal(selector, numeric === null ? null : true, `trial ${trial}`);
    if (mutation === 0 && at + 1 < target) assert.equal(numeric, null, `prefix identity trial ${trial}`);
    if (mutation === 4 && at + 1 <= target) assert.equal(numeric, null, `removed seen row trial ${trial}`);
  }
});

test('trash is consequential and binds the whole tree', () => {
  const before = tree(['\tbutton Move to Trash, ID: open', '\ttext Alice']);
  const row = { before, after: before.replace('Alice', 'Bob'), target: 1, want: null };
  for (const target of [1, { id: 'open' }, { label: 'Move to Trash' }]) assert.equal(exercise(row, target).to, null);
});

test('E2 keeps a remapped acted button bound across following read IDs', () => {
  const state = createMacReadState();
  const before = tree(['\tbutton Add', '\ttext Ready', '\tbutton Cancel, ID: cancel']);
  const after = tree(['\tbutton Add', '\ttext Ready', '\tbutton Undo Banner', '\tbutton Cancel, ID: cancel']);
  const first = state.read({ window, readId: 1, text: before });
  state.endCell([{ type: 'text', text: before }], [first]);
  state.read({ window, readId: 2, text: after });
  const input = target => ({ ...window, readId: 2, args: [target] });
  const initial = input(3), done = state.assertCurrent('click', initial, 'cell');
  assert.equal(initial.args[0], 4); done();
  state.read({ window, readId: 3, text: after });
  const repeated = { ...input(3), readId: 3 };
  const again = state.assertCurrent('click', repeated, 'cell');
  assert.equal(repeated.args[0], 4, 'the inserted banner is not the acted Cancel control'); again();
  assert.doesNotThrow(() => state.assertCurrent('click', { ...input({ id: 'cancel' }), readId: 3 }, 'cell'));
  // Returning to the delivered position with the original identity is safe.
  state.read({ window, readId: 4, text: before });
  const returned = { ...input(3), readId: 4 };
  state.assertCurrent('click', returned, 'cell'); assert.equal(returned.args[0], 3);
});
