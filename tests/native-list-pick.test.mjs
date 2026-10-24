import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { listPicker } from '../plugins/sleight/lib/native-list-pick.mjs';
import { guardedCode, readCode, sameElement, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const window = { title: 'Book a trip', app: 'Firefox', url: null };
const letters = 'abcdefghijklmnopqrstuvwxyz';
// Unique, lexically sorted labels with a code after the name, as the travel form's airports.
const sortedNames = n => Array.from({ length: n }, (_, i) =>
  'Port ' + letters[Math.floor(i / 676) % 26] + letters[Math.floor(i / 26) % 26] + letters[i % 26] + ' Airport ' + (100 + (i * 7) % 900));

// A virtualized list: `visible` rows show, `overscan` more render on each side, a page key moves `page` rows.
function fakeList(names, { visible = 10, page = 9, overscan = 2, start = 0, focus = 'list', hook } = {}) {
  const model = { names, position: start, keys: [], reads: 0, focus, stuck: false, snapshot: [], numbers: new Map(), selected: undefined };
  const clamp = value => Math.max(0, Math.min(model.names.length - visible, value));
  model.key = async key => {
    model.keys.push(key);
    if (!model.stuck) model.position = clamp(model.position + (key === 'Page_Down' ? page : key === 'Page_Up' ? -page : 0));
    hook?.key?.(model, key);
  };
  model.tree = async () => {
    model.reads++;
    hook?.read?.(model);
    const from = Math.max(0, model.position - overscan), to = Math.min(model.names.length, model.position + visible + overscan);
    const lines = ['Window: "Book a trip", App: Firefox.', '0 standard window Book a trip', '\t1 container Book a trip',
      '\t\t2 text Departing from', '\t\t3 list Departing from'];
    model.numbers = new Map();
    for (let i = from; i < to; i++) {
      const number = 4 + i - from;
      const name = model.names[i];
      model.numbers.set(number, name);
      lines.push(`\t\t\t${number} text (${model.selected === name ? 'selected' : 'selectable'}) ${name}\n${name.split(' Airport ')[0]}\n${name.split(' ').at(-1)}`);
    }
    lines.push('\t\t90 text Selected: none', '\t\t91 button Next', '', model.focus === 'list' ? 'The focused UI element is 3 list Departing from'
      : 'The focused UI element is 91 button Next');
    model.snapshot = lines;
    return lines.join('\n');
  };
  return model;
}

function picker(model, extra = {}) {
  const clicks = [];
  const run = listPicker({ read: model.tree, observe() {}, press: model.key, parse: windowFromText, sameElement, expected: window,
    sleep: async () => {}, click: async line => { clicks.push(line); model.selected = /^text \(selectable\) (.*)$/.exec(line)?.[1]; }, ...extra });
  return { clicks, run };
}
const labelOfClick = (model, line) => /^text \(selectable\) (.*)$/.exec(line)?.[1];

test('finds a target ahead with coarse page steps and clicks exactly that row', async () => {
  const names = sortedNames(1000), model = fakeList(names, { page: 9 });
  const { run, clicks } = picker(model);
  const result = await run(names[612]);
  assert.match(result.completeness, /row total unknown/);
  assert.equal(result.found, true); assert.equal(result.clicked, true);
  assert.deepEqual(clicks.map(line => labelOfClick(model, line)), [names[612]]);
  assert.ok(result.reads <= 24, `reads ${result.reads}`);
  assert.ok(model.keys.every(key => key === 'Page_Down' || key === 'Page_Up'));
  assert.ok(model.keys.filter(key => key === 'Page_Down').length >= 60);
});

test('overshoot reverses page by page and still finds the target', async () => {
  const names = sortedNames(300), model = fakeList(names, { page: 9, start: 40 });
  const { run, clicks } = picker(model);
  // The target sits just behind the rendered rows: one page back, not a coarse step.
  const result = await run(names[30]);
  assert.equal(result.clicked, true);
  assert.equal(labelOfClick(model, clicks[0]), names[30]);
  assert.deepEqual(model.keys, ['Page_Up']);
  // CC3: from the top, the measuring key and one jump land on row 30 with no coarse overshoot to come back from.
  const top = fakeList(names, { page: 9 });
  const second = picker(top);
  assert.equal((await second.run(names[30])).clicked, true);
  assert.ok(top.keys.length <= 4 && !top.keys.includes('Page_Up'), top.keys.join());
});

test('every label is found at page sizes 8, 9 and 10 with overscan; a page equal to the window needs overlap and stops instead', async () => {
  const names = sortedNames(160);
  for (const page of [8, 9, 10]) {
    let slow = 0;
    for (const target of names) {
      const model = fakeList(names, { page, overscan: 2 });
      const { run, clicks } = picker(model);
      const result = await run(target);
      assert.equal(result.clicked, true, `${target} at page ${page}: ${JSON.stringify(result)}`);
      assert.deepEqual(clicks.map(line => labelOfClick(model, line)), [target]);
      slow = Math.max(slow, result.reads);
    }
    assert.ok(slow <= 24, `page ${page}: most reads ${slow}`);
  }
  let gaps = 0;
  for (const target of names) {
    const model = fakeList(names, { page: 10, overscan: 0 });
    const { run, clicks } = picker(model);
    const result = await run(target);
    if (result.clicked) assert.equal(labelOfClick(model, clicks[0]), target);
    else { gaps++; assert.equal(result.reason, 'gap'); assert.deepEqual(clicks, []); }
  }
  assert.ok(gaps > 0);
});

test('first row, last row and rows at the edges of the rendered window are found', async () => {
  const names = sortedNames(100);
  for (const [at, start] of [[0, 0], [99, 0], [99, 90], [0, 90], [9, 0], [12, 0], [97, 90]]) {
    const model = fakeList(names, { start });
    const { run, clicks } = picker(model);
    const result = await run(names[at]);
    assert.equal(result.clicked, true, `${at} from ${start}: ${JSON.stringify(result)}`);
    assert.equal(labelOfClick(model, clicks[0]), names[at]);
  }
  // lp1: a row in the middle of the rendered rows is clicked with no key; a row at their edge is first brought inward,
  // and at the top of the list one Page_Up shows the list cannot move (the top rows are the visible ones).
  assert.equal((await picker(fakeList(names, { start: 0 })).run(names[5])).keys, 0, 'already in the middle: no key');
  assert.equal((await picker(fakeList(names, { start: 0 })).run(names[0])).keys, 1, 'at the top: one probing key');
});

test('exact labels only: a longer and a shorter neighbour never match', async () => {
  const names = ['Norcrest Bay', 'Norcrest Point International', 'Norcrest Pointe', 'Norcrest Pointer', 'Norcrest Q'];
  const filler = sortedNames(60).map(name => 'Aa ' + name);
  const all = [...filler, ...names, 'Zz end 1', 'Zz end 2'].sort((a, b) => a.localeCompare(b));
  const model = fakeList(all, { page: 8 });
  const { run, clicks } = picker(model);
  const near = await run('Norcrest Point');
  assert.equal(near.found, false); assert.equal(near.reason, 'not-in-list');
  assert.deepEqual(clicks, []);
  assert.deepEqual(near.near, ['Norcrest Point International']);
  assert.match(near.note, /Pass a whole row label/);
  const exact = await picker(fakeList(all, { page: 8 })).run('Norcrest Pointe');
  assert.equal(exact.label, 'Norcrest Pointe');
  const model2 = fakeList(all, { page: 8 });
  const p = picker(model2);
  await p.run('Norcrest Pointer');
  assert.equal(labelOfClick(model2, p.clicks[0]), 'Norcrest Pointer');
});

test('a row can be named by its name line; a whole-label near miss reports the rows that start with it', async () => {
  const names = sortedNames(80), model = fakeList(names);
  const name = names[40].split(' Airport ')[0];
  const { run, clicks } = picker(model);
  const result = await run(name);
  assert.equal(result.clicked, true);
  assert.equal(labelOfClick(model, clicks[0]), names[40]);
  const prefix = names[41].slice(0, -2);
  const miss = await picker(fakeList(names)).run(prefix);
  assert.equal(miss.clicked, false);
});

test('a label between two rows is reported absent and nothing is clicked', async () => {
  const names = sortedNames(200), model = fakeList(names);
  const { run, clicks } = picker(model);
  const result = await run(names[120] + ' x');
  assert.equal(result.found, false); assert.equal(result.reason, 'not-in-list');
  assert.deepEqual(clicks, []);
  assert.match(result.note, /^No row clicked\./);
  const before = await picker(fakeList(names)).run('A');
  assert.equal(before.reason, 'no-progress');
  const after = await picker(fakeList(names)).run('Zzzz');
  assert.equal(after.reason, 'no-progress');
  assert.match(after.note, /end of the list/);
});

test('stops when the keys do not move the list', async () => {
  const names = sortedNames(200), model = fakeList(names);
  model.stuck = true;
  const { run, clicks } = picker(model);
  const result = await run(names[150]);
  assert.equal(result.reason, 'no-progress');
  assert.equal(model.keys.length, 5, 'one measuring key and one coarse step, then it stops');
  assert.deepEqual(clicks, []);
});

// CC3: a jump presses its keys between two reads, so focus that moves mid-jump is seen at the read after it.
test('stops when focus leaves the list and presses no further key', async () => {
  const names = sortedNames(300);
  let seenAt;
  const model = fakeList(names, { hook: { key: (m, key) => { if (m.keys.length === 8) m.focus = 'button'; },
    read: m => { if (m.focus === 'button') seenAt ??= m.keys.length; } } });
  const { run, clicks } = picker(model);
  const result = await run(names[250]);
  assert.equal(result.reason, 'focus-lost');
  assert.ok(seenAt >= 8);
  assert.equal(model.keys.length, seenAt, 'no key after the read that shows focus elsewhere');
  assert.deepEqual(clicks, []);
  const none = fakeList(names, { focus: 'button' });
  const first = await picker(none).run(names[5]);
  assert.equal(first.reason, 'not-a-list');
  assert.deepEqual(none.keys, []);
});

test('stops on rows that are not strictly ascending, before or after moving', async () => {
  const names = sortedNames(300);
  const swapped = [...names]; [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  const model = fakeList(swapped);
  const { run, clicks } = picker(model);
  assert.equal((await run(names[250])).reason, 'unsorted');
  assert.deepEqual(model.keys, []);
  assert.deepEqual(clicks, []);
  // Rows out of order next to the target: jumps check order only on the rows they see (CC3).
  const later = [...names]; [later[292], later[293]] = [later[293], later[292]];
  const model2 = fakeList(later, { page: 9 });
  const second = picker(model2);
  const result = await second.run(names[290]);
  assert.equal(result.reason, 'unsorted');
  assert.ok(model2.keys.length > 0);
  assert.deepEqual(second.clicks, []);
  const duplicate = fakeList([...names.slice(0, 5), names[4], ...names.slice(5)]);
  assert.equal((await picker(duplicate).run(names[200])).reason, 'unsorted');
});

test('a list that wraps back instead of advancing is refused', async () => {
  const names = sortedNames(300);
  const model = fakeList(names, { hook: { read: m => { if (m.reads === 3) m.position = 0; } } });
  const result = await picker(model).run(names[280]);
  assert.equal(result.reason, 'unsorted');
});

test('caps reads, keys and time', async () => {
  const names = sortedNames(1000);
  const model = fakeList(names, { page: 8 });
  const { run, clicks } = picker(model);
  const result = await run(names[900], { maxReads: 6 });
  assert.equal(result.reason, 'cap'); assert.ok(result.reads <= 6);
  assert.deepEqual(clicks, []);
  let tick = 0;
  const timed = picker(fakeList(names, { page: 8 }), { now: () => (tick += 5000) });
  assert.equal((await timed.run(names[900], { timeoutMs: 12000 })).reason, 'cap');
  const slow = fakeList(sortedNames(1000), { page: 1, visible: 3, overscan: 0 });
  const keyed = await picker(slow).run(slow.names[990], { maxReads: 100 });
  assert.equal(keyed.reason, 'cap');
  assert.ok(slow.keys.length <= 400);
});

test('never clicks a row from a tree that a redraw has already replaced', async () => {
  const names = sortedNames(300), target = names[150];
  // The read right after the first tree that shows the target finds the list redrawn at the top.
  let shown = 0;
  const model = fakeList(names, { hook: { read: m => {
    if (shown === 1) { m.position = 0; shown = 2; }
    else if (shown === 0 && m.position - 2 <= 150 && 150 < m.position + 12) shown = 1;
  } } });
  const clicks = [];
  const { run } = picker(model, { click: async line => {
    assert.ok(model.snapshot.some(row => row.includes(line)), 'the newest tree shows the row being clicked');
    clicks.push(line); model.selected = labelOfClick(model, line);
  } });
  const result = await run(target);
  assert.equal(shown, 2);
  assert.equal(result.clicked, true);
  assert.deepEqual(clicks.map(line => labelOfClick(model, line)), [target]);
  assert.ok(model.keys.length > 30, 'it searched again after the redraw rather than clicking the old tree');

  // A row that is gone from the confirming tree is never clicked.
  let looks = 0;
  const gone = fakeList(sortedNames(300), { hook: { read: m => {
    if (m.position - 2 <= 150 && 150 < m.position + 12 && ++looks === 2) m.names.splice(150, 1);
  } } });
  const second = picker(gone);
  const missing = await second.run(target);
  assert.equal(missing.clicked, false);
  assert.equal(missing.reason, 'not-in-list');
  assert.deepEqual(second.clicks, []);
});

test('the confirming read must show the row once and in the same list', async () => {
  const names = sortedNames(60);
  const model = fakeList(names);
  let reads = 0;
  const { run, clicks } = picker(model, { read: async () => {
    const text = await model.tree();
    if (++reads === 2) return text.replace('3 list Departing from\n', '3 list Departing from\n').replace(/The focused UI element is 3 list Departing from/, 'The focused UI element is 91 button Next');
    return text;
  } });
  const result = await run(names[4]);
  assert.equal(result.reason, 'focus-lost');
  assert.deepEqual(clicks, []);
});

// FT1a: the skill now sends a long list here first. Safari's travel list (race-1017 r3) reads "list (settable)" with plain
// "text <name> <code>" rows, 16 shown, and focus on the list after a row click; the row the task names is a whole label.
test('the Safari list shape from the travel race is searched and its whole-label row clicked', async () => {
  const shown = ['Ashbridge International FTZ', 'Ashbridge Point Municipal HBB', 'Norcliff International JUR', 'Norcrest Bay Municipal YLU',
    'Norcrest Point International MAO', 'Nordale Bay Airport DIT', 'Rosford Valley Field YZB'];
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const names = [...new Set([...shown, ...sortedNames(990)])].sort(compare);
  let position = 0, chosen;
  const keys = [];
  const tree = async () => {
    const rows = names.slice(position, position + 16).map((name, i) => `\t\t\t\t\t\t\t${25 + i} text ${name === chosen ? '(selected) ' : ''}${name}`);
    return ['Window: "sleight benchmark — Book a trip · Skyway", App: Safari.', '0 standard window sleight benchmark — Book a trip · Skyway',
      '\t\t\t\t\t\t23 text Departing from', '\t\t\t\t\t\t24 list (settable) Departing from', ...rows,
      '\t\t\t\t\t\t41 text Selected: Ashbridge International (FTZ)', '\t\t\t\t\t\t42 button Back', '',
      'The focused UI element is 24 list (settable) Departing from'].join('\n');
  };
  const clicks = [];
  const run = listPicker({ read: tree, observe() {}, parse: windowFromText, sameElement, sleep: async () => {},
    expected: { title: 'sleight benchmark — Book a trip · Skyway', app: 'Safari', url: null },
    press: async key => { keys.push(key); position = Math.max(0, Math.min(names.length - 16, position + (key === 'Page_Down' ? 15 : -15))); },
    click: async line => { clicks.push(line); chosen = line.replace(/^text /, ''); } });
  const result = await run('Norcrest Point International MAO');
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.deepEqual(clicks, ['text Norcrest Point International MAO']);
  assert.ok(result.reads <= 30, String(result.reads));
  position = 0; clicks.length = 0;
  const partial = await run('Norcrest Point');
  assert.equal(partial.clicked, false);
  assert.deepEqual(partial.near, ['Norcrest Point International MAO']);
  assert.deepEqual(clicks, []);
});

test('a changed window stops the search with its tree and clicks nothing', async () => {
  const names = sortedNames(300), model = fakeList(names);
  const { run, clicks } = picker(model, { read: async () => {
    const text = await model.tree();
    return model.keys.length >= 4 ? text.replace('Window: "Book a trip"', 'Window: "Other"') : text;
  } });
  await assert.rejects(run(names[250]), /window changed/);
  assert.deepEqual(clicks, []);
});

test('input is checked', async () => {
  const { run } = picker(fakeList(sortedNames(50)));
  for (const bad of ['', '  ', 4, undefined]) await assert.rejects(run(bad), /exact label/);
  await assert.rejects(run('x', { maxReads: 0 }), /maxReads/);
  await assert.rejects(run('x', { coarse: 9 }), /coarse/);
});

// Through the guard: every key and the click use the guarded handle.
function guarded(model, { raw = {} } = {}) {
  const clicks = [], keys = [];
  // The wheel moves the list 3 rows a tick.
  const handle = { getAXState: async () => model.tree(), pressKey: async key => { keys.push(key); await model.key(key); },
    scroll: async (target, direction, ticks) => { model.position = Math.max(0, Math.min(model.names.length - 10, model.position + (direction === 'down' ? 3 : -3) * ticks)); },
    click: async number => { clicks.push(model.numbers.get(number)); model.selected = model.numbers.get(number); }, ...raw };
  const context = { cua: { getApp: async () => handle }, setTimeout, nodeRepl: { write() {} } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  return { clicks, keys, run, handle, start: () => run(readCode('await cua.getApp("Firefox");')),
    call: code => run(guardedCode(code, window)) };
}

test('app.pickFromList pages by key and clicks the row it resolved in its newest tree', async () => {
  const names = sortedNames(400), model = fakeList(names, { page: 9 });
  const g = guarded(model);
  await g.start();
  const result = await g.call(`return await app.pickFromList(${JSON.stringify(names[333])});`);
  assert.equal(result.clicked, true);
  assert.deepEqual(g.clicks, [names[333]]);
  assert.ok(g.keys.length > 20 && g.keys.every(key => key.startsWith('Page_')));
});

test('app.pickFromList stops when the window changes between keys', async () => {
  const names = sortedNames(400), model = fakeList(names);
  let swapped = false;
  const g = guarded(model, { raw: {
    getAXState: async () => { const text = await model.tree(); return swapped ? text.replace('"Book a trip"', '"Elsewhere"') : text; },
    pressKey: async key => { if (model.keys.length >= 8) swapped = true; await model.key(key); },
  } });
  await g.start();
  await assert.rejects(g.call(`return await app.pickFromList(${JSON.stringify(names[390])});`), /window changed|Observed/);
  assert.deepEqual(g.clicks, []);
});

test('app.pickFromList refuses to press a key without the input lease', async () => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-list-lease-')));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    const path = join(dir, 'lease.json');
    writeFileSync(path, JSON.stringify({ token: 'someone else', expires: Date.now() + 30000 }));
    const names = sortedNames(400), model = fakeList(names), keys = [], clicks = [];
    const raw = { getAXState: async () => model.tree(), pressKey: async key => { keys.push(key); await model.key(key); },
      click: async number => { clicks.push(number); } };
    const code = guardedCode(`return await app.pickFromList(${JSON.stringify(names[300])});`, window, undefined, { path, token: 'owner' });
    try {
      await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(raw, { getApp: async () => raw }, { write() {} }), /Input lease stopped/);
    } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; }
    assert.deepEqual(keys, []);
    assert.deepEqual(clicks, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a search that does not click ends the call with its reason; a frameless click is reported, other click errors propagate', async () => {
  const names = sortedNames(100), model = fakeList(names);
  const absent = guarded(model);
  await absent.start();
  await assert.rejects(absent.call(`await app.pickFromList(${JSON.stringify(names[50] + ' x')}); await app.click(1);`), /pickFromList stopped \(not-in-list\): No row clicked\..*reads, \d+ keys/);
  assert.deepEqual(absent.clicks, []);
  const g = guarded(fakeList(names), { raw: { click: async () => { throw new Error('elementHasNoFrame'); } } });
  await g.start();
  await assert.rejects(g.call(`return await app.pickFromList(${JSON.stringify(names[3])});`), /click-failed.*Input may have been sent/);
  const other = guarded(fakeList(names), { raw: { click: async () => { throw new Error('boom'); } } });
  await other.start();
  await assert.rejects(other.call(`return await app.pickFromList(${JSON.stringify(names[3])});`), /boom/);
});

// lp1 (study-form-travel-b7, race-1017): the travel form's virtual list as the b7 reads recorded it. 16 rows render from
// 3 above the first visible row (clamped at the ends), 10 show. Safari: "24 list (settable) Departing from" with rows 25 to
// 40 "text <name>"; Page_Down moves about 2.2 rows a key and the wheel 10 rows a tick (r1 c18, r3 c18 to c21). Firefox:
// "49 list Departing from" with rows 50 to 65 "text (selectable) <name>" plus the name and the code on their own lines;
// Page_Down moves 9 rows a key, the wheel at most 9 rows a call (r2 c16 to c26). A read with a selected row rendered
// prints a "Selected:" block in place of the focus line (Safari r2 c17, Firefox r2 c20). Names are the benchmark's.
const recorded = ['Ashbridge International FTZ', 'Ashbridge Point Municipal HBB', 'Ashbury Municipal FJS', 'Ashbury Point Field KBP',
  'Ashby Harbor Municipal GFJ', 'Ashby Point Airport GTL', 'Ashcliff Field PEC', 'Ashcrest Falls Regional JMF', 'Ashcrest International PYI',
  'Ashcrest Municipal EUD', 'Ashcrest Valley Airport NKF', 'Ashdale Bay International XBZ', 'Ashfield Springs Municipal NAM',
  'Ashgate Springs Airport TEU', 'Ashgate Valley Municipal NFY', 'Ashhaven International IZA', 'Marwick Springs Regional RAO',
  'Marwood Falls Airport NIL', 'Marwood Valley Regional OKF', 'Norbridge Springs Field DKB', 'Norbridge Springs Municipal ENI',
  'Norbury Airport FXU', 'Norbury Bay Municipal YDR', 'Norbury Falls Municipal YQH', 'Norbury International PDZ', 'Norby Point International ILP',
  'Norby Regional MKI', 'Norby Valley Regional BUB', 'Norcliff Heights Municipal XSD', 'Norcliff International JUR', 'Norcliff Point Regional JYX',
  'Norcrest Bay Municipal YLU', 'Norcrest Point International MAO', 'Nordale Bay Airport DIT', 'Nordale Harbor Regional SLF',
  'Nordale Point Municipal GAP', 'Norfield Heights Municipal OQH', 'Norfield Regional ACT', 'Norford Field AYV', 'Norford Point International TLP',
  'Norford Springs International DOL', 'Norgate Valley Regional UBZ', 'Norhaven Falls International GVY', 'Norhaven Falls Municipal XBQ'];
const TARGET = 'Norcrest Point International MAO';
// 1,000 rows with the target at row 612, as in the study (airports.json); filler rows sort between recorded ones.
function airports() {
  const code = i => letters[Math.floor(i / 676) % 26].toUpperCase() + letters[Math.floor(i / 26) % 26].toUpperCase() + letters[i % 26].toUpperCase();
  const fill = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + letters[Math.floor(i / 26) % 26] + letters[i % 26] + ' Field ' + code(i));
  const before = recorded.filter(name => compareNames(name, TARGET) < 0).length;
  const names = [...recorded, ...fill('Kel', 612 - before), ...fill('Vel', 1000 - recorded.length - (612 - before))].sort(compareNames);
  assert.equal(names.indexOf(TARGET), 612);
  return names;
}
const compareNames = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function webList(names, { browser = 'safari', top = 0, focus = 'list', keyRows = browser === 'safari' ? 2.2 : 9 } = {}) {
  const safari = browser === 'safari', list = safari ? 24 : 49, first = list + 1;
  const m = { names, top, focus, selected: undefined, keys: [], ticks: [], reads: 0, misclicks: 0, noFrame: 0, keysElsewhere: 0, rendered: [] };
  const clampTop = value => Math.max(0, Math.min(names.length - 10, value));
  const start = () => Math.max(0, Math.min(names.length - 16, Math.floor(m.top) - 3));
  const visible = i => i >= Math.floor(m.top) && i < Math.floor(m.top) + 10;
  const indent = n => '\t'.repeat(n);
  const rowLine = i => safari ? `text${m.selected === i ? ' (selected)' : ''} ${names[i]}`
    : `text (${m.selected === i ? 'selected' : 'selectable'}) ${names[i]}`;
  const listLine = safari ? 'list (settable) Departing from' : 'list Departing from';
  m.listLine = listLine; m.list = list;
  m.key = async key => {
    m.keys.push(key);
    if (m.focus !== 'list') { m.keysElsewhere++; return; }
    m.top = clampTop(m.top + (key === 'Page_Down' ? keyRows : key === 'Page_Up' ? -keyRows : 0));
  };
  m.wheel = async (number, direction, ticks) => {
    assert.equal(number, list);
    m.ticks.push(ticks);
    const rows = safari ? 10 * ticks : Math.min(9, Math.ceil(ticks / 2));
    m.top = clampTop(m.top + (direction === 'down' ? rows : -rows));
  };
  // A click on a row outside the 10 shown: Safari's engine finds no frame; elsewhere it lands on what is drawn there.
  m.clickNumber = async number => {
    if (number === list) { m.selected = Math.floor(m.top) + 4; m.focus = 'list'; return; }
    const i = m.rendered[number - first];
    assert.ok(i !== undefined, 'a rendered row');
    if (!visible(i)) {
      if (safari) { m.noFrame++; throw new Error('Computer Use server error -10005: elementHasNoFrame'); }
      m.misclicks++; return;
    }
    m.selected = i; m.focus = 'list';
  };
  m.clickLine = async line => {
    const at = m.rendered.findIndex(i => rowLine(i) === line);
    assert.ok(at >= 0, 'the clicked line is in the newest tree: ' + line);
    await m.clickNumber(first + at);
    return names[m.rendered[at]];
  };
  m.tree = async () => {
    m.reads++;
    m.rendered = Array.from({ length: Math.min(16, names.length) }, (_, k) => start() + k);
    const d = safari ? 6 : 6;
    const rows = m.rendered.map((i, k) => indent(d + 1) + (first + k) + ' ' + rowLine(i) +
      (safari ? '' : '\n' + names[i].split(' ').slice(0, -1).join(' ') + '\n' + names[i].split(' ').at(-1)));
    const after = first + 16;
    const lines = safari
      ? ['Window: "sleight benchmark — Book a trip · Skyway", App: Safari.',
        '0 standard window sleight benchmark — Book a trip · Skyway, ID: SafariWindow?IsSecure=false, Secondary Actions: Raise',
        '\t1 split group', '\t\t3 tab group', '\t\t\t4 scroll area', '\t\t\t\t5 HTML content Description: Book a trip · Skyway, URL: 127.0.0.1:5413/travel',
        '\t\t\t\t\t8 container', indent(d) + '20 text City', indent(d) + '21 pop up button (collapsed) City, Value: Sapporo, Secondary Actions: Expand',
        indent(d) + '23 text Departing from', indent(d) + list + ' ' + listLine, ...rows,
        indent(d) + after + ' text ' + (m.selected === undefined ? '1,000 airports, sorted by name. No airport selected.' : 'Selected: ' + names[m.selected]),
        indent(d) + (after + 1) + ' button Back', indent(d) + (after + 2) + ' button Next', '69 menu bar', '\t70 Safari']
      : ['Window: "Book a trip · Skyway", App: Firefox.', '0 standard window Book a trip · Skyway, Secondary Actions: Raise',
        '\t1 container Book a trip · Skyway', '\t\t25 scroll area', '\t\t\t26 HTML Content Description: Book a trip · Skyway, URL: 127.0.0.1:5413/travel',
        '\t\t\t\t33 container', '\t\t\t\t\t41 container', indent(d) + '47 pop up button Sapporo', indent(d) + '48 text Departing from',
        indent(d) + list + ' ' + listLine, ...rows,
        indent(d) + after + ' text ' + (m.selected === undefined ? '1,000 airports, sorted by name. No airport selected.' : 'Selected: ' + names[m.selected]),
        indent(d) + (after + 1) + ' button Back', indent(d) + (after + 2) + ' button Next', '72 menu bar', '\t73 Firefox'];
    const shown = m.selected !== undefined && m.rendered.includes(m.selected);
    lines.push('', shown ? 'Selected:\n\t' + (first + m.rendered.indexOf(m.selected)) + ' ' + rowLine(m.selected) +
      '\n\nNote: Pay special attention to the content selected by the user.'
      : m.focus === 'list' ? 'The focused UI element is ' + list + ' ' + listLine
      : safari ? 'The focused UI element is 21 pop up button (collapsed) City, Value: Sapporo, Secondary Actions: Expand' : 'The focused UI element is 47 pop up button Sapporo');
    return lines.join('\n');
  };
  return m;
}
const travelWindow = browser => browser === 'safari' ? { title: 'sleight benchmark — Book a trip · Skyway', app: 'Safari', url: null }
  : { title: 'Book a trip · Skyway', app: 'Firefox', url: null };
