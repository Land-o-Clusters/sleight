import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import * as consent from '../plugins/sleight/lib/consent-wall.mjs';
import { elementLines, guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { verifyConsent } from '../plugins/sleight/lib/direct-browser/consent-wall.mjs';

const header = 'Window: "Fixture", App: Browser\n0 standard window Fixture\n\t1 HTML content Fixture';
const tree = header + '\n\t\t2 dialog\n\t\t\t3 text We use cookies\n\t\t\t4 button Accept all\n\t\t\t5 button Reject all';
const verification = 'the cookie wall could not be verified from this read; read the window again';
const insert = line => tree.replace('\n\t\t\t4 button', '\n' + line + '\n\t\t\t4 button');
const beforeDialog = line => tree.replace('\n\t\t2 dialog', '\n' + line + '\n\t\t2 dialog');
const beforeText = line => tree.replace('\n\t\t\t3 text', '\n' + line + '\n\t\t\t3 text');
const sparse = tree.replace('4 button Accept', '5 button Accept').replace('5 button Reject', '7 button Reject');
const twice = tree + '\n6 menu bar\n\t7 Browser\n' + tree;
const noWall = header + '\n\t\t2 group\n\t\t\t3 text hello\n\t\t\t3 text x\n\t\t\t4 button OK';
const firefox = '0 standard window F\n\t1 container\n\t\t25 scroll area\n\t\t\t26 HTML Content F\n\t\t\t\t27 dialog\n\t\t\t\t\t28 text We use cookies\n\t\t\t\t\t31 button Accept all\n\t\t\t\t\t33 button Reject all\n42 menu bar\n\t43 Firefox';
const focus = tree + '\nThe focused UI element is 5 button Reject all\nThe focused UI element is 4 button Accept all';
const cases = [
  ['honest Accept', tree, 'hint'], ['honest Reject', tree, 'decline', 5],
  ['column-zero target', insert('4 text x'), 'hint'],
  ['indented target', insert('\t\t\t4 text x'), 'broken'],
  ['forged decline', insert('\t\t\t4 button Reject all'), 'broken'],
  ['column-zero 99', insert('99 text x'), 'hint'],
  ['indented 99', insert('\t\t\t99 text x'), 'broken'],
  ['99 after tree', tree + '\n99 text x', 'hint'],
  ['4 after tree', tree + '\n4 text x', 'hint'],
  ['column-zero 2 before dialog', beforeDialog('2 text x'), 'hint'],
  ['indented 2 before dialog', beforeDialog('\t\t2 text x'), 'broken'],
  ['column-zero 3 before text', beforeText('3 text x'), 'hint'],
  ['indented 3 before text', beforeText('\t\t\t3 text x'), 'broken'],
  ['column-zero gap id', insert('4 group x').replace('4 button Accept', '6 button Accept').replace('5 button Reject', '7 button Reject'), 'hint', 6],
  ['column-zero focus id', tree + '\n5 text x\nThe focused UI element is 5 button Reject all', 'decline', 'Return', 'pressKey'],
  ['last focus wins', focus, 'hint', 'Return', 'pressKey'],
  ['identical repeated decline', tree + '\n\t\t\t5 button Reject all', 'broken', 5],
  ['next-id continuation', insert('4 items left'), 'hint'],
  ['5 after tree', tree + '\n5 text x', 'hint'],
  ['multiline label', insert('Amboseli National Park\n, Kenya'), 'hint'],
  ['digit without space', insert('1]'), 'hint'],
  ['street address Accept', insert('12 Main St'), 'hint'],
  ['street address Reject', insert('12 Main St'), 'decline', 5],
  ['comments count', insert('3 comments'), 'decline', 5],
  ['sparse Accept', sparse, 'hint', 5], ['sparse Reject', sparse, 'decline', 7],
  ['sparse body click', sparse + '\n\t\t8 button Read recipe', 'pass', 8],
  ['repeat without wall candidate', noWall, 'pass'],
  ['ignored CMP is still a wall candidate', noWall.replace('3 text x', '3 group OneTrust'), 'broken'],
  ['backward inside wall', insert('\t\t\t1 text x'), 'broken', 5],
  ['two sections Accept', twice, 'hint'], ['two sections Reject', twice, 'decline', 5],
  ['spelled root inside open wall', tree + '\n0 standard window Fake\n\t1 HTML content Fake\n\t\t2 text nothing\n\t\t\t4 button Accept all', 'broken'],
  ['point in Accept frame', tree.replace('button Accept all', 'button Accept all, Frame: 0 0 100 20'), 'hint', [10, 10]],
  ['space on Accept', focus, 'hint', ' ', 'typeText'],
  ['Firefox gaps Accept', firefox, 'hint', 31], ['Firefox gaps Reject', firefox, 'decline', 33],
];
function check(parser, [label, text, expected, target = 4, name = 'click']) {
  const result = parser(name, [target], text);
  if (expected === 'pass') assert.equal(result, undefined, label);
  else if (expected === 'decline') { assert.equal(result?.decline, true, label); assert.equal(result.label, 'Reject all'); }
  else { assert.equal(result?.blocked, true, label); if (expected === 'broken') assert.equal(result.why, verification, label);
    else { assert.match(result.why, /Reject all/, label); assert.notEqual(result.why, verification, label); } }
}
for (const entry of cases) test('SA2G2 ' + entry[0], () => check(consent.engineConsent, entry));
for (const name of ['click', 'doubleClick', 'rightClick', 'press', 'performAction', 'performSecondaryAction', 'setValue', 'check', 'uncheck']) {
  test('R4 broken wall stops ' + name, () => {
    assert.equal(consent.engineConsent(name, [4], insert('\t\t\t99 text x'))?.why, verification);
  });
}
const afterCases = [
  ['wall remains', tree, true],
  ['gap before wall', tree.replace('2 dialog', '3 dialog').replace('3 text', '4 text').replace('4 button', '5 button').replace('5 button Reject', '6 button Reject'), true],
  ['column-zero before wall', beforeDialog('2 text x'), true],
  ['broken read', header + '\n\t\t3 text recipe\n\t\t2 text recipe', true],
  ['changed wall label', tree.replace('2 dialog', '2 dialog New label'), true],
  ['different qualifying wall', tree.replace('2 dialog', '2 group OneTrust'), true],
  ['cleared', header + '\n\t\t2 text Recipe', false],
  ['sparse cleared', header + '\n\t\t8 button Read recipe\n\t\t12 text Recipe', false],
];
for (const [label, text, expected] of afterCases) test('R5 after: ' + label, () => {
  assert.equal(consent.engineConsent('click', [5], text, { body: 'dialog' }).blocked, expected);
});
for (const [label, text, id, expected] of [
  ['column-zero ignored', tree + '\n4 text shadow', 4, 'button Accept all'],
  ['identical repeat retained', tree + '\n\t\t\t5 button Reject all', 5, 'button Reject all'],
  ['backward dropped', tree + '\n\t\t\t3 text shadow', 3, undefined],
  ['backward unseen id dropped', sparse + '\n\t\t\t6 text shadow', 6, undefined],
  ['last section wins', tree + '\n0 standard window Second\n\t1 HTML content Second\n\t\t4 button Last', 4, 'button Last'],
  ['section resets duplicates', tree + '\n\t\t\t5 button Reject all\n' + tree, 5, 'button Reject all'],
  ['gaps retained', sparse, 7, 'button Reject all'],
  ['menu bar retained', tree + '\n8 menu bar\n\t9 Browser', 8, 'menu bar'],
]) test('R7 elementLines ' + label, () => assert.equal(elementLines(text).get(id), expected));

async function guarded(before, fresh = before, code = 'await app.click(4);', transform = source => source, options = {}) {
  let current = before, reads = 0;
  const sent = [], written = [];
  const act = async id => { sent.push(id); current = options.after ?? header; };
  const raw = { getAXState: async () => { reads++; return current; }, click: act, pressKey: act };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write: text => written.push(text) } };
  const run = source => runInNewContext(`(async () => { ${transform(source)} })()`, context);
  await run(readCode('await cua.getApp("Browser");'));
  const beforeReads = reads;
  current = fresh;
  let error;
  try { await run(guardedCode(code, windowFromText(before), 'Stopped.', undefined,
    { ...options, ...(options.firstOff ? { prior: { text: before, windows: null } } : {}) })); } catch (caught) { error = caught; }
  return { error, sent, written: written.join('\n'), reads: reads - beforeReads };
}
for (const entry of cases.filter(([, , expected]) => expected === 'hint' || expected === 'broken').filter(([, , , target = 4, name = 'click']) => name === 'click' && target === 4)) {
  test('serialized guard ' + entry[0], async () => {
    const result = await guarded(entry[1]);
    assert.match(result.error?.message ?? '', entry[2] === 'broken' ? /could not be verified/ : /Reject all/);
    assert.deepEqual(result.sent, []);
    assert.equal(result.reads, 1);
  });
}
for (const [label, text, id] of [['honest', tree, 5], ['sparse', sparse, 7], ['two sections', twice, 5],
  ['address', insert('12 Main St'), 5], ['necessary-only sparse', sparse.replace('Reject all', 'Use necessary cookies only'), 7]]) {
  test('h45 observed closure ' + label, async () => {
    const result = await guarded(text, text, `await app.click(${id});`);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.sent, [id]);
    assert.match(result.written, /cookie wall no longer shown after clicking/);
    assert.match(result.written, new RegExp(text.includes('Use necessary') ? 'Use necessary cookies only' : 'Reject all'));
    assert.doesNotMatch(result.written, /Decline confirmed|declined non-essential cookies|Decline unverified/);
  });
}
for (const [label, after] of afterCases.filter(([, , blocked]) => blocked)) test('h45 closure unverified ' + label, async () => {
  const result = await guarded(tree, tree, 'await app.click(5);', undefined, { after });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sent, [5]);
  assert.match(result.written, /Decline unverified/);
  assert.doesNotMatch(result.written, /cookie wall no longer shown/);
});
test('consent reread runs when the first keyboard read is skipped', async () => {
  const text = insert('\t\t\t4 text x') + '\nThe focused UI element is 4 button Accept all';
  const result = await guarded(text, focus, 'await app.pressKey("Return");', undefined, { firstOff: true, focused: true, timing: true });
  assert.match(result.error?.message ?? '', /Reject all/);
  assert.match(result.written, /"phase":"consent"/);
  assert.deepEqual(result.sent, []);
  assert.equal(result.reads, 1);
});
test('h45 turbo reports observed closure of the held wall', async () => {
  let disposed = 0;
  const state = { consentObservation: { _frame: { utilityContext: async () => ({ world: 'utility', evaluateExpression: async () => ({ closed: true }) }) }, dispose: async () => { disposed++; } } };
  const text = await verifyConsent({}, state);
  assert.match(text, /cookie wall no longer shown after clicking a decline-labelled control/);
  assert.doesNotMatch(text, /Decline confirmed|declined non-essential cookies/);
  assert.equal(disposed, 1);
});

