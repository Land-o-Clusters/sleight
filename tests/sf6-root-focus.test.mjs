import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, createContext, runInContext } from 'node:vm';
import { differentFocusTarget, elementLines, guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/sf6-run8.json', import.meta.url)));
const firefoxReads = JSON.parse(readFileSync(new URL('./fixtures/sf6-firefox158-reads.json', import.meta.url)));
const firefoxSmoke = JSON.parse(readFileSync(new URL('./fixtures/browser-open-firefox-smoke.json', import.meta.url)));
const smokeRows = [...new Set(Object.values(firefoxSmoke).filter(value => typeof value === 'string')
  .flatMap(text => [...text.matchAll(/^\t*\d+ (.*)\r?$/gm)].map(match => match[1])))];
const tree = recorded.controls.moved.trace.find(e => e.sourceLine === 23).msg.result.content[0].text;
const focus = '1 container SF6R focus probe';
const before = { number: 32, line: 'text field (settable) Memo', focus };
const withFocus = (text, next) => text.replace('The focused UI element is ' + focus, 'The focused UI element is ' + next);
const sibling = line => tree.replace('\n\t40 close button', '\n\t90 ' + line + '\n\t40 close button');
const pageRow = line => tree.replace('\t\t\t\t30 container', '\t\t\t\t90 ' + line + '\n\t\t\t\t30 container');
const unnamed = tree.replace('text field (settable) Memo', 'text field (settable)');

// Generated role probes insert rows before recorded IDs. Give those probes
// ascending engine IDs, keeping the clicked field at 32 and all tree geometry.
// Already ascending recorded reads pass through byte for byte.
function ordered(text, target = 32) {
  const rows = [...text.matchAll(/^(\t*)(\d+) (.*)$/gm)];
  if (rows.every((row, i) => !i || Number(row[2]) > Number(rows[i - 1][2]))) return text;
  const at = rows.findIndex(row => Number(row[2]) === target);
  assert.ok(at >= 0 && at <= target, 'the synthetic prefix fits before the retained click ID');
  const ids = new Map(rows.map((row, i) => [Number(row[2]), i < at ? i : target + i - at]));
  return text.replace(/^(\t*)(\d+) /gm, (_, tabs, id) => tabs + ids.get(Number(id)) + ' ')
    .replace(/^The focused UI element is (\d+) /gm, (_, id) => 'The focused UI element is ' + ids.get(Number(id)) + ' ');
}

function fixture({ initial = tree, after = tree, number = 32, onRead = () => {}, failClick = false } = {}) {
  initial = ordered(initial, number); after = ordered(after, number);
  const events = [];
  let clicked = false;
  const app = {
    getAXState: async () => { if (clicked) onRead(); return clicked ? after : initial; },
    click: async n => { events.push(['click', n]); if (failClick) throw Error('click failed'); clicked = true; },
    typeText: async text => { events.push(['typeText', text]); },
    paste: async text => { events.push(['paste', text]); },
  };
  const context = createContext({ app, cua: { getApp: async () => app }, nodeRepl: { write() {} },
    performance: { now: () => 1000 }, setTimeout: resolve => resolve() });
  const run = (method = 'typeText', lease) => runInContext(`(async () => { ${guardedCode(
    `await app.click(${number}); await app.${method}("cobalt heron 47");`,
    { title: 'SF6R focus probe', app: 'Firefox', url: null }, undefined, lease, { quietEdits: true },
  )} })()`, context, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { run, events };
}

const refusals = [
  ['another specific field', withFocus(tree, '35 text field (settable) Reference, Value: reference stays')],
  ['the window row', withFocus(tree, '0 standard window SF6R focus probe, Secondary Actions: Raise')],
  ['a non-root container', withFocus(tree, '30 container')],
  ['a deeper same-titled container', withFocus(tree.replace('\t\t\t\t30 container',
    '\t\t\t\t30 container SF6R focus probe'), '30 container SF6R focus probe')],
  ['a mismatched root title', withFocus(tree.replace('\t1 container SF6R focus probe', '\t1 container Other'), '1 container Other')],
  ['a competing content container', sibling('container Sidebar')],
  ['a second same-titled content container', sibling('container SF6R focus probe')],
  ['a sibling field outside the content container', tree.replace('\t\t\t\t\t32 text field', '\t32 text field')],
  ['a field under a window control', tree.replace('\t\t\t\t\t32 text field (settable) Memo\n', '')
    .replace('\t40 close button', '\t40 close button\n\t\t32 text field (settable) Memo')],
  ['a field in the next root', tree.replace('\t\t\t\t\t32 text field (settable) Memo\n', '')
    .replace('43 menu bar', '43 menu bar\n\t32 text field (settable) Memo')],
  ['a same-titled container in the next root', withFocus(tree.replace('43 menu bar',
    '43 menu bar\n\t90 container SF6R focus probe'), '90 container SF6R focus probe')],
  ['an ordinary sibling button', sibling('button Close')],
  ['a control role with an extra label', sibling('close button Extra')],
  ['a duplicate window control', sibling('close button')],
  // Put sensitive targets beyond the menu-bar boundary to prove the scan covers the whole read.
  ...['text field (settable) Card number', 'AXSecureTextField', 'secure text field (settable) Secret',
    'password field (settable) Login'].map(line => [line + ' elsewhere in the tree',
    tree.replace('43 menu bar', '43 menu bar\n\t90 ' + line)]),
  ...['text field (settable) Card number', 'text area Account', 'text entry area PIN',
    'search field Bank', 'search text field Billing', 'combo box Credit', 'slider (settable) Secret',
    'AXSecureTextField', 'secure text field', 'secure field', 'password text field', 'password field',
    'axsecuretextfield', 'SECURE TEXT FIELD', 'PASSWORD FIELD']
    .map(line => [line + ' inside the content container',
      tree.replace('\t\t\t\t30 container', '\t\t\t\t90 ' + line + '\n\t\t\t\t30 container')]),
  ...['AXTextField Card number', 'AXTextArea Account', 'AXComboBox Credit', 'AXSearchField Bank',
    'edit text PIN', 'axtextfield Secret', 'EDIT TEXT Billing']
    .map(line => [line + ' without a settable marker', pageRow(line)]),
  ['a payment ancestor of the clicked field', tree.replace('30 container', '30 container Billing')],
  ...['sheet', 'dialog', 'alert', 'system dialog', 'popup', 'standard window Other', 'container Other']
    .map(line => [line + ' at depth 0 after the window', tree.replace('43 menu bar', '90 ' + line + '\n43 menu bar')]),
  ...['sheet', 'dialog', 'alert', 'system dialog', 'AXSheet', 'AXDialog', 'AXAlert', 'AXSystem dialog',
    'Sheet', 'DIALOG', 'popover', 'web dialog', 'group dialog', 'AXPopover', 'AXWebDialog', 'AXGroupDialog',
    'AXWeb dialog', 'AXGroup dialog', 'POPOVER', 'WEB DIALOG', 'GROUP DIALOG', 'menu', 'menu, Options']
    .map(line => [line + ' nested inside the content container',
    tree.replace('\t\t\t\t30 container', '\t\t\t\t90 ' + line + '\n\t\t\t\t30 container')]),
  ['a second window after the menu bar', tree.replace('43 menu bar', '43 menu bar\n90 standard window Other')],
];

// The label may be beside an unnamed field or elsewhere within the same page.
for (const role of ['text', 'heading', 'label']) {
  for (const label of ['Card number', 'Password', 'Security code', 'Account', 'PIN', 'cc-number']) {
    for (const pageRole of ['HTML Content', 'web area', 'AXWebArea']) {
      const after = pageRow(role + ' ' + label).replace('text field (settable) Memo', 'text field (settable)')
        .replace('HTML Content Description:', pageRole + ' Description:');
      refusals.push([role + ' ' + label + ' beside an unnamed field in ' + pageRole, after, after]);
    }
  }
}
const labelAfterField = unnamed.replace('\t\t\t\t33 container',
  '\t\t\t\t\t91 label Card number\n\t\t\t\t33 container');
refusals.push(['a payment label below the clicked field', labelAfterField, labelAfterField]);

for (const role of ['text', 'heading', 'label']) {
  for (const location of ['beside field', 'before group', 'after group']) {
    const noWeb = unnamed.replace('HTML Content Description:', 'group Description:');
    const after = location === 'beside field' ? noWeb.replace('\t\t\t\t30 container',
      '\t\t\t\t90 ' + role + ' Card number\n\t\t\t\t30 container')
      : location === 'before group' ? noWeb.replace('\t\t24 scroll area',
        '\t\t90 ' + role + ' Card number\n\t\t24 scroll area')
        : noWeb.replace('\t40 close button', '\t\t90 ' + role + ' Card number\n\t40 close button');
    refusals.push([role + ' Card number ' + location + ' without a web ancestor', after, after]);
  }
  for (const pageRole of ['HTML Content', 'web area', 'AXWebArea']) {
    for (const location of ['before', 'after']) {
      const page = unnamed.replace('HTML Content Description:', pageRole + ' Description:');
      const after = location === 'before' ? page.replace('\t\t\t25 ' + pageRole,
        '\t\t\t90 ' + role + ' Card number\n\t\t\t25 ' + pageRole)
        : page.replace('\t40 close button', '\t\t\t90 ' + role + ' Card number\n\t40 close button');
      refusals.push([role + ' Card number ' + location + ' sibling ' + pageRole, after, after]);
    }
  }
  const noScroll = pageRow(role + ' Card number').replace('text field (settable) Memo', 'text field (settable)')
    .replace('24 scroll area', '24 group');
  refusals.push([role + ' Card number with web ancestry but no scroll area', noScroll, noScroll]);
  for (const pageRole of ['HTML Content', 'group']) {
    const afterToolbar = unnamed.replace('HTML Content Description:', pageRole + ' Description:')
      .replace('\t\t\t25 ' + pageRole, '\t\t\t92 toolbar Navigation\n\t\t\t\t93 group\n' +
        '\t\t\t\t\t94 ' + role + ' Card number\n\t\t\t90 ' + role + ' Card number\n\t\t\t25 ' + pageRole);
    refusals.push([role + ' Card number after a toolbar subtree in ' + pageRole, afterToolbar, afterToolbar]);
  }
}

for (const pageRole of ['HTML Content', 'web area', 'AXWebArea']) {
  for (const toolbarRole of ['toolbar', 'AXToolbar']) {
    for (const [role, label] of [['text', 'Card number'], ['heading', 'Card number'], ['label', 'Card number'],
      ['heading', 'Payment'], ['label', 'Password']]) {
      for (const location of ['beside web content', 'inside web content']) {
        const page = tree.replace('HTML Content Description:', pageRole + ' Description:');
        const toolbar = '\t\t\t92 ' + toolbarRole + ' Navigation\n\t\t\t\t93 group\n' +
          '\t\t\t\t\t94 ' + role + ' ' + label + '\n';
        const after = location === 'beside web content' ? page.replace('\t\t\t25 ' + pageRole,
          toolbar + '\t\t\t25 ' + pageRole) : page.replace('\t\t\t\t30 container',
          toolbar.split('\n').filter(Boolean).map(line => '\t' + line).join('\n') + '\n\t\t\t\t30 container');
        refusals.push([role + ' ' + label + ' nested in ' + toolbarRole + ' ' + location + ' in ' + pageRole, after, after]);
      }
    }
  }
}

for (const [name, rawAfter, rawInitial = tree] of refusals) {
  const after = ordered(rawAfter), initial = ordered(rawInitial);
  test(`SF6 root focus refuses ${name}`, () => {
    assert.equal(differentFocusTarget(after, { ...before, line: elementLines(initial).get(32) }), 32);
  });
  for (const method of ['typeText', 'paste']) test(`SF6 guard refuses ${method} on ${name}`, async () => {
    const f = fixture({ initial, after });
    await assert.rejects(f.run(method), /another element has focus|keyboard focus is on the window itself/);
    assert.deepEqual(f.events, [['click', 32]]);
    assert.equal(f.events.filter(([event]) => event === 'typeText' || event === 'paste').length, 0);
  });
}

for (const read of firefoxReads) test(`SF6 guard admits ${read.control} Firefox 158 read ${read.callId}`, async () => {
  // Call 1 exposes an unnamed text field at 27; call 2 exposes Memo at 32.
  const number = read.callId === 1 ? 27 : 32;
  const f = fixture({ initial: read.text, after: read.text, number });
  await f.run();
  assert.deepEqual(f.events, [['click', number], ['typeText', 'cobalt heron 47']]);
});

test('SF6 smoke fixture retains 91 unique element rows', () => {
  assert.equal(smokeRows.length, 91);
});
for (const [index, line] of smokeRows.entries()) {
  for (const pageRole of ['HTML Content', 'group']) {
    for (const method of ['typeText', 'paste']) test(`SF6 guard admits toolbar smoke row ${index + 1} in ${pageRole} via ${method}: ${line}`, async () => {
      const after = tree.replace('HTML Content Description:', pageRole + ' Description:')
        .replace('\t\t24 scroll area', '\t\t92 toolbar Navigation\n\t\t\t90 ' + line + '\n\t\t24 scroll area');
      const f = fixture({ initial: after, after });
      await f.run(method);
      assert.deepEqual(f.events, [['click', 32], [method, 'cobalt heron 47']]);
    });
  }
}

// Without web ancestry the container fallback still excludes navigation toolbars.
for (const pageRole of ['group']) {
  for (const toolbarRole of ['toolbar', 'AXToolbar']) {
    for (const role of ['text', 'heading', 'label']) {
      for (const method of ['typeText', 'paste']) test(`SF6 guard admits ${role} Card number nested in ${toolbarRole} beside ${pageRole} via ${method}`, async () => {
        const after = tree.replace('HTML Content Description:', pageRole + ' Description:')
          .replace('\t\t\t25 ' + pageRole, '\t\t\t92 ' + toolbarRole + ' Navigation\n\t\t\t\t93 group\n' +
            '\t\t\t\t\t94 ' + role + ' Card number\n\t\t\t25 ' + pageRole);
        const f = fixture({ initial: after, after });
        await f.run(method);
        assert.deepEqual(f.events, [['click', 32], [method, 'cobalt heron 47']]);
      });
    }
  }
}

for (const role of ['text', 'heading', 'label']) {
  for (const location of ['toolbar', 'other page', 'after page']) {
    test(`SF6 guard admits ${role} Card number in ${location} outside the clicked page`, async () => {
      const row = location === 'toolbar' ? '\t\t92 toolbar Navigation\n\t\t\t90 ' + role + ' Card number\n'
        : location === 'other page' ? '\t\t92 scroll area\n\t\t\t93 HTML Content Other page\n\t\t\t\t90 ' + role + ' Card number\n'
        : '\t\t90 ' + role + ' Card number\n';
      const after = location === 'after page' ? tree.replace('\t40 close button', row + '\t40 close button')
        : tree.replace('\t\t24 scroll area', row + '\t\t24 scroll area');
      const f = fixture({ initial: after, after });
      await f.run();
      assert.deepEqual(f.events, [['click', 32], ['typeText', 'cobalt heron 47']]);
    });
  }
}

for (const line of ['button Account', 'text Not Secure', 'text Connection is not secure',
  'menu button Options', 'menu item Options', 'menu bar Navigation']) {
  test(`SF6 guard admits ordinary content or chrome row ${line}`, async () => {
    const after = tree.replace('\t\t24 scroll area', '\t\t90 ' + line + '\n\t\t24 scroll area');
    const f = fixture({ initial: after, after });
    await f.run();
    assert.deepEqual(f.events, [['click', 32], ['typeText', 'cobalt heron 47']]);
  });
}

for (const label of ['Card number', 'Account', 'PIN', 'Secret']) {
  test(`SF6 guard refuses the clicked sensitive field ${label}`, async () => {
    const sensitive = tree.replace('text field (settable) Memo', 'text field (settable) ' + label);
    assert.equal(differentFocusTarget(sensitive, { ...before, line: 'text field (settable) ' + label }), 32);
    const f = fixture({ initial: sensitive, after: sensitive });
    await assert.rejects(f.run(), /another element has focus/);
    assert.deepEqual(f.events, [['click', 32]]);
    assert.equal(f.events.filter(([event]) => event === 'typeText' || event === 'paste').length, 0);
  });
}

for (const prior of [undefined, focus]) test(`SF6 root focus accepts prior focus ${prior ?? 'unreported'}`, async () => {
  assert.equal(differentFocusTarget(tree, { ...before, focus: prior }), undefined);
  for (const method of ['typeText', 'paste']) {
    const f = fixture({ initial: prior ? tree : tree.replace('The focused UI element is ' + focus, '') });
    await f.run(method);
    assert.deepEqual(f.events, [['click', 32], [method, 'cobalt heron 47']]);
  }
});

for (const prior of ['35 text field (settable) Reference, Value: reference stays',
  '0 standard window SF6R focus probe, Secondary Actions: Raise', '9 container SF6R focus probe', '30 container']) {
  test(`SF6 root focus refuses prior focus ${prior}`, async () => {
    assert.equal(differentFocusTarget(tree, { ...before, focus: prior }), 32);
    const f = fixture({ initial: withFocus(tree, prior) });
    await assert.rejects(f.run(), /another element has focus/);
    assert.deepEqual(f.events, [['click', 32]]);
  });
}

test('SF6 root focus accepts standard controls before the content and a separate menu-bar root', async () => {
  const controls = tree.slice(tree.indexOf('\t40 close button'), tree.indexOf('43 menu bar'));
  const reordered = ordered(tree.replace(controls, '').replace('\t1 container', controls + '\t1 container'));
  const reorderedFocus = /^The focused UI element is (.*)$/m.exec(reordered)[1];
  assert.equal(differentFocusTarget(reordered, { ...before, focus: reorderedFocus }), undefined);
  const f = fixture({ initial: reordered, after: reordered });
  await f.run();
  assert.deepEqual(f.events, [['click', 32], ['typeText', 'cobalt heron 47']]);
});

test('SF6 root focus accepts a clicked text child inside the editable field', () => {
  const child = tree.replace('\t\t\t\t\t32 text field (settable) Memo',
    '\t\t\t\t\t32 text field (settable) Memo\n\t\t\t\t\t\t99 text memo');
  assert.equal(differentFocusTarget(child, { number: 99, line: 'text memo', focus }), undefined);
});

test('SF6 root focus refuses a non-editable click', () => {
  const button = tree.replace('32 text field (settable) Memo', '32 button Memo');
  assert.equal(differentFocusTarget(button, { number: 32, line: 'button Memo', focus }), 32);
});

test('SF6 guard keeps a failed click from sending text', async () => {
  const f = fixture({ failClick: true });
  await assert.rejects(f.run(), /click failed/);
  assert.deepEqual(f.events, [['click', 32]]);
});

test('SF6 guard refuses a changed window before text', async () => {
  const f = fixture({ after: tree.replaceAll('SF6R focus probe', 'Another window') });
  await assert.rejects(f.run(), /Document scope stopped/);
  assert.deepEqual(f.events, [['click', 32]]);
});

for (const loss of ['takeover', 'expiry']) test(`SF6 guard refuses lease ${loss} on root focus`, async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sf6-root-focus-')));
  t.after(() => removeTemp(directory));
  const path = join(directory, 'lease.json');
  const record = { token: 'owned', expires: Date.now() + 60000 };
  writeFileSync(path, JSON.stringify(record));
  const f = fixture({ onRead: () => writeFileSync(path, JSON.stringify(loss === 'takeover'
    ? { ...record, token: 'new-owner' } : { ...record, expires: 0 })) });
  await assert.rejects(f.run('typeText', { path, token: 'owned' }), /ownership lost or expired/);
  assert.deepEqual(f.events, [['click', 32]]);
});