function webPicker(m, browser, extra = {}) {
  const clicks = [];
  const run = listPicker({ read: m.tree, observe() {}, press: m.key, scroll: (line, direction, ticks) => {
    assert.equal(line, m.listLine); return m.wheel(m.list, direction, ticks);
  }, parse: windowFromText, sameElement, expected: travelWindow(browser), sleep: async () => {},
  click: async line => { clicks.push(await m.clickLine(line)); }, ...extra });
  return { run, clicks };
}

test('lp1: the Selected: read after the skill\'s click names the list, when that click was the last action', async () => {
  for (const browser of ['safari', 'firefox']) {
    const names = airports();
    const m = webList(names, { browser, focus: 'city' });
    // Safari r2 c16: click(24) on the list selected its fifth row; Firefox r2 c19: click(57) on a row.
    const number = browser === 'safari' ? m.list : m.list + 8;
    await m.tree();
    const line = browser === 'safari' ? m.listLine : 'text (selectable) ' + names[7];
    await m.clickNumber(number);
    assert.match(await m.tree(), /\nSelected:\n\t\d+ text \(selected\) /);
    assert.doesNotMatch(await m.tree(), /The focused UI element/);
    const { run, clicks } = webPicker(m, browser, { clicked: { number, line } });
    const result = await run(names[11]);
    assert.equal(result.clicked, true, browser + ' ' + JSON.stringify(result));
    assert.deepEqual(clicks, [names[11]]);
    // Without that click, or after a click on another control, the selection says nothing about where keys go.
    for (const clicked of [undefined, { number: 21, line: 'pop up button (collapsed) City, Value: Sapporo, Secondary Actions: Expand' }]) {
      const other = webList(names, { browser, focus: 'city' });
      await other.tree(); await other.clickNumber(number); other.focus = 'city';
      const stopped = await webPicker(other, browser, { clicked }).run(names[300]);
      assert.equal(stopped.reason, 'not-a-list');
      assert.match(stopped.note, /selected row .* no focused element/);
      assert.deepEqual(other.keys, []);
    }
  }
});

