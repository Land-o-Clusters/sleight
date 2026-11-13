import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../bench/windows/uc3f-task.ps1', import.meta.url), 'utf8');
function policy(text) {
  const branch = /if \(\$LASTEXITCODE -ne 0\) \{([^]*?)throw 'UC3F_GUEST_OPERATION_FAILED'/.exec(text)?.[1];
  assert.ok(branch);
  assert.match(branch, /Ordinary \$valuePath/);
  assert.match(branch, /if \(\(Get-Item -LiteralPath \$valuePath\).Length -le 32768\)/);
  assert.match(branch, /try \{\s+\$failure = Get-Content -LiteralPath \$valuePath -Raw \| ConvertFrom-Json/);
  assert.match(branch, /catch \{ \$reply.guestCode = 'GUEST_FAILURE_FILE_INVALID' \}/);
  const filter = /if \(\$failure.guestCode -is \[string\] -and \$failure.guestCode -cmatch '([^']+)'\) \{ \$reply.guestCode = \$failure.guestCode \}/.exec(branch);
  assert.ok(filter);
  assert.equal(filter[1], '^[A-Z][A-Z0-9_]{0,79}\\z');
  assert.match(text, /\$code -cnotin \$known/);
  assert.match(text, /\$reply.error = \$code/);
  assert.match(text, /\$depth -lt 4/);
  // Model only the extracted .NET string predicate, with an absolute JS end.
  const pattern = new RegExp(filter[1].replace('\\z', '(?![\\s\\S])'));
  return (guestCode, bytes) => bytes <= 32768 && typeof guestCode === 'string' && pattern.test(guestCode);
}

test('task guestCode accepts only bounded fixed-format strings from a bounded ordinary failure file', () => {
  const accepts = policy(source);
  for (const value of ['LEASE_EXPIRED', 'A', 'A'.repeat(80)]) assert.equal(accepts(value, 32768), true);
  for (const value of ['free text', 'private', 'C:\\secret\\file.txt', '/tmp/private', '{"contents":"private"}',
    'PRIVATE file contents', 'CODE\n', 'CODE\r\n', 'A'.repeat(81), '', 42, null, {}, ['CODE']]) {
    assert.equal(accepts(value, 128), false, JSON.stringify(value));
  }
  assert.equal(accepts('LEASE_EXPIRED', 32769), false);
});

test('task source policy catches missing size, type, case, end, malformed-JSON and outer-code guards', () => {
  policy(source);
  for (const [before, after] of [
    ['.Length -le 32768', '.Length -le 32769'],
    ['$failure.guestCode -is [string] -and ', ''],
    ['$failure.guestCode -cmatch', '$failure.guestCode -match'],
    ["^[A-Z][A-Z0-9_]{0,79}\\z", "^[A-Z][A-Z0-9_]{0,79}$"],
    ["catch { $reply.guestCode = 'GUEST_FAILURE_FILE_INVALID' }", 'catch {}'],
    ['$code -cnotin $known', '$code -cin $known'],
  ]) {
    assert.ok(source.includes(before), before);
    assert.throws(() => policy(source.replace(before, after)), assert.AssertionError, before);
  }
});
