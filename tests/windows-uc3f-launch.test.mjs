import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { GUEST_OPERATIONS, GUEST_FIXTURE, GUEST_FAILURE, powershellCall, assertFixtureArguments, proveFixtureLaunch } from '../bench/windows/uc3f-collect.mjs';
import { matchBlockedWindowsApp } from '../plugins/sleight/lib/blocked-apps-windows.mjs';

const targets = ['notepad', 'calculator', 'edge', 'firefox', 'terminal', 'wpf', 'cover'];
const launch = GUEST_OPERATIONS.split("  'launch' {\n")[1].split("  'compile-fixture' {")[0];
const now = Date.parse('2026-11-02T12:00:00Z');
const lease = { presence: 'away', row: 'person-idle', token: 'a'.repeat(32),
  issuedUtc: new Date(now).toISOString(), expiresUtc: new Date(now + 900000).toISOString() };

test('fixture launch binds the new process incarnation or its direct child, with broken variants', async () => {
  const token = 'uc3f-0123456789abcdef', image = 'C:\\fixtures\\fixture.exe';
  const proof = () => ({ launcher: { pid: 40, processStart: '100', observedEnd: '120', image }, expectedImage: image,
    windows: [{ pid: 40, processStart: '100', image, windowId: '77', title: `fixture-${token}`, className: 'Fixture' }] });
  const audit = prove => {
    const o = { target: 'edge', token };
    assert.equal(prove(proof(), o).pid, 40);
    const child = proof(); Object.assign(child.windows[0], { pid: 41, processStart: '110', parentPid: 40 });
    assert.equal(prove(child, o).pid, 41);
    for (const patch of [{ pid: 41 }, { processStart: '99' }, { pid: 41, parentPid: 39, processStart: '110' },
      { pid: 41, parentPid: 40, processStart: '99' }, { pid: 41, parentPid: 40, processStart: '121' },
      { pid: 40, processStart: '110', parentPid: 40 }]) {
      const bad = proof(); Object.assign(bad.windows[0], patch);
      assert.throws(() => prove(bad, o), { code: 'FIXTURE_LAUNCH_UNPROVED' });
    }
    const wrongImage = proof(); wrongImage.launcher.image = 'C:\\other.exe';
    assert.throws(() => prove(wrongImage, o), { code: 'FIXTURE_LAUNCH_UNPROVED' });
    const untitled = proof(); Object.assign(untitled.windows[0], { pid: 41, processStart: '110', parentPid: 40, title: 'Sleight WDR7 cover' });
    assert.throws(() => prove(untitled, { target: 'cover', token }), { code: 'FIXTURE_LAUNCH_UNPROVED' });
    const staleCover = proof(); Object.assign(staleCover.windows[0], { pid: 99, title: 'Sleight WDR7 cover' });
    assert.throws(() => prove(staleCover, { target: 'cover', token }), { code: 'FIXTURE_LAUNCH_UNPROVED' });
  };
  audit(proveFixtureLaunch);
  const url = new URL('../bench/windows/uc3f-fixtures.mjs', import.meta.url), source = readFileSync(url, 'utf8');
  for (const [before, after] of [
    ['(direct || child)', 'true'],
    ['w.processStart === launcher.processStart', 'true'],
    ['w.parentPid === launcher.pid', 'true'],
    ['BigInt(w.processStart) >= BigInt(launcher.processStart)', 'true'],
    ['BigInt(w.processStart) <= BigInt(launcher.observedEnd)', 'true'],
  ]) {
    assert.ok(source.includes(before), before);
    const broken = source.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`)
      .replaceAll('import.meta.url', JSON.stringify(url.href));
    const api = await import('data:text/javascript;base64,' + Buffer.from(broken).toString('base64'));
    assert.throws(() => audit(api.proveFixtureLaunch), assert.AssertionError, before);
  }
});
test('guest launch brackets the family lookup with process birth and window ownership checks', () => {
  const source = launch.slice(launch.indexOf('$p = Start-Process @start'));
  const audit = text => {
    for (const check of ['$launchStart = Birth $p', 'OR ParentProcessId=', '$owner -notin @($family',
      '$meta.ParentProcessId -ne $p.Id', '(Birth $again) -cne $childStart', '$ownerAgain -ne $owner',
      '$childStart -ceq $launchStart', 'parentPid = [int]$meta.ParentProcessId', 'observedEnd = $end',
      '$title.ToString().Contains((Split-Path $r.bank -Leaf))']) assert.ok(text.includes(check), check);
  };
  audit(source);
  for (const check of ['OR ParentProcessId=', '$meta.ParentProcessId -ne $p.Id', '(Birth $again) -cne $childStart', '$ownerAgain -ne $owner'])
    assert.throws(() => audit(source.replaceAll(check, 'REMOVED')), assert.AssertionError);
});

function guestCall(execute) {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'uc3f-launch-')));
  writeFileSync(join(bank, 'lease.json'), JSON.stringify(lease));
  return powershellCall({ bank, ownerAway: true, lease }, { execute, now: () => now, validateBank: () => {} });
}

// Source contract only: evaluate the closed Count comparison and project the
// splat. This never runs PowerShell, resolves an installed app or starts a child.
function startParameters(text, args) {
  const start = text.indexOf("$start = @{ FilePath = $program; WorkingDirectory = $r.bank; PassThru = $true; ErrorAction = 'Stop' }");
  const call = text.indexOf('$p = Start-Process @start');
  assert.ok(start >= 0 && call > start);
  assert.equal((text.match(/\bStart-Process\b/g) ?? []).length, 1);
  assert.doesNotMatch(text, /-ArgumentList/);
  const setup = text.slice(start, call);
  const guard = /if \(@\(\$r\.args\)\.Count -gt (-?\d+)\) \{ \$start\.ArgumentList = \$r\.args \}/.exec(setup);
  assert.ok(guard, 'the supplied list is assigned only inside the Count guard');
  assert.equal((text.match(/\$start\.ArgumentList\s*=/g) ?? []).length, 1);
  const params = { FilePath: 'selected fixture image', PassThru: true, ErrorAction: 'Stop' };
  if (args.length > Number(guard[1])) params.ArgumentList = args;
  return params;
}
test('the renamed fixture requires preserved browser metadata rather than a recognized filename', () => {
  const auditName = name => {
    const window = { image: `C:\\fixture\\${name}`, className: 'Chrome_WidgetWin_1' };
    assert.equal(matchBlockedWindowsApp(window), undefined);
    assert.equal(matchBlockedWindowsApp({ ...window, originalFilename: 'msedge.exe' }).browser, true);
    assert.equal(matchBlockedWindowsApp({ ...window, productName: 'Microsoft Edge' }).browser, true);
  };
  auditName('msedge-harness.exe');
  assert.throws(() => auditName('msedge.exe'), assert.AssertionError);

});

for (const target of targets) {
  for (const args of [[], ['one-argument'], ['--title', 'uc3f-quoted', 'two-words']]) {
    test(`${target} serializes ${args.length} safe arguments; classic source guard omits only an empty list`, async () => {
      const call = guestCall(async (_exe, _args, settings) => {
        const payload = /\$r = '([^]*?)' \| ConvertFrom-Json/.exec(settings.input)[1];
        const request = JSON.parse(payload.replaceAll("''", "'"));
        assert.equal(request.operation, 'launch');
        assert.equal(request.target, target);
        assert.deepEqual(request.args, args);
        const params = startParameters(launch, request.args);
        assert.equal(Object.hasOwn(params, 'ArgumentList'), args.length > 0);
        if (args.length) assert.deepEqual(params.ArgumentList, args);
        return { status: 0, stdout: '{}\nSLEIGHT_GUEST_OK\n' };
      });
      assert.deepEqual(await call('launch', { target, args }), {});
    });
  }
}

test('guest exceptions retain fixed refusals and typed causes with bounded transport failures', async () => {
  for (const code of ['FIXTURE_PROCESS_GONE', 'FIXTURE_ACCESS_DENIED', 'FIXTURE_WINDOW_GONE',
    'FIXTURE_TITLE_CHANGED', 'FIXTURE_EXITED', 'PARAMETER_BINDING_FAILED', 'FIXTURE_PREFLIGHT_FAILED']) {
    const call = guestCall(async (_exe, _args, { input }) => {
      assert.ok(input.includes('[Console]::Error.WriteLine((GuestFailure $_ $launchFailure))'));
      assert.doesNotMatch(input, /WriteLine\(\$_|WriteLine\(\$_.Exception/);
      return { status: 1, stderr: code };
    });
    await assert.rejects(call('launch', { target: 'calculator', args: [] }), e => e.code === code);
  }
  for (const type of ['ParameterBindingValidationException', 'ParameterBindingException', 'Win32Exception',
    'InvalidOperationException', 'UnauthorizedAccessException', 'SecurityException', 'ElementNotAvailableException'])
    assert.ok(GUEST_FAILURE.includes(type));
  assert.match(GUEST_FAILURE, /\$depth -lt 4/);
  assert.match(GUEST_FAILURE, /NativeErrorCode -eq 5/);
  assert.match(GUEST_FAILURE, /return \$fallback/);
});

for (const argument of ['two words', 'tab\tword', 'line\nword', 'one"quote', "one'quote", ''])
  test(`PowerShell 5.1 ambiguous argument refuses before a child: ${JSON.stringify(argument)}`, async () => {
    const call = guestCall(async () => assert.fail('unsafe argument reached PowerShell'));
    await assert.rejects(call('launch', { target: 'notepad', args: [argument] }), { code: 'FIXTURE_ARGUMENT_UNSAFE' });
    assert.throws(() => assertFixtureArguments([argument]), { code: 'FIXTURE_ARGUMENT_UNSAFE' });
    assert.match(launch, /throw 'FIXTURE_ARGUMENT_UNSAFE'/);
  });

test('launch transport preserves explicit refusals and bounds missing or unsafe diagnostics', async () => {
  for (const [stderr, code] of [
    ['FIXTURE_ALREADY_RUNNING', 'FIXTURE_ALREADY_RUNNING'], ['LEASE_EXPIRED', 'LEASE_EXPIRED'],
    ['', 'GUEST_OPERATION_FAILED'], ['ParameterBindingValidationException: PRIVATE C:\\secret', 'GUEST_OPERATION_FAILED'],
    ['CODE\nPRIVATE', 'GUEST_OPERATION_FAILED'], ['A'.repeat(81), 'GUEST_OPERATION_FAILED'],
  ]) {
    const call = guestCall(async () => ({ status: 1, stderr }));
    await assert.rejects(call('launch', { target: 'calculator', args: [] }), e => e.code === code);
  }
  const call = guestCall(async () => ({ status: 0, stdout: 'PRIVATE\nSLEIGHT_GUEST_OK\n' }));
  await assert.rejects(call('launch', { target: 'calculator', args: [] }), e => e.code === 'GUEST_OPERATION_FAILED');
});

test('the remaining UAC start has five fixed arguments', () => {
  const starts = GUEST_FIXTURE.split('\n').filter(line => line.includes('Start-Process'));
  assert.equal(starts.length, 1);
  assert.match(starts[0], /-ArgumentList @\('-NoLogo','-NoProfile','-NonInteractive','-Command','exit'\)/);
});
