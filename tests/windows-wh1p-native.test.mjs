import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { driverFiles, headlessPerson, headlessWiring, personVariants, wiringVariants, mutatePerson, fakeDefaultPerson } from './fixtures/windows-wh1p-seams.mjs';

const native = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
const sources = () => Object.fromEntries(['Driver.cs', 'DriverCapture.cs', 'DriverInput.cs', 'DriverInventory.cs', 'DriverHook.cs'].map(name =>
  [name, readFileSync(new URL(name, native), 'utf8').replace(/\r\n/g, '\n')]));

test('person native adapters bind unique extern declarations and preserve production guard bodies', () => {
  const originals = sources(), adapted = headlessPerson(originals);
  for (const name of Object.keys(originals)) {
    if (['Driver.cs', 'DriverCapture.cs'].includes(name)) assert.equal(adapted[name], originals[name]);
    else assert.notEqual(adapted[name], originals[name]);
    assert.doesNotMatch(originals[name], /PersonReview/);
  }
  // These are the actual sources the production wrapper invokes. Tests neither
  // select a fake by default nor define SLEIGHT_TEST_SEAMS to bypass Require.
  assert.match(originals['DriverInput.cs'], /extern bool GetLastInputInfo\(ref LastInput input\)/);
  assert.match(originals['DriverInput.cs'], /if \(!GetLastInputInfo\(ref input\)\)/);
  assert.match(originals['DriverInput.cs'], /uint last = DriverInput.LastPersonInput\(\);\s*age = unchecked\(\(uint\)Environment.TickCount - last\)/);
  assert.match(originals['DriverHook.cs'], /SetWindowsHookEx\(13, callback, GetModuleHandle\(null\), 0\)/);
  assert.match(originals['DriverHook.cs'], /readonly Stopwatch clock = Stopwatch.StartNew\(\)/);
  for (const variant of personVariants) {
    const mutated = mutatePerson(originals, variant);
    assert.notDeepEqual(mutated, originals, variant[0]);
    assert.doesNotThrow(() => headlessPerson(mutated), variant[0]);
  }
  for (const variant of wiringVariants) {
    const mutated = mutatePerson(originals, variant);
    assert.notDeepEqual(mutated, originals, variant[0]);
    assert.doesNotThrow(() => headlessWiring(mutated), variant[0]);
  }
  assert.doesNotThrow(() => headlessWiring(originals));
  assert.equal(personVariants.length, 21);
  assert.equal(wiringVariants.length, 4);
  assert.throws(() => headlessPerson(fakeDefaultPerson(originals)), /unique external declaration: GetLastInputInfo/);
});

test('C# 5 person, Escape, session and production dispatch run headlessly with native broken variants', {
  skip: process.platform !== 'win32' ? 'requires Windows csc.exe; no input, windows or observer process' : false,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'wh1p-native-'))));
  t.after(() => removeTemp(root));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const originals = sources();
  for (const variant of [null, ['fake-default-source', null, null, null, 'production-native-bindings'], ['baseline'], ...personVariants,
    ['production-wiring'], ...wiringVariants]) {
    const name = variant?.[0] ?? 'production-bindings';
    const bindings = !variant || name === 'fake-default-source';
    const wiring = name === 'production-wiring' || wiringVariants.includes(variant);
    const selected = bindings ? (variant ? fakeDefaultPerson(originals) : originals) :
      (wiring ? headlessWiring : headlessPerson)(variant.length === 1 ? originals : mutatePerson(originals, variant));
    for (const [file, source] of Object.entries(selected)) writeFileSync(join(root, file), source);
    const binary = join(root, name + '.exe');
    const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/langversion:5', '/target:exe',
      '/main:Sleight.Driver.PersonReviewChecks', '/out:' + binary,
      ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(file => '/r:' + join(framework, file)),
      ...driverFiles.map(file => originals[file] ? join(root, file) : fileURLToPath(new URL(file, native))),
      fileURLToPath(new URL('./fixtures/windows-wh1p-checks.cs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, name + ': ' + built.stdout + built.stderr);
    // The pristine binary only inspects DllImport metadata. It never enters the
    // production driver entrypoint, hook pump, session probe or input path.
    const result = spawnSync(binary, bindings ? ['--bindings'] : wiring ? ['--wiring'] : [],
      { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(result, variant?.length > 1 ? 1 : 0, name + ': ' + result.stdout + result.stderr);
    const checks = JSON.parse(result.stdout);
    assert.equal(checks.drawing, false);
    if (variant?.length > 1) {
      assert.equal(checks.failed, 1, name);
      assert.equal(checks.property, variant[4], name + ': wrong failure witness');
      assert.match(result.stderr, /assertion failed:/, name + ': must fail an assertion, not crash');
      if (name === 'screensaver-allowed' || name === 'secure-desktop-allowed') {
        assert.equal(checks.bypassActionCompleted, true, name + ': must allow the action');
        assert.equal(checks.posts, 1, name + ': must post the one requested character');
      }
    } else {
      assert.equal(checks.failed, 0);
      if (!variant) assert.equal(checks.passed, 10);
      else if (wiring) {
        assert.equal(checks.passed, 65);
        for (const property of ['production-read-no-hook', 'production-hook-activated', 'production-escape-cancelled',
          'production-read-after-escape', 'production-turn-end', 'production-entry-exit']) assert.ok(checks.properties[property] > 0, property);
      } else {
        assert.equal(checks.passed, 82, result.stdout);
        for (const property of ['person-before', 'person-boundary', 'pointer-target', 'foreign-input', 'mid-type',
          'physical-escape', 'escape-forwarded', 'posted-escape', 'injected-escape', 'escape-rest-of-turn',
          'hook-installed', 'keyboard-only', 'hook-idle-before', 'hook-idle-at', 'hook-native-removed',
          'session-locked', 'session-screensaver', 'session-secure', 'session-screensaver-bypass', 'session-secure-bypass',
          'recent-input-foreground-over-refusal', 'recent-input-pointer-over-refusal', 'hook-activate-refresh']) assert.ok(checks.properties[property] > 0, property);
      }
    }
    t.diagnostic('PERSON_REVIEW_NATIVE ' + JSON.stringify({ variant: name, exit: result.status, ...checks }));
  }
});
