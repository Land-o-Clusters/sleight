import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsPersonDecision, windowsSessionDecision, windowsSafetyFixture, windowsSessionReadFixture } from './fixtures/windows-driver-fake.mjs';
import { WINDOWS_DRIVER_ERRORS, formatWindowsDriverError } from '../plugins/sleight/lib/windows-driver/errors.mjs';
import { inputSeams, effectBoundary, withoutTestSeams } from './fixtures/windows-review-seams.mjs';
import { createWindowsDriverClient } from '../plugins/sleight/lib/windows-driver/client.mjs';

const native = (name, read = readFileSync) => read(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('guard mutation reader normalizes CRLF before matching native bodies', () => {
  const text = native('DriverInput.cs');
  assert.equal(native('DriverInput.cs', () => text.replace(/\n/g, '\r\n')), text);
});
const files = ['DriverInput.cs', 'DriverInventory.cs', 'DriverActions.cs', 'DriverUia.cs', 'DriverCapture.cs', 'DriverSettle.cs', 'Driver.cs'];
const sources = () => Object.fromEntries(files.map(name => [name, native(name)]));
const personRows = [
  [[0, 41, 42, 41], 'person-active'], [[499, 41, 42, 41], 'person-active'],
  [[500, 41, 41, 41], null], [[501, 41, 41, 41], null], [[600, 41, 41, 41], null],
  [[100, 42, 41, 41], 'person-active'], [[100, 42, 43, 41], null],
  [[0x80000000, 41, 41, 41], 'person-unknown'], [[0xffffffff, 41, 41, 41], 'person-unknown'],
  [[100, 0, 42, 41], 'person-unknown'], [[100, 42, 0, 41], 'person-unknown'],
  [[100, 42, 43, 0], 'person-unknown'], [[50, 41, 43, 41], 'person-active'],
];
const sessionRows = [
  [[false, 0, 1, true, 'Default'], 'session-unknown'], [[true, 0, -1, true, 'Default'], 'session-unknown'],
  [[true, 0, 2, true, 'Default'], 'session-unknown'], [[true, 4, 1, true, 'Default'], 'session-disconnected'],
  [[true, 1, 1, true, 'Default'], 'session-disconnected'], [[true, 0, 0, true, 'Winlogon'], 'session-locked'],
  [[true, 0, 0, true, 'Default'], 'session-locked'], [[true, 0, 1, true, 'Default'], null],
  [[true, 0, 1, true, 'Screen-saver'], 'screensaver'], [[true, 0, 1, true, 'Winlogon'], 'secure-desktop'],
  [[true, 0, 1, false, null], 'secure-desktop'], [[true, 0, 1, true, 'Other'], 'input-desktop-unavailable'],
  [[true, 0, 1, true, null], 'input-desktop-unavailable'], [[true, 0, 1, true, 'default'], 'input-desktop-unavailable'],
];

// Execute only the two pure C# decision bodies after removing their scalar type
// suffixes. This checks the production table as well as its independently written JS mirror.
function decision(source, className, args) {
  const region = source.slice(source.indexOf('internal static class ' + className));
  const body = /internal static string Decide\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(region)?.[1];
  assert.ok(body, className + '.Decide missing');
  assert.doesNotMatch(body, /\b(?:Marshal|DllImport|Sample|Require)\b/);
  return runInNewContext(`(${args.join(',')}) => { ${body.replace(/(0x[\da-f]+|\d+)u\b/gi, '$1')} }`);
}
function assertTables(source) {
  const person = decision(source['DriverInput.cs'], 'DriverPerson', ['ageMs', 'foregroundPid', 'pointerPid', 'targetPid']);
  const session = decision(source['DriverInventory.cs'], 'DriverSession', ['wtsOk', 'state', 'flags', 'desktopOpened', 'desktopName']);
  for (const [args, expected] of personRows) assert.equal(person(...args), expected, JSON.stringify(args));
  for (const [args, expected] of sessionRows) assert.equal(session(...args), expected, JSON.stringify(args));
}
function assertSites(source) {
  const input = source['DriverInput.cs'], actions = source['DriverActions.cs'];
  assert.match(input, /if \(!cleanup\) api.Person\(window\);\s*return api.Send\(hwnd, message, wParam, lParam\);/);
  assert.match(input, /api.Error, api.Pause, \(\) => \{ if \(!cleanup\) EnsureBudget\(\); api.Identity\(window, hwnd\); \}/);
  assert.match(input, /void SetValue\([^]*?EnsureBudget\(\); Check\(window, hwnd\); DriverPerson.Require\(window\); MarkInput\(\);/);
  assert.match(input, /Action check = \(\) => \{\s*DriverPerson.Require\(window\);/);
  assert.match(input, /for \(int i = 1; i <= steps; i\+\+\) \{\s*DriverPerson.Require\(window\);/);
  const apply = actions.slice(actions.indexOf('void EffectBoundary('), actions.indexOf('DriverNode ResolveTarget'));
  assert.match(apply, /DriverInput.EnsureBudget\(\);/);
  assert.match(apply, /\}, \(\) => DriverPerson.Require\(window\), DriverInput.MarkInput\);/);
  assert.match(apply, /Live\(node, window\);\s*DriverIdentity.Verify\(window, DriverInventory.Observe\(window.Handle\)\);/);
  assert.match(actions, /clipboardAdmission = clipboardWatch.Admit\(\);\s*DriverPerson.Require\(window\);\s*settle.Begin\(\);/);
  assert.match(actions, /Effect\(\(\) => EffectBoundary\(node, window\), found.Select\)/);
  assert.match(actions, /Effect\(\(\) => EffectBoundary\(node, window\), \(\) => p.SetValue\(plan.Text\)\)/);
  assert.match(actions, /Effect\(\(\) => EffectBoundary\(node, window\), \(\) => \(\(IScroll\)scroll\).Scroll/);
  assert.match(actions, /DriverSession.Require\(\); DriverOperationCounters.Mark\(DriverOperationCounters.Kind.FinalRead\); result = Json.Object\(Read\(window, DriverInventory.Windows\(\), deadline\)\)/);
  assert.match(source['Driver.cs'], /DriverSession.Require\(\);\s*DriverIdentity.BeginRequest\(\);/);
  assert.match(source['Driver.cs'], /Driver deadline exceeded[^]*?DriverSession.DeadlineHint\(\)/);
  assert.match(source['DriverUia.cs'], /object Read\([^]*?new DriverSession.ReadProbe\(\)/);
  assert.match(source['DriverCapture.cs'], /WindowRecord VerifySurface\([^]*?DriverSession.Require\(\);/);
  assert.match(source['DriverCapture.cs'], /object> Capture\(WindowRecord window\)\s*\{\s*DriverSession.Require\(\);/);
  assert.match(source['DriverSettle.cs'], /if \(mode == "cap" \|\| mode == "budget"\) DriverSession.AddHint\(result\);/);
  assert.match(source['DriverSettle.cs'], /DriverSession.Require\(\);\s*string current = snapshot\(\);/);
}

test('13 person and 14 session rows match the production tables and JS mirrors', () => {
  assertTables(sources());
  for (const [args, expected] of personRows) assert.equal(windowsPersonDecision(...args), expected);
  for (const [args, expected] of sessionRows) assert.equal(windowsSessionDecision(...args), expected);
});
test('native safety sites include cleanup exemptions, all input routes, reads, capture and deadline hints', () => assertSites(sources()));
test('Expand/Collapse observes state before its last checkpoint and posts no mutation after refusal', () => {
  const actions = native('DriverActions.cs');
  const body = /void ExpandCollapse\(Func<int> readState, Action checkpoint, Action expand, Action collapse\)\s*\{([^]*?)\n    \}/.exec(actions)?.[1];
  assert.ok(body, 'injectable production Expand/Collapse boundary exists');
  const apply = runInNewContext(`(readState, checkpoint, expand, collapse) => { ${body.replace('int state', 'let state')} }`);
  for (const state of [0, 1]) for (const code of ['PERSON_TOOK_OVER', 'SCREEN_LOCKED', 'SECURE_DESKTOP_ACTIVE']) {
    const order = []; let observed = false;
    assert.throws(() => apply(() => { order.push('state'); observed = true; return state; },
      () => { order.push('checkpoint'); if (observed) throw Object.assign(Error(code), { code }); },
      () => order.push('expand'), () => order.push('collapse')), { code });
    assert.deepEqual(order, ['state', 'checkpoint']);
  }
  const applyBody = actions.slice(actions.indexOf('void Apply('), actions.indexOf('DriverNode ResolveTarget'));
  assert.match(applyBody, /ExpandCollapse\(expand.State, checkpoint, expand.Expand, expand.Collapse\)/);
  assert.ok(applyBody.indexOf('if (name == "Expand/Collapse")') < applyBody.indexOf('\n        Effect(checkpoint,'));
});
test('reads and settle snapshots memoize fetch probes but sample fresh before returning', () => {
  const actions = native('DriverActions.cs');
  const snapshot = actions.slice(actions.indexOf('string Snapshot('));
  for (const region of [snapshot, native('DriverUia.cs').slice(native('DriverUia.cs').indexOf('internal object Read('))]) {
    assert.match(region, /new DriverSession.ReadProbe\(\)/);
    assert.match(region, /\(\) => \{ session.Require\(\); return nodes.Count/);
    assert.match(region, /session.Finish\(\);\s*return /);
  }
  assert.match(actions, /DriverSession.IsSafety\(e\)\) throw;/);
});
// As with Decide above, evaluate the small production C# body with only scalar
// syntax and the unavailable clock/native calls adapted. No Windows APIs run.
function readProbe(source = native('DriverInventory.cs')) {
  const body = /internal sealed class ReadProbe\s*\{([^]*?)\n    \}/.exec(source)?.[1];
  assert.ok(body, 'production read memo exists');
  const js = body.replace(/readonly Stopwatch clock = new Stopwatch\(\);/, '')
    .replace(/internal ReadProbe\(\)/, 'constructor()')
    .replace(/internal void (\w+)\(\)/g, '$1()')
    .replace(/DriverSession.Require\(\)/g, 'sample()');
  return ({ sample, now }) => {
    let began = now();
    const clock = { get ElapsedMilliseconds() { return now() - began; }, Start() { began = now(); }, Restart() { began = now(); } };
    return runInNewContext(`new (class { ${js} })()`, { sample, clock });
  };
}
test('a 1,000-node read makes 2 probes at 0 ms and 22 probes at 1,000 ms', () => {
  for (const makeProbe of [undefined, readProbe()]) {
    for (const [nodeMs, probes] of [[0, 2], [1, 22]]) {
      const fake = windowsSessionReadFixture({ makeProbe });
      assert.equal(fake.read({ nodes: 1000, nodeMs }).nodes, 1000);
      assert.equal(fake.probes.length, probes);
    }
  }
});
test('locks and secure desktops during a read refuse at memo expiry or the fresh end probe', () => {
  for (const makeProbe of [undefined, readProbe()]) for (const scenario of ['locked', 'secure']) {
    for (const [nodes, nodeMs, lockAt, probes] of [[1000, 1, 50, 2], [1000, 0.04, 10, 2]]) {
      const fake = windowsSessionReadFixture({ makeProbe, scenario, lockAt });
      assert.throws(() => fake.read({ nodes, nodeMs }), { code: scenario === 'locked' ? 'SCREEN_LOCKED' : 'SECURE_DESKTOP_ACTIVE' });
      assert.equal(fake.probes.length, probes);
      assert.equal(fake.results.length, 0);
    }
  }
});
test('input and the next read never reuse an earlier read memo', () => {
  for (const makeProbe of [undefined, readProbe()]) {
    const fake = windowsSessionReadFixture({ makeProbe, lockAt: 1 });
    fake.read({ nodes: 1000, nodeMs: 0 });
    fake.advance(1);
    assert.throws(() => fake.input(), { code: 'SCREEN_LOCKED' });
    assert.throws(() => fake.read({ nodes: 1, nodeMs: 0 }), { code: 'SCREEN_LOCKED' });
    assert.equal(fake.probes.length, 4);
    assert.deepEqual(fake.posts, []);
  }
  assert.match(withoutTestSeams(native('DriverInput.cs')), /void Require\(WindowRecord window\)\s*\{\s*DriverSession\.Require\(\);/);
});
test('every non-ping Dispatch result passes a final fresh session probe', () => {
  const dispatch = native('Driver.cs').slice(native('Driver.cs').indexOf('static object Dispatch('), native('Driver.cs').indexOf('static string Encode('));
  assert.match(dispatch, /object result = DispatchCore\(request, ref reader\);\s*if \(request.Method != "ping"\) DriverSession.Require\(\);\s*DriverInput.EnsureNotCancelled\(\);\s*return result;/);
});
test('person input timestamp is read before TickCount', () => {
  assert.match(native('DriverInput.cs'), /uint last = DriverInput.LastPersonInput\(\);\s*age = unchecked\(\(uint\)Environment.TickCount - last\);/);
});
test('a two-unit character or CRLF cannot cross the 64-unit checkpoint boundary', () => {
  const input = native('DriverInput.cs');
  const body = /bool TextCheckpoint\(int index, int units, int nextCheck\)\s*\{([^}]+)\}/.exec(input)?.[1];
  assert.ok(body, 'production UTF-16 checkpoint decision exists');
  const checkpoint = runInNewContext(`(index, units, nextCheck) => { ${body} }`);
  assert.equal(checkpoint(63, 1, 64), false);
  assert.equal(checkpoint(63, 2, 64), true);
  assert.equal(checkpoint(64, 1, 64), true);
  assert.match(input, /if \(TextCheckpoint\(i, units, nextCheck\)\) \{ check\(\); nextCheck = i \+ 64; \}/);
  for (const pair of ['🪄', '\r\n']) {
    const text = 'a' + pair.repeat(100);
    let next = 0, since = 0;
    for (let i = 0; i < text.length;) {
      const units = i === 0 ? 1 : 2;
      if (checkpoint(i, units, next)) { assert.ok(since <= 64); since = 0; next = i + 64; }
      since += units; i += units;
    }
    assert.ok(since <= 64);
  }
});
test('twelve broken UC3F variants each fail the table or boundary contract', () => {
  const original = sources();
  const variants = [
    ['DriverInput.cs', 'ageMs < 500', 'ageMs <= 500'],
    ['DriverInput.cs', 'foregroundPid == targetPid || pointerPid == targetPid', 'false'],
    ['DriverInput.cs', 'if (!cleanup) api.Person(window);', 'api.Person(window);'],
    ['DriverInventory.cs', 'return "session-unknown";', 'return null;'],
    ['DriverInventory.cs', 'return "screensaver";', 'return null;'],
    ['DriverInventory.cs', 'if (flags == 0)', 'if (flags == 1)'],
    ['DriverInput.cs', 'for (int i = 1; i <= steps; i++) {\n                DriverPerson.Require(window);', 'for (int i = 1; i <= steps; i++) {'],
    ['DriverActions.cs', '}, () => DriverPerson.Require(window), DriverInput.MarkInput);', '}, () => { }, DriverInput.MarkInput);'],
    ['DriverInput.cs', 'Check(window, hwnd); DriverPerson.Require(window); MarkInput();', 'Check(window, hwnd); MarkInput();'],
    ['DriverActions.cs', 'DriverSession.Require(); DriverOperationCounters.Mark(DriverOperationCounters.Kind.FinalRead); result = Json.Object(Read', 'DriverOperationCounters.Mark(DriverOperationCounters.Kind.FinalRead); result = Json.Object(Read'],
    ['DriverSettle.cs', 'if (mode == "cap" || mode == "budget") DriverSession.AddHint(result);', 'if (mode == "budget") DriverSession.AddHint(result);'],
    ['DriverSettle.cs', 'DriverSession.Require();\n                string current = snapshot();', 'string current = snapshot();'],
  ];
  variants.forEach(([file, before, after], i) => {
    assert.ok(original[file].includes(before), `mutation ${i + 1} applied`);
    const changed = { ...original, [file]: original[file].replace(before, after) };
    assert.throws(() => { assertTables(changed); assertSites(changed); }, { code: 'ERR_ASSERTION' }, `variant ${i + 1}`);
  });
});

const sites = ['admission', 'post', 'retry', 'pump', 'drag', 'pattern', 'setValue', 'selectText', 'scroll', 'final-read', 'read', 'capture', 'surface'];
for (const scenario of ['person', 'locked', 'secure']) test(`${scenario} refuses at all applicable fake sites and cleanup still runs`, () => {
  for (const site of sites) {
    if (scenario === 'person' && ['final-read', 'read', 'capture', 'surface'].includes(site)) continue;
    const fixture = windowsSafetyFixture({ scenario, site });
    const result = fixture.run(site);
    assert.equal(result.code, scenario === 'person' ? 'PERSON_TOOK_OVER' : scenario === 'locked' ? 'SCREEN_LOCKED' : 'SECURE_DESKTOP_ACTIVE', site);
    assert.equal(result.unhealthy, false);
    assert.equal(result.delivery, ['admission', 'post', 'pattern', 'setValue', 'selectText', 'scroll', 'read', 'capture', 'surface'].includes(site) ? 'not-sent' : 'sent-unverified', site);
    assert.equal(result.retry, result.delivery === 'not-sent' ? 'safe' : 'read-first');
    assert.equal(fixture.posts.filter(effect => effect !== 'prior-input').length + fixture.patterns.length + fixture.reads.length, 0);
    assert.deepEqual(fixture.cleanup, ['key-up', 'mouse-up']);
    const line = formatWindowsDriverError(result, { action: true });
    assert.ok(line.includes(WINDOWS_DRIVER_ERRORS[result.code].message));
    if (result.delivery !== 'not-sent') assert.match(line, /Read the app state before repeating/);
  }
});
test('typed progress, tick wrap, session-first priority, secure hints and no sticky desktop state', () => {
  const fixture = windowsSafetyFixture({ scenario: 'person', site: 'pump' });
  assert.equal(fixture.run('pump').typed, 64);
  assert.equal(windowsPersonDecision((0x10 - 0xfffffff0) >>> 0, 41, 42, 41), 'person-active');
  assert.equal(windowsSafetyFixture({ scenario: 'locked', site: 'pattern', person: true }).run('pattern').code, 'SCREEN_LOCKED');
  for (const mode of ['cap', 'budget', 'deadline', 'ACTION_BUDGET']) {
    assert.deepEqual(windowsSafetyFixture({ scenario: 'secure' }).hint(mode), ['secure-desktop-seen']);
  }
  const secure = windowsSafetyFixture({ scenario: 'secure' });
  secure.run('read'); secure.unlock();
  assert.equal(secure.run('read').code, undefined);
});
for (const scenario of ['person', 'locked', 'secure']) test(`${scenario} wire scenario refuses with a healthy helper, ping still works`, async t => {
  const client = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn: ({ nonce }) => spawn(process.execPath,
    [fileURLToPath(new URL('./fixtures/windows-driver-fake.mjs', import.meta.url)), scenario],
    { env: { SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'] }) }) });
  t.after(() => client.close());
  await client.request('ping', {});
  const binding = { windowId: '101', processStart: '134059077770000001', readId: 1 };
  if (scenario !== 'person') {
    for (const method of ['getState', 'listApps', 'getApp', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'verifyWindowIdentity']) {
      const params = method === 'getApp' ? { selector: 'Notepad' } : ['getState', 'listApps'].includes(method) ? {} :
        { windowId: binding.windowId, processStart: binding.processStart };
      await assert.rejects(client.request(method, params),
        error => error.code === (scenario === 'locked' ? 'SCREEN_LOCKED' : 'SECURE_DESKTOP_ACTIVE') && error.unhealthy === false);
    }
  } else {
    const read = await client.request('getApp', { selector: 'Notepad' });
    binding.readId = read.readId;
  }
  const forms = { click: [3], doubleClick: [3], rightClick: [3], setValue: [3, 'hello'], typeText: ['hello'],
    pressKey: ['Return'], paste: ['hello'], scroll: [3, { direction: 'down', amount: 2 }], selectText: [3, 'hello'],
    performSecondaryAction: [3, 'Invoke'], drag: [[1, 2], [20, 30]], stuckMenuEscape: ['Escape'] };
  for (const [method, args] of Object.entries(forms)) await assert.rejects(client.request(method, { ...binding, args }), error =>
    error.code === (scenario === 'person' ? 'PERSON_TOOK_OVER' : scenario === 'locked' ? 'SCREEN_LOCKED' : 'SECURE_DESKTOP_ACTIVE') &&
      error.unhealthy === false && error.message.includes('delivery=not-sent') && error.message.includes('retry=safe'));
  await client.request('ping', {});
});

test('Entry preserves the six refusal fields without replacing its error identity', () => {
  const driver = native('Driver.cs');
  const body = /Dictionary<string, object> ErrorValue\(Exception error\)\s*\{([^]*?)\n    \}/.exec(driver)?.[1];
  assert.ok(body, 'production error envelope builder exists');
  const js = body.replace('error as DriverFault', '(error.Code === undefined ? null : error)')
    .replace(/var /g, 'let ')
    .replace(/foreach \(string key in new\[\] \{([^}]+)\}\)/, 'for (const key of [$1])')
    .replace(/fault.Disposition.ContainsKey\(key\)/g, 'Object.hasOwn(fault.Disposition, key)');
  const Json = { Map(...pairs) { return Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_, i) => pairs.slice(i * 2, i * 2 + 2))); } };
  const envelope = runInNewContext(`error => { ${js} }`, { Json });
  for (const [Code, reason, sent] of [['PERSON_TOOK_OVER', 'person-active', false], ['SCREEN_LOCKED', 'session-locked', true], ['SECURE_DESKTOP_ACTIVE', 'secure-desktop', true]]) {
    const fields = { delivery: sent ? 'sent-unverified' : 'not-sent', retry: sent ? 'read-first' : 'safe', reason,
      typed: sent ? 64 : 0, personTookOver: Code === 'PERSON_TOOK_OVER', limits: reason === 'secure-desktop' ? ['secure-desktop-seen'] : [],
      code: 'spoofed', message: 'spoofed', unhealthy: true, extra: 'drop' };
    const result = envelope({ Code, Message: 'diagnostic', Disposition: fields });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { code: Code, message: 'diagnostic', unhealthy: false,
      delivery: fields.delivery, retry: fields.retry, reason, typed: fields.typed, personTookOver: fields.personTookOver, limits: fields.limits });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(envelope({ Code: 'STALE_READ', Message: 'STALE_READ' }))),
    { code: 'STALE_READ', message: 'STALE_READ', unhealthy: false });
  assert.deepEqual(JSON.parse(JSON.stringify(envelope(Error('private')))),
    { code: 'UIA_UNAVAILABLE', message: 'Windows automation is unavailable.', unhealthy: false });
  assert.match(driver, /else response.Add\("error", ErrorValue\(job.Error\)\);/);
});
test('settle hints are merged into top-level limits after route-specific limits', () => {
  const actions = native('DriverActions.cs');
  const scroll = actions.indexOf('if (plan.Method == "scroll") limits =');
  const merge = actions.indexOf('limits = limits.Concat((string[])settleResult["limits"]).Distinct().ToArray();');
  assert.ok(scroll >= 0 && merge > scroll && merge < actions.indexOf('result.Add("limits", limits)'));
});
test('unconfirmed errors retain the cause code and budget secure-desktop diagnostics', () => {
  const actions = native('DriverActions.cs');
  const matches = [...actions.matchAll(/new DriverFault\("ACTION_UNCONFIRMED", (e.Code == "ACTION_BUDGET" \? e.Message : e.Code)\)/g)];
  assert.equal(matches.length, 2, 'both settle and final-read errors retain the cause code');
  for (const [Code, Message, expected] of [['BACKGROUND_UNAVAILABLE', 'detail', 'BACKGROUND_UNAVAILABLE'],
    ['ACTION_BUDGET', 'ACTION_BUDGET limits=[secure-desktop-seen].', 'ACTION_BUDGET limits=[secure-desktop-seen].']]) {
    const detail = runInNewContext(`e => ${matches[0][1]}`)({ Code, Message });
    assert.equal(detail, expected);
  }
});


test('ReadProbe exists only as a local in Read and Snapshot, never at an input site', () => {
  const source = sources();
  const uses = Object.entries(source).flatMap(([name, text]) => [...text.matchAll(/new DriverSession\.ReadProbe\(\)/g)].map(match => ({ name, index: match.index, text })));
  assert.equal(uses.length, 2);
  for (const { name, index, text } of uses) {
    assert.ok(['DriverUia.cs', 'DriverActions.cs'].includes(name));
    assert.match(text.slice(index - 14, index), /var session = $/);
    const method = name === 'DriverUia.cs' ? 'object Read(' : 'string Snapshot(';
    const masked = text.replace(/\/\/[^\n]*|\/\*[^]*?\*\/|"(?:\\.|[^"\\])*"/g, token => ' '.repeat(token.length));
    const start = masked.indexOf('{', masked.indexOf(method));
    let end = start + 1, depth = 1;
    for (; depth && end < masked.length; end++) { if (masked[end] === '{') depth++; if (masked[end] === '}') depth--; }
    assert.ok(index > start && index < end, 'constructor belongs to ' + method);
    assert.doesNotMatch(text, /(?:DriverSession\.)?ReadProbe\s+\w+\s*[;=]/);
  }
  assert.doesNotMatch(source['DriverInput.cs'], /ReadProbe/);
});

test('Post resamples person immediately before every send after Observe work', () => {
  for (const message of [0x102, 0x201]) for (const validated of [false, true]) {
    const order = []; let active = false;
    const { post } = inputSeams();
    const api = { Identity() { order.push('observe'); active = true; },
      Person() { order.push('person'); if (active) throw Object.assign(Error('PERSON_TOOK_OVER'), { code: 'PERSON_TOOK_OVER' }); },
      Send() { order.push('send'); return true; }, Point() { return { X: 2, Y: 2 }; },
      Surface() { return { Left: 0, Top: 0, Right: 10, Bottom: 10 }; } };
    assert.throws(() => post({}, 101, message, 0, 0, false, validated, false, false, api), { code: 'PERSON_TOOK_OVER' });
    assert.equal(order.at(-1), 'person'); assert.ok(order.includes('observe')); assert.ok(!order.includes('send'));
  }
});
test('UIA EffectBoundary checks person after the final Observe and refuses before MarkInput', () => {
  const order = []; let active = false;
  assert.throws(() => effectBoundary()(() => { order.push('observe'); active = true; },
    () => { order.push('person'); if (active) throw Error('person'); }, () => order.push('mark')), /person/);
  assert.deepEqual(order, ['observe', 'person']);
});
