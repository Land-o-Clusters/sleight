import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { body, method, withoutTestSeams } from './fixtures/windows-review-seams.mjs';

const inputPath = new URL('../plugins/sleight/lib/direct-browser/native/win/DriverInput.cs', import.meta.url);
const inventoryPath = new URL('../plugins/sleight/lib/direct-browser/native/win/DriverInventory.cs', import.meta.url);
const read = url => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
const csharp = code => code
  .replace(/uint\? app = /g, 'let app = ')
  .replace(/!app\.HasValue/g, 'app == null')
  .replace(/app\.Value/g, 'app')
  .replace(/IntPtr frame = /g, 'let frame = ')
  .replace(/string name = /g, 'let name = ')
  .replace(/IList<IntPtr> found = /g, 'let found = ')
  .replace(/uint pid = /g, 'let pid = ')
  .replace(/IntPtr\.Zero/g, '0')
  .replace(/\.Count\b/g, '.length')
  .replace(/catch \{/g, 'catch (error) {')
    .replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1');
function compile(source, signature, args, extra = {}) {
  const js = csharp(body(source, signature));
  return runInNewContext(`(${args.join(',')}) => { ${js} }`, {
    String: { Equals: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase() },
    StringComparison: { OrdinalIgnoreCase: 0 },
    DriverFault: class DriverFault extends Error { constructor(code) { super(code); this.Code = code; } },
    ...extra,
  });
}
function harness(input = read(inputPath), inventory = read(inventoryPath)) {
  const activity = compile(input, 'internal static uint ActivityPid(', ['hwnd', 'rawPid', 'target', 'child', 'hosted']);
  const hosted = compile(inventory, 'internal static uint? LiveHostedAppPid(IntPtr hwnd, Func<IntPtr, IntPtr> root,',
    ['hwnd', 'root', 'className', 'cores', 'pidOf']);
  const decide = compile(input, 'internal static string Decide(', ['ageMs', 'foregroundPid', 'pointerPid', 'targetPid']);
  const owned = compile(input, 'internal static void RequireOwned(', ['window', 'hwnd', 'pid', 'child']);
  const frameApp = (frame, className, cores, corePid) => hwnd => hosted(hwnd, () => frame, () => className, () => cores,
    handle => cores.length === 1 && handle === cores[0] ? corePid : 0);
  return { activity, hosted, decide, owned, frameApp };
}
const noChild = () => false;
function notepad() {
  return { Pid: 1000, Handle: 500, CoreHandle: 0, InputRoot: 500, ClassName: 'Notepad' };
}

test('an unresolved Calculator frame does not refuse an ordinary Notepad action', () => {
  const { activity, decide, frameApp } = harness();
  const target = notepad();
  const foreground = activity(401, 7, target, noChild, frameApp(401, 'ApplicationFrameWindow', [], 0));
  assert.equal(foreground, 7);
  assert.equal(decide(100, foreground, 99, target.Pid), null);
});

test('a person in Notepad refuses the Notepad action', () => {
  const { activity, decide, frameApp } = harness();
  const target = notepad();
  const foreground = activity(target.Handle, target.Pid, target, noChild, frameApp(target.Handle, 'Notepad', [], 0));
  assert.equal(foreground, 1000);
  assert.equal(decide(100, foreground, 99, target.Pid), 'person-active');
});

test('an unresolved frame over a packaged root is person-unknown', () => {
  const { activity, decide, frameApp } = harness();
  const target = { Pid: 41, Handle: 201, CoreHandle: 301, InputRoot: 301 };
  const foreground = activity(401, 7, target, noChild, frameApp(401, 'ApplicationFrameWindow', [], 0));
  assert.equal(foreground, 0);
  assert.equal(decide(100, foreground, 99, target.Pid), 'person-unknown');
});

test('T28 resolves the other packaged app through LiveHostedAppPid', () => {
  const { activity, decide, hosted } = harness();
  const target = { Pid: 41, Handle: 201, CoreHandle: 301 };
  const mapped = hosted(402, () => 402, () => 'ApplicationFrameWindow', () => [502], handle => handle === 502 ? 42 : 0);
  const foreground = activity(402, 7, target, noChild, () => mapped);
  assert.equal(mapped, 42);
  assert.equal(foreground, 42);
  assert.equal(decide(100, foreground, 99, target.Pid), null);
});

test('the old pid-0 mutant refuses Notepad while an unresolved frame is in front', () => {
  const before = 'if (app.Value == 0 && (target == null || target.CoreHandle == IntPtr.Zero)) return rawPid;\n        return app.Value;';
  const broken = read(inputPath).replace(before, 'return app.Value;');
  assert.notEqual(broken, read(inputPath));
  const { activity, decide, frameApp } = harness(broken);
  const target = notepad();
  const foreground = activity(401, 7, target, noChild, frameApp(401, 'ApplicationFrameWindow', [], 0));
  assert.equal(foreground, 0);
  assert.equal(decide(100, foreground, 99, target.Pid), 'person-unknown');
});

test('LiveHostedAppPid returns one core pid and 0 for an unresolved frame', () => {
  const { hosted } = harness();
  assert.equal(hosted(401, h => h, () => 'ApplicationFrameWindow', () => [301], h => h === 301 ? 41 : 0), 41);
  assert.equal(hosted(401, h => h, () => 'ApplicationFrameWindow', () => [], () => 41), 0);
  assert.equal(hosted(401, h => h, () => 'ApplicationFrameWindow', () => [301, 302], () => 41), 0);
  assert.equal(hosted(500, h => h, () => 'Notepad', () => [], () => 41), null);
  assert.equal(hosted(401, h => h, () => null, () => [301], () => 41), 0);
  assert.equal(hosted(401, h => h, () => 'ApplicationFrameWindow', () => [301], () => 0), 0);
});

test('the unresolved-frame null mutant lets a packaged target keep the host pid', () => {
  const before = 'if (found == null || found.Count != 1) return 0;';
  const broken = read(inventoryPath).replace(before, 'if (found == null || found.Count != 1) return null;');
  assert.notEqual(broken, read(inventoryPath));
  const { activity, decide, frameApp } = harness(read(inputPath), broken);
  const target = { Pid: 41, Handle: 201, CoreHandle: 301 };
  const foreground = activity(401, 7, target, noChild, frameApp(401, 'ApplicationFrameWindow', [], 0));
  assert.equal(foreground, 7);
  assert.equal(decide(100, foreground, 99, target.Pid), null);
});

test('RequireOwned refuses a child of the wrong pid, and the pid mutant accepts it', () => {
  const { owned } = harness();
  const window = { Pid: 41, InputRoot: 301 };
  assert.throws(() => owned(window, 250, 7, true), { Code: 'IDENTITY_CHANGED' });
  assert.doesNotThrow(() => owned(window, 250, 41, true));
  assert.throws(() => owned(window, 301, 0, true), { Code: 'IDENTITY_CHANGED' });
  assert.throws(() => owned(null, 301, 41, true), { Code: 'IDENTITY_CHANGED' });
  const before = 'pid == 0 || pid != window.Pid || hwnd != window.InputRoot && !child';
  const broken = harness(read(inputPath).replace(before, 'pid == 0 || hwnd != window.InputRoot && !child'));
  assert.doesNotThrow(() => broken.owned(window, 250, 7, true));
});

test('Drag commits the point after Post and DragTracked is gone', () => {
  const input = read(inputPath);
  assert.equal(input.includes('DragTracked'), false);
  const drag = input.slice(input.indexOf('internal static void Drag('));
  const post = drag.indexOf('Post(window, hwnd, 0x200, 1, packed);');
  const commit = drag.indexOf('last = packed;');
  assert.ok(post >= 0 && commit > post);
  assert.match(drag, /finally \{ Post\(window, hwnd, 0x202, 0, last, true\); \}/);
  for (const name of ['Driver.cs', 'DriverActions.cs', 'DriverUia.cs', 'Program.cs']) {
    const source = read(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url));
    assert.equal(source.includes('DragScript'), false, name);
  }
  assert.doesNotMatch(input, /DragScript\.\w+\s*=/);
  assert.equal(withoutTestSeams(input).includes('DragScript'), false);
});