test('lp1: the recorded Safari and Firefox reads after a list click are accepted as they are', async () => {
  // Safari r1 c15 and Firefox r2 c20, cut to the form's rows.
  const safari = ['Window: "sleight benchmark — Book a trip · Skyway", App: Safari.',
    '0 standard window sleight benchmark — Book a trip · Skyway, ID: SafariWindow?IsSecure=false, Secondary Actions: Raise',
    '\t\t\t\t5 HTML content Description: Book a trip · Skyway, URL: 127.0.0.1:5413/travel', '\t\t\t\t\t8 container',
    '\t\t\t\t\t\t21 pop up button (collapsed) City, Value: Sapporo, Secondary Actions: Expand', '\t\t\t\t\t\t23 text Departing from',
    '\t\t\t\t\t\t24 list (settable) Departing from',
    ...recorded.slice(0, 16).map((name, i) => `\t\t\t\t\t\t\t${25 + i} text ${i === 4 ? '(selected) ' : ''}${name}`),
    '\t\t\t\t\t\t41 text Selected: Ashby Harbor Municipal (GFJ)', '\t\t\t\t\t\t42 button Back', '\t\t\t\t\t\t43 button Next',
    '69 menu bar', '\t70 Safari', '', 'Selected:', '\t29 text (selected) Ashby Harbor Municipal GFJ', '',
    'Note: Pay special attention to the content selected by the user.'].join('\n');
  const ffNames = ['Ashwood Airport FWY', 'Belbridge Bay Municipal ECU', 'Belbridge Springs International SVL', 'Belbury Heights Regional GIU',
    'Belbury Point Municipal AVV', 'Belbury Valley Municipal JIC', 'Belby International RBD', 'Belcliff Field ABT', 'Belcrest International PWE'];
  const firefox = ['Window: "Book a trip · Skyway", App: Firefox.', '0 standard window Book a trip · Skyway, Secondary Actions: Raise',
    '\t\t\t26 HTML Content Description: Book a trip · Skyway, URL: 127.0.0.1:5413/travel', '\t\t\t\t\t\t47 pop up button Sapporo',
    '\t\t\t\t\t\t48 text Departing from', '\t\t\t\t\t\t49 list Departing from',
    ...ffNames.map((name, i) => `\t\t\t\t\t\t\t${50 + i} text (${i === 7 ? 'selected' : 'selectable'}) ${name}\n${name.split(' ').slice(0, -1).join(' ')}\n${name.split(' ').at(-1)}`),
    '\t\t\t\t\t\t66 text Selected: Belcliff Field (ABT)', '72 menu bar', '\t73 Firefox', '', 'Selected:', '\t57 text (selected) Belcliff Field ABT', '',
    'Note: Pay special attention to the content selected by the user.'].join('\n');
  for (const [text, browser, clicked, want] of [
    [safari, 'safari', { number: 24, line: 'list (settable) Departing from' }, 'Ashcrest Municipal EUD'],
    [firefox, 'firefox', { number: 57, line: 'text (selectable) Belcliff Field ABT' }, 'Belbury Valley Municipal JIC']]) {
    const clicks = [];
    // After the click the row reads as selected, as the recorded reads after a row click show.
    const result = await listPicker({ read: async () => clicks.length
      ? text.replace('text (selectable) ' + want, 'text (selected) ' + want).replace('text ' + want, 'text (selected) ' + want) : text,
    observe() {}, press: async () => { throw new Error('no key needed'); },
      scroll: async () => { throw new Error('no wheel needed'); },
      parse: windowFromText, sameElement, expected: travelWindow(browser), sleep: async () => {}, clicked,
      click: async line => { clicks.push(line); } })(want);
    assert.equal(result.clicked, true, browser + ' ' + JSON.stringify(result));
    assert.equal(clicks.length, 1);
    assert.ok(clicks[0].endsWith(want));
  }
});

