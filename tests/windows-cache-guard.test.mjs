import test from 'node:test';
import assert from 'node:assert/strict';
import { preapprovedWriteTarget, PROTECTED, preapprovedWriteDenied as guard } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';

const home = ['C:', 'Users', 'fixture'].join('/');
const options = { platform: 'win32', home, stat: async path => ({ realPath: path }) };
const roots = [String.raw`$env:LOCALAPPDATA\sleight\turbo-host`, String.raw`%LOCALAPPDATA%\sleight\turbo-host`,
  String.raw`~\AppData\Local\sleight\turbo-host`, String.raw`C:\Users\fixture\AppData\Local\sleight\turbo-host`,
  'c:/users/fixture/appdata/local/sleight/turbo-host', '${env:LOCALAPPDATA}\\sleight\\turbo-host'];
const writers = ['Copy-Item', 'Move-Item', 'Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Remove-Item', 'Rename-Item',
  'cp', 'copy', 'move', 'mv', 'del', 'erase', 'rd', 'rmdir', 'ren', 'ni', 'ri', 'sc', 'ac', 'xcopy', 'robocopy'];
const wrappers = [text => text, text => `cmd /c ${text.replaceAll("'", '"')}`, text => `cmd.exe /d /s /c "${text.replaceAll("'", '"')}"`,
  text => `powershell -c "${text}"`, text => `powershell.exe -NoProfile -Command "${text}"`,
  text => `pwsh -c "${text}"`, text => `pwsh.exe -Command "${text}"`,
  text => `powershell -EncodedCommand ${Buffer.from(text, 'utf16le').toString('base64')}`,
  text => `pwsh -EncodedCommand ${Buffer.from(text, 'utf16le').toString('base64')}`];
const invocation = (verb, root) => {
  const file = `'${root}\\person-run-123\\person-host.exe'`;
  if (['Copy-Item', 'Move-Item', 'cp', 'copy', 'move', 'mv', 'xcopy'].includes(verb)) return `${verb} evil ${file}`;
  if (['Set-Content', 'Add-Content', 'sc', 'ac'].includes(verb)) return `${verb} -Path ${file} -Value evil`;
  if (verb === 'Out-File') return `Write-Output evil | Out-File -FilePath ${file}`;
  if (['Rename-Item', 'ren'].includes(verb)) return `${verb} ${file} replacement.exe`;
  if (verb === 'robocopy') return `robocopy C:\\evil '${root}\\person-run-123' person-host.exe`;
  return `${verb} ${file}`;
};

for (const verb of writers) test(`Windows cache refuses ${verb} through native shells and path spellings`, async () => {
  for (const root of roots) for (const wrap of wrappers) {
    const command = wrap(invocation(verb, root));
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
  }
});

test('Windows cache refuses redirects, ambiguous syntax, encoded scripts and relative writes', async () => {
  for (const root of roots) for (const command of [
    `echo evil > '${root}\\a.exe'`, `Write-Output evil >> '${root}\\a.exe'`,
    `Write-Output evil 2> '${root}\\a.exe'`, `Write-Output evil *> '${root}\\a.exe'`,
    `& $writer '${root}\\a.exe'`, `Mystery-Writer '${root}\\a.exe'`,
    `Copy-Item -Destination:'${root}\\a.exe' evil`, `Remove-Item '${root}\\a.exe`,
    `Set-Content -LiteralPath '${root}\\a.exe' -Value evil`, `Add-Content -Path '${root}\\a.exe' -Value evil`,
    `cd '${root}'; Set-Content a.exe evil`, `powershell -Command "cd '${root}'; sc a.exe evil"`,
    `cmd /c "cd /d ${root} & copy evil a.exe"`,
  ]) assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
  for (const command of ['pwsh -EncodedCommand !!!', 'powershell -enc AAAA'])
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
});

test('Windows cache readers retain concrete paths and conservative expansion refusals', async () => {
  for (const root of roots) for (const reader of ['cat', 'type', 'Get-Content', 'Get-FileHash', 'dir']) {
    const command = `${reader} '${root}\\person-host.exe'`;
    assert.equal(await guard({ tool: 'Bash', command }, options), root.includes('{') || root.startsWith('$env:') && reader !== 'cat', command);
  }
  for (const command of [String.raw`Set-Content C:\fixture\a.txt text`, String.raw`Copy-Item evil C:\fixture\a.exe`])
    assert.equal(await guard({ tool: 'Bash', command }, options), false, command);
});

