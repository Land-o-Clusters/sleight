import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preapprovedWriteDenied as guard, preapprovedWriteTarget, preapprovedWriteReason } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';

// Reviewer commands are never executed. Only the real text guard sees these fixtures.
const fixtures = JSON.parse(readFileSync(new URL('fixtures/windows-guard-review.json', import.meta.url)));
const options = { platform: 'win32', home: ['C:', 'Users', 'fixture'].join('/'), stat: async path => ({ realPath: path }) };
const refused = async rows => {
  const result = [];
  for (const row of rows) if (await guard(row, options)) result.push(row.command ?? row.file_path);
  return result;
};

test('WIN5R3 fixture populations retain the measured baseline', () => {
  for (const [name, total, denied] of [['ordinary', 214, 37], ['review', 153, 70], ['fullIntent', 55, 11], ['extra', 24, 8]]) {
    assert.equal(fixtures[name].length, total);
    assert.equal(fixtures[name].filter(row => row.beforeDenied).length, denied);
  }
});

test('all 214 ordinary Windows developer commands pass the narrowed guard', async () => {
  assert.deepEqual(await refused(fixtures.ordinary), []);
});

// These prior refusals carry a folder hint, hinted wildcard or environment traversal.
const hintProbes = [0, 1, 4, 5, 6, 9, 16, 24, 25, 43, 44, 45, 51, 53, 54, 55, 56, 59, 60,
  65, 67, 68, 69, 70, 74, 75, 80, 86, 87, 91, 93, 96, 99, 104, 105, 107, 112, 117, 118, 120,
  121, 122, 123, 128, 136, 137, 139, 142, 143, 144, 145, 150, 151];
test('all 153 review probes retain 53 hint refusals and refuse two decoded expressions', async () => {
  assert.equal(hintProbes.length, 53);
  for (const [index, row] of fixtures.review.entries()) {
    const expected = hintProbes.includes(index) || [36, 37].includes(index);
    if (hintProbes.includes(index)) assert.equal(row.beforeDenied, true, `baseline probe ${index}`);
    assert.equal(await guard(row, options), expected, `probe ${index}: ${row.command}`);
  }
});

test('the 55 full-intent name-building probes document the text guard limit', async () => {
  assert.deepEqual(await refused(fixtures.fullIntent), []);
});

test('wildcards require a hint in the same word', async () => {
  for (const command of ['git add *.js', 'Remove-Item -Path:*.exe', 'cat README.md; dir *.cs',
    '$values[0]', '$x = 5; $x[0]',
    'Set-Location ..; Set-Location Local; Set-Location sle?ght']) {
    assert.equal(await guard({ tool: 'Bash', command }, options), false, command);
  }
  for (const command of [String.raw`Remove-Item C:\Users\fixture\*\x`, String.raw`Remove-Item -Path:C:\Users\fixture\*\x`,
    String.raw`Remove-Item $env:USERPROFILE\*\x`, String.raw`Remove-Item %ROOT%\*\x`,
    String.raw`Remove-Item .\Local\*\x`, String.raw`Remove-Item .\sleigh~1\*`,
    String.raw`Remove-Item $env:APPDATA\*\x`, String.raw`Set-Content .\*\x evil`]) {
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
  }
});

test('encoded flags belong to PowerShell invocations, including wrappers and stripped spellings', async () => {
  for (const command of ['git commit -m "use pwsh -e flag"', 'node -e "console.log(1)"',
    'Set-Content x -Encoding utf8', 'robocopy a b /E', 'docker run -e FOO=bar image',
    'pwsh -Command "echo -e"', 'echo -en AAAA', 'echo pwsh -e AAAA', 'Write-Host powershell -en AAAA',
    'git commit -m pwsh -e flag', 'cmd /c "echo pwsh -e AAAA"']) {
    assert.equal(await guard({ tool: 'Bash', command }, options), false, command);
  }
  for (const command of ['PoWeRsHeLl.ExE /E AAAA', '& "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -en AAAA',
    'cmd /c "p^wsh -e^n AAAA"', 'cmd /c pwsh -en AAAA', 'pwsh -Command "powershell -en AAAA"',
    '"po"wershell -e AAAA', "'pw'+'sh' -en AAAA", 'pwsh "-en" AAAA', 'pwsh -e`n AAAA']) {
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
  }
});

test('turbo, git formats and roaming APPDATA are ordinary data without a Local hint', async () => {
  for (const command of ['npm run turbo', 'git log --format="%h:%s"', 'git log --format="%h:~0%"',
    String.raw`cd $env:APPDATA`, String.raw`code $env:APPDATA\Code\User\settings.json`])
    assert.equal(await guard({ tool: 'Bash', command }, options), false, command);
  for (const command of [String.raw`copy evil %p:~0%\x`, String.raw`copy evil %p:a=b%\x`,
    String.raw`Set-Content $env:APPDATA\..\x evil`, String.raw`Set-Content $env:APPDATA\Local\x evil`,
    'copy evil --format="%p:~0%/x"',
    'Set-Content turbo-host/x evil', 'turbo appdata', 'turbo sleight'])
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
});

test('Windows refusals name the matched rule without inventing a helper-folder spelling', async () => {
  for (const [command, reason] of [['pwsh -en AAAA', /encoded PowerShell/],
    [String.raw`Set-Content $env:TEMP\..\x evil`, /environment.*traversal/],
    [String.raw`Remove-Item C:\Users\fixture\*\x`, /wildcard.*path hint/],
    [String.raw`Set-Content $env:LOCALAPPDATA\x evil`, /local app-data/],
    [String.raw`copy evil %p:~0%\x`, /cmd variable substitution/]]) {
    const label = await preapprovedWriteTarget({ tool: 'Bash', command }, options);
    assert.ok(label, command);
    const message = preapprovedWriteReason(label);
    assert.match(message, reason);
    assert.doesNotMatch(message, /names sleight's helper folder/);
  }
  const label = await preapprovedWriteTarget({ tool: 'Bash', command: 'Set-Content sleight/turbo-host/x evil' }, options);
  assert.match(preapprovedWriteReason(label), /names sleight's helper folder/);
  const hint = await preapprovedWriteTarget({ tool: 'Bash', command: 'Set-Content sleight/x evil' }, options);
  assert.match(preapprovedWriteReason(hint), /helper-name hint/);
  assert.doesNotMatch(preapprovedWriteReason(hint), /names sleight's helper folder/);
});

test('rg hostname helpers are executable reader options on Windows and macOS', async () => {
  for (const platform of ['win32', 'darwin']) for (const flag of ['--hostname-bin runner', '--hostname-bin=runner']) {
    const command = platform === 'win32' ? `rg ${flag} x C:\\p\\sleight` : `rg ${flag} sleight-mcp hand file`;
    assert.equal(await guard({ tool: 'Bash', command }, { ...options, platform }), true, command);
  }
});

test('extra reviewer probes retain readers and expose unresolved Windows file aliases', async () => {
  // Native fs.stat canonicalization still needs a Windows run. These are identity-stat fixtures.
  // SA1D also protects the settings directory itself (probe 7), including file-tool writes.
  const deniedIndices = [0, 2, 3, 7, 12, 16, 17, 20];
  for (const [index, row] of fixtures.extra.entries())
    assert.equal(await guard(row, options), deniedIndices.includes(index), `probe ${index}: ${row.command ?? row.file_path}`);
});
