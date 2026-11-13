import { chromiumShellName } from './fixtures/chromium-isolated.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { runInNewContext } from 'node:vm';
import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
const ts = parserSkip ? undefined : (await import('typescript')).default;
import * as guard from '../plugins/sleight/hooks/shell-guard.mjs';
import * as stopNotice from '../plugins/sleight/hooks/stop-notice.mjs';
import { preapprovedWriteDenied } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import * as writeGuard from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { lineCommentEnd, isLineTerminator } from '../plugins/sleight/lib/code-line-terminators.mjs';

const denied = command => guard.shellLaunchDenied({ tool: 'Bash', command });

const appTools = ['drag', 'hover', 'open_file', 'menu_bar', 'select_window', 'notifications', 'app_handoff', 'browser_tabs'];
async function checkAppFence(tool, source) {
  const h = installedGuard({ source }), event = { tool: 'Bash', command: 'open report.pdf' };
  assert.equal((await h.pre(event)).deny, undefined);
  await h.use(tool, async e => {
    assert.equal((await h.pre(event)).deny, guard.shellGuardReason, 'fence before forwarding');
    return e;
  }, { agentId: 'child' });
  await h.complete();
  assert.equal((await h.pre(event)).deny, guard.shellGuardReason, 'main completion keeps child fence');
  await h.complete({ agentId: 'unrelated' });
  assert.equal((await h.pre(event)).deny, guard.shellGuardReason);
  await h.complete({ agentId: 'child' });
  assert.equal((await h.pre(event)).deny, undefined, 'child completion clears its fence');
  await h.stop();
  assert.match((await h.use(tool)).deny, /user stopped/);
  assert.equal((await h.pre(event)).deny, undefined, 'stopped call cannot raise fence');
}
for (const tool of appTools) test(`SA1E F18 ${tool} fences before forwarding and retains only its loop's fence`, { skip: parserSkip }, () => checkAppFence(tool));

const profileRoots = ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Google/Chrome Dev', 'Chromium',
  'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'com.operasoftware.Opera', 'Opera', 'Vivaldi', 'Arc', 'Helium',
  'net.imput.helium', 'Firefox/Profiles'];
const profileContext = { home: '/fixture/home', cwd: '/fixture/home/project' };
const profileCommand = path => `chrome --headless --user-data-dir="${path}"`;
const profileCases = profileRoots.flatMap(root => [
  `/fixture/home/Library/Application Support/${root}`,
  `/fixture/home/Library/Application Support/${root}/Default`,
  `../Library/Application Support/${root}`,
  `~/Library/Application Support/${root}`,
  `$HOME/Library/Application Support/${root}`,
  `\${HOME}/Library/Application Support/${root}`,
].map(path => [profileCommand(path), profileContext]));
profileCases.push(
  ['firefox --headless --no-remote -profile "/fixture/home/Library/Application Support/Firefox/Profiles/real"', profileContext],
  ['firefox --headless --no-remote -P default', profileContext],
  [profileCommand('relative-profile'), {}], [profileCommand('~/profile'), {}], [profileCommand('$HOME/profile'), {}],
  [profileCommand('$PROFILE'), profileContext], [profileCommand('~someone/profile'), profileContext],
  [profileCommand('/fixture/home/Library/Application Support/Google/Chrome/../Chrome/Default'), profileContext],
  [profileCommand('/fixture/home/library/application support/google/chrome/Default'), profileContext],
  [`cd /fixture/home; ${profileCommand('Library/Application Support/Google/Chrome')}`, profileContext],
  [`env -C /fixture/home ${profileCommand('Library/Application Support/Google/Chrome')}`, profileContext],
  [`env --chdir=/fixture/home ${profileCommand('Library/Application Support/Google/Chrome')}`, profileContext],
  [`env -C/fixture/home ${profileCommand('Library/Application Support/Google/Chrome')}`, profileContext],
  [profileCommand('/tmp/new-profile') + ' --user-data-dir="~/Library/Application Support/Google/Chrome"', profileContext],
  [profileCommand('~/Library/Application Support/Google/Chrome') + ' --user-data-dir=/tmp/new-profile', profileContext],
);
for (const [browser, root] of [
  ['google-chrome', 'Google/Chrome'], ['google-chrome-beta', 'Google/Chrome Beta'],
  ['"Google Chrome Canary"', 'Google/Chrome Canary'], ['chromium', 'Chromium'], ['msedge', 'Microsoft Edge'],
  ['brave-browser', 'BraveSoftware/Brave-Browser'], ['opera', 'com.operasoftware.Opera'],
  ['helium', 'net.imput.helium'],
]) profileCases.push([`${browser} --headless --user-data-dir="~/Library/Application Support/${root}"`, profileContext]);
profileCases.push(['firefox --headless --no-remote --profile="~/Library/Application Support/Firefox/Profiles/real"', profileContext]);
for (const [command, context] of profileCases) test(`SA1M F19 refuses default or unresolved profile: ${command}`, () =>
  assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command, ...context }), true));
function checkSeparateProfiles(api = guard) {
  for (const path of ['/tmp/new-profile', join('/', 'private', 'tmp', 'new-profile'), '~/new-profile', '$HOME/new-profile',
    '/fixture/home/Library/Application Support/Google/Chrome-fixture'])
    assert.equal(api.shellLaunchDenied({ tool: 'Bash', command: profileCommand(path), ...profileContext }), false, path);
  assert.equal(api.shellLaunchDenied({ tool: 'Bash', command: 'firefox --headless --no-remote -profile /tmp/new-profile' }), false);
  assert.match(api.shellGuardReason, /new empty directory/);
}
test('SA1M F19 allows separate paths and asks for a new empty directory', async t => {
  checkSeparateProfiles();
  const broken = await brokenGuard("if (option === '-P') return false;", 'return false;');
  const fresh = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-profile-')));
  for (const browser of ['chrome', 'firefox']) {
    const command = browser === 'firefox' ? `${browser} --headless --no-remote --profile "${fresh}"`
      : `${browser} --headless --user-data-dir="${fresh}"`;
    assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command }), false, command);
    assert.throws(() => assert.equal(broken.shellLaunchDenied({ tool: 'Bash', command }), false), { code: 'ERR_ASSERTION' });
  }
});
async function checkHostPaths(source) {
  for (const cwd of ['/synthetic-home/project', new Error('unknown cwd')]) {
    const h = installedGuard({ cwd, source }); await h.use();
    for (const [hook, tool] of [['classic.PreToolUse', 'Bash'], ['tool.call:Bash', 'Bash'],
      ['tool.call:PowerShell', 'PowerShell'], ['tool.call:Monitor', 'Monitor']]) {
      for (const path of ['~/Library/Application Support/Google/Chrome', '../Library/Application Support/Google/Chrome']) {
        const result = await h.hooks.get(hook)(h.$, { tool, command: profileCommand(path), cwd: '/tmp', home: '/spoof' }, e => e);
        assert.equal(result.deny, guard.shellGuardReason, `${hook}, ${path}, ${cwd}`);
      }
      // A relative profile path refuses whatever the cwd, since an earlier cd may have moved it (sa1m review).
      const result = await h.hooks.get(hook)(h.$, { tool, command: profileCommand('./new-profile') }, e => e);
      assert.equal(result.deny, guard.shellGuardReason, hook);
      const fresh = await h.hooks.get(hook)(h.$, { tool, command: profileCommand('~/new-profile') }, e => e);
      assert.equal(fresh.deny, undefined, `${hook} home-based fresh profile`);
    }
  }
}
test('SA1M F19 host supplies trusted paths through every shell hook', { skip: parserSkip }, () => checkHostPaths());
test('SA1M F19 path-check bypass fails each refusal and separate-path variants fail', async t => {
  const mutant = await brokenGuard('&& separateProfile(value, option)', '');
  for (const [command, context] of profileCases)
    assert.throws(() => assert.equal(mutant.shellLaunchDenied({ tool: 'Bash', command, ...context }), true), { code: 'ERR_ASSERTION' });
  for (const [from, to] of [
    ['if (option === \'-P\') return false;', 'return false;'],
    ['new empty directory', 'profile'],
  ]) {
    const broken = await brokenGuard(from, to);
    assert.throws(() => checkSeparateProfiles(broken), { code: 'ERR_ASSERTION' });
  }
  t.diagnostic(`${profileCases.length} profile-path bypasses caught`);
});
test('SA1M unqualified browser aliases cannot claim a headless exemption', async () => {
  const broken = await brokenGuard('|vivaldi|arc)', ')');
  for (const browser of ['vivaldi', 'arc']) for (const path of ['/tmp/new-profile', `~/Library/Application Support/${browser}`]) {
    const event = { tool: 'Bash', command: `${browser} --headless --user-data-dir="${path}"`, ...profileContext };
    assert.equal(guard.shellLaunchDenied(event), true);
    assert.throws(() => assert.equal(broken.shellLaunchDenied(event), true), { code: 'ERR_ASSERTION' });
  }
});
test('SA1M F19 missing host path wiring fails the hook assertions', { skip: parserSkip }, async t => {
  const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  for (const [from, to] of [
    // The event's cwd no longer changes a verdict (relative profile paths always refuse), and a spoofed home can't
    // hide a real root (the root check matches under any prefix), so the cwd/home spoof variant has nothing to catch.
    ['...await shellPaths($), platform:', 'platform:'],
    ["...await shellPaths($), tool: 'Bash'", "tool: 'Bash'"],
  ]) {
    assert.ok(source.includes(from), from);
    await assert.rejects(checkHostPaths(source.replace(from, to)), { code: 'ERR_ASSERTION' });
  }
  t.diagnostic('2 host path wiring variants caught');
});