test('lp1: a target named on two lines matches the row whose name and code they are', async () => {
  const names = airports(), m = webList(names, { browser: 'firefox' });
  const { run, clicks } = webPicker(m, 'firefox');
  const result = await run('Norcrest Point International\nMAO');
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.deepEqual(clicks, [TARGET]);
});

// Seconds per unit from the study: Safari's helper paid 20.8 s for 23 reads and 88 keys (r1 c18), so about 0.2 s a read
// and 0.18 s a key; Firefox sent 40 keys and a read in 0.8 s (r2 c26), so 0.02 s a key. A wheel step with its read cost
// 0.27 s in an older Safari loop (older r2 c26) and up to 1.0 s a call in b7. The old picker had no wheel.
const cost = { safari: { read: 0.2, key: 0.18 }, firefox: { read: 0.2, key: 0.02 } };
const seconds = (browser, r, wheel = 0.27) => (r.reads - (r.ticks ? r.wheelSteps : 0)) * cost[browser].read + r.keys * cost[browser].key + (r.wheelSteps ?? 0) * wheel;

test('lp1: the mover is chosen by measured rows: Safari stays on the wheel, Firefox takes keys once focus shows; row 612 of 1,000', async t => {
  const out = {};
  for (const browser of ['safari', 'firefox']) {
    const names = airports(), m = webList(names, { browser, focus: 'city' });
    await m.tree(); await m.clickNumber(m.list);
    const { run, clicks } = webPicker(m, browser, { clicked: { number: m.list, line: m.listLine } });
    const result = await run(TARGET);
    assert.equal(result.clicked, true, browser + ' ' + JSON.stringify(result));
    assert.deepEqual(clicks, [TARGET]);
    assert.equal(m.misclicks + m.noFrame, 0);
    const r = { ...result, wheelSteps: m.ticks.length };
    out[browser] = { reads: r.reads, keys: r.keys, ticks: r.ticks ?? 0, wheelSteps: r.wheelSteps,
      seconds: +seconds(browser, r).toFixed(1), secondsAtB7Wheel: +seconds(browser, r, 1.0).toFixed(1) };
  }
  t.diagnostic('row 612: ' + JSON.stringify(out));
  // After the click only a selected row names the list, so both start on the wheel (lp1 review). Safari's wheel moves 10
  // rows a tick and keeps going; Firefox's half a row, so keys take over once a read shows the focus on the list.
  // Safari's keys are the last centering moves, 2.2 rows each, after a read shows the focus.
  assert.ok(out.safari.keys <= 4 && out.safari.ticks >= 55 && out.safari.wheelSteps <= 16, JSON.stringify(out.safari));
  assert.ok(out.safari.secondsAtB7Wheel < 20, 'inside the 20 s cap even at 1 s a wheel step');
  // One more wheel tick is a centering move where no key count lands the row in the band (CC3).
  assert.ok(out.firefox.wheelSteps <= 5 && out.firefox.keys >= 60, JSON.stringify(out.firefox));
  // CC3's jumps: 28 Firefox reads and 16 Safari reads before them, on this list (612 rows share "Kel"). Firefox's jumps go
  // out 16 keys between reads.
  assert.ok(out.firefox.reads <= 24 && out.safari.reads <= 14, JSON.stringify(out));
  // The old picker paged Safari by key only: 612 rows at 2.2 rows a key.
  const old = { keys: Math.ceil(612 / 2.2), reads: Math.ceil(612 / 2.2 / 4) + 2 };
  t.diagnostic('old Safari keys-only estimate: ' + JSON.stringify({ ...old, seconds: +(old.keys * 0.18 + old.reads * 0.2).toFixed(1) }));
});