function assertHooksCompiledOut(source) {
  const production = withoutTestSeams(source);
  if (production.includes('DragScript')) throw new Error('DragScript remains in the shipped driver');
  if ((source.match(/#if SLEIGHT_TEST_SEAMS/g) || []).length !== 5) throw new Error('SLEIGHT_TEST_SEAMS count');
}
test('DragScript hooks exist only inside SLEIGHT_TEST_SEAMS', () => {
  const input = read(inputPath);
  assertHooksCompiledOut(input);
  const host = readFileSync(new URL('../plugins/sleight/lib/direct-browser/windows-host.mjs', import.meta.url), 'utf8');
  assert.equal(host.includes('SLEIGHT_TEST_SEAMS'), false);
  const kit = readFileSync(new URL('./windows-driver-confinement-native.test.mjs', import.meta.url), 'utf8');
  const compile = kit.slice(kit.indexOf("spawnSync(join(framework, 'csc.exe')"));
  assert.match(compile.slice(0, 500), /\/define:SLEIGHT_TEST_SEAMS/);
});
test('a hook left outside SLEIGHT_TEST_SEAMS fails the production scan', () => {
  const input = read(inputPath);
  const hooked = '#if SLEIGHT_TEST_SEAMS\n        if (DragScript.Pause != null) { DragScript.Pause(milliseconds); return; }\n#endif';
  const broken = input.replace(hooked, '        if (DragScript.Pause != null) { DragScript.Pause(milliseconds); return; }');
  assert.notEqual(broken, input);
  assert.throws(() => assertHooksCompiledOut(broken), /DragScript remains/);
});
const winDir = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
function winSources() {
  return readdirSync(winDir).filter(name => name.endsWith('.cs')).sort().map(name => ({ name, text: read(new URL(name, winDir)) }));
}
function seamPolarity(cond) {
  const text = cond.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (text === 'SLEIGHT_TEST_SEAMS' || /^defined\s*\(\s*SLEIGHT_TEST_SEAMS\s*\)$/.test(text)) return 'test';
  if (text === '!SLEIGHT_TEST_SEAMS' || /^!\s*defined\s*\(\s*SLEIGHT_TEST_SEAMS\s*\)$/.test(text)) return 'prod';
  return 'unknown';
}
// Production leaves SLEIGHT_TEST_SEAMS unset. test: compiled only by that define.
// ship: compiled into the driver users get. dead: omitted for some other reason.
function lineRegions(source) {
  const lines = source.split('\n');
  const regions = [];
  const stack = [];
  const shipping = () => stack.every(frame => frame.ship);
  const inTest = () => stack.some(frame => frame.seamThen);
  const mark = () => { regions.push(inTest() && !shipping() ? 'test' : shipping() ? 'ship' : 'dead'); };
  for (const line of lines) {
    const trimmed = line.trim();
    const kind = (trimmed.match(/^#\s*(if|ifdef|ifndef|elif|else|endif)\b/) || [])[1];
    if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
      const rest = trimmed.replace(/^#\s*(?:if|ifdef|ifndef)\b/, '').trim();
      const pol = kind === 'if' ? seamPolarity(rest) : 'unknown';
      const parent = shipping();
      stack.push({ ship: parent && pol !== 'test', seamThen: parent && pol === 'test', parent, pol });
      mark();
      continue;
    }
    if (kind === 'else' || kind === 'elif') {
      const frame = stack.at(-1);
      if (!frame) throw new Error('unmatched #' + kind);
      const pol = kind === 'elif' ? seamPolarity(trimmed.replace(/^#\s*elif\b/, '').trim())
        : frame.pol === 'test' ? 'prod' : frame.pol === 'prod' ? 'test' : 'unknown';
      frame.pol = pol;
      frame.seamThen = frame.parent && pol === 'test';
      frame.ship = frame.parent && pol !== 'test';
      mark();
      continue;
    }
    if (kind === 'endif') {
      if (!stack.pop()) throw new Error('unmatched #endif');
      mark();
      continue;
    }
    mark();
  }
  if (stack.length) throw new Error('unclosed conditional');
  return regions;
}
function classStacks(source) {
  const stacks = [];
  const classes = [];
  let pending = [];
  let depth = 0;
  for (const line of source.split('\n')) {
    stacks.push(classes.map(item => item.name));
    const code = line.replace(/\/\/.*$/, '').replace(/"(?:\\.|[^"\\])*"/g, '""');
    for (const match of code.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)) pending.push(match[1]);
    for (const ch of code) {
      if (ch === '{') {
        if (pending.length) classes.push({ name: pending.shift(), depth });
        depth++;
      } else if (ch === '}') {
        depth--;
        while (classes.length && classes.at(-1).depth >= depth) classes.pop();
      }
    }
  }
  return stacks;
}
function fieldDecls(source) {
  const lines = source.split('\n');
  const regions = lineRegions(source);
  const classes = classStacks(source);
  const decls = [];
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    for (const match of code.matchAll(/\bstatic\b[^;\n{]*?\b([A-Za-z_]\w*)\s*;/g)) {
      decls.push({ type: classes[i].at(-1) || '', member: match[1], region: regions[i], line: i + 1 });
    }
  });
  return decls;
}
function seamCalls(source) {
  const lines = source.split('\n');
  const regions = lineRegions(source);
  const calls = [];
  const patterns = [
    /if\s*\(\s*((?:[A-Za-z_]\w*\.)+)([A-Za-z_]\w*)\s*!=\s*null\s*\)\s*\{[^{}]*\1\2\s*\(/,
    /if\s*\(\s*((?:[A-Za-z_]\w*\.)+)([A-Za-z_]\w*)\s*!=\s*null\s*\)\s*return\s+\1\2\s*\(/,
  ];
  lines.forEach((line, i) => {
    if (!/\breturn\b/.test(line)) return;
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      calls.push({ type: match[1].slice(0, -1).split('.').at(-1), member: match[2], region: regions[i], line: i + 1 });
    }
  });
  return calls;
}
function assertNoSeamDefine(files) {
  for (const file of files) {
    if (file.text.split('\n').some(line => /^\s*#\s*define\s+SLEIGHT_TEST_SEAMS\b/.test(line)))
      throw new Error('#define SLEIGHT_TEST_SEAMS in ' + file.name);
  }
}
function assertSeamMembers(files) {
  assertNoSeamDefine(files);
  const decls = [];
  const calls = [];
  for (const file of files) {
    for (const decl of fieldDecls(file.text)) decls.push(decl);
    for (const call of seamCalls(file.text)) calls.push({ ...call, file: file.name });
  }
  if (calls.length === 0) throw new Error('no seam call sites');
  for (const call of calls) {
    const name = call.type + '.' + call.member;
    if (call.region === 'ship') throw new Error('seam call ships: ' + name + ' ' + call.file + ':' + call.line);
    const matches = decls.filter(decl => decl.type === call.type && decl.member === call.member);
    if (matches.length === 0) throw new Error('seam member undeclared: ' + name);
    if (matches.some(decl => decl.region === 'ship')) throw new Error('seam member ships: ' + name);
    if (!matches.some(decl => decl.region === 'test')) throw new Error('seam member is outside SLEIGHT_TEST_SEAMS: ' + name);
  }
}
function withDriverInput(text) {
  return winSources().map(file => file.name === 'DriverInput.cs' ? { name: file.name, text } : file);
}
const pauseHook = '#if SLEIGHT_TEST_SEAMS\n        if (DragScript.Pause != null) { DragScript.Pause(milliseconds); return; }\n#endif';
test('every seam member is declared only inside SLEIGHT_TEST_SEAMS', () => {
  const files = winSources();
  assertSeamMembers(files);
  const calls = seamCalls(files.find(file => file.name === 'DriverInput.cs').text);
  assert.deepEqual(calls.map(call => call.type + '.' + call.member).sort(), ['DragScript.Logical', 'DragScript.Pause', 'DragScript.Person', 'DragScript.Post']);
  assert.equal(calls.every(call => call.region === 'test'), true);
});
test('a seam under another name outside SLEIGHT_TEST_SEAMS fails the scan', () => {
  const input = read(inputPath);
  const broken = input.replace(pauseHook, '        if (OtherSeam.Pause != null) { OtherSeam.Pause(milliseconds); return; }')
    .replace('#endif\n    internal static void Post(', '#endif\n    internal static class OtherSeam {\n        internal static Action<int> Pause;\n    }\n    internal static void Post(');
  assert.equal(broken.includes('OtherSeam'), true);
  assert.equal(withoutTestSeams(broken).includes('DragScript'), false);
  assert.throws(() => assertSeamMembers(withDriverInput(broken)), /seam (call|member) ships: OtherSeam\.Pause/);
});
test('a seam in an #else branch fails the scan', () => {
  const input = read(inputPath);
  const broken = input.replace(pauseHook, '#if SLEIGHT_TEST_SEAMS\n#else\n        if (ElseHook.Pause != null) { ElseHook.Pause(milliseconds); return; }\n#endif')
    .replace('#endif\n    internal static void Post(', '#endif\n#if SLEIGHT_TEST_SEAMS\n#else\n    internal static class ElseHook {\n        internal static Action<int> Pause;\n    }\n#endif\n    internal static void Post(');
  assert.equal(withoutTestSeams(broken).includes('ElseHook'), false);
  assert.throws(() => assertSeamMembers(withDriverInput(broken)), /seam (call|member) ships: ElseHook\.Pause/);
});
test('a source #define SLEIGHT_TEST_SEAMS fails the scan', () => {
  const broken = '#define SLEIGHT_TEST_SEAMS\n' + read(inputPath);
  assert.throws(() => assertSeamMembers(withDriverInput(broken)), /#define SLEIGHT_TEST_SEAMS in DriverInput\.cs/);
});
test('SF4 harness case drives one-argument LiveHostedAppPid with its own window', () => {
  const source = read(new URL('./fixtures/windows-driver-confinement-checks.cs', import.meta.url));
  const start = source.indexOf('Case("SF4 the one-argument LiveHostedAppPid reads a harness window the test owns"');
  const end = source.indexOf('Case("T30', start);
  const row = source.slice(start, end);
  const helper = source.slice(source.indexOf('static IntPtr CreateHidden('), source.indexOf('static extern IntPtr DefWindowProcW'));
  assert.ok(start >= 0 && end > start && helper.includes('CreateWindowExW'));
  assert.match(row, /CreateHidden\("ApplicationFrameWindow", IntPtr\.Zero\)/);
  assert.match(row, /LiveHostedAppPid\(frame\)/);
  assert.match(row, /LiveHostedAppPid\(IntPtr\.Zero\)/);
  assert.doesNotMatch(source, /ShowWindow/);
});
test('SF4 Check child wiring refuses the wrong pid and skips the predicate on the input root', () => {
  const input = read(inputPath);
  const owned = compile(input, 'internal static void RequireOwned(', ['window', 'hwnd', 'pid', 'child']);
  const check = method(input, 'internal static void Check(WindowRecord window, IntPtr hwnd, uint pid, Func<IntPtr, IntPtr, bool> child, Func<IntPtr, WindowRecord> observe)',
    ['window', 'hwnd', 'pid', 'child', 'observe'], { RequireOwned: owned });
  const window = { Pid: 41, Handle: 101, InputRoot: 101, RequireReadable() {}, SameIdentity(other) { return other === window; } };
  let calls = 0;
  assert.throws(() => check(window, 250, 7, () => { calls++; return true; }, () => window), { Code: 'IDENTITY_CHANGED' });
  assert.equal(calls, 1);
  calls = 0;
  let seen = [];
  check(window, 250, 41, (parent, child) => { calls++; seen = [parent, child]; return true; }, () => window);
  assert.equal(calls, 1);
  assert.deepEqual(seen, [101, 250]);
  calls = 0;
  check(window, 101, 41, () => { calls++; return true; }, () => window);
  assert.equal(calls, 0);
  assert.throws(() => check(window, 250, 41, () => false, () => window), { Code: 'IDENTITY_CHANGED' });
  assert.throws(() => check(window, 101, 41, () => false, () => null), { Code: 'IDENTITY_CHANGED' });
  const broken = input.replace('hwnd != window.InputRoot && child(window.InputRoot, hwnd)', 'child(window.InputRoot, hwnd)');
  const loose = method(broken, 'internal static void Check(WindowRecord window, IntPtr hwnd, uint pid, Func<IntPtr, IntPtr, bool> child, Func<IntPtr, WindowRecord> observe)',
    ['window', 'hwnd', 'pid', 'child', 'observe'], { RequireOwned: owned });
  calls = 0;
  loose(window, 101, 41, () => { calls++; return true; }, () => window);
  assert.equal(calls, 1);
});
test('SF4 one-argument LiveHostedAppPid wires ClassOf and PidOf', () => {
  const inventory = read(inventoryPath);
  const one = body(inventory, 'internal static uint? LiveHostedAppPid(IntPtr hwnd)');
  assert.match(one, /return LiveHostedAppPid\(hwnd, RootWindow, ClassOf, CoresOf, PidOf\);/);
  const classOf = method(inventory, 'internal static string ClassOf(', ['handle'], {
    StringBuilder: class StringBuilder { constructor(capacity) { this.Capacity = capacity; this.text = ''; } ToString() { return this.text; } },
    GetClassNameW: (handle, name) => { name.text = handle === 401 ? 'ApplicationFrameWindow' : ''; return name.text.length; },
  });
  const pidOf = runInNewContext(`(handle, GetWindowThreadProcessId) => { ${body(inventory, 'internal static uint PidOf(').replace('uint pid;', 'let pid;').replace('GetWindowThreadProcessId(handle, out pid)', 'GetWindowThreadProcessId(handle, value => { pid = value; })')} }`);
  const { hosted } = harness();
  const readPid = handle => pidOf(handle, (ignored, set) => { set(handle === 301 ? 41 : 0); return handle === 301 ? 5 : 0; });
  assert.equal(hosted(401, hwnd => hwnd, classOf, () => [301], readPid), 41);
  const unread = method(inventory, 'internal static string ClassOf(', ['handle'], {
    StringBuilder: class StringBuilder { constructor(capacity) { this.Capacity = capacity; } ToString() { return ''; } },
    GetClassNameW: () => 0,
  });
  assert.equal(hosted(401, hwnd => hwnd, unread, () => [301], readPid), 0);
  const deadPid = handle => pidOf(handle, (ignored, set) => { set(41); return 0; });
  assert.equal(hosted(401, hwnd => hwnd, classOf, () => [301], deadPid), 0);
  assert.equal(hosted(0, hwnd => hwnd, classOf, () => [301], readPid), 0);
});