const headlessRefusals = [
  'google-chrome --headless https://x.invalid', 'chrome --headless --user-data-dir=',
  'chrome --headless --user-data-dir ""', 'chrome --headless --user-data-dir --dump-dom',
  'chrome --headless --profile-directory=/tmp/p', 'chrome --headless -- --user-data-dir=/tmp/p',
  'firefox --headless https://x.invalid', 'firefox --headless --profile /tmp/p',
  'firefox --headless --no-remote', 'firefox --headless --no-remote --profile ""',
  'firefox --headless --no-remote -P', 'firefox --headless --no-remote -- --profile /tmp/p',
  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless https://x.invalid',
  '"/Applications/Firefox.app/Contents/MacOS/firefox" --headless https://x.invalid',
];
for (const command of headlessRefusals) test(`SA1E F19 requires profile: ${command}`, () => assert.equal(denied(command), true));
test('SA1E F19 accepts isolated profiles and names the required flags', () => {
  for (const command of [
    'chrome --headless --user-data-dir=/tmp/p', 'chromium --headless=new --user-data-dir="/tmp/a b"',
    'firefox --headless --no-remote --profile /tmp/p',
    '"/Applications/Firefox.app/Contents/MacOS/firefox" --headless --no-remote --profile /tmp/p',
    '"/Applications/Helium.app/Contents/MacOS/Helium" --headless --user-data-dir=/tmp/p',
    'chrome --version', 'firefox --help',
  ]) assert.equal(denied(command), false, command);
  for (const flag of ['--user-data-dir', '--no-remote', '--profile']) assert.ok(guard.shellGuardReason.includes(flag), flag);
});

for (const path of ['classic.PreToolUse', 'tool.call:Monitor']) {
  test(`SA1E F20 Monitor launch guard through ${path}`, { skip: parserSkip }, async () => {
    const h = installedGuard();
    const invoke = command => {
      const e = path === 'classic.PreToolUse' ? { tool_name: 'Monitor', tool_input: { command } } : { tool: 'Monitor', command };
      return (h.hooks.get(path) ?? ((_$, e, next) => next(e)))(h.$, e, e => e);
    };
    assert.equal((await invoke('open x')).deny, undefined, 'ordinary turn');
    await h.use();
    assert.equal((await invoke('open x')).deny, guard.shellGuardReason);
    assert.equal((await invoke('printf ok')).deny, undefined);
  });
  test(`SA1E F20 Monitor write guard without a driving turn through ${path}`, { skip: parserSkip }, async () => {
    const h = installedGuard({ realWriteGuard: true });
    const command = 'tee "/synthetic-home/Library/Application Support/sleight/permissions.json"';
    const e = path === 'classic.PreToolUse' ? { tool_name: 'Monitor', tool_input: { command } } : { tool: 'Monitor', command };
    const result = await (h.hooks.get(path) ?? ((_$, e, next) => next(e)))(h.$, e, e => e);
    assert.match(result.deny ?? '', /Only the user changes/);
  });
}

