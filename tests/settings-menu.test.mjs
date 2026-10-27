import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { preapprovedWriteDenied } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { linkCommand, managedShim, resolveShimLauncher, settingsDoctorLine } from '../plugins/sleight/lib/settings-link.mjs';
import { menuCommand, menuMessage } from '../plugins/sleight/lib/hand/menu-command.mjs';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';
const root = t => registerTemp(t, trackTemp(fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'sleight-sm1-')))));
const launch = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).pathname;
const source = fs.readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const deny = command => preapprovedWriteDenied({ tool: 'Bash', command }, { stat: async path => ({ realPath: path }) });
for (const command of ['sleight hand on', 'sleight menu', 'sleight-mcp link', 'sleight unlink',
  'node /x/launch.mjs menu', 'sh -c "sleight menu"', 'python3 -c "import os; os.system(\'sleight menu\')"',
  '$BIN menu', 'CMD=sleight; $CMD hand on', 'sleight $OP', '$(printf sleight) menu',
  'node /x/sleight hand on', 'sleight-mcp unlink', 'sleight-mcp menu', 'xargs sleight menu',
  'printf menu | xargs sleight', 'sleight `printf menu`', 'sh -c "$BIN link"',
  'node -e "require(\'child_process\').execSync(\'sleight link\')"']) {
  test('shell refuses ' + command, async () => assert.equal(await deny(command), true));
}
for (const command of ['sleight hand status', 'sleight turbo status', 'sleight permissions', 'sleight cursor list',
  'sleight cursor check tsugi', 'sleight cursor status', 'node /x/launch.mjs hand status',
  'sh -c "sleight hand status"', 'rg -n menu plugins/sleight/lib/launch.mjs', 'sleight --doctor']) {
  test('shell allows ' + command, async () => assert.equal(await deny(command), false));
}
for (const op of ['menu', 'link', 'unlink']) test(op + ' refuses outside an own terminal before any command work', () => {
  const run = spawnSync(process.execPath, [launch, op], { encoding: 'utf8', env: process.env, timeout: 10000 });
  assert.equal(run.status, 3, run.stderr); assert.equal(run.stdout, ''); assert.match(run.stderr, /run it yourself in a terminal/);
});
function fixture(t) {
  const home = root(t), config = path.join(home, 'config'), recorded = path.join(home, "old plugin's copy");
  const make = name => {
    const install = path.join(home, name);
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(install, 'bin/sleight-mcp'), '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n', { mode: 0o700 });
    return install;
  };
  make("old plugin's copy");
  fs.mkdirSync(path.join(config, 'plugins'), { recursive: true });
  const record = value => fs.writeFileSync(path.join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'sleight@sleight': value } }));
  return { home, config, recorded, make, record };
}
test('shim resolves the current install, a moved update, missing record fallback, and missing installs', async t => {
  const f = fixture(t), output = [];
  assert.equal(await linkCommand('link', [], { ...f, ask: async () => true, out: s => output.push(s), env: { PATH: '/usr/bin:/bin' } }), 0);
  assert.equal(managedShim(f.home), true); assert.equal(fs.readlinkSync(path.join(f.home, '.local/bin/sleight')), '.sleight-shim-v1'); assert.match(settingsDoctorLine(f.home), /Settings: sleight menu/);
  assert.ok(output.includes('export PATH="$HOME/.local/bin:$PATH"\n'));
  const command = path.join(f.home, '.local/bin/sleight');
  const run = () => spawnSync(command, ['menu', 'argument with spaces', "a'b"], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: f.config }, timeout: 10000 });
  for (const name of ['current plugin', "updated plugin's copy"]) {
    const install = f.make(name); f.record([{ scope: 'user', installPath: install }]);
    const result = run(); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [path.join(install, 'bin/sleight-mcp'), 'menu', 'argument with spaces', "a'b"]);
  }
  const project = f.make('project install'); f.record([{ scope: 'project', installPath: project }]);
  assert.equal(run().stdout.split('\n')[0], path.join(project, 'bin/sleight-mcp'));
  f.record([]); assert.equal(run().stdout.split('\n')[0], path.join(f.recorded, 'bin/sleight-mcp'));
  fs.unlinkSync(path.join(f.config, 'plugins/installed_plugins.json'));
  assert.equal(run().status, 0);
  fs.rmSync(f.recorded, { recursive: true });
  const missing = run(); assert.equal(missing.status, 1); assert.match(missing.stderr, /no installed sleight launcher found/);
});
test('resolver rejects ambiguous or relative records and uses the recorded fallback', t => {
  const f = fixture(t), install = f.make('current');
  for (const entries of [[{ scope: 'user', installPath: '../escape' }], [{ scope: 'user', installPath: install }, { scope: 'user', installPath: install }]]) {
    f.record(entries); assert.equal(resolveShimLauncher({ ...f, fs, path }), path.join(f.recorded, 'bin/sleight-mcp'));
  }
});
test('link needs an affirmative answer, refuses existing files, and unlink removes only its own shim', async t => {
  const f = fixture(t), out = () => {}, file = path.join(f.home, '.local/bin/sleight');
  assert.equal(await linkCommand('link', [], { ...f, ask: async () => false, out }), 0); assert.equal(fs.existsSync(file), false);
  await linkCommand('link', [], { ...f, ask: async () => true, out });
  await linkCommand('unlink', [], { ...f, out }); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, 'personal command');
  assert.equal(await linkCommand('link', [], { ...f, ask: async () => { throw Error('must not ask'); }, out }), 1);
  await linkCommand('unlink', [], { ...f, out }); assert.equal(fs.readFileSync(file, 'utf8'), 'personal command');
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.recorded, 'bin/sleight-mcp'), file);
  await linkCommand('unlink', [], { ...f, out }); assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});
