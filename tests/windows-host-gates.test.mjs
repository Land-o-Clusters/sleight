import { assertChildStatus } from './fixtures/child-status.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareWindowsHandHost, windowsHostExecutable } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

const windows = { skip: process.platform !== 'win32' ? 'requires Windows in-box csc; all modes are headless' : false };
let binary, root;
after(() => { if (root) removeTemp(root); });
async function host() {
  if (binary) return binary;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-gate-tests-')));
  const built = await prepareWindowsHandHost({ cacheRoot: join(root, 'host') });
  assert.equal(built.status, 'ready', JSON.stringify(built));
  return (binary = windowsHostExecutable(built.receipt));
}
async function run(mode, value) {
  return spawnSync(await host(), [mode], { input: value === undefined ? '' : JSON.stringify(value),
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 65536, killSignal: 'SIGKILL' });
}
for (const mode of ['--gate-selftest', '--consent-selftest']) {
  test('compiled native ' + mode + ' passes without drawing', windows, async () => {
    const result = await run(mode); assertChildStatus(result, 0, result.stderr);
    const reply = JSON.parse(result.stdout); assert.equal(reply.ok, true); assert.ok(Object.keys(reply.cases).length >= 10);
    assert.ok(Object.values(reply.cases).every(Boolean));
    const required = mode === '--gate-selftest' ? ['browser-inherited', 'strict-refuses-browser', 'browser-foreign-owner',
      'browser-broad-0x2', 'browser-broad-0x4', 'browser-broad-0x10', 'browser-broad-0x100', 'browser-broad-WD', 'browser-broad-WO',
      'handle-browser-inherited', 'handle-browser-strict-refused', 'handle-browser-other-name', 'handle-browser-writer', 'accepted-connection', 'accepted-foreign-pid',
      'accepted-wrong-tuple', 'tcp-table-grow-once', 'tcp-table-growth-bounded'] :
      ['payment', 'action', 'relaunch', 'debugger', 'app'].flatMap(kind => ['tab-space', 'enter-on-open', 'early-tab', 'early-mouse', 'queued-input',
        'early-typing-cleared', 'typed-return', 'one-shot', 'injection-clears', 'repeat-refused', 'modifiers-refused', 'reactivation', 'inactive'].map(name => kind + '-' + name))
        .concat(['detail-newline', 'refused-device-4', 'refused-device-8', 'refused-device-16', 'dpi-null-bounds', 'layout-work-area-width',
          ...[0, 47, 769, 4294967295].map(dpi => 'dpi-refused-' + dpi), ...[48, 144, 768].map(dpi => 'dpi-accepted-' + dpi),
          ...[2, 3].flatMap(n => ['layout-work-area-', 'layout-work-area-buttons-', 'layout-work-area-scroll-', 'layout-refuses-short-',
            'layout-refuses-narrow-', 'layout-minimum-lines-', 'layout-minimum-labels-'].map(name => name + n))],
          [96, 120, 144, 192].flatMap(dpi => ['layout-bounds-', 'layout-labels-', 'layout-text-', 'layout-hit-', 'layout-scale-'].map(name => name + dpi)));
    for (const name of required) assert.equal(reply.cases[name], true, name);
  });
}
test('compiled host advertises only non-drawing native gate test modes', windows, async () => {
  const result = await run('--capabilities'); assertChildStatus(result, 0, result.stderr); const info = JSON.parse(result.stdout);
  for (const mode of ['--browser-gate', '--gate-selftest', '--consent-selftest', '--consent-validate']) assert.ok(info.modes.includes(mode));
  assert.equal(info.drawing, false); assert.ok(!info.modes.includes('--consent'));
});
test('compiled consent validation accepts payment card data without opening a card', windows, async () => {
  const result = await run('--consent-validate', { nonce: 'a'.repeat(64), op: 'consent', id: 'test', kind: 'payment',
    question: 'Allow $12?', detail: 'Fixture account, $12.00', choices: ['cancel', 'once'], deadline: Date.now() + 10000 });
  assertChildStatus(result, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { ok: true, drawing: false });
});
for (const edit of [{ choices: ['cancel', 'always'] }, { nonce: '' }, { deadline: 1 }, { kind: 'unknown' },
  { detail: '\u202ehello' }, { detail: '\u007fhello' }, { detail: '\u0085hello' }, { extra: true }]) {
  test('compiled consent validator refuses ' + JSON.stringify(edit), windows, async () => {
    const result = await run('--consent-validate', { nonce: 'a'.repeat(64), op: 'consent', id: 'test', kind: 'payment',
      question: 'Allow $12?', detail: 'Fixture account, $12.00', choices: ['cancel', 'once'], deadline: Date.now() + 10000, ...edit });
    assertChildStatus(result, 65, result.stderr); assert.equal(result.stdout, '');
  });
}
for (const value of [{ nonce: 'a'.repeat(64), op: 'private-file', path: 'C:\\file:stream', kind: 'file' },
  { nonce: 'a'.repeat(64), op: 'browser-file', path: 'C:\\hand.json', kind: 'file' },
  { nonce: 'a'.repeat(64), op: 'read-browser-file', path: 'C:\\hand.json', kind: 'file' },
  { nonce: 'a'.repeat(64), op: 'peer', pid: 0 }, { nonce: 'a'.repeat(64), op: 'consent' }]) {
  test('compiled browser gate rejects malformed request ' + value.op, windows, async () => {
    const result = await run('--browser-gate', value); assertChildStatus(result, 65, result.stderr); assert.equal(result.stdout, '');
  });
}