test('SA1E F18 missing and late app-tool fences fail every tool assertion', { skip: parserSkip }, async t => {
  const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  const from = 'for (const name of [...BROWSER_TOOLS, ...APP_TOOLS])';
  assert.ok(source.includes(from));
  const missing = source.replace(from, 'for (const name of BROWSER_TOOLS)');
  const late = source.replaceAll('state.shellUsers.add(loopKey(e))', '')
    .replaceAll('const ran = await forward($, state, e, owner, next)', 'const ran = await forward($, state, e, owner, next); state.shellUsers.add(loopKey(e))');
  for (const tool of appTools) for (const mutant of [missing, late])
    await assert.rejects(checkAppFence(tool, mutant), { code: 'ERR_ASSERTION' });
  t.diagnostic(`${appTools.length * 2} missing/late fence variants caught`);
});
test('SA1E F19 missing isolation check fails every refusal assertion', async t => {
  const mutant = await brokenGuard('isolated && !flags.some', 'true && !flags.some');
  for (const command of headlessRefusals)
    assert.throws(() => assert.equal(mutant.shellLaunchDenied({ tool: 'Bash', command }), true), { code: 'ERR_ASSERTION' });
  t.diagnostic(`${headlessRefusals.length} profile bypass assertions caught the broken variant`);
});
test('SA1E F19 incomplete profile checks and missing recovery flags fail their assertions', async t => {
  for (const [from, to, command, expected] of [
    ["flags.includes('--no-remote') && profile(['--profile', '-profile', '-P'])", 'true', 'firefox --headless', true],
    ["profile(['--user-data-dir'])", "flags.some(arg => arg.includes('profile'))", 'chrome --headless --profile-directory=/tmp/p', true],
    ["values.every(({ value, option }) => value.trim() && !value.startsWith('-') && separateProfile(value, option))", 'true', 'chrome --headless --user-data-dir=', true],
    ["flags.includes('--no-remote') && profile", 'profile', 'firefox --headless --profile /tmp/p', true],
    ["args.length === 1 && ['--version', '--help'].includes(args[0])", 'false', 'chrome --version', false],
  ]) {
    const mutant = await brokenGuard(from, to);
    assert.throws(() => assert.equal(mutant.shellLaunchDenied({ tool: 'Bash', command }), expected), { code: 'ERR_ASSERTION' });
  }
  const reason = await brokenGuard('--user-data-dir=<path>, or Firefox --no-remote --profile <path>', 'an isolated profile');
  assert.throws(() => assert.ok(reason.shellGuardReason.includes('--user-data-dir')), { code: 'ERR_ASSERTION' });
  t.diagnostic('6 incomplete-profile, help and recovery-text variants caught');
});
test('SA1E F20 missing Monitor hook, classic filter or normalization each fails closed checks', { skip: parserSkip }, async t => {
  const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  const variants = [
    ["{ tool: 'Monitor' as 'Bash' }", "{ tool: 'AbsentMonitor' as 'Bash' }", 'tool.call:Monitor', 'launch'],
    ["{ tool: 'Monitor' as 'Bash' }", "{ tool: 'AbsentMonitor' as 'Bash' }", 'tool.call:Monitor', 'write'],
    ["'NotebookEdit', 'Bash', 'PowerShell', 'Monitor'", "'NotebookEdit', 'Bash', 'PowerShell'", 'classic.PreToolUse', 'launch'],
    ["'NotebookEdit', 'Bash', 'PowerShell', 'Monitor'", "'NotebookEdit', 'Bash', 'PowerShell'", 'classic.PreToolUse', 'write'],
    ["if (event.tool === 'Monitor') event = { ...event, tool: 'Bash' }", '', 'classic.PreToolUse', 'write'],
    ["if (event.tool === 'Monitor') event = { ...event, tool: 'Bash' }", '', 'tool.call:Monitor', 'write'],
  ];
  for (const [from, to, path, kind] of variants) {
    assert.ok(source.includes(from), from);
    const h = installedGuard({ source: source.replace(from, to), realWriteGuard: true });
    if (kind === 'launch') await h.use();
    const command = kind === 'launch' ? 'open x' : 'tee "/synthetic-home/Library/Application Support/sleight/permissions.json"';
    const event = path === 'classic.PreToolUse' ? { tool_name: 'Monitor', tool_input: { command } } : { tool: 'Monitor', command };
    const result = await (h.hooks.get(path) ?? ((_$, e, next) => next(e)))(h.$, event, e => e);
    assert.throws(() => assert.match(result.deny ?? '', kind === 'launch' ? /sleight's shell guard/ : /Only the user changes/), { code: 'ERR_ASSERTION' });
  }
  t.diagnostic('6 Monitor guard variants caught');
});

const escapeLaunches = [
  String.raw`echo \'; explorer x; echo \'`,
  String.raw`echo \'; open /Applications/Safari.app; echo \'`,
  String.raw`echo \'; Start-Process notepad; echo \'`,
  String.raw`echo \"; mshta x; echo \"`,
];
const windowsSeparator = String.raw`echo \; explorer x`;

test('UC3C2 platform scans preserve POSIX escapes and Windows separators', () => {
  for (const platform of ['darwin', 'linux', 'win32', undefined]) {
    for (const tool of ['Bash', 'PowerShell']) {
      for (const command of escapeLaunches)
        assert.equal(guard.shellLaunchDenied({ tool, command, platform }), true, `${platform}, ${tool}, ${command}`);
      assert.equal(guard.shellLaunchDenied({ tool, command: windowsSeparator, platform }),
        platform === 'win32' || platform === undefined && !['darwin', 'linux'].includes(process.platform), `${platform}, ${tool}`);
    }
  }
});

test('UC3C2 unknown sandbox platform scans both dialects without Node globals', () => {
  const source = readFileSync(new URL('../plugins/sleight/hooks/shell-guard.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/m, '').replace(/^export /gm, '');
  const scan = code => runInNewContext(code + '\nshellLaunchDenied', { lineCommentEnd, isLineTerminator });
  for (const command of [...escapeLaunches, windowsSeparator])
    assert.equal(scan(source)({ tool: 'Bash', command }), true, command);
});

test('UC3C2 either single-dialect variant fails the escape regression assertions', async () => {
  const from = "return scanShell(input, 'darwin', 0, paths) || scanShell(input, 'win32', 0, paths);";
  const windowsOnly = await brokenGuard(from, "return scanShell(input, 'win32', 0, paths);");
  const posixOnly = await brokenGuard(from, "return scanShell(input, 'darwin', 0, paths);");
  for (const platform of ['win32', 'unknown']) {
    for (const [variant, commands] of [[windowsOnly, escapeLaunches], [posixOnly, [windowsSeparator]]]) {
      for (const command of commands) {
        const event = { tool: 'Bash', command, platform };
        assert.equal(guard.shellLaunchDenied(event), true);
        assert.throws(() => assert.equal(variant.shellLaunchDenied(event), true), { code: 'ERR_ASSERTION' });
      }
    }
  }
});

// UC3C: all command strings are inputs, never executed.
const windowsLaunches = [
  String.raw`& "$env:LOCALAPPDATA\sleight\turbo-host\bank\driver-host.exe" --driver`,
  'driver-host.exe --driver', '"C:\\cache\\CURSOR-HOST.EXE" --hand',
  String.raw`C:\cache\person-host.exe`, './driver-host.exe --driver',
  'node -e \'require("child_process").spawn("driver-host.exe", ["--driver"])\'',
  'Start-Process notepad', 'saps notepad', 'start notepad', 'Invoke-Item file.txt', 'ii file.txt',
  'cmd /c "start notepad"', 'cmd.exe /d /s /c "start \"\" notepad.exe"',
  'powershell -enc AAAA', 'pwsh -EncodedCommand AAAA', 'POWERSHELL.EXE -NoProfile -enc AAAA',
  'pwsh -Command "Start-Process notepad"', 'powershell -c "explorer.exe file.txt"',
  String.raw`explorer.exe C:\Users\fixture\file.txt`, 'explorer file.txt',
  'rundll32.exe url.dll,FileProtocolHandler https://example.invalid',
  'rundll32 shell32.dll,ShellExec_RunDLL notepad', 'mshta https://example.invalid',
  'wscript script.vbs', 'cscript script.vbs',
  'pwsh -e AAAA', 'pwsh -en AAAA', 'powershell -enco AAAA',
  'Start-Process -FilePath notepad.exe', 'Microsoft.PowerShell.Management\\Start-Process notepad',
  'node -e \'require("child_process").spawn("C:\\\\cache\\\\driver-host.exe")\'',
  'pwsh -Command \'Write-Host ok; & "C:\\cache\\driver-host.exe" --driver\'',
];
const windowsAllowed = [
  'cmd /c "start msedge --headless=new --user-data-dir=/tmp/p https://example.invalid"',
  'cmd /c \'start "" msedge.exe --headless=new --user-data-dir=/tmp/p https://example.invalid\'',
  'start /b msedge --headless=new --user-data-dir=/tmp/p https://example.invalid',
  'Start-Process msedge -ArgumentList "--headless=new", "--user-data-dir=/tmp/p", "https://example.invalid"',
  'pwsh -Command \'Write-Host "explorer file.txt"\'',
  'grep "explorer" file.txt', 'echo "Start-Process notepad"',
  'git grep driver-host.exe', 'rundll32 printui.dll,PrintUIEntry /?',
  'pwsh -File script.ps1 -enc data',
];
for (const command of windowsLaunches) test(`UC3C Windows launch refuses: ${command}`, () => {
  assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command, platform: 'win32' }), true);
});
for (const command of windowsAllowed) test(`UC3C Windows data or headless passes: ${command}`, () => {
  assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command, platform: 'win32' }), false);
});
test('UC3C start is a launcher only on Windows and PowerShell receives the same scan', () => {
  assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command: 'start notepad', platform: 'darwin' }), false);
  assert.equal(guard.shellLaunchDenied({ tool: 'PowerShell', command: 'Start-Process notepad', platform: 'win32' }), true);
});
test('UC3C Windows launch words work in Mac shell text, except bare start', () => {
  for (const command of ['Start-Process notepad', 'cmd /c "start notepad"', 'pwsh -c "saps notepad"'])
    assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command, platform: 'darwin' }), true, command);
});
test('UC3C headless flags cannot hide launchers or become flags from data', () => {
  for (const command of ['start msedge "data --headless"', 'start msedge -- --headless',
    'start msedge --headless=false', 'start notepad --headless',
    'cmd /c "start msedge --headless; explorer file.txt"',
    'Start-Process notepad -ArgumentList "--headless=new"',
    'Start-Process msedge -ArgumentList "--headless=false"'])
    assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command, platform: 'win32' }), true, command);
});
test('UC3C nested Windows command bodies keep the recursion bound', () => {
  assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command: 'cmd /c '.repeat(20) + 'echo safe', platform: 'win32' }), true);
});
test('UC3C sandbox scan uses the supplied platform without Node globals', () => {
  const source = readFileSync(new URL('../plugins/sleight/hooks/shell-guard.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/m, '').replace(/^export /gm, '');
  const scan = code => runInNewContext(code + '\nshellLaunchDenied', { lineCommentEnd, isLineTerminator });
  const check = api => {
    assert.equal(api({ tool: 'Bash', command: 'start notepad', platform: 'win32' }), true);
    assert.equal(api({ tool: 'Bash', command: 'start notepad', platform: 'darwin' }), false);
  };
  check(scan(source));
  const mutant = source.replace('event.platform ?? runtimePlatform', 'runtimePlatform');
  assert.notEqual(mutant, source);
  assert.throws(() => check(scan(mutant)), { code: 'ERR_ASSERTION' });
});
test('UC3C recovered 46-command developer set measures launch and combined refusals in both Windows tools', async t => {
  const corpus = JSON.parse(readFileSync(new URL('fixtures/windows-guard-polish.json', import.meta.url)));
  const rows = [...corpus.macOrdinary, ...corpus.windowsOrdinary];
  assert.equal(rows.length, 46);
  for (const tool of ['Bash', 'PowerShell']) {
    const refused = rows.filter(row => guard.shellLaunchDenied({ tool, command: row.command, platform: 'win32' }));
    assert.equal(refused.length, 0, `${tool}: developer command falsely refused`);
    t.diagnostic(`${tool}: ${rows.length} commands; ${refused.length} refused: ${JSON.stringify(refused.map(row => row.command))}`);
    let combined = 0;
    for (const row of rows) combined += Number(guard.shellLaunchDenied({ tool, command: row.command, platform: 'win32' }) ||
      await preapprovedWriteDenied({ tool, command: row.command }, { platform: 'win32',
        home: ['C:', 'Users', 'fixture'].join('/'), stat: async path => ({ realPath: path }) }));
    assert.equal(combined, 3, `${tool}: combined developer refusals changed`);
    t.diagnostic(`${tool}: launch plus settings guards refuse ${combined} of ${rows.length} (${(100 * combined / rows.length).toFixed(2)}%)`);
  }
});

async function brokenGuard(from, to) {
  const url = new URL('../plugins/sleight/hooks/shell-guard.mjs', import.meta.url);
  const original = readFileSync(url, 'utf8');
  assert.ok(original.includes(from), `mutation anchor missing: ${from}`);
  const source = original.replace(from, to).replace("'../lib/code-line-terminators.mjs'",
    JSON.stringify(new URL('../lib/code-line-terminators.mjs', url).href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
test('UC3C every Windows refusal fixture fails with its Windows checks removed', async () => {
  const mutant = await brokenGuard("scanPlatform(event.command, event.platform ?? runtimePlatform, event)", 'false');
  for (const command of windowsLaunches) assert.throws(() =>
    assert.equal(mutant.shellLaunchDenied({ tool: 'Bash', command, platform: 'win32' }), true),
  undefined, `surviving disabled-scan mutant: ${command}`);
});
test('UC3C targeted shell mutants fail their host, launcher, encoded and headless assertions', async () => {
  for (const [from, to, command, expected] of [
    ['if (!consumerOnly && (windowsHost.test(name) || windowsLauncher.test(name))) return true;', '', 'driver-host.exe --driver', true],
    ['if (!consumerOnly && (windowsHost.test(name) || windowsLauncher.test(name))) return true;', '', 'explorer file.txt', true],
    ["if (powershell.test(name) && args[i].length > 1 && '-encodedcommand'.startsWith(args[i].toLowerCase())) return true;", '', 'pwsh -enc AAAA', true],
    ["return command([executable, ...rest], depth + 1, stdinSource, heredocs);", 'return true;', 'start msedge --headless=new --user-data-dir=/tmp/p', false],
    ['scanPlatform(event.command, event.platform ?? runtimePlatform, event)', "scanShell(event.command, 'win32')", 'start notepad', false],
  ]) {
    const mutant = await brokenGuard(from, to);
    assert.throws(() => assert.equal(mutant.shellLaunchDenied({ tool: 'Bash', command,
      platform: command === 'start notepad' ? 'darwin' : 'win32' }), expected), undefined, `surviving mutant: ${command}`);
  }
});
test('UC3C every data and headless fixture fails with an always-refuse scan', async () => {
  const mutant = await brokenGuard('scanPlatform(event.command, event.platform ?? runtimePlatform, event)', 'true');
  for (const command of windowsAllowed) assert.throws(() =>
    assert.equal(mutant.shellLaunchDenied({ tool: 'Bash', command, platform: 'win32' }), false),
  undefined, `surviving always-refuse mutant: ${command}`);
});

// FD4D fixtures remain strings. No shell, interpreter or launcher runs here.
for (const consumer of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'busybox sh', 'env sh', '/bin/sh -', 'env -S "sh"']) {
  for (const producer of ['echo "open ./page.html"', 'echo open ./page.html',
    'printf "%s\\n" "open ./page.html"', 'echo "open ./page.html" | cat',
    'printf "%s" "open ./page.html" | grep open | cat',
    "cat <<'EOF'\nopen ./page.html\nEOF"]) {
    // Put the pipe on the heredoc declaration, before its body.
    const command = producer.includes('\n')
      ? producer.replace('\n', ` | ${consumer}\n`) : `${producer} | ${consumer}`;
    test(`fd4d literal pipeline refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));
  }
}

const interpreterPayloads = [
  ['python3 -c', 'import os; os.system("open ./page.html")'],
  ['python -Ic', 'import subprocess; subprocess.run(["open", "./page.html"])'],
  ['python3 -c', 'from os import popen; popen("open ./page.html")'],
  ['node -e', 'require("child_process").execSync("open ./page.html")'],
  ['node --eval', 'require("child_process").spawn("open", ["./page.html"])'],
  ['node -e', 'import("child_process").then(cp => cp.exec("xdg-open ./page.html"))'],
  ['perl -e', 'system("open ./page.html")'],
  ['perl -E', 'exec "osascript", "script.scpt"'],
  ['ruby -e', 'system("open ./page.html")'],
  ['ruby -e', 'exec("xdg-open", "./page.html")'],
  ['osascript -e', 'tell application "AnyApp" to activate'],
  ['swift -e', 'import AppKit; NSWorkspace.shared.open(URL(fileURLWithPath: "./page.html"))'],
  ['swift -e', 'LSOpenCFURLRef(url, nil)'],
  ['python3 -c', 'print("webbrowser")'],
];
for (const [prefix, payload] of interpreterPayloads) {
  const command = `${prefix} '${payload}'`;
  test(`fd4d interpreter payload refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));
}
for (const [interpreter, payload] of [
  ['python', 'import os; os.system("open ./page.html")'],
  ['python3', 'import subprocess; subprocess.run(["open", "./page.html"])'],
  ['node', 'require("child_process").execSync("open ./page.html")'],
  ['perl', 'system("open ./page.html")'], ['ruby', 'system("open ./page.html")'],
  ['osascript', 'tell application "AnyApp" to activate'],
  ['swift', 'import AppKit; NSWorkspace.shared.open(URL(fileURLWithPath: "./page.html"))'],
]) {
  for (const input of [
    `${interpreter} - <<'EOF'\n${payload}\nEOF`,
    `${interpreter} <<'EOF'\n${payload}\nEOF`,
    `printf '%s' '${payload}' | ${interpreter}`,
  ]) test(`fd4d interpreter stdin refuses: ${JSON.stringify(input)}`, () => assert.equal(denied(input), true));
}

for (const command of [
  'source <(echo open ./page.html)', '. <(printf "%s" "open ./page.html")',
  "source /dev/stdin <<'EOF'\nopen ./page.html\nEOF", ". /dev/stdin <<'EOF'\nopen ./page.html\nEOF",
  'source /dev/stdin <<< "open ./page.html"',
  'launchctl submit -l fixture -- open ./page.html', 'launchctl load fixture.plist',
  'launchctl bootstrap gui/501 fixture.plist', 'launchctl kickstart gui/501/fixture',
  '$(which open) ./page.html', '$(command -v open) ./page.html',
  '`which open` ./page.html', '`command -v open` ./page.html',
  'env $(which open) ./page.html', '"$(command -v /usr/bin/open)" ./page.html',
]) test(`fd4d consumer or wrapper refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));

for (const command of [
  'echo "open ./page.html" | sh | cat', 'printf harmless | echo "open ./page.html" | sh',
  'echo "open ./page.html" |& env sh', 'echo "open ./page.html" | env sh -c "cat | sh"',
  'echo "open ./page.html" |\nsh', 'echo "open ./page.html" | # next stage\ncat |\nenv sh',
  'node -e\'require("child_process").execSync("open ./page.html")\'',
  'node --eval=\'require("child_process").spawn("open")\'',
  'perl -we\'system("open ./page.html")\'', 'ruby -e\'system("open ./page.html")\'',
  'python3 -c \'os.system("/usr/bin/open ./page.html")\'',
  'node -e "require(\'child_process\').execSync(\'open ./page.html\')"',
  'ruby -e \'puts "hello"\' -e \'system("open ./page.html")\'',
  'ruby -e \'NSWorkspace.sharedWorkspace\'',
]) test(`fd4d literal spelling refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));

// Catch file API names or data strings being mistaken for process launchers.
const quotePayload = payload => "'" + payload.replaceAll("'", "'\\''") + "'";
for (const [interpreter, flag, payload] of [
  ['python3', '-c', "open('f')"],
  ['python3', '-c', 'open("fixture.txt", "w").write("hello")'],
  ['python3', '-c', "with open('f') as f:\n    print(f.read())"],
  ['python3', '-c', "import json; json.load(open('f'))"],
  ['python3', '-c', "import io; io.open('f')"],
  ['python3', '-c', "import codecs; codecs.open('f')"],
  ['python3', '-c', "import os; os.open('f', os.O_RDONLY)"],
  ['python3', '-c', "import gzip; gzip.open('f')"],
  ['python3', '-c', "import tarfile; tarfile.open('f')"],
  ['python3', '-c', "from pathlib import Path; Path('f').open()"],
  ['python3', '-c', 'Path.open()'],
  ['python3', '-c', "print('open the file')"],
  ['python3', '-c', 'print("open")'],
  ['python3', '-c', 'print("xdg-open")'],
  ['python3', '-c', 'print("x-www-browser")'],
  ['python3', '-c', 'print("/usr/bin/open")'],
  ['python3', '-c', 'import os; os.system("echo open")'],
  ['python3', '-c', 'import subprocess; subprocess.run(["opener", "f"])'],
  ['ruby', '-e', 'File.open("f", "w") { |f| f.write("hello") }'],
  ['ruby', '-e', 'puts "open"'],
  ['ruby', '-e', 'system("echo open")'],
  ['perl', '-e', 'open(my $fh, "<", "f") or die $!;'],
  ['perl', '-e', 'print "open the file";'],
  ['node', '-e', 'const fs = require("fs"); fs.open("f", "r", () => {})'],
  ['node', '-e', 'const fs = require("fs"); fs.promises.open("f", "r")'],
  ['node', '-e', "ws.on('open', () => {})"],
  ['node', '-e', 'open(url)'],
  ['node', '-e', 'console.log("open the file")'],
  ['node', '-e', 'require("child_process").execSync("echo /usr/bin/open")'],
]) {
  for (const command of [
    `${interpreter} ${flag} ${quotePayload(payload)}`,
    `${interpreter} <<'EOF'\n${payload}\nEOF`,
    `${interpreter} <<EOF\n${payload}\nEOF`,
    `printf '%s' ${quotePayload(payload)} | ${interpreter}`,
    `cat <<'EOF' | ${interpreter}\n${payload}\nEOF`,
  ]) test(`fd4e file IO and data pass: ${JSON.stringify(command)}`, () => assert.equal(denied(command), false));
}

test('fd4e interpreter file IO survives wrappers and stream redirects', () => {
  for (const consumer of ['python3', 'env python3', 'env -S "python3"',
    'env --split-string=python3', 'timeout 5 python3', '/usr/bin/python3 -']) {
    for (const command of [
      `${consumer} <<'EOF'\nopen("f")\nEOF`,
      `${consumer} <<< 'open("f")'`,
      `${consumer} < <(printf '%s' 'open("f")')`,
    ]) assert.equal(denied(command), false, command);
  }
});

test('fd4e interpreter heredoc exemptions preserve expansions and later shell launches', () => {
  const body = 'print("$(open x)")';
  assert.equal(denied(`python3 <<EOF\n${body}\nEOF`), true, 'unquoted heredoc expands shell input');
  assert.equal(denied(`python3 <<'EOF'\n${body}\nEOF`), false, 'quoted heredoc keeps dollar substitution literal');
  assert.equal(denied('python3 <<EOF\nprint("`open x`")\nEOF'), true, 'unquoted backticks expand too');
  for (const command of [
    'python3 <<\'EOF\'\nopen("f")\nEOF\nopen x',
    'python3 <<\'EOF\'\nopen("f")\nEOF\nsh <<\'SH\'\nopen x\nSH',
    'python3 <<< \'print("hello")\'; open x',
    'python3 < <(open x)',
  ]) assert.equal(denied(command), true, command);
});

for (const payload of [
  'os.system("open ./page.html")', 'os.system("/usr/bin/open ./page.html")',
  'subprocess.run(["open", "./page.html"])', 'subprocess.call("xdg-open ./page.html", shell=True)',
  'subprocess.Popen(["/usr/bin/x-www-browser", "https://example.invalid"])',
  'popen("osascript script.scpt")', 'exec("/usr/bin/xdg-open", "./page.html")',
  'spawn("x-www-browser", ["https://example.invalid"])', 'execSync("/usr/bin/osascript -e script")',
  'system "open ./page.html"', 'exec "osascript", "script.scpt"',
  '`open ./page.html`', '`/usr/bin/xdg-open ./page.html`', '`x-www-browser https://example.invalid`',
  'NSAppleScript.alloc.initWithSource(script)', 'print("osascript -e script")',
]) {
  for (const command of [
    `ruby -e ${quotePayload(payload)}`,
    `ruby <<'EOF'\n${payload}\nEOF`,
    `printf '%s' ${quotePayload(payload)} | ruby`,
  ]) test(`fd4e launcher payload refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));
}

for (const sink of ['cat', 'cat 2>log', 'tee', 'pbcopy', 'grep open', 'wc -l', 'cat | grep open | wc -l']) {
  const command = `${sink} <<'EOF'\nopen the door\nSafari\nIt's (an example).\nEOF`;
  test(`fd4d heredoc output stays data: ${sink}`, () => {
    assert.equal(denied(command), false);
    assert.equal(denied(command + '\nopen ./page.html'), true, 'later commands still checked');
    assert.equal(denied(command.replace("<<'EOF'", "<<'EOF' | sh")), true, 'downstream shell consumes the body');
  });
}

test('fd4d data and headless controls do not become executable payloads', () => {
  for (const command of [
    'echo "open ./page.html" | cat', 'printf "%s" "open ./page.html" | grep open | wc',
    'printf "%s" "chromium --headless --user-data-dir=/tmp/p" | /bin/sh -', 'echo "printf hello" | env sh',
    'echo "open x"; printf hello | sh', // A separate pipeline has no launcher input.
    'which open', 'command -v open', 'echo "$(which open)"', 'printf "%s" "`command -v open`"',
    'python3 -c \'print("hello")\'', 'node -e \'console.log("hello")\'',
    'perl -E \'say "hello"\'', 'ruby -e \'puts "hello"\'', 'swift -e \'print("hello")\'',
    'python3 script.py open', 'node script.js open', 'ruby script.rb open', 'perl script.pl open', 'swift script.swift open',
    'printf "%s" \'console.log("hello")\' | node',
    "ruby <<'EOF'\nputs 'hello'\nEOF", "swift - <<'EOF'\nprint(\"hello\")\nEOF",
    'cat <<EOF\n<(open x)\nEOF', "cat <<'EOF'\n$(open x)\nEOF",
  ]) assert.equal(denied(command), false, command);
  assert.equal(denied('cat <<EOF\n$(open x)\nEOF'), true, 'unquoted data still expands commands');
});

test('shell guard denies app, URL and window launchers without executing them', () => {
  for (const command of [
    'open https://example.invalid', '/usr/bin/open -a AnyApp', 'open -g -j ./preview.html',
    'open -R ./document.pdf', 'o"pe"n https://example.invalid', 'o\\pen ./document.pdf',
    'osascript -e \'tell application "AnyApp" to activate\'', '/usr/bin/osascript script.scpt',
    'xdg-open https://example.invalid', 'gio open ./preview.html', 'sensible-browser https://example.invalid',
    '"/Applications/Any App.app/Contents/MacOS/Any App"',
    '"/Applications/Any App.app/Contents/MacOS/Any App" --headless',
    'chrome https://example.invalid', 'chromium --new-window', 'google-chrome-stable --app=https://example.invalid',
    'firefox -new-window https://example.invalid', 'helium https://example.invalid', 'safari https://example.invalid', 'Safari',
    '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" https://example.invalid',
  ]) assert.equal(denied(command), true, command);
});

test('headless exemption belongs to the browser command and an actual flag', () => {
  for (const command of [
    'chromium --headless --user-data-dir=/tmp/p', 'google-chrome --headless=new --user-data-dir=/tmp/p --dump-dom https://example.invalid',
    'firefox --headless --no-remote --profile /tmp/p --screenshot /tmp/fixture.png', chromiumShellName + ' --headless --user-data-dir=/tmp/p',
    'chromium --headless=new --user-data-dir=/tmp/p', 'msedge --headless --user-data-dir=/tmp/p', 'opera --headless --user-data-dir=/tmp/p',
    '"/Applications/Helium.app/Contents/MacOS/Helium" --headless=old --user-data-dir=/tmp/p',
    'chrome --version', 'chromium --help',
  ]) assert.equal(denied(command), false, command);
  for (const command of ['chrome --headless=false', 'chrome --headless --headless=false', 'chrome -- --headless', 'chrome "argument --headless"',
    'open -a AnyApp --args --headless', 'chrome https://example.invalid; echo --headless',
    'chrome --headless && open ./preview.html', 'safari --headless']) assert.equal(denied(command), true, command);
});

test('every shell segment is checked across lists, pipes, background jobs and newlines', () => {
  for (const separator of [';', '&&', '||', '|', '&', '|&', '\n']) {
    assert.equal(denied(`printf ok ${separator} open ./page.html`), true, separator);
    assert.equal(denied(`open ./page.html ${separator} printf ok`), true, separator);
    assert.equal(denied(`printf ok ${separator} chromium --headless --user-data-dir=/tmp/p`), false, separator);
  }
  for (const command of ['(open ./page.html)', '{ open ./page.html; }', 'if true; then open ./page.html; fi',
    'while false; do open ./page.html; done', 'open ./page.html 2>/tmp/log', '2>/tmp/log open ./page.html',
    'op\\\nen ./page.html']) assert.equal(denied(command), true, command);
});

test('assignments, ordinary wrappers and literal shell scripts cannot hide a launch', () => {
  for (const command of ['BROWSER=anything open ./page.html', 'env LANG=C open ./page.html',
    'env -u BROWSER -- open ./page.html', 'env -S "open ./page.html"', 'env --split-string="open ./page.html"',
    'command -- /usr/bin/open ./page.html', 'builtin open ./page.html', 'exec open ./page.html',
    'nohup open ./page.html &', 'sudo -u fixture open ./page.html', 'nice -n 10 open ./page.html',
    'time -p open ./page.html', 'printf x | xargs -I {} open {}',
    'arch -arm64 open ./page.html', 'arch -arm64e open ./page.html', 'arch -arch arm64 open ./page.html',
    'arch -d BROWSER -e LANG=C open ./page.html',
    'timeout 10 open ./page.html', 'timeout -s TERM -k 2 10 open ./page.html',
    'timeout --signal TERM --kill-after 2 10 open ./page.html',
    'caffeinate -dimsu -t 10 -w 123 open ./page.html', 'setsid -f open ./page.html',
    'caffeinate -dt 10 open ./page.html',
    'stdbuf -o L -e0 open ./page.html', 'stdbuf --output L --error=0 open ./page.html',
    'script -q /dev/null open ./page.html', 'script -q -c "open ./page.html" /dev/null',
    'script --command="open ./page.html" /dev/null',
    'script -qc "open ./page.html" /dev/null', 'script -c"open ./page.html" /dev/null',
    'script -F -q /dev/null open ./page.html',
    'launchctl asuser 501 open ./page.html', 'exec -a harmless open ./page.html',
    'sh -c "open ./page.html"', 'bash -lc \'echo ok && open ./page.html\'',
    'zsh -c \'chromium --headless; open ./page.html\'', 'eval "open ./page.html"',
    'find . -name page.html -exec open {} \\;', 'find . -execdir osascript {} +'])
    assert.equal(denied(command), true, command);
});

test('command substitutions execute inside double quotes but single-quoted examples are data', () => {
  for (const command of ['echo $(open ./page.html)', 'echo "$(open ./page.html)"',
    'echo `open ./page.html`', 'echo "`open ./page.html`"', 'echo $(printf "%s" "$(open ./page.html)")'])
    assert.equal(denied(command), true, command);
  for (const command of ["echo '$(open ./page.html)'", "echo '`open ./page.html`'", 'echo \\`open ./page.html\\`'])
    assert.equal(denied(command), false, command);
});

test('Python webbrowser module and source forms are denied', () => {
  for (const command of ['python -m webbrowser https://example.invalid', '/usr/bin/python3 -mwebbrowser https://example.invalid',
    'python3 -c \'import webbrowser; webbrowser.open("https://example.invalid")\'',
    'python3 -c\'from webbrowser import open as launch; launch("https://example.invalid")\'',
    'python3 -Imwebbrowser https://example.invalid', 'python3 -Ic \'import webbrowser; webbrowser.open("https://example.invalid")\'',
    'python3 - <<\'PY\'\nimport webbrowser\nwebbrowser.open("https://example.invalid")\nPY',
    'env python3 - <<\'PY\'\nimport webbrowser\nwebbrowser.open("https://example.invalid")\nPY',
    'printf \'import webbrowser; webbrowser.open("https://example.invalid")\' | python3'])
    assert.equal(denied(command), true, command);
});

test('ordinary shell work and quoted examples remain allowed', () => {
  for (const command of ['printf "%s" "open https://example.invalid"', 'echo "one; open a && open b | open c & open d"',
    'echo open ./preview.html', 'rg "webbrowser.open" tests', 'cat open',
    'echo safari', 'printf "%s" Safari', 'rg Safari tests', 'cat safari',
    'arch -arm64 chromium --headless --user-data-dir=/tmp/p', 'timeout 10 firefox --headless --no-remote --profile /tmp/p',
    'caffeinate -t 5 msedge --headless --user-data-dir=/tmp/p', 'setsid opera --headless --user-data-dir=/tmp/p',
    'stdbuf -oL chromium --headless --user-data-dir=/tmp/p', 'script -q /dev/null firefox --headless --no-remote --profile /tmp/p',
    'launchctl asuser 501 msedge --headless --user-data-dir=/tmp/p', 'exec -a harmless opera --headless --user-data-dir=/tmp/p',
    'node --test tests/shell-guard.test.mjs', 'npm run lint:prose',
    'python3 -c \'print("one; two && three")\'', 'echo hi > /tmp/open',
    '# open ./preview.html\necho hi', 'printf ok # open ./preview.html',
    'env -u BROWSER chromium --headless --user-data-dir=/tmp/p', 'sh -c \'printf "%s" "open ./preview.html"\''])
    assert.equal(denied(command), false, command);
  for (const event of [{ tool: 'Read', command: 'open ./preview.html' }, { tool: 'Bash' },
    { tool: 'Bash', command: null }, {}]) assert.equal(guard.shellLaunchDenied(event), false);
});

test('heredoc data is skipped through its exact terminator and later commands still run', () => {
  for (const opener of ['<<EOF', "<<'EOF'", '<<"EOF"', '<<-EOF']) {
    const command = `git commit -F - ${opener}\nopen the door\nSafari\nEOF\nprintf ok`;
    assert.equal(denied(command), false, command);
    assert.equal(denied(command + '\nopen ./page.html'), true, command);
  }
  for (const command of [
    "cat >message <<'ONE' <<\"TWO\"\nopen the door\nONE\nSafari\nTWO",
    'cat >message <<-EOF\n\topen the door\n\tEOF\nprintf ok',
    'cat >message <<EOF\nopen the door\nEOFsuffix\nSafari\nEOF',
    'printf "%s" "<<EOF"\nprintf ok',
  ]) assert.equal(denied(command), false, command);
  assert.equal(denied('cat <<EOF; open ./page.html\nplain data\nEOF'), true);
});

test('shell heredocs are scanned as commands, while ordinary shell input stays allowed', () => {
  for (const launcher of ['sh', 'bash -s', 'zsh', 'env bash', 'timeout 5 sh', 'exec -a harmless zsh',
    'env -S sh', 'env --split-string=sh', 'bash -c sh', 'eval sh', 'script -q -c sh /dev/null']) {
    const command = `${launcher} <<'EOF'\nopen ./page.html\nEOF`;
    assert.equal(denied(command), true, command);
    assert.equal(denied(`${launcher} <<EOF\nprintf '%s' 'open the door'\nEOF`), false, launcher);
  }
  assert.equal(denied("sh <<'OUTER'\ncat <<'INNER'\nopen the door\nINNER\nOUTER"), true);
});

test('unquoted heredocs check expanding substitutions without interpreting ordinary data', () => {
  for (const body of ['$(open ./page.html)', '`open ./page.html`', "'$(open ./page.html)'", '"$(open ./page.html)"']) {
    assert.equal(denied(`cat >message <<EOF\n${body}\nEOF`), true, body);
    assert.equal(denied(`cat >message <<'EOF'\n${body}\nEOF`), false, body);
  }
  assert.equal(denied('cat >message <<EOF # ordinary data follows\nopen the door\nEOF\nprintf ok'), false);
  assert.equal(denied('cat >message <<EOF # ordinary data follows\nopen the door\nEOF\nopen ./page.html'), true);
});

function installedGuard({ disabled = false, refuseWrite = false, realWriteGuard = false, cwd = '/synthetic-project', guardApi = guard,
  source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8') } = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  let checked = 0, ended = 0;
  const exports = {};
  runInNewContext(js, { exports, require(name) {
    if (name === 'claude-code') return { atom: (_key, value) => ({ value }),
      read: async (_$, atom) => atom.value, update: async (_$, atom, fn) => { atom.value = fn(atom.value); } };
    if (name === './shell-guard.mjs') return guardApi;
    if (name === './stop-notice.mjs') return stopNotice;
    if (name === './narration.mjs') return { createNarrationCache: () => ({ take() {}, configure() {}, observe() {}, reset() {} }) };
    if (name === './preapproved-write-guard.mjs') return realWriteGuard ? writeGuard : {
      loggingSwitchWriteDenied: () => false, preapprovedWriteTarget: async () => { checked++; return refuseWrite ? "sleight's settings files" : undefined; },
      preapprovedWriteReason: label => `Only the user changes ${label}. Ask them to make this change.`,
    };
    return {};
  } });
  const hooks = new Map();
  exports.register((name, filter, handler) => {
    hooks.set(handler ? `${name}:${filter.tool ?? filter.command}` : name, handler ?? filter);
    return { catch() {} };
  });
  const pre = hooks.get('classic.PreToolUse'); assert.equal(typeof pre, 'function');
  const shell = hooks.get('tool.call:Bash'); assert.equal(typeof shell, 'function');
  let passed = 0;
  const $ = { env: { get: async key => key === 'SLEIGHT_SHELL_GUARD' ? (disabled ? '0' : undefined) : '/synthetic-home' },
    session: { cwd: async () => { if (cwd instanceof Error) throw cwd; return cwd; } },
    fs: { stat: async () => { throw Error('unexpected stat'); } },
    plugin: { root: '/synthetic-plugin' }, process: { run: async () => ({ exitCode: 0, stdout: '{"enabled":true}' }) },
    mcp: { connect: async () => ({ isConnected: true, server: 'computer' }), call: async (_server, _tool, args) => {
      if (args.sleight_turbo?.event === 'bootstrap') return { content: [{ type: 'text', text: JSON.stringify({ sleightTurbo: {
        version: 1, session: 'fixture', nonce: 'a'.repeat(64) } }) }] };
      if (args.hook_event_name) ended++;
      // Since RA1 the relay answers a begin frame with whether it bound a turbo turn.
      if (args.sleight_turbo?.event === 'begin') return { content: [{ type: 'text', text: JSON.stringify({ sleightRemote: { turboBound: true } }) }] };
      return { content: [] };
    } }, ui: { status() {}, log() {}, toast() {}, panes: async () => [] } };
  const next = event => { passed++; return event; };
  return { $, hooks, pre: event => event.tool === 'Bash' ? shell($, event, e => pre($, e, next)) : pre($, event, next), checked: () => checked, passed: () => passed, ended: () => ended,
    use: (tool = 'js', next = event => event, extra = {}) => (hooks.get(`tool.call:mcp__plugin_sleight_computer__${tool}`) ?? ((_$, e, next) => next(e)))($, { tool_use_id: 'call', ...extra }, next),
    complete: (event, next = event => event) => hooks.get('turn.complete')($, event ?? {}, next),
    stop: () => hooks.get('command.run:sleight')($, { args: 'stop' }) };
}

test('UC3C2 installed mod refuses escaped launchers when cwd is Mac, Windows or throwing', { skip: parserSkip }, async t => {
  const paths = [['classic.PreToolUse', 'Bash'], ['classic.PreToolUse', 'PowerShell'],
    ['tool.call:Bash', 'Bash'], ['tool.call:PowerShell', 'PowerShell']];
  const from = "return scanShell(input, 'darwin', 0, paths) || scanShell(input, 'win32', 0, paths);";
  const windowsOnly = await brokenGuard(from, "return scanShell(input, 'win32', 0, paths);");
  let checked = 0, caught = 0;
  for (const cwd of ['/fixture/project', String.raw`C:\fixture\project`, new Error('cwd unavailable')]) {
    const h = installedGuard({ cwd });
    const broken = installedGuard({ cwd, guardApi: windowsOnly });
    await h.use(); await broken.use();
    for (const [path, tool] of paths) for (const command of escapeLaunches) {
      // A tool-provided platform cannot override the host's cwd result.
      const event = { tool, command, platform: 'linux' };
      const result = await h.hooks.get(path)(h.$, event, e => e);
      assert.equal(result.deny, guard.shellGuardReason, `${path}, ${tool}, ${cwd}, ${command}`);
      checked++;
      if (cwd instanceof Error || cwd.startsWith('C:')) {
        await assert.rejects(async () => assert.equal(
          (await broken.hooks.get(path)(broken.$, event, e => e)).deny, guard.shellGuardReason), { code: 'ERR_ASSERTION' });
        caught++;
      }
    }
  }
  assert.equal(checked, 48); assert.equal(caught, 32);
  t.diagnostic(`${checked} hook/tool refusal assertions; ${caught} single-dialect failures caught`);
});

test('UC3C2 recovered 46 ordinary commands have zero launch refusals on Mac and throwing cwd', { skip: parserSkip }, async t => {
  const corpus = JSON.parse(readFileSync(new URL('fixtures/windows-guard-polish.json', import.meta.url)));
  const rows = [...corpus.macOrdinary, ...corpus.windowsOrdinary];
  assert.equal(rows.length, 46);
  const paths = [['classic.PreToolUse', 'Bash'], ['classic.PreToolUse', 'PowerShell'],
    ['tool.call:Bash', 'Bash'], ['tool.call:PowerShell', 'PowerShell']];
  for (const cwd of ['/fixture/project', new Error('cwd unavailable')]) {
    const h = installedGuard({ cwd });
    await h.use();
    for (const [path, tool] of paths) {
      let refused = 0;
      for (const { command } of rows) {
        const result = await h.hooks.get(path)(h.$, { tool, command }, e => e);
        refused += Number(result.deny === guard.shellGuardReason);
      }
      assert.equal(refused, 0, `${path}, ${tool}, ${cwd}`);
      t.diagnostic(`${cwd instanceof Error ? 'unknown' : 'darwin'}, ${path}, ${tool}: ${refused}/${rows.length} launch refusals`);
    }
  }
});

test('UC3CR installed mod refuses bare Windows start on all three guard paths without Node globals', { skip: parserSkip }, async () => {
  const guardSource = readFileSync(new URL('../plugins/sleight/hooks/shell-guard.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/m, '').replace(/^export /gm, '');
  const guardApi = runInNewContext(guardSource + '\n({ shellLaunchDenied, shellGuardReason })', { lineCommentEnd, isLineTerminator });
  const modSource = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  const paths = [['classic.PreToolUse', 'Bash'], ['classic.PreToolUse', 'PowerShell'],
    ['tool.call:Bash', 'Bash'], ['tool.call:PowerShell', 'PowerShell']];
  const check = async (source, cwd, expected) => {
    const h = installedGuard({ source, cwd, guardApi });
    await h.use();
    for (const [path, tool] of paths) {
      const result = await h.hooks.get(path)(h.$, { tool, command: 'start notepad' }, event => event);
      assert.equal(result.deny, expected ? guard.shellGuardReason : undefined, `${path}, ${tool}, ${cwd}`);
    }
  };
  for (const cwd of [String.raw`C:\fixture\project`, 'D:/fixture/project', String.raw`\\server\share\project`, new Error('cwd unavailable')])
    await check(modSource, cwd, true);
  await check(modSource, '/fixture/project', false);
  for (const [from, to] of [
    ['shellLaunchDenied({ ...guarded, platform })', 'shellLaunchDenied(guarded)'],
    ['shellLaunchDenied({ ...e, ...await shellPaths($), platform: await shellPlatform($) })', 'shellLaunchDenied(e)'],
    ["shellLaunchDenied({ ...e, ...await shellPaths($), tool: 'Bash', platform: await shellPlatform($) })", "shellLaunchDenied({ ...e, tool: 'Bash' })"],
  ]) {
    assert.ok(modSource.includes(from), `mod platform mutation anchor missing: ${from}`);
    // Unknown hosts now refuse bare start too. Detect lost host wiring through
    // the Mac behavior, where the real host must still allow that command.
    await assert.rejects(check(modSource.replace(from, to), '/fixture/project', false), { code: 'ERR_ASSERTION' });
  }
});

test('installed tool.call shell fence refuses before PreToolUse filesystem access and preserves the write guard', { skip: parserSkip }, async () => {
  const h = installedGuard({ refuseWrite: true });
  await h.use();
  const pre = h.pre;
  assert.equal((await pre({ tool: 'Bash', command: 'open ./page.html' })).deny, guard.shellGuardReason);
  assert.equal(h.checked(), 0); assert.equal(h.passed(), 0);
  assert.match((await pre({ tool: 'Write', file_path: 'policy' })).deny, /Only the user changes sleight's settings files/);
  assert.equal(h.checked(), 1);
  await pre({ tool: 'Read' }); assert.equal(h.passed(), 1);
});

test('shell guard covers only sleight turns, resets on completion or stop, and supports opt-out', { skip: parserSkip }, async () => {
  const event = { tool: 'Bash', command: 'open report.pdf' };
  for (const tool of ['js', 'replay', 'browser_open', 'browser_read', 'browser_act', 'browser_fill']) {
    const h = installedGuard();
    assert.equal((await h.pre(event)).deny, undefined, tool);
    await h.use(tool, async e => {
      assert.equal((await h.pre(event)).deny, guard.shellGuardReason, 'guard active when the first call runs');
      return e;
    });
    await h.complete({ agentId: 'child' });
    assert.equal((await h.pre(event)).deny, guard.shellGuardReason);
    await h.complete();
    assert.equal((await h.pre(event)).deny, undefined, 'ordinary next turn');
    await h.use(tool); await h.complete({ isAborted: true });
    assert.equal((await h.pre(event)).deny, undefined, 'aborted turn');
    await h.use(tool); await h.stop();
    assert.equal((await h.pre(event)).deny, undefined, 'explicit stop');
    assert.match((await h.use(tool)).deny, /user stopped/);
    assert.equal((await h.pre(event)).deny, undefined, 'refused tool cannot reactivate');
  }
  const off = installedGuard({ disabled: true, refuseWrite: true });
  await off.use();
  assert.match((await off.pre(event)).deny, /Only the user changes sleight's settings files/, 'opt-out retains the approval write guard');
  const allow = installedGuard({ disabled: true }); await allow.use();
  assert.equal((await allow.pre(event)).deny, undefined);
  assert.match(guard.shellGuardReason, /sleight.*guard.*this turn/i);
  assert.match(guard.shellGuardReason, /SLEIGHT_SHELL_GUARD=0/);
});

test('turbo prompt setup alone leaves ordinary shell work untouched and still ends its binding', { skip: parserSkip }, async () => {
  const h = installedGuard(), event = { tool: 'Bash', command: 'open report.pdf' };
  await h.hooks.get('prompt.submit')(h.$, { origin: { kind: 'composer' }, text: 'ordinary work' }, event => event);
  assert.equal((await h.pre(event)).deny, undefined);
  await h.complete();
  assert.equal(h.ended(), 1);
  assert.equal((await h.pre(event)).deny, undefined);
});

// Each review reproducer is an independent assertion so a first failure cannot
// hide the other baseline bypasses. These strings are never executed.
for (const command of [
  '(( x = 1 << 2 ))\nopen ./p.html',
  'let x=1<<2\nopen ./p.html',
  'echo $[1<<2]\nopen ./p.html',
  'echo $((1<<2))\nopen ./p.html',
  '[[ 1 << 2 ]]\nopen ./p.html',
  'cat <<~EOF\n~EOF\nopen x\nEOF',
  'cat <<EOF | sh\nopen x\nEOF',
  'cat <<EOF | env sh\nopen x\nEOF',
  'cat <<EOF | xargs open\nopen x\nEOF',
  'sh <<< "open x"',
  'bash <(echo open x)',
  ...['fish -c', 'csh -c', 'tcsh -c', 'su -c', 'parallel', 'watch',
    'busybox sh -c'].map(prefix => `${prefix} 'open x'`),
  ...['doas', 'chroot /fixture', 'sandbox-exec -p "(allow default)"', 'xcrun',
    'ionice -c 3'].map(prefix => `${prefix} open x`),
  'shortcuts run "Open Safari"',
]) test(`fd4b review bypass refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));

test('availability checks do not launch an app, while execution forms still refuse', () => {
  for (const command of ['command -v open', 'command -V open', 'which open', 'type open', 'type -a open'])
    assert.equal(denied(command), false, command);
  for (const command of ['command -p open x', 'command -pv open x', 'exec open x', 'which open; open x'])
    assert.equal(denied(command), true, command);
});

test('uncertain heredocs and shell consumers keep command scans, while interpreter launchers refuse', () => {
  for (const command of [
    "unknown <<'EOF'\nopen x\nEOF",
    "cat >message <<'EOF'\nopen x", // No exact terminator.
    "cat >message <<'EOF'\nopen x\n EOF", // Spaces are not stripped.
    "cat >message <<-'EOF'\nopen x\n EOF",
    "git commit -F - <<'A' <<'B'\nplain\nA\nopen x", // All docs must match.
    'git commit -F - <<EOF\nEO\\\nF\nopen x\nEOF', // Expanded delimiter continuation.
    "cat >message <<$'EOF'\nEOF\nopen x", // Unsupported delimiter quoting.
    "cat >message <<'EOF'\nplain\nEOF\n(( x = 1 << 2 ))\nopen x",
    'python3 - <<\'EOF\'\nos.system("open x")\nEOF',
    'node - <<\'EOF\'\nrequire("child_process").execSync("open x")\nEOF',
    ...['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'busybox sh', 'env sh',
      'xargs', 'xargs sh -c', 'doas sh', 'ionice -c 3 sh'].map(consumer =>
      `cat <<'EOF' | cat | ${consumer}\nopen x\nEOF`),
    "sh | cat <<'EOF' >message\nopen x\nEOF",
    "git commit -F - <<'EOF' | sh\nopen x\nEOF",
    "sh <<'OUTER'\ncat >message <<'INNER'\nopen x\nINNER\nOUTER",
    'cat <<< "open x" | env sh',
    'cat <(echo open x) | sh',
    'cat <<< "open x" | xargs',
  ]) assert.equal(denied(command), true, command);
});

test('file data sinks, captured cat output and scanned interpreter input still pass', () => {
  for (const command of [
    "cat >message <<'EOF'\nIt's (open) `open x`\nopen the door\nEOF",
    "tee message <<'EOF'\nopen the door\nEOF",
    "cat <<'ONE' <<\"TWO\" >message\nopen the door\nONE\nSafari\nTWO",
    "message=$(cat <<'EOF'\nIt's (open) `open x`\nopen the door\nEOF\n)",
    "gh issue create --body-file - <<'EOF'\nopen the door\nEOF",
    "gh pr comment 1 --body-file=- <<'EOF'\nopen the door\nEOF",
    'cat >message <<EOF\nordinary data\nEOF',
    "cat >message <<-'EOF'\n\topen the door\n\tEOF",
    "git commit -F - <<'EOF'\nEOFsuffix\nopen the door\nEOF",
    "cat >message <<\"E\\q\"\nopen the door\nE\\q",
    'cat >message <<EOF\n<(open x)\nEOF',
    "python3 - <<'PY'\nprint('hello')\nPY",
    "node - <<'JS'\nconsole.log('hello')\nJS",
  ]) assert.equal(denied(command), false, command);
});

test('proven commit data keeps apostrophes, parentheses, backticks and opener words literal', () => {
  const body = "It's a fix (reviewed). Let's keep (( examples, $[1<<2] and [[ examples.\n`open x`\n$(open x)\nopen the door\nSafari";
  for (const delimiter of ["'EOF'", '"EOF"', "E'OF'", '\\EOF']) {
    const command = `git commit -F - <<${delimiter}\n${body}\nEOF`;
    assert.equal(denied(command), false, command);
    assert.equal(denied(command + '\nopen x'), true, command);
  }
});

test('top-level completion clears the shell guard even when downstream completion throws', { skip: parserSkip }, async () => {
  const h = installedGuard(), event = { tool: 'Bash', command: 'open report.pdf' };
  await h.use();
  await assert.rejects(h.complete({}, async () => { throw Error('completion failed'); }), /completion failed/);
  assert.equal((await h.pre(event)).deny, undefined);
  assert.equal(h.ended(), 1);
  await h.use();
  await assert.rejects(h.complete({ agentId: 'child' }, async () => { throw Error('child failed'); }), /child failed/);
  assert.equal((await h.pre(event)).deny, guard.shellGuardReason);
});

test('consumer checks follow quoted split strings, attached shell options and unknown pipes', () => {
  for (const command of [
    `env -S "s'h'" <<< 'open x'`,
    `cat >message <<'EOF' | env -S "s'h'"\nopen x\nEOF`,
    "tee message <<'EOF' | unknown\nopen x\nEOF",
    "sh -c'open x'", "fish --command='open x'", "busybox sh -c'open x'",
    "su fixture -lc'open x'", "su --command='open x' fixture",
    "echo $(cat >message <<'EOF' | sh\nopen x\nEOF\n)",
    'cat >message <<EO\\\nF\n$(open x)\nEOF',
    'git commit -F - <<E\u00a0F\nE\u00a0F\nopen x\nE',
    "unknown <<'EOF'\nIt's data to an unknown consumer.\nop\\\nen x\nEOF",
  ]) assert.equal(denied(command), true, command);
});

test('added wrappers preserve ordinary and headless commands with option operands', () => {
  for (const command of [
    'doas -u fixture chromium --headless --user-data-dir=/tmp/p', 'ionice -c3 -n7 chromium --headless --user-data-dir=/tmp/p',
    'chroot --userspec fixture /fixture chromium --headless --user-data-dir=/tmp/p',
    'parallel -j 2 chromium --headless --user-data-dir=/tmp/p', 'watch -n 2 chromium --headless --user-data-dir=/tmp/p',
    'busybox sh -c "chromium --headless --user-data-dir=/tmp/p"',
    'sandbox-exec -p "(allow default)" chromium --headless --user-data-dir=/tmp/p',
    'xcrun --sdk macosx --toolchain default chromium --headless --user-data-dir=/tmp/p',
    'su -c "printf ok"', 'shortcuts list',
  ]) assert.equal(denied(command), false, command);
});

test('every shell and xargs consumer scans each supported input form through pipelines', () => {
  for (const consumer of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'busybox sh',
    'env sh', 'env -S "s\'h\'"', 'xargs', 'xargs sh -c', 'doas sh', 'ionice -c 3 sh']) {
    for (const command of [
      `${consumer} <<'EOF'\nopen x\nEOF`,
      `${consumer} <<< 'open x'`,
      `${consumer} <(echo open x)`,
      `cat <<'EOF' | cat | ${consumer}\nopen x\nEOF`,
      `cat <<< 'open x' | cat | ${consumer}`,
      `cat <(printf '%s' 'open x') | cat | ${consumer}`,
    ]) assert.equal(denied(command), true, command);
  }
});

test('captured heredoc data cannot swallow a command after its exact closing boundary', () => {
  for (const body of ["It's open", 'open (', 'open )', '`open x`', '`', '$(open x)', 'Safari']) {
    for (const command of [
      `message=$(cat <<'EOF'\n${body}\nEOF\n)`,
      `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`,
    ]) {
      assert.equal(denied(command), false, command);
      assert.equal(denied(command + '\nopen x'), true, command);
    }
  }
});

// FD4F: only the guard sees these strings. No fixture program runs.
const fd4fPayloads = [
  ['python3', 'import subprocess as sp; sp.run(["open", "f"])'],
  ['python3', 'from subprocess import run; run(["open", "f"])'],
  ['python3', 'from subprocess import run as launch; launch(args=["open", "f"])'],
  ['python3', 'import subprocess; subprocess.run(args=["/usr/bin/open", "f"])'],
  ['python3', 'import subprocess; argv = ["open", "f"]; subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ("open", "f"); subprocess.run(args=argv)'],
  ['python3', 'import subprocess; argv = "cat", "open"; subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ["sh", "-c", "open f"]; subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ["cat", "open"]; subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ["open", "f"]; saved = argv; argv = ["cat", "f"]; subprocess.run(saved)'],
  ['python3', 'import subprocess; argv = ["open", "f"]; argv = argv; subprocess.run(argv)'],
  ['python3', 'import subprocess; subprocess.run(["cat", "open"])'],
  ['python3', 'import subprocess; subprocess.run(["env", "osascript", "script.scpt"])'],
  ['python3', 'import os as platform; platform.system("open f")'],
  ['python3', 'from os import popen as launch; launch("open f")'],
  ['python3', 'import asyncio; asyncio.create_subprocess_exec("open", "f")'],
  ['python3', 'import asyncio as aio; aio.create_subprocess_shell("cd /tmp && open f")'],
  ['python3', 'from asyncio import create_subprocess_exec as launch; launch("open", "f")'],
  ...['execv', 'execve', 'execvp', 'execvpe', 'execl', 'execle', 'execlp', 'execlpe',
    'spawnv', 'spawnve', 'spawnvp', 'spawnvpe', 'spawnl', 'spawnle', 'spawnlp', 'spawnlpe'].map(method =>
    ['python3', `import os; os.${method}(os.P_NOWAIT, "/usr/bin/open", ["open", "f"])`]),
  ...['run', 'call', 'check_call', 'check_output', 'Popen', 'getoutput', 'getstatusoutput'].map(method =>
    ['python3', `import subprocess; subprocess.${method}(args=["open", "f"])`]),
  ...['f', 'r', 'b', 'u', 'fr', 'rf', 'br', 'rb', 'F', 'R', 'B', 'U'].map(prefix =>
    ['python3', `import os; os.system(${prefix}"open f")`]),
  ['python3', 'import os; os.system("""cd /tmp && open f""")'],
  ['python3', "import subprocess; subprocess.run(args=(r'''/usr/bin/open''', 'f'))"],
  ...['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'].flatMap(method => [
    ['node', `require("child_process").${method}("open", ["f"])`],
    ['node', `require("node:child_process")["${method}"]("open", ["f"])`],
    ['node', `const { ${method}: launch } = require("node:child_process"); launch("open", ["f"])`],
    ['node', `const { ${method} } = require("child_process"); ${method}("open", ["f"])`],
  ]),
  ['node', 'const cp = require("child_process"); cp["execFile"]("/usr/bin/open", ["f"])'],
  ['node', 'const { "spawn": launch } = require("child_process"); launch("open", ["f"])'],
  ['node', 'const { ["spawn"]: launch } = require("child_process"); launch("open", ["f"])'],
  ['node', 'import { spawn as launch } from "node:child_process"; launch("open", ["f"])'],
  ['node', 'import * as cp from "node:child_process"; cp.spawn("open", ["f"])'],
  ['node', 'const cp = require("child_process"); cp.execSync(`cd /tmp && open f`)'],
  ['node', 'const cp = require("child_process"); const argv = ["open"]; cp.spawn("env", argv)'],
  ['node', 'require("child_process").spawn("node", ["open"])'],
  ['node', 'require("open")("f")'], ['node', 'const launch = require("open"); launch("f")'],
  ['node', 'const text = `open the door`; require("child_process").spawn("open", ["f"])'],
  ['ruby', 'Open3.capture2("open", "f")'], ['ruby', 'Open3.capture3 "cd /tmp && open f"'],
  ['ruby', 'Open3.popen3("sh", "-c", "open f")'],
  ['ruby', '%x(open f)'], ['ruby', '%x(cd /tmp && open f)'],
  ['ruby', '`cd /tmp && /usr/bin/open f`'], ['perl', '`cd /tmp && open f`'],
  ['perl', 'qx(open f)'], ['perl', 'qx(cd /tmp && osascript script.scpt)'],
  ['perl', 'qx/open f/'], ['perl', 'qx{cd /tmp && open f}'], ['perl', 'qx"open f"'],
  ['perl', 'open(my $fh, "open f |")'], ['perl', 'open(my $fh, "| open f")'],
  ['perl', 'open(my $fh, "-|", "open", "f")'],
  ['perl', 'open my $fh, "|-", "/usr/bin/open", "f";'],
  ['swift', 'import Foundation; let p = Process(); p.launchPath = "/usr/bin/open"; p.launch()'],
  ['swift', 'import Foundation; let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); try p.run()'],
  ...[';', '&&', '||', '|'].map(op => ['python3', `import os; os.system("cd /tmp ${op} open f")`]),
  ...['sh -c open f', "sh -c 'open f'", 'bash -lc "open f"', 'env open f',
    'env LANG=C /usr/bin/open f', 'env -u BROWSER osascript script.scpt'].map(command =>
    ['python3', `import os; os.system(${JSON.stringify(command)})`]),
];
for (const [interpreter, payload] of fd4fPayloads) {
  const flag = interpreter === 'python3' ? '-c' : '-e';
  for (const command of [
    `${interpreter} ${flag} ${quotePayload(payload)}`,
    `${interpreter} <<'FD4F'\n${payload}\nFD4F`,
    `printf '%s' ${quotePayload(payload)} | ${interpreter}`,
  ]) test(`fd4f process argument refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));
}

for (const [interpreter, payload] of [
  ['node', 'const text = `open the door`'],
  ['node', 'console.log(`open the file`)'],
  ['node', 'const text = `cd /tmp && open f`'],
  ['node', 'console.log(`open f (not a call)`)'],
  ['node', 'require("fs").open(`open the file`, "r", () => {})'],
  ['node', 'const cp = require("child_process"); cp.execSync("echo open")'],
  ['node', 'const spawn = "open the file"; console.log(spawn)'],
  ['node', 'const options = { exec: "open", spawn: "open" }; console.log(options)'],
  ['python3', 'import subprocess; method = subprocess.run; print("open")'],
  ['python3', 'import os; method = os.system; print("open")'],
  ['python3', 'import subprocess; argv = ["open", "f"]; argv = make_args(); subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ["open", "f"]; print(argv)'],
  ['python3', 'import subprocess; subprocess.run(["cat", "opener"])'],
  ['python3', 'import subprocess; subprocess.run(["cat", "f"]); print("open")'],
  ['python3', 'import subprocess; subprocess.run(["cat", "f"]); open("open", "w")'],
  ['python3', 'import subprocess; argv = ["open", "f"]; argv = ["cat", "f"]; subprocess.run(argv)'],
  ['python3', 'print("subprocess.run(open)")'],
  ['python3', 'qx("open")'],
  ['python3', 'open(r"open", "w"); Path("f").open()'],
  ['ruby', 'File.open("open", "w") { |f| f.write("open") }'],
  ['perl', 'open(my $fh, "<", "open")'],
  ['perl', 'open my $fh, "<", "open";'],
]) {
  for (const command of [
    `${interpreter} ${interpreter === 'python3' ? '-c' : '-e'} ${quotePayload(payload)}`,
    `${interpreter} <<'FD4F'\n${payload}\nFD4F`,
    `printf '%s' ${quotePayload(payload)} | ${interpreter}`,
    `${interpreter} <<< ${quotePayload(payload)}`,
    `${interpreter} < <(printf '%s' ${quotePayload(payload)})`,
  ]) test(`fd4f file IO and template data pass: ${JSON.stringify(command)}`, () => assert.equal(denied(command), false));
}

test('fd4f repeated literal references stay bounded without expanding the program data', () => {
  const source = 'import subprocess; argv = ["cat"]; ' + 'argv = [argv, argv]; '.repeat(19) + 'subprocess.run(argv)';
  assert.equal(denied(`python3 -c ${quotePayload(source)}`), false);
});

// sa1m review SHOULD-FIX: other flag spellings the browser accepts (the last one wins) and relative paths.
const strayProfiles = [
  'chrome --headless --user-data-dir=/tmp/x -user-data-dir="/fixture/home/Library/Application Support/Google/Chrome"',
  'chrome --headless --user-data-dir=/tmp/x --USER-DATA-DIR=/fixture/home/x',
  'chrome --headless -user-data-dir=/tmp/x',
  'firefox --headless --no-remote --PROFILE "/fixture/home/Library/Application Support/Firefox/Profiles/real" --profile /tmp/p',
  'firefox --headless --no-remote --profile /tmp/p -PROFILE /fixture/home/x',
  'firefox --headless --no-remote --profile /tmp/p -p default', 'chrome --headless --user-data-dir=/tmp/x /user-data-dir=/fixture/home/x',
  // Chromium reads a switch value only after '=', so these leave the default profile in use (security review).
  'chrome --headless --user-data-dir /tmp/p', 'chromium --headless=new --user-data-dir "/tmp/a b"',
  'chrome --headless --user-data-dir=new-profile', 'chrome --headless --user-data-dir=./new-profile',
  'firefox --headless --no-remote --profile Profiles/real',
];
test('sa1m review: stray profile spellings and relative paths grant no exemption', async () => {
  for (const command of strayProfiles) assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command, ...profileContext }), true, command);
  for (const command of ['chrome --headless --user-data-dir=/tmp/p', 'firefox --headless --no-remote --profile /tmp/p',
    'firefox --headless --no-remote -profile /tmp/p', 'chrome --headless --user-data-dir=/tmp/p --profile-directory=Default'])
    assert.equal(guard.shellLaunchDenied({ tool: 'Bash', command, ...profileContext }), false, command);
  const noStray = await brokenGuard('const isolated = !stray && (', 'const isolated = (');
  assert.ok(strayProfiles.slice(0, 7).some(command => noStray.shellLaunchDenied({ tool: 'Bash', command, ...profileContext }) === false));
  const relative = await brokenGuard('if (!absolute(value)) return false;', "if (!absolute(value)) value = '/fixture/home/project/' + value;");
  assert.ok(strayProfiles.slice(9).every(command => relative.shellLaunchDenied({ tool: 'Bash', command, ...profileContext }) === false));
  const spaced = await brokenGuard("value: firefox ? flags[i + 1] ?? '' : ''", "value: flags[i + 1] ?? ''");
  assert.ok(strayProfiles.slice(7, 9).every(command => spaced.shellLaunchDenied({ tool: 'Bash', command, ...profileContext }) === false));
});