const reviewFamilies = {
  pieces: [String.raw`Set-Content "$env:LOCALAPPDATA\$a\$b\x.exe" evil`,
    String.raw`$a='sleight';$b='turbo-host'; Set-Content "$env:LOCALAPPDATA\$a\$b\x.exe" evil`,
    String.raw`[IO.File]::WriteAllBytes([IO.Path]::Combine($env:LOCALAPPDATA,'sleight','turbo-host','x'),1)`,
    String.raw`iex ("Set-Con"+"tent $env:LOCALAPPDATA\sleight\turbo"+"-host\x evil")`,
    String.raw`cmd /c "set p=%LOCALAPPDATA%&& copy evil %p%\sleight\turbo-host\x"`,
    String.raw`Set-Content ('slei'+'ght\tur'+'bo-host\x') evil`],
  bases: [String.raw`[Environment]::GetFolderPath('LocalApplicationData')`,
    String.raw`Set-Content "$env:TEMP\..\$a\$b\x" evil`,
    String.raw`Set-Content $env:APPDATA\..\Local\sleight\turbo-host\x evil`,
    String.raw`Remove-Item %TEMP%\..\$a\$b -Recurse`, String.raw`Remove-Item ~\..\$a -Recurse`],
  wildcards: [String.raw`Set-Content $env:LOCALAPPDATA\sleight\turbo-ho*\x evil`,
    String.raw`Set-Content $env:LOCALAPPDATA\sl*\turbo-host\x evil`,
    String.raw`Set-Content $env:LOCALAPPDATA\sleight\tu*\x evil`,
    String.raw`Set-Content C:\Users\fixture\AppData\Loc*\sleight\turbo-host\x evil`,
    String.raw`Remove-Item C:\Users\fixture\*\Loc?l\sl[ei]*\x`,
    String.raw`Remove-Item $env:USERPROFILE\*\*\x`, String.raw`Remove-Item -Path:C:\Users\fixture\*\x`],
  shortNames: [String.raw`Remove-Item C:\Users\fixture\APPDAT~1\Local\$a\x`,
    String.raw`Remove-Item C:\Users\fixture\AppData\Local\sleight\TURBO-~1\x`,
    String.raw`Remove-Item C:\Users\fixture\APPDAT~1\Local\SLEIGH~1\TURBO-~1\x`,
    String.raw`Remove-Item C:\fixture\SLEIGH~1\x`],
  escapes: ['Set-Content $env:LOCALAPPDATA\\sleight\\turbo`-host\\x evil',
    'Set-Content $env:LOCALAPPDATA\\sleight\\turbo``-host\\x evil',
    String.raw`cmd /c copy evil %LOCALAPPDATA%\sleight\tur^bo-host\x`,
    String.raw`cmd /c copy evil %LOCALAPPDATA:~0%\sleight\turbo-host\x`,
    String.raw`cmd /c copy evil %LOCALAPPDATA:a=a%\sleight\turbo-host\x`,
    String.raw`cmd /c copy evil %p:~0%\x`, String.raw`cmd /c copy evil C:\slei^ght\x`],
  trailing: [String.raw`cmd /c rd /s /q %LOCALAPPDATA%\sleight\turbo-host&echo done`,
    String.raw`Remove-Item -Recurse $env:LOCALAPPDATA\sleight\turbo-host&`,
    String.raw`Remove-Item $env:LOCALAPPDATA\sleight\turbo-host,x`,
    String.raw`Remove-Item ($env:LOCALAPPDATA+"\sleight\turbo-host")`,
    String.raw`Remove-Item C:\fixture\sleightx`],
};
for (const [family, commands] of Object.entries(reviewFamilies)) test(`fail closed for review family: ${family}`, async () => {
  for (const command of commands) assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
});

test('reader exemption never covers a second statement or executable syntax', async () => {
  const read = String.raw`cat $env:LOCALAPPDATA\sleight\turbo-host\x`;
  for (const separator of ['\n', '\r\n', '\r', ';', '&', '|', '<', '>', '`', '(', '{']) {
    const command = read + separator + String.raw`Remove-Item $env:LOCALAPPDATA\sleight\turbo-host\x`;
    assert.equal(await guard({ tool: 'Bash', command }, options), true, JSON.stringify(command));
  }
  for (const command of [String.raw`cat $env:LOCALAPPDATA\sleight\turbo-host\*`,
    String.raw`cat "$env:LOCALAPPDATA\sleight\$name"`, String.raw`cat 'slei'ght\x`,
    String.raw`rg --pre=runner sleight file`, String.raw`git grep -Orunner sleight`,
    String.raw`cat %name:~0%\sleight\x`]) assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
});

test('all encoded-command abbreviations refuse on Windows', async () => {
  for (const shell of ['pwsh', 'powershell.exe', String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`]) {
    for (const prefix of ['-', '/']) for (const flag of ['e', 'ec', 'en', 'enc', 'enco', 'EncodedC', 'EncodedCommand']) {
      for (const value of [' AAAA', ':AAAA', '']) {
        const command = `${shell} ${prefix}${flag}${value}`;
        assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
      }
    }
  }
  assert.equal(await guard({ tool: 'Bash', command: 'git commit -m "use pwsh -e flag"' }, options), false);
  for (const command of ['pwsh "-en" AAAA', "powershell '-enco' AAAA", 'pwsh -e`n AAAA',
    'pwsh -e^n AAAA', 'pwsh -EncodedCommand:AAAA'])
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
});