test('menu compiles cold, starts once, reports an existing item and propagates startup failure', async () => {
  let prepares = 0, starts = 0; const output = [];
  const options = { platform: 'darwin', out: s => output.push(s), built: () => false,
    prepare: async () => { prepares++; return { status: 'ready' }; }, start: async () => ++starts > 1 };
  assert.equal(await menuCommand([], options), 0); assert.equal(output[0], "Compiling sleight's menu host for first use.\n"); assert.equal(output[1], menuMessage);
  output.length = 0; assert.equal(await menuCommand([], { ...options, built: () => true }), 0);
  assert.deepEqual(output, ["sleight's menu is already in the menu bar.\n"]); assert.equal(prepares, 2); assert.equal(starts, 2);
  assert.equal(await menuCommand([], { ...options, prepare: async () => ({ status: 'unavailable', code: 'TEST' }) }), 1);
  assert.equal(await menuCommand(['extra'], options), 2);
});
test('menu client has no consent channel, sprites, action frames or pause exchange', async t => {
  const child = new EventEmitter(), lines = [];
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
  child.stdin.write = line => { lines.push(JSON.parse(line)); return true; };
  child.stdin.end = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.pid = 1;
  let options, ready;
  let setting = { enabled: true, style: 'sprite', character: 'tsugi' };
  const client = createHandClient({ menuOnly: true, setting: () => setting,
    watch: () => undefined, permissions: null, usage: null, cursorPicker: { catalog: async () => ({ rows: [], thumbnails: [] }) }, built: () => true, onMenuReady: existing => { ready = existing; },
    loadSprite: () => { throw Error('no sprite may load'); }, prepare: async () => ({ status: 'ready', spawn: o => { options = o; return child; } }) });
  t.after(() => client.close()); assert.equal(await client.startMenu(), true);
  assert.equal(options.consent, false); assert.equal(options.menuOnly, true);
  client.send({ kind: 'click', pid: 1, windowId: 2, at: [0, 0] });
  child.stdout.emit('data', JSON.stringify({ hand: 'menu-ready', nonce: lines[0].nonce, existing: false }) + '\n');
  assert.equal(ready, false); assert.deepEqual(lines.map(l => l.hand), ['menu']);
  setting = { enabled: false, style: 'ring' };
  child.stdout.emit('data', JSON.stringify({ hand: 'picker', nonce: lines[0].nonce, op: 'refresh' }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lines.filter(l => l.hand === 'menu').at(-1).enabled, false);
  assert.equal(lines.some(l => ['act', 'aim', 'status', 'character', 'pause-ack'].includes(l.hand)), false);
});
test('native menu plan and single-instance lock run without an application or a window', { skip: macCommandSkip('xcrun') }, t => {
  const dir = root(t), swift = path.join(dir, 'main.swift'), bin = path.join(dir, 'lock-test');
  const lock = source.match(/\/\/ BEGIN MENU INSTANCE\n([\s\S]*?)\/\/ END MENU INSTANCE/)[1];
  const plan = source.match(/struct SettingsMenuPlan \{[\s\S]*?\n\}/)[0];
  fs.writeFileSync(swift, 'import Foundation\nimport Darwin\n' + lock + plan + `
let a = MenuInstance(), b = MenuInstance(), file = CommandLine.arguments[1]
if CommandLine.arguments.count == 3 {
    print(a.claim(file) ? "free" : "held"); exit(0)
}
func probe() -> String {
    let task = Process(), output = Pipe()
    task.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); task.arguments = [file, "probe"]; task.standardOutput = output
    try! task.run(); task.waitUntilExit(); precondition(task.terminationStatus == 0)
    return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
}
precondition(a.claim(file)); precondition(!b.claim(file)); precondition(probe() == "held")
a.release(); precondition(probe() == "free"); precondition(b.claim(file)); b.release()
precondition(a.claim(file, standalone: false)); precondition(b.claim(file, standalone: false))
precondition(probe() == "held"); a.release(); b.release()
precondition(!SettingsMenuPlan(menuOnly: true).pause); precondition(SettingsMenuPlan(menuOnly: true).quit)
let data = try! JSONSerialization.data(withJSONObject: SettingsMenuPlan(menuOnly: true).json)
FileHandle.standardOutput.write(data)
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', bin], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const result = spawnSync(bin, [path.join(dir, 'menu.lock')], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { pause: false, resume: false, quit: true, drawsCursor: false, extraRows: ['Quit Menu'] });
  assert.match(source, /if plan\.pause &&/); assert.match(source, /if plan\.quit \{/);
  assert.match(source, /func quitMenu[\s\S]*?guard settingsMenu, personMenuActivation\(sender\)/);
  assert.match(source, /if settingsMenu && !\["menu", "picker", "hide"\]\.contains/);
});

test('full consent host compiles and dumps the menu-only plan before creating an application', { skip: macCommandSkip('xcrun') }, t => {
  const dir = root(t), binary = path.join(dir, 'consent-host');
  const file = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  t.diagnostic(`hostBytes=${fs.statSync(binary).size}`);
  const result = spawnSync(binary, ['--settings-menu-dump'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { pause: false, resume: false, quit: true, drawsCursor: false, extraRows: ['Quit Menu'] });
  const input = spawnSync(binary, ['--cursor-menu-dump'], { encoding: 'utf8', timeout: 10000,
    input: JSON.stringify({ hand: 'picker', nonce: 'a'.repeat(64), op: 'input-check' }) + '\n' });
  assert.equal(input.status, 0, input.stderr);
  assert.deepEqual(JSON.parse(input.stdout), { hardware: true, synthetic: false, keyboard: true, return: true, enter: true,
    otherKey: false, unhighlighted: false, old: false, future: false, mouseDown: false, wrongWindow: false, ax: false, axMethodsRefused: true, absent: false });
  assert.ok(source.indexOf('if arguments == ["--settings-menu-dump"]') < source.indexOf('let app = NSApplication.shared'));
});

test('the PATH shim retains the launcher terminal gate for menu and link', async t => {
  const home = root(t), recorded = new URL('../plugins/sleight', import.meta.url).pathname;
  await linkCommand('link', [], { home, recorded, ask: async () => true, out: () => {} });
  for (const op of ['menu', 'link']) {
    const run = spawnSync(path.join(home, '.local/bin/sleight'), [op], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
    assert.equal(run.status, 3, run.stderr); assert.equal(run.stdout, '');
  }
});