test('lp1: rows per mover, measured on the recorded geometry', async t => {
  const rows = {};
  for (const browser of ['safari', 'firefox']) {
    const names = airports();
    const keyed = webList(names, { browser });
    const before = await keyed.tree();
    for (let i = 0; i < 4; i++) await keyed.key('Page_Down');
    const wheeled = webList(names, { browser });
    await wheeled.wheel(wheeled.list, 'down', 1);
    rows[browser] = { perKey: keyed.top / 4, perTick: wheeled.top };
    assert.ok(before.includes(keyed.listLine));
  }
  t.diagnostic('rows moved: ' + JSON.stringify(rows));
  assert.ok(rows.safari.perKey < 5 && rows.firefox.perKey >= 5);
});

test('lp1: every row of a 200-row list is clicked inside the visible band, from the top, the middle and the end', async t => {
  const names = airports().slice(0, 200);
  for (const browser of ['safari', 'firefox']) {
    let retries = 0;
    const frameless = [];
    for (const top of [0, 95, 190]) {
      for (let i = 0; i < names.length; i++) {
        const m = webList(names, { browser, top });
        const { run, clicks } = webPicker(m, browser);
        const result = await run(names[i]);
        assert.equal(result.clicked, true, `${browser} row ${i} from ${top}: ${JSON.stringify(result)}`);
        assert.deepEqual(clicks, [names[i]]);
        // Firefox would click what is drawn over a hidden row; that never happens.
        assert.equal(m.misclicks, 0, `${browser} row ${i} from ${top}`);
        retries += m.noFrame;
        if (m.noFrame) frameless.push(`${i} from ${top}`);
      }
    }
    t.diagnostic(browser + ' frameless first clicks (each read again and clicked): ' + JSON.stringify(frameless));
    // Safari refuses a hidden row's click and the helper recovers (3 of 600 searches, rows next to the list's end where
    // the overscan is held); a Firefox click there would land on another control, so it never happens.
    assert.ok(retries <= (browser === 'safari' ? 12 : 0), browser + ' frameless clicks ' + retries);
  }
});

test('lp1: a frameless row is read again, nudged inward and clicked once more; a second failure stops', async () => {
  const names = airports().slice(0, 100);
  const m = webList(names);
  let failures = 1;
  const clicks = [];
  const run = listPicker({ read: m.tree, observe() {}, press: m.key, parse: windowFromText, sameElement, expected: travelWindow('safari'),
    sleep: async () => {}, click: async line => {
      if (failures-- > 0) throw new Error('Computer Use server error -10005: elementHasNoFrame');
      clicks.push(await m.clickLine(line));
    } });
  const result = await run(names[7]);
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.deepEqual(clicks, [names[7]]);
  failures = 5;
  const fresh = webList(names);
  const again = await listPicker({ read: fresh.tree, observe() {}, parse: windowFromText, sameElement, expected: travelWindow('safari'),
    press: fresh.key, sleep: async () => {}, click: async () => { failures--; throw new Error('Computer Use server error -10005: elementHasNoFrame'); } })(names[7]);
  assert.equal(again.reason, 'click-failed');
  assert.equal(failures, 3, 'two attempts');
});

test('lp1: keys that move nothing hand over to the wheel; a wheel that moves nothing stops', async () => {
  const names = airports();
  const m = webList(names, { browser: 'safari' });
  const { run, clicks } = webPicker(m, 'safari', { press: async key => { m.keys.push(key); } });
  const result = await run(names[400]);
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.deepEqual(clicks, [names[400]]);
  assert.equal(m.keys.length, 5, "a measuring key and a coarse step before the wheel");
  const stuck = webList(names, { browser: 'safari' });
  const none = await webPicker(stuck, 'safari', { press: async () => {}, scroll: async () => {} }).run(names[400]);
  assert.equal(none.reason, 'no-progress');
  assert.match(none.note, /scroll wheel/);
});