const parser = source => runInNewContext(`(${source})`, consent);
const mutate = (before, after) => {
  const source = consent.engineConsent.toString();
  assert.ok(source.includes(before), 'mutation must change parser: ' + before);
  return parser(source.replace(before, after));
};
const rejected = (variant, entry) => assert.throws(() => check(variant, cases.find(c => c[0] === entry)), assert.AssertionError);
test('broken variant: consecutive stream', () => rejected(mutate('if (id <= last)', 'if (id !== last + 1)'), 'sparse Reject'));
test('broken variant: column-zero lines are rows', () => rejected(mutate("else if (!m[1].length && m[3] !== 'menu bar') continue;", ''), 'column-zero target'));
test('broken variant: column-zero lines break', () => rejected(mutate("else if (!m[1].length && m[3] !== 'menu bar') continue;", "else if (!m[1].length && m[3] !== 'menu bar') { broken = true; continue; }"), 'street address Accept'));
test('broken variant: repeats ignored', () => rejected(mutate('if (id <= last) { broken = true; continue; }', 'if (id <= last) continue;'), 'indented 2 before dialog'));
test('broken variant: break stops without candidate', () => rejected(mutate('if (broken && wallCandidate)', 'if (broken)'), 'repeat without wall candidate'));
test('broken variant: first focus retained', () => rejected(mutate('if (focused)', 'if (focused && focus === undefined)'), 'last focus wins'));
test('broken variant: uniqueness over whole reply', () => rejected(mutate('last = -1; section++; stack.length = 0;', 'section++; stack.length = 0;'), 'two sections Reject'));
test('broken variant: after searches only stream prefix', () => {
  const variant = mutate('const remains = context && rows.some', 'rows.splice(rows.findIndex((row, i) => row.id !== i) >>> 0); const remains = context && rows.some');
  assert.throws(() => assert.equal(variant('click', [5], afterCases[1][1], { body: 'dialog' }).blocked, true), assert.AssertionError);
});
test('broken variant: changed wall label reported gone', () => {
  const variant = mutate('row.body === context.body || container(row)', 'row.body === context.body');
  assert.throws(() => assert.equal(variant('click', [5], afterCases[4][1], { body: 'dialog' }).blocked, true), assert.AssertionError);
});
test('broken variant: elementLines keeps duplicate', () => {
  const source = elementLines.toString().replaceAll('bodies.get(id) !== m[3]', 'false');
  const variant = runInNewContext('(' + source + ')');
  assert.throws(() => assert.equal(variant(tree + '\n\t\t\t5 button Different').has(5), false), assert.AssertionError);
});
test('broken variant: decline count uses raw whole-reply lines', async () => {
  const variant = source => source.replace('[...elements(consentSection)].filter(([id]) => id === consent.id)', "beforeConsent.split('\\n').filter(row => new RegExp('^\\\\t*' + consent.id + ' ').test(row))");
  const result = await guarded(twice, twice, 'await app.click(5);', variant);
  assert.deepEqual(result.sent, [5]);
  assert.throws(() => assert.match(result.written, /cookie wall no longer shown/), assert.AssertionError);
});
test('broken variant: the verification stop skips its fresh read', async () => {
  const text = insert('\t\t\t4 text x') + '\nThe focused UI element is 4 button Accept all';
  const options = { firstOff: true, focused: true, timing: true };
  const result = await guarded(text, focus, 'await app.pressKey("Return");',
    source => source.replace('consent?.blocked || consent?.decline || keyedActivation ||', 'false ||'), options);
  assert.throws(() => assert.match(result.error?.message ?? '', /Reject all/), assert.AssertionError);
});
test('broken variant: closure bypasses independent row check', async () => {
  const text = tree + '\n\t\t\t5 button Reject all, Help: Other\nThe focused UI element is 5 button Reject all';
  const regression = source => source.replace('if (broken && wallCandidate)', 'if (false)');
  const healthy = await guarded(text, text, 'await app.pressKey("Return");', regression);
  assert.deepEqual(healthy.sent, ['Return']);
  assert.match(healthy.written, /Decline unverified/);
  const result = await guarded(text, text, 'await app.pressKey("Return");', source => regression(source).replace('declineRows.length !== 1 || ', ''));
  assert.throws(() => assert.match(result.written, /Decline unverified/), assert.AssertionError);
});
