import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guestTransport } from '../bench/windows/rt31-sitting.mjs';

const source = readFileSync(new URL('../bench/windows/rt31-guest.ps1', import.meta.url), 'utf8');
const stopped = "if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -ieq 'Notepad' }).Count -ne 0) { throw 'NOTEPAD_ALREADY_RUNNING' }";
const rename = '[IO.Directory]::Move($source, (Join-Path $backup $name))';
const setupCall = "Backup-NotepadState 'setup'";
const closeCall = "Backup-NotepadState 'close'";

function ordered(text, fragments) {
  let offset = 0;
  for (const fragment of fragments) {
    const index = text.indexOf(fragment, offset);
    assert.ok(index >= offset, `missing or out of order: ${fragment}`);
    offset = index + fragment.length;
  }
}

function assertCloseBackup(script) {
  const close = script.slice(script.indexOf("if ($Operation -eq 'close') {"), script.indexOf("if ($Operation -eq 'restore') {"));
  ordered(close, ["if (-not $process.HasExited) { throw 'GUEST_CLOSE_UNCONFIRMED' }",
    "$stateBackup = 'saved'", "try { Backup-NotepadState 'close' } catch { $stateBackup = 'failed' }",
    'closed = $true', 'stateBackup = $stateBackup', '$status = 0']);
}

test('a close-time backup failure still reports the already closed fixture', () => {
  assertCloseBackup(source);
});

for (const [name, before, after] of [
  ['throws after closing', "try { Backup-NotepadState 'close' } catch { $stateBackup = 'failed' }", closeCall],
  ['hides a failed backup', "$stateBackup = 'failed'", "$stateBackup = 'saved'"],
  ['omits backup status', 'stateBackup = $stateBackup', ''],
]) test(`close cleanup guard rejects a variant that ${name}`, () => {
  assert.ok(source.includes(before));
  assert.throws(() => assertCloseBackup(source.replace(before, after)), { code: 'ERR_ASSERTION' });
});

// PowerShell is not installed on the Mac. Pin the guest control flow directly;
// transport fakes below exercise how its fixed refusals reach the caller.
function assertStateBackup(script) {
  // Preserve quoted literals while removing PowerShell line and block comments.
  script = script.replace(/'(?:''|[^'])*'|"(?:`[\s\S]|[^"`])*"|<#[\s\S]*?#>|#[^\r\n]*/g,
    token => /^(?:#|<#)/.test(token) ? token.replace(/[^\r\n]/g, ' ') : token);
  const helper = script.slice(script.indexOf('function Backup-NotepadState('), script.indexOf('\ntry {'));
  ordered(helper, [
    'try {', stopped,
    "$localState = Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.WindowsNotepad_8wekyb3d8bbwe\\LocalState'",
    '$backup = Join-Path $Bank ("notepad-state-{0}-{1}-{2}" -f $phase, $Invocation, [Guid]::NewGuid().ToString(\'N\'))',
    "foreach ($name in @('TabState', 'WindowState')) {", stopped,
    '$source = Join-Path $localState $name',
    'if (-not (Test-Path -LiteralPath $source)) { continue }',
    'New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null', stopped,
    rename, '} catch {',
    "if ($_.Exception.Message -ceq 'NOTEPAD_ALREADY_RUNNING') { throw }",
    "throw 'GUEST_NOTEPAD_STATE_BACKUP_FAILED'",
  ]);
  // Fix the rename API deliberately, rather than allowing Move-Item variants.
  assert.doesNotMatch(helper, /Get-Content|ReadAll|Get-ChildItem|Remove-Item|Copy-Item|Move-Item|::Delete|::Copy|-Force/);
  assert.equal(helper.split(rename).length - 1, 1);
  const setup = script.slice(script.indexOf("if ($Operation -eq 'setup') {"), script.indexOf('  $boundRead ='));
  ordered(setup, [
    "if (Test-Path $statePath) { throw 'FIXTURE_EXISTS' }",
    "if (@(Get-Process notepad -ErrorAction SilentlyContinue).Count -ne 0) { throw 'NOTEPAD_ALREADY_RUNNING' }",
    setupCall, '[IO.File]::WriteAllText($file,', 'Start-Process notepad.exe',
  ]);
  const close = script.slice(script.indexOf("if ($Operation -eq 'close') {"), script.indexOf("if ($Operation -eq 'restore') {"));
  ordered(close, ['$wp.Close()', "if (-not $process.HasExited) { throw 'GUEST_CLOSE_UNCONFIRMED' }",
    closeCall, 'closed = $true', '$status = 0']);
  assert.match(script, /if \(\$tabs.Count -gt 1\) \{ throw 'GUEST_EXTRA_TABS' \}/);
  assert.equal(script.split(setupCall).length - 1, 1);
  assert.equal(script.split(closeCall).length - 1, 1);
}

test('RT31 backs up opaque Notepad state while stopped, before launch and after exit', () => {
  assertStateBackup(source);
});

for (const [name, before, after] of [
  ['skips setup backup', setupCall, ''],
  ['comments out setup backup', setupCall, '# ' + setupCall],
  ['comments out close backup', closeCall, '# ' + closeCall],
  ['comments out the rename', rename, '# ' + rename],
  ['block comments setup backup', setupCall, '<# ' + setupCall + ' #>'],
  ['block comments close backup', closeCall, '<# ' + closeCall + ' #>'],
  ['block comments the rename', rename, '<# ' + rename + ' #>'],
  ['skips close backup', closeCall, ''],
  ['skips the directory rename', rename, ''],
  ['drops the helper process guard', stopped, ''],
  ['moves state while the fixture still runs', closeCall, ''],
  ['swallows rename failures', "throw 'GUEST_NOTEPAD_STATE_BACKUP_FAILED'", 'return'],
  ['reads tab contents', rename, 'Get-Content $source\n      ' + rename],
]) {
  test(`source guard rejects a broken variant that ${name}`, () => {
    assert.ok(source.includes(before));
    let broken = source.replace(before, after);
    if (name === 'moves state while the fixture still runs') broken = broken.replace('$wp.Close()', closeCall + '\n    $wp.Close()');
    assert.throws(() => assertStateBackup(broken), { code: 'ERR_ASSERTION' });
  });
}

// These checks cover generic transport refusal propagation, not guest execution.
for (const reason of ['GUEST_NOTEPAD_STATE_BACKUP_FAILED', 'NOTEPAD_ALREADY_RUNNING']) {
  for (const operation of ['setup', 'close']) {
    test(`fake guest ${operation} preserves ${reason} after collecting its scheduled task`, async () => {
      const calls = [];
      const transport = await guestTransport({ sshConfig: '/fixture/config', host: 'vm', guestRoot: 'C:\\sleight', guestUser: 'Sleight' }, {
        runChild: async (command, args, options) => {
          calls.push({ command, args, options });
          const payload = options.input?.includes('Register-ScheduledTask') ? JSON.stringify({ fixture: false, error: reason }) + '\n' : '';
          return { status: 0, stdout: options.input ? payload + 'SLEIGHT_GUEST_OK\n' : '' };
        },
      });
      await assert.rejects(transport.call(operation), new RegExp(`^Error: ${reason}$`));
      assert.equal(transport.cleanupConfirmed, true);
      const tasks = calls.filter(call => call.options.input?.includes('Register-ScheduledTask'));
      assert.equal(tasks.length, 1);
      assert.ok(tasks[0].options.input.includes(`$op='${operation}'`));
      ordered(tasks[0].options.input, ['Unregister-ScheduledTask', 'Write-Output $payload']);
    });
  }
}