const ordinaryWindows = ['git status', 'git diff', 'git log -5', 'git add src/index.js', 'git commit -m "fix tests"',
  'npm test', 'npm install', 'npm run build', 'node --version', 'node scripts/build.mjs',
  String.raw`dir C:\fixture\project`, String.raw`dir "C:\fixture\project with spaces"`,
  String.raw`Set-Content C:\fixture\a.txt text`, String.raw`Copy-Item evil C:\fixture\a.exe`,
  String.raw`Remove-Item C:\fixture\a.exe`, 'pwsh -NoProfile -Command "Get-Date"',
  'powershell -NoProfile -Command "Get-Location"', 'cmd /c ver'];
test('18 ordinary Windows commands stay allowed', async () => {
  assert.equal(ordinaryWindows.length, 18);
  for (const command of ordinaryWindows) assert.equal(await guard({ tool: 'Bash', command }, options), false, command);
});

test('single literal readers retain the plain Mac read forms on Windows', async () => {
  for (const command of [String.raw`grep -n sleight C:\fixture\file`, String.raw`rg turbo C:\fixture\file`,
    String.raw`head C:\fixture\sleight.log`, String.raw`tail C:\fixture\sleight.log`,
    String.raw`wc C:\fixture\sleight.log`, String.raw`file C:\fixture\sleight.log`,
    String.raw`stat C:\fixture\sleight.log`, String.raw`diff C:\fixture\sleight.log C:\fixture\old.log`,
    'git --no-pager log --oneline -- sleight', 'git status -- sleight'])
    assert.equal(await guard({ tool: 'Bash', command }, options), false, command);
});

test('18 ordinary Mac commands stay allowed and the Mac helper cache stays protected', async () => {
  const commands = ['cp a b', 'rm -rf node_modules', 'tee project.txt', 'sed -i x project.txt', 'npm test',
    'git commit -m "pwsh -enc x"', String.raw`Set-Content $env:LOCALAPPDATA\Temp\foo x`,
    String.raw`cmd /c copy evil %LOCALAPPDATA%\npm\x`, 'xcopy a b', 'cat ~/AppData/Local/sleight/turbo-host/x',
    'node script.js', 'python3 script.py', 'git status', 'pwd', 'ls -la', 'echo hello', 'mkdir project', 'touch file'];
  assert.equal(commands.length, 18);
  for (const command of commands) assert.equal(await guard({ tool: 'Bash', command }, { ...options, platform: 'darwin' }), false, command);
  assert.equal(await guard({ tool: 'Bash', command: 'tee ~/Library/Caches/sleight/helper' }, { ...options, platform: 'darwin' }), true);
});

test('false-positive cost is explicit for common Windows commands', async () => {
  for (const command of [String.raw`cd C:\Users\fixture\Projects\sleight`,
    String.raw`Remove-Item $env:LOCALAPPDATA\Temp\foo`, String.raw`npm config set cache $env:LOCALAPPDATA\npm-cache`,
    'echo see %LOCALAPPDATA% dir', String.raw`Remove-Item C:\Users\fixture\project\*.tmp`,
    'echo %p:~0%', 'pwsh -en RwBlAHQALQBEAGEAdABlAA==', String.raw`cd $env:TEMP\..`])
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
});

test('opaque script and pipe contents remain outside the text guard', async () => {
  for (const command of ['powershell -File runner.ps1', 'pwsh -f runner.ps1', String.raw`.\runner.ps1`,
    'Get-Content runner.ps1 | iex', 'type runner.ps1 | powershell -Command -', 'python runner.py', 'node runner.js',
    'pwsh -Command "iex $script"'])
    assert.equal(await guard({ tool: 'Bash', command }, options), false, command);
});

test('macOS retains its launcher refusal for expanding Windows-looking operands', async () => {
  for (const verb of writers) assert.equal(await preapprovedWriteTarget({ tool: 'Bash', command: `${verb} '${roots[0]}\\a.exe'` },
    { ...options, platform: 'darwin' }), PROTECTED.launcher, verb);
  for (const verb of writers) assert.equal(await preapprovedWriteTarget({ tool: 'Bash', command: `${verb} '${roots[3]}\\a.exe'` },
    { ...options, platform: 'darwin' }), undefined, verb + ': Windows cache policy remains off on macOS');
});

test('Windows cache guard refuses normalized paths and globbed cache roots', async () => {
  for (const command of [String.raw`Remove-Item $env:LOCALAPPDATA\sleight\turbo-host* -Recurse`,
    String.raw`Remove-Item ~\AppData\Local\sleight\turbo-host? -Recurse`,
    String.raw`Set-Content -Path ~\AppData\Local\sleight\elsewhere\..\turbo-host\a.exe -Value evil`,
    String.raw`pwsh -Command "New-Item $env:LOCALAPPDATA\sleight\.\turbo-host\a.exe"`])
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
});
