import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCell, handleBindings } from '../plugins/sleight/lib/code-ast.mjs';
import { calls, FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { nativeArgumentsProblem } from '../plugins/sleight/lib/native-arguments.mjs';
import { unsafeHandleUse, trustedInvocations } from '../plugins/sleight/lib/call-inspection.mjs';

const astOf = code => {
  const { ast, error } = parseCell(code);
  assert.equal(error, null);
  return ast;
};
const safe = ['() => null', '() => true', '() => false', '() => 0', '() => -1', '() => ""',
  '() => `literal`', '() => void 0', '() => ({ missing: true })', '() => [null, false]',
  '() => {}', '() => { return; }', '() => { return null; }', 'error => { throw error; }',
  'function(error) { throw error; }', 'function() { return false; }'];
for (const handler of safe) test(`catch keeps a proven acquisition: ${handler}`, () => {
  const code = `const editor = await cua.getApp("Notes").catch(${handler}); await editor.typeText("SECRET");`;
  const hint = handleBindings(astOf(code)).get('editor');
  assert.equal(hint?.app, 'Notes');
  assert.equal(code.slice(...hint.range), `await cua.getApp("Notes").catch(${handler})`);
  const parsed = calls(code, new Map());
  assert.equal(parsed.inputs[0].target.app, 'Notes');
  assert.equal(parsed.unknown, false);
});

const unsafe = ['() => undefined', '() => { return undefined; }', '() => cua.getApp("Mail")', '() => other', '() => recover()', 'async () => null',
  'async error => { throw error; }', 'function* () { return null; }', '() => (other, null)',
  '() => (recover(), null)', '() => { other = null; return null; }', '() => { recover(); return null; }',
  '() => { throw recover(); }', '() => { throw other; }', 'error => { error = other; throw error; }',
  '(error = recover()) => null', '({ error }) => null', '(...errors) => null', 'recover',
  'undefined => undefined', 'function undefined() { return undefined; }', '() => void recover()',
  '() => ({ value: other })', '() => ({ ...other })', '() => [other]', '() => `text${other}`',
  '() => ({ get value() { return null; } })', '() => ({ [key]: null })',
  '() => this', 'function() { return this; }', '() => arguments', 'function() { return arguments; }',
  '() => { if (ok) return null; return other; }', '() => { try { return null; } finally { return other; } }'];
for (const handler of unsafe) test(`catch keeps an unproven destination unknown: ${handler}`, () => {
  const code = `const editor = await cua.getApp("Notes").catch(${handler}); await editor.typeText("SECRET");`;
  const handles = new Map([['editor', { app: 'Old' }]]);
  assert.equal(handleBindings(astOf(code)).has('editor'), false);
  const parsed = calls(code, handles);
  assert.equal(handles.has('editor'), false);
  assert.equal(parsed.inputs.at(-1).target.app, undefined);
});

for (const prefix of ['const undefined = other;', 'var undefined;', 'let undefined;',
  'const { value: undefined } = source;', 'import { value as undefined } from "fixture";',
  'function later(undefined) {}', 'function undefined() {}']) test(`undefined shadows stay unknown: ${prefix}`, () => {
  const code = `${prefix} const editor = await cua.getApp("Notes").catch(() => undefined); await editor.typeText("SECRET");`;
  assert.equal(handleBindings(astOf(code)).has('editor'), false);
  assert.equal(calls(code, new Map()).inputs.at(-1).target.app, undefined);
});

for (const suffix of ['editor = other;', '[editor] = source;', '({ value: editor } = source);',
  'function later() { editor = other; }', 'editor++;', 'for (editor of source) {}'])
  test(`reassignment after catch clears the binding: ${suffix}`, () => {
    const code = `let editor = await cua.getApp("Notes").catch(() => null); ${suffix} await editor.typeText("SECRET");`;
    assert.equal(handleBindings(astOf(code)).has('editor'), false);
    assert.equal(calls(code, new Map()).inputs.at(-1).target.app, undefined);
  });

for (const source of ['cua.getApp("Notes")["catch"](() => null)', 'cua.getApp("Notes").catch?.(() => null)',
  'cua.getApp("Notes")?.catch(() => null)', 'cua.getApp("Notes").catch(() => null, other)',
  'cua.getApp("Notes").then(recover).catch(() => null)', 'other.catch(() => null)',
  'cua.getApp("Notes").finally(() => null)', 'cua.getApp("Notes").finally(() => null).catch(() => null)',
  'Promise.race([cua.getApp("Notes"), other]).catch(() => null)',
  '(other, cua.getApp("Notes").catch(() => null))', 'cua.getApp(name).catch(() => null)'])
  test(`unproven acquisition shape stays unknown: ${source}`, () => {
    const code = `const editor = await ${source}; await editor.typeText("SECRET");`;
    assert.equal(handleBindings(astOf(code)).has('editor'), false);
    const handles = new Map([['editor', { app: 'Old' }]]);
    assert.equal(calls(code, handles).inputs.at(-1).target.app, undefined);
    assert.equal(handles.has('editor'), false);
  });

test('a handler parameter named after its destination invalidates the binding', () => {
  const code = 'const tab = await cua.getTab("fixture").catch(tab => null); await tab.typeText("SECRET");';
  assert.equal(handleBindings(astOf(code)).has('tab'), false);
  const handles = new Map([['tab', { app: 'browser' }]]);
  assert.equal(calls(code, handles).inputs.at(-1).target.app, undefined);
  assert.equal(handles.has('tab'), false);
});

for (const handler of ['() => null', '() => void 0', 'error => { throw error; }']) {
  test(`native argument validation follows a safe catch binding: ${handler}`, () => {
    const prefix = `const editor = await cua.getApp("Notes").catch(${handler});`;
    assert.equal(nativeArgumentsProblem(prefix + 'await editor.typeText(123);'), 'sleight: invalid native arguments. Engine App.typeText(text: string); nothing was sent.');
    assert.equal(nativeArgumentsProblem(prefix + 'await editor.typeText("text");'), undefined);
  });

  test(`call inspection guards a safe catch binding: ${handler}`, () => {
    const prefix = `const editor = await cua.getApp("Notes").catch(${handler});`;
    assert.match(unsafeHandleUse(astOf(prefix + 'const method = editor.typeText;')), /method extraction/);
    assert.equal(unsafeHandleUse(astOf(prefix + 'await editor.typeText("text");')), false);
    const trusted = 'function swipe(h, size) { return h.scroll([0,0], "down"); }';
    const code = prefix + `(${trusted}).bind(null, editor, [1,2])("down");`;
    const options = { code, trustedFunctions: new Set([trusted]) };
    assert.equal(trustedInvocations(astOf(code), code, options.trustedFunctions).size, 2);
    assert.equal(unsafeHandleUse(astOf(code), undefined, options), false);
  });
}

for (const prefix of ['', 'const undefined = other;']) test(`bare undefined grants no native or trusted-wrapper hint: ${prefix}`, () => {
  const acquisition = prefix + 'const editor = await cua.getApp("Notes").catch(() => undefined);';
  assert.equal(nativeArgumentsProblem(acquisition + 'await editor.typeText(123);'), undefined);
  const trusted = 'function swipe(h, size) { return h.scroll([0,0], "down"); }';
  const code = acquisition + `(${trusted}).bind(null, editor, [1,2])("down");`;
  assert.equal(trustedInvocations(astOf(code), code, new Set([trusted])).size, 0);
  assert.match(unsafeHandleUse(astOf(code), undefined, { code, trustedFunctions: new Set([trusted]) }), /bind/);
});

for (const source of ['cua.getBrowser()', 'cua.getTab("fixture")', 'cua.createBrowserTab("firefox", "https://example.test")',
  'browser.tabs.get("1")', 'browser.tabs.new()']) test(`browser acquisitions keep their kind: ${source}`, () => {
  const bindings = handleBindings(astOf(`const browser = await cua.getBrowser(); const tab = await ${source}.catch(() => null);`));
  assert.equal(bindings.get('tab')?.kind, 'browser');
});

test('a known prior handle named undefined cannot become a non-handle fallback', () => {
  const previous = new Map([['undefined', { kind: 'app', app: 'Mail' }]]);
  assert.equal(handleBindings(astOf('const editor = await cua.getApp("Notes").catch(() => undefined);'), previous).has('editor'), false);
  const parsed = calls('const editor = await cua.getApp("Notes").catch(() => undefined); await editor.typeText("SECRET");',
    new Map([['undefined', { app: 'Mail' }]]));
  assert.equal(parsed.inputs.at(-1).target.app, undefined);
});

test('an unproven catch cannot seed a locator hint from the fallback body', () => {
  const previous = new Map([['browser', { kind: 'browser' }]]);
  const code = 'const tab = await browser.tabs.get("1").catch(() => other.getByRole("button"));';
  assert.equal(handleBindings(astOf(code), previous).has('tab'), false);
});

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/ca5-catch-cells.json', import.meta.url)));
for (const [index, fixture] of fixtures.entries()) test(`recorded OD1 cell: ${fixture.callId}`, () => {
  const bindings = handleBindings(astOf(fixture.code)), handles = new Map();
  const parsed = calls(fixture.code, handles);
  if (index === 1) {
    // This recorded fallback returns another acquisition. It cannot pass the
    // non-handle proof even though the legacy scanner guessed Safari here.
    assert.equal(bindings.has('app'), false);
    assert.equal(handles.has('app'), false);
    assert.equal(parsed.inputs.length, 2);
    assert.ok(parsed.inputs.every(input => input.target.app === undefined));
  } else {
    const name = index === 0 ? 'tab' : 's';
    assert.equal(bindings.get(name)?.kind, 'browser');
    assert.equal(handles.get(name)?.app, 'browser');
    // These cells type through ff, not through the newly acquired tab.
    assert.ok(parsed.inputs.every(input => input.target.app === undefined));
  }
});

test('safe catch avoids a false rule stop while an arbitrary fallback still stops', () => {
  const flow = new FlowRules({ version: 1, rules: [
    { id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['Mail'], except: ['Notes'] },
  ] });
  for (const handler of ['() => null', '() => other', '() => cua.getApp("Mail")']) {
    const plan = flow.analyze('js', { code: `const editor = await cua.getApp("Notes").catch(${handler}); await editor.typeText("SECRET");` });
    assert.equal(plan.violations.length, handler === '() => null' ? 0 : 1);
  }
});

test('a safe binding persists to the next flow call and a reassignment removes its exception', () => {
  const flow = new FlowRules({ version: 1, rules: [
    { id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['Mail'], except: ['Notes'] },
  ] });
  flow.forward(flow.analyze('js', { code: 'let editor = await cua.getApp("Notes").catch(() => null);' }));
  assert.equal(flow.analyze('js', { code: 'await editor.typeText("SECRET")' }).violations.length, 0);
  const changed = flow.analyze('js', { code: 'editor = other; await editor.typeText("SECRET")' });
  assert.equal(changed.handles.has('editor'), false);
  assert.equal(changed.violations.length, 1);
});
