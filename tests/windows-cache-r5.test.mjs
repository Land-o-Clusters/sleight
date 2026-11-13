import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preapprovedWriteDenied as guard } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';

// These strings are guard inputs only. No fixture command is ever executed.
const fixtures = JSON.parse(readFileSync(new URL('fixtures/windows-guard-r5.json', import.meta.url)));
const tuning = JSON.parse(readFileSync(new URL('fixtures/windows-guard-review.json', import.meta.url))).ordinary;
const options = { platform: 'win32', home: ['C:', 'Users', 'fixture'].join('/'), stat: async path => ({ realPath: path }) };

for (const [index, row] of fixtures.attacks.entries()) {
  if (row.family !== 'W') continue;
  test(`WIN5R5 wildcard attack ${index} refuses: ${row.command}`, async () => {
    assert.equal(await guard({tool: 'Bash', command: row.command}, options), true);
  });
}
// These three Unicode-dash spellings need a Windows host parser check. pwsh-preview is a different executable name.
const encodedControls = [9, 10, 11, 29];
for (const [index, row] of fixtures.encoded.entries()) {
  if (encodedControls.includes(index)) continue;
  test(`WIN5R5 encoded wrapper ${index} refuses: ${row.command}`, async () => {
    assert.equal(await guard({tool: 'Bash', command: row.command}, options), true);
  });
}

test('decoded base64 passed to iex refuses, including assignment before invocation', async () => {
  for (const command of [
    'powershell -c "$s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(\'AAAA\'));iex $s"',
    'pwsh -Command "iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'AAAA\')))"',
    'iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("AAAA")))',
  ]) assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
});

test('local hint matches a path segment and preserves common localization and localhost globs', async () => {
  for (const command of ['git add src/localization/*.json', 'git add src/locales/*.yml',
    'git add locale/*.po', 'curl http://localhost:3000/api/*', 'curl "http://localhost:3000/search?q=a*"'])
    assert.equal(await guard({tool: 'Bash', command}, options), false, command);
  for (const command of [String.raw`Remove-Item Local\sl*`, String.raw`Remove-Item -Path:Local\sl*`,
    String.raw`Remove-Item AppData\Loc*\s*`, String.raw`ls ~\*.txt`])
    assert.equal(await guard({tool: 'Bash', command}, options), true, command);
});

test('PowerShell tool refuses protected-name mutations on darwin, Linux and WSL', async () => {
  const commands = ['Set-Content "~/Library/Application Support/sleight/permissions.json" "{}"',
    'Add-Content permissions.json x', 'Remove-Item "$HOME/Library/Application Support/sleight/permissions.json"',
    'Remove-Item -Recurse -Force ~/Library/Caches/sleight', 'Copy-Item evil ~/Library/Caches/sleight/turbo-host/x',
    'Out-File -FilePath preapproved.json', 'New-Item turbo.json', 'Move-Item evil hand.json',
    'ri -r ~/Library/Caches/sleight', 'sc permissions.json x', 'cpi evil electron-grants.json',
    'mi evil grant-seal.key', 'ac turbo-owner.json x', 'ni turbo-apps.json', 's`c permi`ssions.json x',
    'Set-Content "~/Library/Application Support/other/config.json" x', 'pwsh -enc AAAA'];
  for (const platform of ['darwin', 'linux']) for (const command of commands)
    assert.equal(await guard({tool: 'PowerShell', command}, {...options, platform, home: '/home/fixture'}), true, command);
});

test('PowerShell readers and ordinary writes pass on POSIX, and Bash keeps its Mac behavior', async () => {
  for (const platform of ['darwin', 'linux']) {
    for (const command of ['Get-Content "~/Library/Application Support/sleight/permissions.json"',
      'Get-Content "$HOME/Library/Application Support/sleight/permissions.json"', 'Get-FileHash grant-seal.key',
      'Set-Content notes.txt x', 'Remove-Item build -Recurse', 'git status',
      'echo pwsh -e AAAA', 'Write-Host powershell -en AAAA', 'git commit -m "pwsh -e"',
      'pwsh -File x.ps1 -Environment staging'])
      assert.equal(await guard({tool: 'PowerShell', command}, {...options, platform}), false, command);
    for (const command of ['Set-Content permissions.json x', 'pwsh -enc AAAA', 'rm -rf ./build/*'])
      assert.equal(await guard({tool: 'Bash', command}, {...options, platform}), false, command);
  }
});

test('PowerShell quoted mentions stay data except in known execution arguments', async () => {
  for (const command of ['echo pwsh -e AAAA', 'Write-Host powershell -en AAAA',
    'git commit -m pwsh -e flag', 'node -e "console.log(\'pwsh -enc AAAA\')"',
    'Get-Content "pwsh -e AAAA"', 'cmd /c "echo pwsh -e AAAA"',
    'echo "iex GetString(FromBase64String(AAAA))"', 'pwsh -File x.ps1 -Environment staging'])
    assert.equal(await guard({tool: 'Bash', command}, options), false, command);
  for (const command of ['echo ok; & { pwsh -enc AAAA }', 'git status; start pwsh -enc AAAA',
    '& pwsh -enc AAAA', 'Start-Process "pwsh" -ArgumentList "-enc AAAA"',
    'Start-Process -FilePath pwsh -ArgumentList @("-enc", "AAAA")',
    'Start-Process pwsh -ArgumentList "-NoProfile -EncodedCommand AAAA"',
    "Start-Process powershell -ArgumentList '-NoProfile','-enc','AAAA'"])
    assert.equal(await guard({tool: 'Bash', command}, options), true, command);
});

test('WIN5R5 corpus measurements retain frozen baselines and print current refusals', async t => {
  const ordinaryRefusals = {tuning: [], heldout: [25, 162], adjacent: [2, 3, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 46]};
  for (const [name, rows] of Object.entries({tuning, ...fixtures})) {
    let denied = 0;
    for (const [index, row] of rows.entries()) {
      const actual = await guard({tool: 'Bash', command: row.command}, name === 'macBash' ?
        {...options, platform: 'darwin', home: ['', 'Users', 'fixture'].join('/')} : options);
      const expected = name in ordinaryRefusals ? ordinaryRefusals[name].includes(index) : name === 'encoded' ? !encodedControls.includes(index) :
        row.family === 'W' ? true : row.beforeDenied;
      assert.equal(actual, expected, `${name} ${index}: ${row.command}`);
      denied += Number(actual);
    }
    t.diagnostic(`${name}: ${rows.length} total; baseline ${name === 'tuning' ? 0 : rows.filter(r => r.beforeDenied).length} refused; current ${denied} refused`);
  }
});

test('the original 364 held-out ordinary commands retain two refusals in both Windows tools', async t => {
  assert.equal(fixtures.heldout.length, 366);
  const rows = fixtures.heldout.slice(0, 364);
  for (const tool of ['Bash', 'PowerShell']) {
    const denied = [];
    for (const [index, row] of rows.entries()) if (await guard({ tool, command: row.command }, options)) denied.push(index);
    assert.deepEqual(denied, [25, 162], tool);
    t.diagnostic(`${tool}: ${rows.length} held-out commands; ${denied.length} refused`);
  }
});