test('lp1: app.pickFromList after app.click on the list, through the guard: keys, wheel and click by the list\'s number', async () => {
  const names = airports(), m = webList(names, { browser: 'safari', focus: 'city' });
  const clicks = [], scrolls = [];
  const handle = { getAXState: async () => m.tree(), pressKey: async key => m.key(key),
    scroll: async (number, direction, ticks) => { scrolls.push([number, direction, ticks]); await m.wheel(number, direction, ticks); },
    click: async number => { clicks.push(number); await m.clickNumber(number); } };
  const context = { cua: { getApp: async () => handle }, setTimeout, nodeRepl: { write() {} } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await run(readCode('await cua.getApp("Safari");'));
  const result = await run(guardedCode(`await app.click(24); return await app.pickFromList(${JSON.stringify(TARGET)});`, travelWindow('safari')));
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.equal(clicks[0], 24);
  assert.equal(names[m.selected], TARGET);
  assert.ok(scrolls.length > 3 && scrolls.every(([number]) => number === 24));
  assert.ok(m.keys.length <= 8);
  // A key, a read or another action between the click and the helper leaves the selection unproven.
  const other = webList(names, { browser: 'safari', focus: 'city' });
  const handle2 = { ...handle, getAXState: async () => other.tree(), click: async number => other.clickNumber(number), pressKey: async key => other.key(key) };
  const context2 = { cua: { getApp: async () => handle2 }, setTimeout, nodeRepl: { write() {} } };
  const run2 = code => runInNewContext(`(async () => { ${code} })()`, context2);
  await run2(readCode('await cua.getApp("Safari");'));
  other.focus = 'city';
  await assert.rejects(run2(guardedCode(`await app.click(24); await app.pressKey("Tab"); return await app.pickFromList(${JSON.stringify(TARGET)});`, travelWindow('safari'))),
    /not-a-list/);
});

// lp1 review finding 2: with only a "Selected:" row naming the list, nothing shows where keys go, so the search uses the
// wheel on the list until a read shows the focus on it. A page script that moves focus mid-search gets no key.
test('lp1 review: no key while only a selection names the list; focus moved elsewhere stops the search with no key sent', async () => {
  for (const browser of ['safari', 'firefox']) {
    const names = airports(), m = webList(names, { browser });
    let blind = 0;
    const tree = m.tree;
    m.tree = async () => { const text = await tree(); m.blind = !/^The focused UI element is /m.test(text); return text; };
    const key = m.key;
    m.key = async k => { if (m.blind) blind++; await key(k); };
    await m.tree(); await m.clickNumber(m.list);
    const { run, clicks } = webPicker(m, browser, { clicked: { number: m.list, line: m.listLine } });
    const result = await run(TARGET);
    assert.equal(result.clicked, true, browser + ' ' + JSON.stringify(result));
    assert.deepEqual(clicks, [TARGET]);
    assert.equal(blind, 0, browser + ': keys sent after a read with no focus line');
    // Focus moves to the City pop up button after the click: the search reaches a read that shows it and stops.
    const moved = webList(names, { browser });
    await moved.tree(); await moved.clickNumber(moved.list); moved.focus = 'city';
    const stopped = await webPicker(moved, browser, { clicked: { number: moved.list, line: moved.listLine } }).run(TARGET);
    assert.equal(stopped.reason, 'focus-lost', browser + ' ' + JSON.stringify(stopped));
    assert.equal(moved.keysElsewhere, 0);
  }
});

// lp1 review finding 3: the read after the pick's click must show the row selected. A click that reached something else
// (a Firefox row drawn under the form's buttons) reports clicked: false with the reason, never a pick.
test('lp1 review: a click the next read does not show as selected is reported unverified, through the guard too', async () => {
  const names = airports().slice(0, 200), m = webList(names, { browser: 'firefox' });
  const { run } = webPicker(m, 'firefox', { click: async () => { m.misclicks++; } });
  const result = await run(names[40]);
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'click-unverified');
  assert.match(result.note, /another control/);
  const g = guarded(fakeList(sortedNames(100)), { raw: { click: async () => {} } });
  await g.start();
  await assert.rejects(g.call(`return await app.pickFromList(${JSON.stringify(sortedNames(100)[40])});`), /pickFromList stopped \(click-unverified\)/);
});

// CC2 (codex-vs-cc-1019): app.pickFromList(<list>, "<row>") makes the focusing click itself. Haiku's own first move in
// Firefox travel was a pick with no click (focus on the City pop up button: refused), or a click on an overscan row
// (-10005 elementHasNoFrame) in 3 of 6 runs. Held-out shape: the webList geometry with focus left on the City control.
function namedPicker(m, browser, extra = {}) {
  const clicks = [];
  const run = listPicker({ read: m.tree, observe() {}, press: m.key, scroll: (line, direction, ticks) => {
    assert.equal(line, m.listLine); return m.wheel(m.list, direction, ticks);
  }, parse: windowFromText, sameElement, expected: travelWindow(browser), sleep: async () => {},
  click: async line => {
    if (line === m.listLine) { clicks.push('list'); return m.clickNumber(m.list); }
    clicks.push(await m.clickLine(line));
  }, ...extra });
  return { run, clicks };
}

test('CC2: with the list named first, focus elsewhere costs no stop and no frameless click, from the top, middle and end', async t => {
  const out = {};
  for (const browser of ['safari', 'firefox']) {
    const names = airports();
    const runs = [];
    for (const [top, target, ref] of [[0, TARGET, 'number'], [0, names[5], 'label'], [300, names[40], 'number'], [300, names[900], 'object'],
      [990, names[200], 'number'], [990, names[997], 'label']]) {
      const m = webList(names, { browser, focus: 'city', top });
      const list = ref === 'number' ? m.list : ref === 'label' ? 'Departing from' : { label: 'Departing from' };
      const { run, clicks } = namedPicker(m, browser);
      const result = await run(list, target);
      assert.equal(result.clicked, true, `${browser} ${top} ${target}: ${JSON.stringify(result)}`);
      assert.equal(clicks.at(-1), target);
      assert.equal(m.noFrame + m.misclicks, 0, `${browser} ${top}: frameless or misplaced clicks`);
      assert.equal(names[m.selected], target);
      runs.push(result.reads);
    }
    out[browser] = runs;
  }
  t.diagnostic('reads per run, focus on City first: ' + JSON.stringify(out));
});

test('CC2: the focusing click goes to a row in the band shown at every scroll position, and skips a list that has focus', async () => {
  for (const browser of ['safari', 'firefox']) {
    const names = airports();
    const m = webList(names, { browser, focus: 'city', top: 500 });
    const { run, clicks } = namedPicker(m, browser);
    await run(m.list, names[505]);
    // 16 rendered from 3 above the first shown: the eighth rendered row is shown at the top, middle and end alike.
    assert.equal(clicks[0], names[497 + 7]);
    const focused = webList(names, { browser, focus: 'list', top: 500 });
    const second = namedPicker(focused, browser);
    await second.run(focused.list, names[505]);
    assert.deepEqual(second.clicks, [names[505]], 'no focusing click when the read shows focus on that list');
  }
});

test('CC2: a frameless first row is retried once on the list itself; both frameless stops with no key sent', async () => {
  const names = airports(), m = webList(names, { browser: 'safari', focus: 'city' });
  let failures = 1;
  const { run, clicks } = namedPicker(m, 'safari', { click: async line => {
    if (failures-- > 0) throw new Error('Computer Use server error -10005: elementHasNoFrame');
    if (line === m.listLine) { clicks.push('list'); return m.clickNumber(m.list); }
    clicks.push(await m.clickLine(line));
  } });
  const result = await run(m.list, names[60]);
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.deepEqual(clicks, ['list', names[60]]);
  const none = webList(names, { browser: 'safari', focus: 'city' });
  const stuck = await namedPicker(none, 'safari', { click: async () => { throw new Error('Computer Use server error -10005: elementHasNoFrame'); } }).run(none.list, names[60]);
  assert.equal(stuck.reason, 'not-a-list');
  assert.match(stuck.note, /had a frame to click/);
  assert.deepEqual(none.keys, []);
  // Any other click error propagates, as for the row click.
  await assert.rejects(namedPicker(webList(names, { browser: 'safari', focus: 'city' }), 'safari', { click: async () => { throw new Error('boom'); } })
    .run(24, names[60]), /boom/);
});

