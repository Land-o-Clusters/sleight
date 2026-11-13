import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { win32, join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { forbiddenWindowsTarget, matchBlockedWindowsApp } from '../plugins/sleight/lib/blocked-apps-windows.mjs';
import { prepareWindowsHandHost, windowsDriverSources } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';

const identityURL = new URL('../plugins/sleight/lib/direct-browser/native/win/DriverIdentity.cs', import.meta.url);
const parentURL = new URL('../plugins/sleight/lib/blocked-apps-windows.mjs', import.meta.url);
const native = readFileSync(identityURL, 'utf8'), parent = readFileSync(parentURL, 'utf8');
const quoted = text => [...text.matchAll(/"([^"\n]*)"/g)].map(match => match[1]);
function nativeTable(source = native) {
  const names = name => {
    const body = source.match(new RegExp(`string\\[\\] ${name} = \\{([^}]+)\\}`))?.[1];
    assert.ok(body, `native table ${name} missing`);
    return quoted(body);
  };
  const pattern = name => {
    const value = source.match(new RegExp(`const string ${name} = @"([^"]+)"`))?.[1];
    assert.ok(value, `native pattern ${name} missing`);
    return new RegExp(value.replaceAll('\\A', '^').replaceAll('\\z', '$'), 'i');
  };
  return { terminals: names('TerminalNames'), ai: names('AiNames'),
    terminalAumid: pattern('TerminalAumid'), aiAumid: pattern('AiAumid'),
    terminalClass: source.match(/const string TerminalClass = "([^"]+)"/)?.[1] };
}
function parentTable(source = parent) {
  const names = name => [...source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]\\)`))[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  return { terminals: names('terminals'), ai: names('ai'),
    terminalAumid: source.match(/(\/\^microsoft\\\.windowsterminal[^\n]+?\/)\.test/)[1],
    aiAumid: source.match(/(\/\^openai\\\.[^\n]+?\/)\.test/)[1],
    terminalClass: source.match(/(?:^|\|\|)\s*window\?\.className === '([^']+)'/m)[1] };
}
function assertParity(source = native, parentSource = parent) {
  const a = nativeTable(source), b = parentTable(parentSource);
  for (const key of ['terminals', 'ai']) assert.deepEqual([...a[key]].sort(), [...b[key]].sort(), `${key}: native/parent name drift`);
  for (const key of ['terminalAumid', 'aiAumid']) assert.equal(a[key].source,
    b[key].slice(1, -1), `${key}: native/parent AUMID drift`);
  assert.equal(a.terminalClass, b.terminalClass, 'native/parent class drift');
}
// C# cannot execute on this host. Mirror its parsed tables and pin the native
// branch wiring separately, so a green mirror cannot hide a removed native guard.
function nativePolicy(window, allowForbidden = false, source = native) {
  const table = nativeTable(source);
  const identities = [window.image, window.originalFilename, window.productName].map(value =>
    win32.basename(value ?? '').replace(/\.exe$/i, '').toLowerCase());
  const aumid = (window.aumid ?? '').toLowerCase();
  const blocked = identities.some(name => table.terminals.includes(name) || table.ai.includes(name)) ||
    window.className === table.terminalClass || table.terminalAumid.test(aumid) || table.aiAumid.test(aumid);
  const settingsSource = source.match(/return ForbiddenTarget\(window\) && Regex.IsMatch\(\(window.Title \?\? ""\)\.Trim\(\),\s*@"([^"]+)"/)?.[1];
  assert.ok(settingsSource, 'settings must reuse the target identity policy');
  const settings = new RegExp(settingsSource.replaceAll('\\A', '^').replaceAll('\\z', '$'), 'i');
  if (blocked && settings.test((window.title ?? '').trim())) return 'FORBIDDEN_SETTINGS';
  return blocked && !allowForbidden ? 'FORBIDDEN_TARGET' : undefined;
}
function assertWiring(source = native) {
  assert.match(source, /static readonly bool AllowForbiddenTargets =\s*Environment.GetEnvironmentVariable\("SLEIGHT_ALLOW_FORBIDDEN_TARGETS"\) == "1";/);
  assert.match(source, /window.Image, window.OriginalFilename, window.ProductName/);
  assert.match(source, /Regex.Replace\(Path.GetFileName\(value \?\? ""\), @"\\.exe\\z", "", RegexOptions.IgnoreCase\)\.ToLowerInvariant\(\)/);
  assert.match(source, /TerminalNames.Intersect\(identities\).Any\(\) \|\| AiNames.Intersect\(identities\).Any\(\)/);
  assert.match(source, /window.ClassName == TerminalClass \|\| Regex.IsMatch\(aumid, TerminalAumid\) \|\|\s*Regex.IsMatch\(aumid, AiAumid\)/);
  const settings = source.indexOf('if (ForbiddenSettings(window))'), target = source.indexOf('if (!AllowForbiddenTargets && ForbiddenTarget(window))');
  assert.ok(settings >= 0 && target > settings, 'settings refuse before the override branch');
  assert.match(source, /if \(!AllowForbiddenTargets && ForbiddenTarget\(window\)\) \{ window.Refused = "FORBIDDEN_TARGET"; return; \}/);
  assert.ok(source.indexOf('if (UnresolvedHost(window))') < settings);
  assert.ok(source.indexOf('if (window.Refused != null) return;') < settings);
  assert.ok(source.indexOf('catalog.Contains(window.Image)') > target, 'the override cannot bypass own-host checks');
}
const identityOff = native.replace(/string\[\] TerminalNames = \{[^}]+\}/, 'string[] TerminalNames = { "never" }')
  .replace(/string\[\] AiNames = \{[^}]+\}/, 'string[] AiNames = { "never" }')
  .replace(/const string (TerminalAumid|AiAumid) = @"[^"]+"/g, 'const string $1 = @"\\Anever\\z"')
  .replace('const string TerminalClass = "ConsoleWindowClass"', 'const string TerminalClass = "never"');
test('UC3C native and parent terminal/OpenAI sets, AUMIDs and class are equal', () => assertParity());
test('UC3C native policy binds its tables, static override and settings-first branches', () => assertWiring());

const identityRows = [
  ...['windowsterminal', 'wt', 'conhost', 'openconsole', 'powershell', 'pwsh', 'powershell_ise', 'cmd', 'mintty', 'bash', 'git-bash',
    'wsl', 'ubuntu', 'debian', 'kali', 'conemu', 'conemu64', 'cmder', 'alacritty', 'wezterm', 'wezterm-gui', 'hyper', 'tabby',
    'chatgpt', 'codex', 'atlas'].flatMap(name => ['image', 'originalFilename', 'productName'].map(field =>
      [`${name} through ${field}`, { image: 'C:\\Apps\\notes.exe', [field]: `C:\\Apps\\${name.toUpperCase()}.EXE` }])),
  ['console class', { className: 'ConsoleWindowClass' }],
  ...['Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe!App',
    'OpenAI.ChatGPT', 'OpenAI.Codex_app', 'OpenAI.Atlas!app', 'OpenAI.ChatGPT-app'].map(aumid => [aumid, { aumid }]),
];
for (const [name, window] of identityRows) test(`UC3C direct launch policy: ${name}`, () => {
  assert.throws(() => assert.equal(nativePolicy(window, false, identityOff), 'FORBIDDEN_TARGET'),
    undefined, `identity-disabled mutant escaped test: ${name}`);
  for (const allowForbidden of [false, true]) {
    assert.equal(nativePolicy(window, allowForbidden), allowForbidden ? undefined : 'FORBIDDEN_TARGET');
    assert.equal(nativePolicy(window, allowForbidden), forbiddenWindowsTarget(window, { allowForbidden })?.code);
    for (const title of ['Settings', ' preferences ', 'Settings - Windows Terminal', 'Windows Terminal: Preferences',
      'Profiles', 'Startup', 'Interaction', 'Appearance', 'Rendering', 'Compatibility', 'Actions', 'Defaults',
      'réglages…', 'Einstellungen', 'impostazioni', 'configuración', 'ajustes', 'preferencias', '設定', '设置', '偏好设置']) {
      assert.equal(nativePolicy({ ...window, title }, allowForbidden), 'FORBIDDEN_SETTINGS', title);
      assert.equal(nativePolicy({ ...window, title }, allowForbidden), forbiddenWindowsTarget({ ...window, title }, { allowForbidden })?.code);
      const settingsOff = native.replace('@"\\A(?:(?:settings', '@"\\Anever(?:(?:settings');
      assert.throws(() => assert.equal(nativePolicy({ ...window, title }, allowForbidden, settingsOff), 'FORBIDDEN_SETTINGS'),
        undefined, `settings-disabled mutant escaped test: ${name}, ${title}`);
    }
  }
});
for (const [name, window] of [
  ['direct Notepad read', { image: 'C:\\Windows\\notepad.exe' }],
  ['stripped renamed terminal remains outside the name policy', { image: 'C:\\Apps\\notes.exe' }],
  ['approval host is a warning', { image: 'C:\\Apps\\Code.exe', className: 'Chrome_WidgetWin_1' }],
  ['AUMID near miss', { aumid: 'OpenAI.ChatGPTImpostor' }],
  ['terminal AUMID near miss', { aumid: 'Microsoft.WindowsTerminalFake_app' }],
  ['non-exe extension is not stripped', { productName: 'cmd.txt' }],
]) test(`UC3C accepted identity: ${name}`, () => {
  assert.equal(nativePolicy(window), undefined);
  assert.equal(matchBlockedWindowsApp(window), undefined);
  const tooBroad = native.replace(/const string TerminalAumid = @"[^"]+"/, 'const string TerminalAumid = @"\\A"');
  assert.throws(() => assert.equal(nativePolicy(window, false, tooBroad), undefined),
    undefined, `overbroad-identity mutant escaped test: ${name}`);
});

test('UC3C parity detects a one-sided wt-preview addition and reports its name', () => {
  assert.throws(() => assertParity(native.replace('"wt",', '"wt", "wt-preview",')), /wt-preview/);
  assert.throws(() => assertParity(native, parent.replace("'wt',", "'wt', 'wt-preview',")), /wt-preview/);
});
test('UC3C native safety assertions reject broken branch, override, identity and settings variants', () => {
  for (const [from, to] of [
    ['!AllowForbiddenTargets && ForbiddenTarget(window)', 'false'],
    ['!AllowForbiddenTargets && ForbiddenTarget(window)', 'ForbiddenTarget(window)'],
    ['== "1";', '!= "0";'],
    ['window.Image, window.OriginalFilename, window.ProductName', 'window.Image'],
    ['window.ClassName == TerminalClass', 'false'],
    ['Regex.IsMatch(aumid, TerminalAumid)', 'false'],
    ['Regex.IsMatch(aumid, AiAumid)', 'false'],
    ['if (ForbiddenSettings(window))', 'if (!AllowForbiddenTargets && ForbiddenSettings(window))'],
  ]) {
    assert.ok(native.includes(from), `mutation anchor missing: ${from}`);
    assert.throws(() => assertWiring(native.replace(from, to)), undefined, `surviving native mutant: ${from}`);
  }
});

async function assertSpawnPolicy(t, prepare = prepareWindowsHandHost) {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-uc3c-'))));
  const sourceRoot = join(root, 'source'), compiler = join(root, 'csc.exe');
  mkdirSync(sourceRoot); writeFileSync(compiler, 'fake compiler');
  for (const name of windowsDriverSources) writeFileSync(join(sourceRoot, name), 'source:' + name);
  const key = 'SLEIGHT_ALLOW_FORBIDDEN_TARGETS', old = process.env[key];
  try {
  for (const value of [undefined, '0', 'true', '01', '1 ', '1']) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    let observed;
    const built = await prepare({ platform: 'win32', kind: 'driver', sourceRoot,
      cacheRoot: join(root, 'cache'), compiler,
      access(checks) { for (const [op, path] of checks) if (op === 'create') mkdirSync(path, { recursive: true }); },
      async compile({ binary }) { writeFileSync(binary, 'fake driver'); },
      run(file, args, options) { observed = { file, args, options }; return {}; } });
    assert.equal(built.status, 'ready'); built.spawn({ nonce: 'a'.repeat(64), allowForbidden: true });
    assert.deepEqual(observed.args, ['--driver']);
    assert.deepEqual(observed.options.env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
      SLEIGHT_DRIVER_NONCE: 'a'.repeat(64), ...value === '1' ? { [key]: '1' } : {} });
    assert.equal(observed.options.shell, undefined);
  }
  } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
}
test('UC3C driver spawn forwards only an exact owner override and no caller environment', async t => {
  await assertSpawnPolicy(t);
});
test('UC3C spawn safety tests fail with the override dropped or unconditionally forwarded', async t => {
  const url = new URL('../plugins/sleight/lib/direct-browser/windows-host.mjs', import.meta.url);
  const original = readFileSync(url, 'utf8');
  const anchor = "process.env.SLEIGHT_ALLOW_FORBIDDEN_TARGETS === '1'";
  assert.ok(original.includes(anchor), 'spawn override mutation anchor missing');
  for (const condition of ['false', 'true']) {
    const source = original.replace(anchor, condition).replaceAll('import.meta.url', JSON.stringify(url.href))
      .replace("'../platform/paths.mjs'", JSON.stringify(new URL('../platform/paths.mjs', url).href));
    const api = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    await assert.rejects(assertSpawnPolicy(t, api.prepareWindowsHandHost), { code: 'ERR_ASSERTION' });
  }
});
