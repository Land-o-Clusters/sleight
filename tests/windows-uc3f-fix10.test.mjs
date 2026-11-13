import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const variant = process.env.UC3GFIX10_BROKEN;
const variants = {
  'core-admitted-by-name': ['plugins/sleight/lib/driver-safety.mjs', 'const selector = params.selector;', `const selector = params.selector;
      if (selector === 'Calculator') state.windows.forEach(w => { w.className = 'Win32'; });`],
  'core-admitted-by-aumid': ['plugins/sleight/lib/driver-safety.mjs', 'const selector = params.selector;', `const selector = params.selector;
      if (selector === 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App') state.windows.forEach(w => { w.className = 'Win32'; });`],
  'identity-aumid-bypass': ['plugins/sleight/lib/repl/identity.mjs', "/i.test(observed.className ?? ''))", "/i.test(observed.className ?? '') && !observed.aumid)"],
  'lookup-hash-ignored': ['plugins/sleight/lib/driver-safety.mjs', 'w.hostedSelectorHashes?.includes(hash)', 'false'],
  'calculator-name-read-omitted': ['bench/windows/uc3f-collect.mjs', "['Calculator', aumid, String(receipt.pid)", '[aumid, String(receipt.pid)'],
  'calculator-success-accepted': ['bench/windows/uc3f-collect.mjs', "    fail('FIXTURE_REFUSAL_UNPROVED');", '    continue;'],
  'calculator-multiple-processes': ['bench/windows/uc3f-collect.mjs', 'copy.calculatorProcesses.length !== 1', 'copy.calculatorProcesses.length < 1'],
  'calculator-cloaked-frame-ignored': ['bench/windows/uc3f-collect.mjs', 'copy.newFrameIds.length !== 1', 'copy.newFrameIds.length < 1'],
  'calculator-birth-equal-accepted': ['bench/windows/uc3f-collect.mjs', 'BigInt(copy.launcher.processStart) <= BigInt(copy.activationSince)', 'BigInt(copy.launcher.processStart) < BigInt(copy.activationSince)'],
  'calculator-input': ['bench/windows/uc3f-collect.mjs', "['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].map(method =>", "['click', 'getScreenshot', 'getAXStateAndScreenshot'].map(method =>"],
  'projection-drops-lookups': ['bench/windows/uc3f-collect.mjs', "interval.caseId === 'calculator-refused' ? ['getApp'] : []", "false ? ['getApp'] : []"],
};
if (variant && !variants[variant]) throw Error('UNKNOWN_TEST_VARIANT');
async function production(path, replacements = {}) {
  const url = new URL(path, root);
  let source = readFileSync(url, 'utf8');
  const mutation = variants[variant];
  if (mutation?.[0] === path) {
    assert.ok(source.includes(mutation[1]), variant + ': anchor');
    source = source.replace(mutation[1], mutation[2]);
  }
  source = source.replace(/from '([^']+)'/g, (all, target) => {
    if (!target.startsWith('.')) return all;
    const absolute = new URL(target, url).href;
    return `from '${replacements[absolute] ?? absolute}'`;
  }).replaceAll('import.meta.url', JSON.stringify(url.href));
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}
const identityURL = await production('plugins/sleight/lib/repl/identity.mjs');
const identity = await import(identityURL);
const safetyURL = await production('plugins/sleight/lib/driver-safety.mjs', {
  [new URL('plugins/sleight/lib/windows-repl/identity.mjs', root).href]: identityURL,
});
const { createDriverSafety } = await import(safetyURL);
const collector = await import(await production('bench/windows/uc3f-collect.mjs'));
const birth = '134381325118728105', aumid = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
const window = () => ({ windowId: '99', pid: 4240, processStart: birth, image: 'C:\\Apps\\CalculatorApp.exe',
  imageIdentity: '134381300000000000:4096', className: 'Windows.UI.Core.CoreWindow', title: 'Calculator', app: 'CalculatorApp', aumid, integrity: 'medium' });