test('CC2: without a list argument, focus on a pop up button stops as before and names the list form', async () => {
  for (const browser of ['safari', 'firefox']) {
    const m = webList(airports(), { browser, focus: 'city' });
    const { run, clicks } = namedPicker(m, browser);
    const result = await run(TARGET);
    assert.equal(result.reason, 'not-a-list');
    assert.match(result.note, /^No row clicked\. Focus is on "pop up button/);
    assert.match(result.note, /Name the list first: `app\.pickFromList\(<list number>, "<whole row text>"\)`/);
    assert.deepEqual(clicks, []);
    assert.deepEqual(m.keys, []);
  }
});

test('CC2: a list argument that names no list, two lists, or a line Claude saw elsewhere clicks nothing', async () => {
  const names = airports();
  const cases = [[47, /Element 47 is not a list or one of its rows/], [999, /Element 999 is not in the window/],
    ['Arriving at', /No list matches "Arriving at"/], [{ id: 'nope' }, /No list matches/]];
  for (const [ref, message] of cases) {
    const m = webList(names, { browser: 'firefox', focus: 'city' });
    const { run, clicks } = namedPicker(m, 'firefox');
    const result = await run(ref, TARGET);
    assert.equal(result.reason, 'not-a-list', JSON.stringify(ref));
    assert.match(result.note, message);
    assert.deepEqual(clicks, []);
    assert.deepEqual(m.keys, []);
  }
  // The number names the list in the fresh read, but Claude saw another element there: stopped, as the guard stops a click.
  const m = webList(names, { browser: 'firefox', focus: 'city' });
  const { run, clicks } = namedPicker(m, 'firefox', { lineSeen: n => n === 49 ? 'list Arriving at' : undefined });
  const stale = await run(49, TARGET);
  assert.equal(stale.reason, 'not-a-list');
  assert.match(stale.note, /Element 49 changed since you read the window/);
  assert.deepEqual(clicks, []);
  // A row's number names its list.
  const row = webList(names, { browser: 'firefox', focus: 'city' });
  const byRow = namedPicker(row, 'firefox');
  assert.equal((await byRow.run(row.list + 8, names[30])).clicked, true);
  for (const bad of [-1, 1.5, '', {}, { label: '' }, null]) {
    await assert.rejects(namedPicker(webList(names, { browser: 'firefox' }), 'firefox').run(bad, TARGET), /takes the list as/, JSON.stringify(bad));
  }
});

test('CC2: a two-line label with the list named picks the row whose name and code they are', async () => {
  const names = airports(), m = webList(names, { browser: 'firefox', focus: 'city' });
  const { run, clicks } = namedPicker(m, 'firefox');
  const result = await run(m.list, 'Norcrest Point International\nMAO');
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.equal(clicks.at(-1), TARGET);
});

test('CC2: app.pickFromList(24, row) through the guard clicks a row of list 24 itself, then the row', async () => {
  for (const browser of ['safari', 'firefox']) {
    const names = airports(), m = webList(names, { browser, focus: 'city' });
    const clicks = [];
    const handle = { getAXState: async () => m.tree(), pressKey: async key => m.key(key),
      scroll: async (number, direction, ticks) => m.wheel(number, direction, ticks),
      click: async number => { clicks.push(number); await m.clickNumber(number); } };
    const context = { cua: { getApp: async () => handle }, setTimeout, nodeRepl: { write() {} } };
    const run = code => runInNewContext(`(async () => { ${code} })()`, context);
    await run(readCode(`await cua.getApp(${JSON.stringify(browser === 'safari' ? 'Safari' : 'Firefox')});`));
    const result = await run(guardedCode(`return await app.pickFromList(${m.list}, ${JSON.stringify(TARGET)});`, travelWindow(browser)));
    assert.equal(result.clicked, true, browser + ' ' + JSON.stringify(result));
    assert.ok(clicks[0] > m.list && clicks[0] <= m.list + 16, 'the first click is a row of the list');
    assert.equal(names[m.selected], TARGET);
    assert.equal(m.noFrame + m.misclicks, 0);
  }
});

// CC3 (codex-vs-cc-1019): fewer reads per pick. After one measuring key the search jumps to where the labels on either
// side put the row (interpolated, or extrapolated from one side) instead of paging four at a time with a read after each.
// The offline model is astra-1018-forms' simulate.py setup (10 shown rows, a fixed 8, 9 or 10-row page, the list at its top,
// focus on it, keys only), driving this helper. Reads to see the row count as that model does: the read whose rows first
// include it. The helper then confirms it in a second read and verifies the click in a third.
// A held-out generated list: syllable prefixes, endings, an optional feature word, a kind and a code.
function places(n = 1000, seed = 7) {
  let x = seed;
  const rand = k => { x = (x * 1103515245 + 12345) % 2147483648; return x % k; };
  const pre = ['Ab', 'Bran', 'Cor', 'Dew', 'Elm', 'Fair', 'Glen', 'Hay', 'Ing', 'Jas', 'Kirk', 'Lang', 'Mill', 'New', 'Old', 'Pen', 'Quar',
    'Red', 'Stan', 'Thorn', 'Up', 'Ven', 'Whit', 'Yar', 'Zen'];
  const mid = ['bridge', 'brook', 'by', 'combe', 'den', 'field', 'ford', 'gate', 'ham', 'hurst', 'ley', 'mere', 'mouth', 'ridge', 'stead',
    'thorpe', 'ton', 'well', 'wick', 'worth'];
  const feat = ['', '', 'Bay ', 'Cross ', 'Green ', 'Hill ', 'Marsh ', 'Vale '], kind = ['Airfield', 'Airport', 'Field', 'International', 'Regional'];
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', out = new Set();
  while (out.size < n) out.add(pre[rand(pre.length)] + mid[rand(mid.length)] + ' ' + feat[rand(feat.length)] + kind[rand(kind.length)] + ' ' + L[rand(26)] + L[rand(26)] + L[rand(26)]);
  return [...out].sort(compareNames);
}
async function census(names, { page, overscan, every = 1 }) {
  const out = { found: 0, targets: 0, seeMax: 0, seeSum: 0, readMax: 0, readSum: 0, overTen: 0, keyMax: 0 };
  for (let i = 0; i < names.length; i += every) {
    let seen;
    const model = fakeList(names, { page, overscan, hook: { read: m => { if (seen === undefined && i >= m.position && i < m.position + 10) seen = m.reads; } } });
    const { run, clicks } = picker(model);
    const result = await run(names[i]);
    out.targets++;
    if (result.clicked && labelOfClick(model, clicks.at(-1)) === names[i]) out.found++;
    seen ??= result.reads;
    out.seeMax = Math.max(out.seeMax, seen); out.seeSum += seen; out.overTen += seen > 10;
    out.readMax = Math.max(out.readMax, result.reads); out.readSum += result.reads; out.keyMax = Math.max(out.keyMax, result.keys);
  }
  return { ...out, seeMean: +(out.seeSum / out.targets).toFixed(2), readMean: +(out.readSum / out.targets).toFixed(2) };
}

test('CC3: the offline model finds every row of a held-out 1,000-row list with jumps, in about half the reads', async t => {
  const names = places();
  for (const [page, overscan, every] of [[9, 0, 1], [8, 0, 4], [10, 2, 4]]) {
    const r = await census(names, { page, overscan, every });
    t.diagnostic(`places page ${page} overscan ${overscan}: ${JSON.stringify(r)}`);
    assert.equal(r.found, r.targets, `page ${page} overscan ${overscan}`);
    // Paging four at a time took 18 to 20 reads for row 612 (simulate.py); here the mean is 8 to 9, with 16 keys a read.
    assert.ok(r.seeMean <= 9 && r.seeMax <= 18 && r.readMax <= 20, JSON.stringify(r));
    assert.ok(r.keyMax <= 400);
  }
});

test('CC3: evenly spread labels and numbers take at most 14 reads to see any of 1,000 rows, 16 keys a read', async t => {
  const numbers = Array.from({ length: 1000 }, (_, i) => 'Item ' + (i * 3 + 1)).sort(compareNames);
  for (const [label, names] of [['codes', sortedNames(1000)], ['numbers', numbers]]) {
    const r = await census(names, { page: 9, overscan: 0, every: 2 });
    t.diagnostic(`${label}: ${JSON.stringify(r)}`);
    assert.equal(r.found, r.targets);
    // 900 rows at 9 rows a key need six 16-key reads, whatever the estimate says.
    assert.ok(r.seeMax <= 14 && r.seeMean <= 7.5, JSON.stringify(r));
  }
});

// The study's own list, when this Mac has the benchmark fixture (it isn't in the repo).
const fixture = `${process.env.HOME}/Library/Caches/sleight-bench/fowlbrowser/test/forms/site/airports.json`;
test('CC3: the travel fixture\'s 1,000 airports, as simulate.py ran them', { skip: !existsSync(fixture) && 'benchmark fixture not on this Mac' }, async t => {
  const names = JSON.parse(readFileSync(fixture, 'utf8')).map(row => row.name + ' ' + row.code).sort(compareNames);
  const r = await census(names, { page: 9, overscan: 0 });
  t.diagnostic(`airports page 9 overscan 0: ${JSON.stringify(r)}`);
  assert.equal(r.found, 1000);
  assert.ok(r.seeMean <= 8.5 && r.seeMax <= 16, JSON.stringify(r));
});

test('CC3: an end the jump ran into, a top-clamped first measure and a redraw still end on the right row', async () => {
  // A jump past the list's end counts rows it never moved; the rows a later read shares with an earlier one fix the count.
  const names = places(1000, 11);
  for (const target of [names[880], names[995], names[3]]) {
    const model = fakeList(names, { page: 9, overscan: 2 });
    const { run, clicks } = picker(model);
    const result = await run(target);
    assert.equal(result.clicked, true, JSON.stringify(result));
    assert.equal(labelOfClick(model, clicks[0]), target);
  }
  // Safari and Firefox geometry, focus left elsewhere, every 50th row from the top, the middle and the end.
  // A selection-only read after keys stops the search; every other search picks inside the visible band.
  for (const browser of ['safari', 'firefox']) {
    for (const top of [0, 500, 990]) {
      for (let i = 0; i < 1000; i += 50) {
        const m = webList(airports(), { browser, focus: 'city', top });
        let lostFocus;
        const tree = m.tree;
        m.tree = async () => {
          const text = await tree();
          if (!lostFocus && m.keys.length && m.selected !== i && !/The focused UI element is /.test(text)) {
            lostFocus = { keys: m.keys.length, wheels: m.ticks.length, selected: m.selected };
          }
          return text;
        };
        const { run } = namedPicker(m, browser);
        const result = await run(m.list, m.names[i]);
        if (lostFocus) {
          assert.equal(result.reason, 'focus-lost', `${browser} ${top} ${i}: ${JSON.stringify(result)}`);
          assert.match(result.note, /Keys may have reached another control/);
          assert.deepEqual({ keys: m.keys.length, wheels: m.ticks.length, selected: m.selected }, lostFocus,
            'no input after the read loses focus');
          assert.equal(result.clicked, false);
        } else {
          assert.equal(result.clicked, true, `${browser} ${top} ${i}: ${JSON.stringify(result)}`);
        }
        assert.equal(m.misclicks + m.noFrame, 0, `${browser} ${top} ${i}`);
      }
    }
  }
});

// CC13 review fixes.
// A named list gets the focusing click only when it shows three or more plain rows in ascending order.
function plainList(rows, { role = 'text (selectable)', focus = 'list' } = {}) {
  const clicks = [], keys = [];
  const tree = async () => ['Window: "Book a trip", App: Firefox.', '0 standard window Book a trip', '\t1 list Choices',
    ...rows.map((row, i) => `\t\t${2 + i} ${role} ${row}`), '\t30 button Next', '',
    focus === 'list' ? 'The focused UI element is 1 list Choices' : 'The focused UI element is 30 button Next'].join('\n');
  const run = listPicker({ read: tree, observe() {}, press: async key => keys.push(key), parse: windowFromText, sameElement, expected: window,
    sleep: async () => {}, click: async line => clicks.push(line) });
  return { run, clicks, keys };
}

test('CC13 review: no focusing click on an unsorted, short or actionable list; success reports the focusing click', async () => {
  for (const [rows, role, message] of [[['Bravo', 'Alpha', 'Charlie', 'Delta'], undefined, /ascending order, so it was not clicked/],
    [['Alpha', 'Bravo'], undefined, /three or more labeled rows/], [['Alpha', 'Bravo', 'Charlie', 'Delta'], 'button', /holds button rows, which act when clicked/],
    [['Alpha', 'Bravo', 'Charlie', 'Delta'], 'tab', /holds tab rows/], [['Alpha', 'Bravo', 'Charlie', 'Delta'], 'pop up button', /holds pop up button rows/]]) {
    const p = plainList(rows, { role, focus: 'button' });
    const result = await p.run(1, 'Charlie');
    assert.equal(result.reason, 'not-a-list', JSON.stringify(rows) + role);
    assert.match(result.note, message);
    assert.match(result.note, /^No row clicked\..*No key was sent\.$/);
    assert.deepEqual(p.clicks, []); assert.deepEqual(p.keys, []);
  }
  const names = airports(), m = webList(names, { browser: 'firefox', focus: 'city' });
  const result = await namedPicker(m, 'firefox').run(m.list, names[40]);
  assert.equal(result.clicked, true);
  assert.match(result.focusClick, /^text \(selectable\) /);
  const already = webList(names, { browser: 'firefox' });
  assert.equal((await namedPicker(already, 'firefox').run(already.list, names[5])).focusClick, undefined, 'no focusing click, none reported');
});

test('CC13 review: a focusing click that leaves focus on another list stops before any key', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => 'Dest ' + letters[i]);
  let selected;
  const tree = async () => ['Window: "Book a trip", App: Firefox.', '0 standard window Book a trip', '\t1 list box From',
    ...rows.map((row, i) => `\t\t${2 + i} text (${selected === row ? 'selected' : 'selectable'}) ${row}`), '\t20 list box To',
    ...rows.map((row, i) => `\t\t${21 + i} text (selectable) ${row}`), '', 'The focused UI element is 20 list box To'].join('\n');
  const keys = [], clicks = [];
  const result = await listPicker({ read: tree, observe() {}, press: async key => keys.push(key), parse: windowFromText, sameElement, expected: window,
    sleep: async () => {}, click: async line => { clicks.push(line); selected = /\(selectable\) (.*)$/.exec(line)?.[1]; } })(1, rows[9]);
  assert.equal(result.reason, 'focus-lost');
  assert.match(result.note, /The click did not focus the named list\. No key was sent\./);
  assert.equal(clicks.length, 1);
  assert.deepEqual(keys, []);
});

