import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preapprovedWriteDenied as guard } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';

// Recovered WIN5R5 reviewer corpora. Commands are data and are never executed.
// beforeDenied records 384adc19, denied records the polish result, both with identity stat.
const fixtures = JSON.parse(readFileSync(new URL('fixtures/windows-guard-polish.json', import.meta.url)));
const options = platform => ({ platform, home: platform === 'win32' ? ['C:', 'Users', 'fixture'].join('/') : '/home/fixture',
  stat: async path => ({ realPath: path }) });
const totals = { macOrdinary: [27, 7, 8], windowsOrdinary: [19, 9, 2], wildcard: [60, 39, 39], wrappers: [111, 92, 98], posixAttacks: [37, 32, 36], macBashExtra: [182, 6, 6] };
for (const [name, rows] of Object.entries(fixtures)) {
  const posix = ['macOrdinary', 'posixAttacks', 'macBashExtra'].includes(name);
  test(`reviewer ${name} retains its baseline and current decisions`, async t => {
    assert.deepEqual([rows.length, rows.filter(r => r.beforeDenied).length, rows.filter(r => r.denied).length], totals[name]);
    if (name === 'wrappers') assert.equal(rows.filter(r => r.beforeDenied && !r.denied).length, 0, 'no baseline wrapper refusal reopens');
    for (const platform of posix ? ['darwin', 'linux'] : ['win32']) for (const row of rows)
      assert.equal(await guard({ tool: posix && name !== 'macBashExtra' ? 'PowerShell' : 'Bash', command: row.command }, options(platform)), row.denied, `${platform}: ${row.command}`);
    t.diagnostic(`${rows.length} commands; refused ${totals[name][1]} before, ${totals[name][2]} after`);
  });
}
test('relative globs allow final filename patterns but refuse wildcard parents and short prefixes', async () => {
  for (const command of ['git add ./src/*.ts', 'rm -rf ./build/*', 'node --test ./tests/*.test.mjs',
    String.raw`Select-String -Path .\src\*.cs -Pattern TODO`, 'cp ../config/* .', 'dir ../*.sln',
    'cp ./files/abcde* out', 'cp ./files/a*.txt out'])
    assert.equal(await guard({ tool: 'Bash', command }, options('win32')), false, command);
  for (const command of ['rm -rf ./*/x', 'rm -rf ../A*/L*/s*', 'rm -rf ./sl*', 'rm -rf ../abcd*',
    'rm -rf ./a?', 'rm -rf ./a[bc]/x', String.raw`Remove-Item -Path:..\sl*`, String.raw`Remove-Item -Path:.\*\x`])
    assert.equal(await guard({ tool: 'Bash', command }, options('win32')), true, command);
});
test('parenthesized runners retain execution context and operators still separate data commands', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const command of [
    'iex ("powershell -e AAAA")', 'Invoke-Expression ("pwsh -enc AAAA")', 'iex (("pwsh -e AAAA"))',
    'cmd /c ("powershell -e AAAA")', 'echo harmless; iex ("pwsh -enc AAAA")',
    'winget install powershell -e; iex ("pwsh -enc AAAA")',
  ]) assert.equal(await guard({ tool: 'PowerShell', command }, options(platform)), true, command);
});
test('package and lookup commands treat shell names as data through wrappers too', async () => {
  for (const executable of ['winget', 'choco', 'scoop', 'brew', 'which', 'Get-Command']) {
    const command = `${executable} powershell -e`;
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const text of [command, `cmd /c "${command}"`])
        assert.equal(await guard({ tool: 'PowerShell', command: text }, options(platform)), false, text);
      assert.equal(await guard({ tool: 'PowerShell', command: command + '; pwsh -enc AAAA' }, options(platform)), true);
    }
  }
});
test('lookup and data groups used as programs refuse encoded flags on all platforms', async () => {
  const commands = [
    '& (Get-Command powershell) -enc AAAA',
    '& (Get-Command pwsh).Source -enc AAAA',
    '& (Get-Command powershell.exe -ErrorAction Stop) -EncodedCommand AAAA',
    '& $(Get-Command pwsh) -enc AAAA',
    '. (Get-Command pwsh) -enc AAAA',
    '& (which pwsh) -enc AAAA',
    '$(which pwsh) -enc AAAA',
    '`which pwsh` -enc AAAA',
    '& (winget list pwsh) -enc AAAA',
    '& (echo pwsh) -enc AAAA',
    '& (Get-Command pwsh) -enc AAAA',
    '$(printf pwsh) -enc AAAA',
    '& (git rev-parse pwsh) -enc AAAA',
  ];
  for (const platform of ['win32', 'darwin', 'linux']) for (const tool of platform === 'win32' ? ['Bash', 'PowerShell'] : ['PowerShell']) {
    for (const command of commands)
      assert.equal(await guard({ tool, command }, options(platform)), true, `${platform} ${tool}: ${command}`);
    for (const command of ['winget powershell -e', 'cmd /c "which pwsh"', 'echo pwsh -enc AAAA'])
      assert.equal(await guard({ tool, command }, options(platform)), false, `${platform} ${tool}: ${command}`);
  }
});
test('escape ticks and substitution groups both retain encoded-command refusals', async t => {
  const commands = [
    'p`wsh -enc AAAA x`y',
    'pw`sh -enc AAAA a`b',
    'pw`sh.exe -ec AAAA a`b',
    'pwsh -`enc AAAA x`y',
    'powershell -`EncodedCommand AAAA a`b',
    'pwsh -enc A`AA`A x`y',
    'pwsh.ex`e -enc AAAA a`b',
    'p`w`s`h -e`n`c A`AA`A',
    'p`wsh.ex`e -ec AA`AA a`b',
    'pwsh -e`nc AAAA a`b',
    'p`wsh -enc AAAA',
    '`pwsh` -enc AAAA',
  ];
  const results = [];
  for (const platform of ['win32', 'darwin', 'linux']) for (const tool of platform === 'win32' ? ['Bash', 'PowerShell'] : ['PowerShell']) {
    for (const command of commands) results.push({ platform, tool, command, denied: await guard({ tool, command }, options(platform)) });
  }
  t.diagnostic(`${commands.length} tick spellings; ${results.filter(r => r.denied).length}/${results.length} refused`);
  for (const { platform, tool, command, denied } of results) assert.equal(denied, true, `${platform} ${tool}: ${command}`);
});
test('tick continuations and escaped quotes cannot hide encoded flags in either reading', async t => {
  const commands = [
    'pwsh `\n-enc AAAA', 'pwsh `\r\n-enc AAAA',
    'pw`\nsh -enc AAAA', 'pw`\r\nsh -enc AAAA',
    'pwsh -en`\nc AAAA', 'pwsh -en`\r\nc AAAA',
    'echo `"x ; pwsh -enc AAAA', 'echo "a`"b" ; pwsh -enc AAAA',
    "echo `'x ; pwsh -enc AAAA", "echo 'a`'b' ; pwsh -enc AAAA",
    'echo `which pwsh` `\n-enc AAAA', 'echo `which pwsh` -`"enc AAAA',
    'echo `which pwsh` -`\'enc AAAA',
  ];
  const results = [];
  for (const platform of ['win32', 'darwin', 'linux']) for (const tool of platform === 'win32' ? ['Bash', 'PowerShell'] : ['PowerShell']) {
    for (const command of commands) results.push({ platform, tool, command, denied: await guard({ tool, command }, options(platform)) });
  }
  t.diagnostic(`${commands.length} continuation/quote spellings; ${results.filter(r => r.denied).length}/${results.length} refused`);
  for (const { platform, tool, command, denied } of results) assert.equal(denied, true, `${platform} ${tool}: ${command}`);
});
test('Windows Bash checks executable substitutions inside double quotes', async t => {
  const commands = [
    'echo "$(pwsh -enc AAAA)"', 'echo "`pwsh -enc AAAA`"',
    'git commit -m "$(powershell.exe -EncodedCommand AAAA)"',
    'echo "prefix$(pwsh -ec AAAA)suffix"',
    'echo "$(echo "$(pwsh -enc AAAA)")"',
    'echo "$(printf \'%s\' "$(pwsh -enc AAAA)")"',
    'echo "$(echo \')\'; pwsh -enc AAAA)"',
    'echo "$(echo ignored); `pwsh -enc AAAA`"',
    'echo "$(# )\npwsh -enc AAAA\n)"',
    'echo "$(# \" )\npwsh -enc AAAA\n)"',
    'echo "$(iex GetString FromBase64String AAAA)"',
    'echo "`iex GetString FromBase64String AAAA`"',
    'echo "$(sleight-mcp hand on)"', 'echo "`sleight-mcp hand on`"',
  ];
  const results = [];
  for (const command of commands) results.push({ command, denied: await guard({ tool: 'Bash', command }, options('win32')) });
  t.diagnostic(`${commands.length} quoted substitutions; ${results.filter(r => r.denied).length}/${results.length} refused`);
  for (const { command, denied } of results) assert.equal(denied, true, command);
});
test('Windows Bash keeps literal and ordinary substitution arguments available', async () => {
  for (const command of [
    'echo \'$(pwsh -enc AAAA)\'', 'echo \'`pwsh -enc AAAA`\'',
    'echo "\\$(pwsh -enc AAAA)"', 'echo "\\`pwsh -enc AAAA\\`"',
    'echo "$(printf \'%s\' \'pwsh -enc AAAA\')"',
    'echo "$(echo \'pwsh -enc AAAA\')"',
    'echo "$(pwsh -NoProfile -File build.ps1)"',
    'git commit -m "run `pwsh -NoProfile` first"',
    'echo "$(git rev-parse --show-toplevel)"',
  ]) assert.equal(await guard({ tool: 'Bash', command }, options('win32')), false, command);
});
test('WP1R3 ordinary corpora retain counts in both Windows tools', async t => {
  const r5 = JSON.parse(readFileSync(new URL('fixtures/windows-guard-r5.json', import.meta.url)));
  const tuning = JSON.parse(readFileSync(new URL('fixtures/windows-guard-review.json', import.meta.url))).ordinary;
  const corpora = { heldout: [r5.heldout.slice(0, 364), [25, 162]], tuning: [tuning, []], windows: [fixtures.windowsOrdinary, [1, 3]] };
  for (const tool of ['Bash', 'PowerShell']) for (const [name, [rows, expected]] of Object.entries(corpora)) {
    const denied = [];
    for (const [index, row] of rows.entries()) if (await guard({ tool, command: row.command }, options('win32'))) denied.push(index);
    t.diagnostic(`${tool} ${name}: ${rows.length} commands; ${denied.length} refused; indexes ${denied.join(',')}`);
    assert.deepEqual(denied, expected, `${tool} ${name}`);
  }
});
test('backtick shell mentions fail closed while quoted mentions stay data', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const tool of platform === 'win32' ? ['Bash', 'PowerShell'] : ['PowerShell']) {
    // This can execute a POSIX substitution, so allowing it would hide a guarded invocation.
    assert.equal(await guard({ tool, command: 'echo use `pwsh -e` for scripts' }, options(platform)), true);
    for (const command of ['echo use pwsh -e for scripts', "echo 'use `pwsh -e` for scripts'", 'git commit -m "run `pwsh -NoProfile` first"'])
      assert.equal(await guard({ tool, command }, options(platform)), false, `${platform} ${tool}: ${command}`);
  }
});
test('POSIX PowerShell protects wildcard cache and support words, including location changes', async () => {
  for (const platform of ['darwin', 'linux']) {
    for (const command of ['Set-Content ~/Library/Caches/sl*/x evil',
      'Set-Content (Join-Path $HOME "Library/Caches/sl*/x") evil',
      'cd ~/Library/Caches/sl*; Set-Content turbo-host/x evil',
      'Set-Location ~/Library/Caches; Remove-Item -Recurse sl*',
      'Remove-Item ~/Library/Application*/sl* -Recurse',
      'Remove-Item "${HOME}/Library/Application*Support/sl*" -Recurse'])
      assert.equal(await guard({ tool: 'PowerShell', command }, options(platform)), true, command);
    for (const command of ['Get-Content ~/Library/Caches/other/x', 'Remove-Item ./cache/*.tmp',
      'Set-Content ./library-code/*.txt x', 'Copy-Item ~/Downloads/*.zip ./backup'])
      assert.equal(await guard({ tool: 'PowerShell', command }, options(platform)), false, command);
  }
});
