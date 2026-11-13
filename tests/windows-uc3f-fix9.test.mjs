import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as productionCollector from '../bench/windows/uc3f-collect.mjs';
import { UC3F_ROWS as productionRows } from '../bench/windows/driver-sitting.mjs';
import { vmPlan as productionVMPlan } from '../bench/windows/uc3f-sitting.mjs';
import { uc3fTransport as productionTransport } from '../bench/windows/uc3f-transport.mjs';

const token = 'uc3f-0123456789abcdef', birth = '134381325118728105';
const file = `driver-notepad.txt-${token}.txt`;
const url = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url);
const variants = {
  'notepad-substring': ["w.title.replace(/^\\*/, '') === `driver-notepad.txt-${token}.txt - Notepad`", 'w.title.includes(token)'],
  'prestart-retains-bank': ["].includes(error?.code);", '].includes(undefined);'],
  'poststart-releases-bank': ['return ![\'FIXTURE_ARGUMENT_UNSAFE\'', 'return false && ![\'FIXTURE_ARGUMENT_UNSAFE\''],
  'prestart-phase-ignored': ["if (error?.launchStarted === false) return false;", ''],
  'prestart-state-retained': ['launchUnproved = launchMayHaveStarted(error);', 'launchUnproved = true;'],
  'summary-empty-cleanup-codes': ["cleanupConfirmed, ...cleanupCodes.length ? { cleanupCodes } : {} };", 'cleanupConfirmed, cleanupCodes };'],
  'calculator-adopts-baseline': ['copy.baselineWindows.includes(w.windowId)', 'false'],
  'calculator-ignores-birth': ['BigInt(copy.launcher.processStart) <= BigInt(copy.activationSince)', 'false'],
  'calculator-ignores-title': ['w.coreTitle !== w.title', 'false'],
  'frame-system-directory-ignored': ["proof.frameHostImage.toLowerCase() === win32.join(proof.systemDirectory, 'ApplicationFrameHost.exe').toLowerCase()", 'true'],
  'hashtable-property-miss': ['$f.ContainsKey($key)', "$f.PSObject.Properties[$key]"],
  'terminal-reuses-instance': ["if (@(Get-Process -Name $names[$target] -ErrorAction SilentlyContinue).Count -ne 0) { throw 'FIXTURE_ALREADY_RUNNING' }", ''],
  'notepad-activation': ["$aumid = if ($target -ceq 'notepad') { $null } else { $packageId }", '$aumid = $packageId'],
  'close-race-fails': ["@('FIXTURE_PROCESS_GONE','FIXTURE_WINDOW_GONE')", "@('FIXTURE_NOT_GONE')"],
  'close-error-in-powershell': ['public static int CloseWindow', 'public static int DelayedCloseWindow'],
  'close-short-lease': ['RequireLease 11000', ''],
  'notepad-existing-title': ["throw 'NOTEPAD_BANK_TITLE_EXISTS'", "throw 'FIXTURE_LAUNCH_UNPROVED'"],
  'observer-arbitrary-uppercase': ['$code -cnotin $known', "$code -cnotmatch '^[A-Z][A-Z0-9_]{0,79}\\z'", 'uc3f-observer.ps1'],
  'injector-arbitrary-uppercase': ['$code -cnotin $known', "$code -cnotmatch '^[A-Z][A-Z0-9_]{0,79}\\z'", 'uc3f-inject.ps1'],
  'rows-calculator-driven': ["...['notepad', 'wpf'].map(id => caseRule(id, 50", "...['notepad', 'calculator'].map(id => caseRule(id, 50", 'driver-sitting.mjs'],
  'dryrun-old-cases': ["['notepad', 'wpf', 'calculator-refused']", "['notepad', 'calculator']", 'uc3f-sitting.mjs'],
  'recovery-bank-lost': ["return `$ErrorActionPreference='Stop'\n$bank=${quote(bank)}", "return `$ErrorActionPreference='Stop'\n$bank='UNKNOWN'", 'uc3f-transport.mjs'],
  'recovery-enables-window': ["$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden", "$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Normal", 'uc3f-transport.mjs'],
};
const variant = process.env.UC3GFIX9_BROKEN;
if (variant && !variants[variant]) throw Error('UNKNOWN_TEST_VARIANT');
function changed(text, kind) {
  const mutation = variants[variant];
  if (!mutation || mutation[2] !== kind) return text;
  assert.ok(text.includes(mutation[0]), `${variant} anchor exists`);
  return text.replace(mutation[0], mutation[1]);
}
const source = changed(readFileSync(url, 'utf8'));
const collector = variant && !variants[variant][2] ? await import('data:text/javascript;base64,' + Buffer.from(source
  .replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`)
  .replaceAll('import.meta.url', JSON.stringify(url.href))).toString('base64')) : productionCollector;
async function moduleVariant(file) {
  const url = new URL('../bench/windows/' + file, import.meta.url);
  return import('data:text/javascript;base64,' + Buffer.from(changed(readFileSync(url, 'utf8'), file)
    .replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href))).toString('base64'));
}
const UC3F_ROWS = variants[variant]?.[2] === 'driver-sitting.mjs' ? (await moduleVariant('driver-sitting.mjs')).UC3F_ROWS : productionRows;
const vmPlan = variants[variant]?.[2] === 'uc3f-sitting.mjs' ? (await moduleVariant('uc3f-sitting.mjs')).vmPlan : productionVMPlan;
const uc3fTransport = variants[variant]?.[2] === 'uc3f-transport.mjs' ? (await moduleVariant('uc3f-transport.mjs')).uc3fTransport : productionTransport;

test('UC3GFIX9 rows replace Calculator driving with WPF and add ten refusal trials', () => {
  const idle = UC3F_ROWS.find(r => r.id === 'person-idle');
  assert.deepEqual(idle.cases.map(c => [c.id, c.trials]), [['notepad', 50], ['wpf', 50], ['calculator-refused', 10], ['background-word', 20]]);
  assert.deepEqual(UC3F_ROWS.find(r => r.id === 'browser-refused-edge').cases.map(c => [c.id, c.trials]),
    [['name', 10], ['hwnd', 10], ['notepad', 50], ['wpf', 100]]);
  assert.deepEqual(vmPlan({ ownerAway: true }).rows[0].cases, ['notepad', 'wpf', 'calculator-refused']);
  assert.equal(vmPlan({ ownerAway: true }).plannedCases, 24);
  assert.equal(vmPlan({ ownerAway: true }).plannedTrials, 450);
  assert.equal(vmPlan({ ownerPresent: true }).plannedCases, 15);
  assert.equal(vmPlan({ ownerPresent: true }).plannedTrials, 1301);
  assert.deepEqual(collector.collectorPlan(['person-idle'])[0].cases.map(c => c.trials), [50, 50, 10, 20]);
});

for (const file of ['uc3f-observer.ps1', 'uc3f-inject.ps1']) test(`UC3GFIX9 ${file} keeps unknown uppercase framework text out of fixed causes`, () => {
  const source = changed(readFileSync(new URL('../bench/windows/' + file, import.meta.url), 'utf8'), file);
  assert.match(source, /if \(\$code -cnotin \$known\)/);
  assert.match(source, /if \(\$innerCode -cin \$known\)/);
  const known = /\$known = @\(([^\n]+)\)/.exec(source)[1].match(/'[A-Z][A-Z0-9_]+'/g).map(s => s.slice(1, -1));
  assert.equal(known.includes('FIXTURE_PROCESS_GONE'), true);
  assert.equal(known.includes('FRAMEWORK_PRIVATE_TEXT'), false);
});

test('UC3GFIX9 Calculator refusal trial checks eleven lookup and read routes with zero actions', async () => {
  const calls = [], fixture = { target: 'calculator-refused', windowId: '459238', coreWindowId: '100', pid: 4240, processStart: birth };
  const facts = await collector.measureGuestTrial({ rowId: 'person-idle', caseId: 'calculator-refused', trial: 0,
    fixtures: [fixture], check: async () => {}, request: async (_c, method) => {
      calls.push(method); return { raw: { ok: false, code: 'HOSTED_APP_UNRESOLVED', counters: { postedMessages: 0, patternCalls: 0, uiaFetches: 0 } } };
    } }, { client: async () => ({}) });
  assert.deepEqual(calls, Array(11).fill('getApp'));
  assert.equal(facts.driver[0].raw.code, 'HOSTED_APP_UNRESOLVED');
});

if (!variant) test('UC3GFIX9 named broken variants fail their regression assertions', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  for (const name of Object.keys(variants)) {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=900000', '--test-name-pattern=UC3GFIX9', fileURLToPath(import.meta.url)],
      { env: { ...env, UC3GFIX9_BROKEN: name }, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 1, name + ': ' + result.stdout.slice(-1500) + result.stderr);
    assert.match(result.stdout, /failureType: 'testCodeFailure'/, name);
    console.log(`${name}: exit=${result.status} tests=${/^# tests (\d+)/m.exec(result.stdout)?.[1]} pass=${/^# pass (\d+)/m.exec(result.stdout)?.[1]} fail=${/^# fail (\d+)/m.exec(result.stdout)?.[1]}`);
  }
});