test('CC13 review: a stale list number stops through the guard when the relay passed the line Claude saw', async () => {
  const names = airports(), m = webList(names, { browser: 'safari', focus: 'city' });
  const clicks = [];
  const handle = { getAXState: async () => m.tree(), pressKey: async key => m.key(key), scroll: async (number, direction, ticks) => m.wheel(number, direction, ticks),
    click: async number => { clicks.push(number); await m.clickNumber(number); } };
  const context = { cua: { getApp: async () => handle }, setTimeout, nodeRepl: { write() {} } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await run(readCode('await cua.getApp("Safari");'));
  await assert.rejects(run(guardedCode(`return await app.pickFromList(24, ${JSON.stringify(TARGET)});`, travelWindow('safari'), undefined, undefined,
    { literals: [24], seenLines: { 24: 'list (settable) Arriving at' } })), /not-a-list.*Element 24 changed since you read the window/);
  assert.deepEqual(clicks, []);
  assert.deepEqual(m.keys, []);
});

test('CC13 review: at most 16 keys between reads; focus that leaves between bursts ends the jump', async () => {
  let since = 0, most = 0;
  const names = sortedNames(1000);
  const model = fakeList(names, { page: 9, hook: { key: () => { most = Math.max(most, ++since); }, read: () => { since = 0; } } });
  const result = await picker(model).run(names[950]);
  assert.equal(result.clicked, true);
  assert.equal(most, 16);
  // Focus moves to the Next button during the first long jump: the read after that burst stops the search.
  let seenAt;
  const moved = fakeList(names, { page: 9, hook: { key: m => { if (m.keys.length === 20) m.focus = 'button'; },
    read: m => { if (m.focus === 'button') seenAt ??= m.keys.length; } } });
  const stopped = await picker(moved).run(names[950]);
  assert.equal(stopped.reason, 'focus-lost');
  assert.ok(seenAt - 20 < 16, `keys after the focus moved: ${seenAt - 20}`);
  assert.equal(moved.keys.length, seenAt);
});

test('CC13 review: the time cap ends a key burst after its first key, and the read after it stops the search', async () => {
  const names = sortedNames(1000);
  let clock = 0;
  const model = fakeList(names, { page: 9, hook: { key: () => { clock += 400; } } });
  const result = await picker(model, { now: () => clock }).run(names[950], { timeoutMs: 3000 });
  assert.equal(result.reason, 'cap');
  assert.match(result.note, /time cap/);
  // 3,000 ms at 400 ms a key: the burst stops at the eighth key, not the sixteenth.
  assert.ok(model.keys.length <= 9, String(model.keys.length));
});