const proof = () => ({ refusalOnly: true, baselineWindows: ['12'], activationSince: '134381325118000000',
  calculatorProcesses: [{ pid: 4240, processStart: birth }], newFrameIds: ['99'],
  launcher: { pid: 4240, processStart: birth, observedEnd: '134381325128728105', image: 'C:\\Apps\\CalculatorApp.exe' },
  activation: { aumid, pid: 4240, processStart: birth, exited: false },
  expectedImage: 'C:\\Apps\\CalculatorApp.exe', frameHostImage: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', systemDirectory: 'C:\\Windows\\System32',
  windows: [{ ...window(), className: 'ApplicationFrameWindow', coreWindowId: '100', corePid: 4240,
    coreProcessStart: birth, coreTitle: 'Calculator', coreClassName: 'Windows.UI.Core.CoreWindow',
    framePid: 2812, frameProcessStart: '134381300000000000', frameImage: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', refusalOnly: true }] });

for (const className of ['ApplicationFrameWindow', 'Windows.UI.Core.CoreWindow']) for (const modelId of [null, aumid])
  test(`UC3GFIX10 JS identity refuses ${className} with AUMID ${modelId}`, () => {
    const w = { ...window(), className, aumid: modelId };
    assert.throws(() => identity.verifyWindowIdentity(w, w), { code: 'HOSTED_APP_UNRESOLVED' });
  });

for (const selector of ['Calculator', aumid, { windowId: '99' }])
  test(`UC3GFIX10 parent refuses a native CoreWindow regression by ${JSON.stringify(selector)} before approval`, async () => {
    let cards = 0, leases = 0, reads = 0;
    const safety = createDriverSafety({ platform: 'win32', driver: { request: async method => {
      if (method === 'getState') return { windows: [window()] };
      reads++; return { window: window() };
    } }, approve: async () => { cards++; return true; }, lease: { acquire() { leases++; }, renew() {}, close() {} } });
    try { await assert.rejects(safety.request('getApp', { selector }), { code: 'HOSTED_APP_UNRESOLVED' }); }
    finally { await safety.close(); }
    assert.deepEqual({ cards, leases, reads }, { cards: 0, leases: 0, reads: 0 });
  });

for (const selector of ['Calculator', aumid, '4240', 'calculatorapp.exe', { windowId: '99' }])
  test(`UC3GFIX10 redacted hosted inventory preserves refusal by ${JSON.stringify(selector)}`, async () => {
    const w = { windowId: '99', pid: 4240, processStart: birth, refused: 'HOSTED_APP_UNRESOLVED',
      hostedSelectorHashes: ['Calculator', aumid, '4240', 'calculatorapp.exe'].map(s => createHash('sha256').update(s.toLowerCase()).digest('hex')) };
    const calls = [];
    const safety = createDriverSafety({ platform: 'win32', driver: { request: async method => { calls.push(method); return { windows: [w] }; } },
      approve: () => assert.fail('card'), lease: { acquire: () => assert.fail('lease'), close() {} } });
    try {
      await assert.rejects(safety.request('getApp', { selector }), { code: 'HOSTED_APP_UNRESOLVED' });
      const state = await safety.request('getState', {});
      assert.equal(Object.hasOwn(state.windows[0], 'hostedSelectorHashes'), false);
      assert.deepEqual(calls, ['getState', 'getState']);
    } finally { await safety.close(); }
  });

test('UC3GFIX10 Calculator setup and trial require every lookup and read to refuse', async () => {
  const receipt = collector.proveRefusedCalculator(proof(), { token: 'uc3f-0123456789abcdef' });
  const calls = [];
  const count = await collector.requireCalculatorRefusals(receipt, async (method, params) => {
    calls.push([method, params]); throw Object.assign(Error('HOSTED_APP_UNRESOLVED'), { code: 'HOSTED_APP_UNRESOLVED' });
  });
  assert.equal(count, 11);
  assert.deepEqual(calls.slice(0, 5).map(c => c[1].selector), ['Calculator', aumid, '4240', { windowId: '99' }, { windowId: '100' }]);
  assert.deepEqual(calls.slice(5).map(c => [c[0], c[1].selector?.windowId]), ['99', '100'].flatMap(id =>
    ['getApp', 'getApp', 'getApp'].map(m => [m, id])));
  const projected = collector.projectTrial({ driver: calls.map(([method], i) => ({ method, tickMs: i * 2, replyTickMs: i * 2 + 1,
    raw: { ok: false, code: 'HOSTED_APP_UNRESOLVED' } })) }, { caseId: 'calculator-refused', rowId: 'person-idle', startTickMs: 0, endTickMs: 30 });
  assert.equal(projected.driver.length, 11);
  assert.equal(JSON.stringify(projected).includes(aumid), false);
  for (let accepted = 0; accepted < 11; accepted++) {
    let i = 0;
    await assert.rejects(collector.requireCalculatorRefusals(receipt, async () => {
      if (i++ === accepted) return {};
      throw Object.assign(Error('HOSTED_APP_UNRESOLVED'), { code: 'HOSTED_APP_UNRESOLVED' });
    }), { code: 'FIXTURE_REFUSAL_UNPROVED' });
  }
});

for (const [label, mutate] of [
  ['second Calculator process', p => p.calculatorProcesses.push({ pid: 5052, processStart: '134381325118728106' })],
  ['wrong process', p => { p.calculatorProcesses[0].pid = 5052; }],
  ['reused PID', p => { p.calculatorProcesses[0].processStart = '134381325118728106'; }],
  ['second cloaked frame', p => p.newFrameIds.push('5571400')],
  ['missing process census', p => { delete p.calculatorProcesses; }],
]) test(`UC3GFIX10 cleanup receipt refuses ${label}`, () => {
  const p = proof(); mutate(p);
  assert.throws(() => collector.proveRefusedCalculator(p, { token: 'uc3f-0123456789abcdef' }), { code: 'FIXTURE_CALCULATOR_OWNERSHIP_UNPROVED' });
});
test('UC3GFIX10 Calculator must be born strictly after activation', () => {
  const p = proof(); p.activationSince = birth;
  assert.throws(() => collector.proveRefusedCalculator(p, { token: 'uc3f-0123456789abcdef' }), { code: 'FIXTURE_LAUNCH_UNPROVED' });
});

if (!variant) test('UC3GFIX10 broken variants fail behavioral assertions', () => {
  for (const name of Object.keys(variants)) {
    const env = { ...process.env, UC3GFIX10_BROKEN: name }; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=900000', fileURLToPath(import.meta.url)],
      { env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
    assert.equal(r.status, 1, name + ': ' + r.stdout.slice(-2000) + r.stderr);
    assert.match(r.stdout, /failureType: 'testCodeFailure'/);
    console.log(`BROKEN_VARIANT ${name} exit=${r.status} ` + ['tests', 'pass', 'fail', 'skipped'].map(k => `${k}=${new RegExp('^# ' + k + ' (\\d+)', 'm').exec(r.stdout)?.[1]}`).join(' '));
  }
});
