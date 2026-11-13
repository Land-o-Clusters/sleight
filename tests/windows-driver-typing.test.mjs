import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { body, method, DriverFault } from './fixtures/windows-review-seams.mjs';
import { GUEST_FIXTURE } from '../bench/windows/uc3f-collect.mjs';
const recorded = JSON.parse(readFileSync(new URL('./fixtures/windows-typing-focus.json', import.meta.url), 'utf8'));

const path = 'plugins/sleight/lib/direct-browser/native/win/';
const read = name => process.env.WT1_BASELINE === '1'
  ? execFileSync('/usr/bin/git', ['show', '3077b36c3:' + path + name], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' })
  : readFileSync(new URL('../' + path + name, import.meta.url), 'utf8');
let actions = read('DriverActions.cs'), input = read('DriverInput.cs'), fixture = GUEST_FIXTURE;
const broken = process.env.WT1_BROKEN;
if (broken === 'person-bypass') {
  const type = body(input, 'internal static string Type(');
  assert.match(type, /DriverPerson.Require\(window\);/);
  input = input.replace(type, type.replace('DriverPerson.Require(window);', ''));
  input = input.replace('if (!cleanup) api.Person(window);', '');
  actions = actions.replace('clipboardAdmission = clipboardWatch.Admit();\n            DriverPerson.Require(window);', 'clipboardAdmission = clipboardWatch.Admit();');
} else if (broken === 'container-focus') {
  const focus = body(actions, 'IntPtr FocusHandle(');
  actions = actions.replace(focus, focus.replaceAll('node.Element.GetCurrentPropertyValueEx(HasKeyboardFocus', 'element.GetCurrentPropertyValueEx(HasKeyboardFocus'));
} else if (broken === 'fixture-unfocused') fixture = fixture.replace('$window.Add_ContentRendered({ [void]$editor.Focus() })', '');

function seams() {
  return {
    choose: method(actions.replace('DriverNode selected =', 'var selected ='), 'internal static DriverNode FocusedTarget(', ['nodes', 'accepts']),
    matches: method(actions, 'internal static bool NativeFocusMatches(', ['focus', 'expected', 'child']),
  };
}
function resolve(nodes, focus) {
  if (!actions.includes('internal static DriverNode FocusedTarget(')) {
    // Execute the old production selection statements for the red receipt.
    const old = /var focused = latest.Values.Where\(n => n.Focused\).ToList\(\);[^]*?node = focused\[0\];/.exec(actions)?.[0];
    assert.ok(old);
    return runInNewContext(`nodes => { let node; ${old.replace('var focused = latest.Values.Where(n => n.Focused).ToList()', 'let focused = nodes.filter(n => n.Focused)').replace('focused.Count', 'focused.length')} return node; }`, { DriverFault })(nodes);
  }
  const { choose, matches } = seams();
  return choose(nodes, node => matches(focus, node.hwnd, (parent, child) => node.descendants?.includes(child) && parent === node.hwnd));
}
const node = (hwnd, extra = {}) => ({ hwnd, Focused: true, ...extra });

test('Notepad: four UIA focus claims resolve only to the native RichEdit focus HWND', () => {
  const focus = Number(recorded.notepad.native[0].focus);
  const nodes = recorded.notepad.focused.map(n => node(n.hwnd, { className: n.className }));
  const editor = nodes.find(n => n.className === 'RichEditD2DPT');
  assert.equal(recorded.windowsBuild, 26300); assert.equal(recorded.notepad.version, '11.2607.14.0');
  assert.equal(nodes.length, 4); assert.ok(editor);
  assert.equal(resolve(nodes, focus), editor);
  assert.equal(resolve([...nodes].reverse(), focus), editor);
  assert.match(actions, /node = FocusedTarget\(latest.Values, candidate => \{\s*try \{ FocusHandle\(candidate\); return true; \}/);
});

test('focus selection refuses zero, stale, ambiguous and unreadable matches', () => {
  for (const nodes of [[], [node(101)], [node(700), node(700)], [node(700, { Focused: false })]])
    assert.throws(() => resolve(nodes, 700), { code: 'NO_BACKGROUND_FOCUS' });
  assert.throws(() => resolve([node(700)], 0), { code: 'NO_BACKGROUND_FOCUS' });
  const { choose } = seams();
  for (const code of ['IDENTITY_CHANGED', 'PASSWORD_TARGET', 'SCREEN_LOCKED'])
    assert.throws(() => choose([node(700)], () => { throw new DriverFault(code); }), { code });
});

test('native focus must be the target HWND or a child, never an ancestor or sibling', () => {
  const { matches } = seams();
  const child = (parent, handle) => parent === 100 && handle === 700;
  assert.equal(matches(700, 700, child), true);
  assert.equal(matches(700, 100, child), true);
  assert.equal(matches(100, 700, child), false);
  assert.equal(matches(101, 700, child), false);
  assert.equal(matches(0, 700, child), false);
  assert.equal(matches(700, 0, child), false);
});

test('WPF checks the focused editor UIA element while retaining native HWND password and identity checks', () => {
  const focus = body(actions, 'IntPtr FocusHandle(');
  assert.match(focus, /Password\(\(property, ignore\) => element.GetCurrentPropertyValueEx\(property, ignore\), \(int\)type\)/);
  assert.match(focus, /node.Element.GetCurrentPropertyValueEx\(HasKeyboardFocus, true\)/);
  assert.doesNotMatch(focus, /element.GetCurrentPropertyValueEx\(HasKeyboardFocus/);
  assert.match(focus, /DriverInput.Check\(node.Host, focus\);\s*if \(DriverInput.Focus\(node.Host\) != focus\)/);
  assert.match(fixture, /\$window.Add_ContentRendered\(\{ \[void\]\$editor.Focus\(\) \}\)/);
});

test('the selected background route refuses person input before identity work and every text pump checkpoint', () => {
  const type = body(input, 'internal static string Type(');
  const closure = /Action check = \(\) => \{([^]*?)\n        \};/.exec(type)?.[1];
  assert.ok(closure);
  let calls, refusal;
  const check = runInNewContext(`() => { ${closure} }`, { window: {}, hwnd: 700, requireFocus: false,
    DriverPerson: { Require() { calls.push('person'); if (refusal) throw new DriverFault(refusal); } },
    Check() { calls.push('identity'); }, Focus() { return 700; }, RequireWritableEdit() {}, DriverFault });
  for (const code of ['PERSON_TOOK_OVER', 'SCREEN_LOCKED', 'SECURE_DESKTOP_ACTIVE']) {
    calls = []; refusal = code;
    assert.throws(check, { code }); assert.deepEqual(calls, ['person']);
  }
  calls = []; refusal = undefined; check(); check();
  assert.deepEqual(calls, ['person', 'identity', 'person', 'identity']);
  assert.match(type, /\}, check, \(\) =>/);
  assert.match(body(input, 'internal static void PumpText('), /if \(TextCheckpoint\(i, units, nextCheck\)\) \{ check\(\); nextCheck = i \+ 64; \}/);
  assert.match(actions, /case "typeText": return DriverInput.Type\(node.Host, FocusHandle\(node\), plan.Text\);/);
});

function withActions(source, run) {
  const saved = actions;
  actions = source;
  try { return run(); }
  finally { actions = saved; }
}
function mutateSource(source, change) {
  const changed = change(source);
  assert.notEqual(changed, source, 'mutation must change source');
  return changed;
}
function firstFocusWitness() {
  const focus = Number(recorded.notepad.native[0].focus);
  const nodes = recorded.notepad.focused.map(n => node(n.hwnd, { className: n.className }));
  const editor = nodes.find(n => n.className === 'RichEditD2DPT');
  assert.equal(resolve(nodes, focus), editor);
  assert.equal(resolve([...nodes].reverse(), focus), editor);
  for (const sample of [[], [node(101)], [node(700), node(700)], [node(700, { Focused: false })]])
    assert.throws(() => resolve(sample, 700), { code: 'NO_BACKGROUND_FOCUS' });
  assert.throws(() => resolve([node(700)], 0), { code: 'NO_BACKGROUND_FOCUS' });
}
function reverseHwndWitness() {
  const { matches } = seams();
  const child = (parent, handle) => parent === 100 && handle === 700;
  assert.equal(matches(700, 700, child), true);
  assert.equal(matches(700, 100, child), true);
  assert.equal(matches(100, 700, child), false);
}
test('first-focus broken variant fails in the default suite', () => {
  withActions(actions, firstFocusWitness);
  const broken = mutateSource(actions, source => source.replace(
    'if (!candidate.Focused || !accepts(candidate)) continue;',
    'if (!candidate.Focused) continue; return candidate;'));
  assert.throws(() => withActions(broken, firstFocusWitness), { code: 'ERR_ASSERTION' });
});
test('reverse-hwnd broken variant fails in the default suite', () => {
  withActions(actions, reverseHwndWitness);
  const broken = mutateSource(actions, source => source.replace(
    '(focus == expected || child(expected, focus))',
    '(focus == expected || child(expected, focus) || child(focus, expected))'));
  assert.throws(() => withActions(broken, reverseHwndWitness), { code: 'ERR_ASSERTION' });
});
