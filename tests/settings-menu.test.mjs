import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { preapprovedWriteDenied } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { linkCommand, managedShim, resolveShimLauncher, settingsDoctorLine } from '../plugins/sleight/lib/settings-link.mjs';
import { menuCommand, menuMessage } from '../plugins/sleight/lib/hand/menu-command.mjs';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
import { createMenuWorker } from '../plugins/sleight/lib/hand/menu-worker.mjs';
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
  const home = root(t), config = path.join(home, 'config'), recorded = path.join(config, "plugins/cache/fixture/sleight/old plugin's copy");
  const make = name => {
    const install = path.join(config, 'plugins/cache/fixture/sleight', name);
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(install, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(install, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'sleight' }));
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
  assert.equal(managedShim(f.home), true); assert.equal(fs.readlinkSync(path.join(f.home, '.local/bin/sleight')), '.sleight-shim-v1'); assert.match(settingsDoctorLine(f.home, { PATH: path.join(f.home, '.local/bin') }), /Settings: sleight menu/);
  assert.ok(output.includes('export PATH="$HOME/.local/bin:$PATH"\n'));
  const command = path.join(f.home, '.local/bin/sleight');
  const run = () => spawnSync(command, ['menu', 'argument with spaces', "a'b"], { encoding: 'utf8', env: { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: f.config }, timeout: 10000 });
  for (const name of ['current plugin', "updated plugin's copy"]) {
    const install = f.make(name); f.record([{ scope: 'user', installPath: install }]);
    const result = run(); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [path.join(install, 'bin/sleight-mcp'), 'menu', 'argument with spaces', "a'b"]);
  }
  const project = f.make('project install'); f.record([{ scope: 'project', installPath: project }]);
  assert.equal(run().stdout.split('\n')[0], path.join(f.recorded, 'bin/sleight-mcp'));
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
test('standalone menu survives turning Ghost Hand off and back on through the settings watcher', async t => {
  const child = new EventEmitter(), lines = [], messages = [];
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.pid = 1;
  child.stdin.write = line => { lines.push(JSON.parse(line)); return true; };
  let ended = false, watcher;
  child.stdin.end = () => { ended = true; child.exitCode = 0; child.emit('exit', 0); };
  let setting = { enabled: true, style: 'ring' };
  const worker = createMenuWorker({ send: message => messages.push(message), createClient: options => createHandClient({ ...options,
    setting: () => setting, watch: (_folder, listener) => { watcher = listener; }, permissions: null, usage: null,
    cursorPicker: { catalog: async () => ({ rows: [], thumbnails: [] }) }, built: () => true,
    prepare: async () => ({ status: 'ready', spawn: () => child }) }) });
  t.after(() => worker.client.close()); await worker.client.startMenu();
  child.stdout.emit('data', JSON.stringify({ hand: 'menu-ready', nonce: lines[0].nonce, existing: false }) + '\n');
  for (const enabled of [false, true]) {
    setting = { ...setting, enabled }; watcher('change', 'hand.json');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lines.filter(l => l.hand === 'menu').at(-1).enabled, enabled);
    assert.equal(ended, false);
  }
  assert.deepEqual(messages, [{ ready: true, existing: false }]);
  child.emit('exit', 0); assert.equal(ended, true);
});
test('native menu plan and single-instance lock run without an application or a window', { skip: macCommandSkip('xcrun') }, t => {
  const dir = root(t), swift = path.join(dir, 'main.swift'), bin = path.join(dir, 'lock-test');
  const lock = source.match(/\/\/ BEGIN MENU INSTANCE\n([\s\S]*?)\/\/ END MENU INSTANCE/)[1];
  const plan = source.match(/struct SettingsMenuPlan \{[\s\S]*?\n\}/)[0];
  fs.writeFileSync(swift, 'import Foundation\nimport Darwin\n' + lock + plan + `
let file = CommandLine.arguments[1]
let a = MenuInstance(), b = MenuInstance()
if CommandLine.arguments.count == 3 {
    let session = CommandLine.arguments[2] == "session"
    print(a.claim(file, standalone: !session) ? "free" : "held")
    fflush(stdout)
    if session { _ = FileHandle.standardInput.readDataToEndOfFile() }
    exit(0)
}
func probe(_ session: Bool = false) -> (Process, Pipe, String) {
    let task = Process(), output = Pipe(), input = Pipe()
    task.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); task.arguments = [file, session ? "session" : "probe"]
    task.standardOutput = output; task.standardInput = input
    try! task.run()
    var data = Data()
    while true { let byte = output.fileHandleForReading.readData(ofLength: 1); if byte == Data([10]) || byte.isEmpty { break }; data.append(byte) }
    return (task, input, String(data: data, encoding: .utf8)!)
}
// Standalone first: a later session claims immediately, stays alive and causes the standalone to yield.
precondition(a.claim(file)); precondition(!b.claim(file))
let (session, input, result) = probe(true); precondition(result == "free")
precondition(!a.claim(file)); precondition(a.reason == "session-present")
input.fileHandleForWriting.closeFile(); session.waitUntilExit(); precondition(session.terminationStatus == 0)
a.release(); b.release()
// Session first: every session keeps a menu, and standalone reports existing.
precondition(a.claim(file, standalone: false)); precondition(b.claim(file, standalone: false))
let (probeTask, probeInput, held) = probe(); precondition(held == "held"); probeInput.fileHandleForWriting.closeFile(); probeTask.waitUntilExit()
a.release(); b.release()
precondition(a.claim(file)); a.release()
// Session faults always keep its menu: unsafe, missing, linked, replaced, touched and externally held locks.
let sessionFile = (file as NSString).deletingLastPathComponent + "/menu-session.lock"
precondition(chmod(sessionFile, 0o644) == 0)
precondition(a.claim(file, standalone: false)); precondition(a.reason == "unsafe-lock"); a.release()
precondition(unlink(sessionFile) == 0); precondition(a.claim(file, standalone: false)); a.release()
precondition(unlink(sessionFile) == 0); precondition(symlink(file, sessionFile) == 0)
precondition(a.claim(file, standalone: false)); precondition(a.reason == "unsafe-lock"); a.release()
precondition(unlink(sessionFile) == 0)
precondition(a.claim(file, standalone: false)); precondition(truncate(sessionFile, 1) == 0)
precondition(a.claim(file, standalone: false)); precondition(a.reason == "changed-lock"); a.release()
let heldFD = open(sessionFile, O_RDWR); precondition(heldFD >= 0); precondition(flock(heldFD, LOCK_EX | LOCK_NB) == 0)
precondition(a.claim(file, standalone: false)); precondition(a.reason == "held-lock"); a.release(); close(heldFD)
precondition(unlink(sessionFile) == 0); precondition(a.claim(file, standalone: false))
precondition(unlink(sessionFile) == 0); precondition(a.claim(file, standalone: false)); precondition(a.reason == "changed-lock"); a.release()
FileHandle.standardError.write(Data("orders=2 faults=6\\n".utf8))
precondition(!SettingsMenuPlan(menuOnly: true).pause); precondition(SettingsMenuPlan(menuOnly: true).quit)
for owns in [false, true] {
    precondition(SettingsMenuPlan(menuOnly: false).visible(retiring: false, owns: owns))
    precondition(SettingsMenuPlan(menuOnly: false).pause)
    precondition(!SettingsMenuPlan(menuOnly: false).visible(retiring: true, owns: owns))
    precondition(SettingsMenuPlan(menuOnly: true).visible(retiring: false, owns: owns) == owns)
}
let data = try! JSONSerialization.data(withJSONObject: SettingsMenuPlan(menuOnly: true).json)
FileHandle.standardOutput.write(data)
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', bin], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const bank = path.join(dir, 'private'); fs.mkdirSync(bank, { mode: 0o700 });
  const result = spawnSync(bin, [path.join(bank, 'menu-presence.lock')], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
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
  const { home, config, recorded } = fixture(t);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(recorded, 'bin/sleight-mcp'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(launch)} "$@"\n`, { mode: 0o700 });
  await linkCommand('link', [], { home, recorded, ask: async () => true, out: () => {} });
  for (const op of ['menu', 'link']) {
    const run = spawnSync(path.join(home, '.local/bin/sleight'), [op], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: home } });
    assert.equal(run.status, 3, run.stderr); assert.equal(run.stdout, '');
  }
});

for (const kind of ['project', 'tmp', 'writable-parent', 'wrong-name', 'symlink-escape', 'foreign-owner',
  'writable-launcher', 'writable-manifest', 'writable-bin', 'wrong-cache-layout']) {
  test('shim refuses forged install record: ' + kind, async t => {
    const f = fixture(t), candidate = f.make('candidate');
    let installPath = candidate, scope = 'user';
    if (kind === 'project') scope = 'project';
    if (kind === 'tmp' || kind === 'symlink-escape') {
      const outside = path.join(f.home, 'outside'); fs.renameSync(candidate, outside); installPath = outside;
      if (kind === 'symlink-escape') { fs.symlinkSync(outside, candidate); installPath = candidate; }
    }
    if (kind === 'writable-parent') fs.chmodSync(path.dirname(candidate), 0o777);
    if (kind === 'writable-launcher') fs.chmodSync(path.join(candidate, 'bin/sleight-mcp'), 0o777);
    if (kind === 'writable-manifest') fs.chmodSync(path.join(candidate, '.claude-plugin/plugin.json'), 0o666);
    if (kind === 'writable-bin') fs.chmodSync(path.join(candidate, 'bin'), 0o777);
    if (kind === 'wrong-cache-layout') {
      installPath = path.join(f.config, 'plugins/cache/other'); fs.renameSync(candidate, installPath);
    }
    if (kind === 'wrong-name') fs.writeFileSync(path.join(candidate, '.claude-plugin/plugin.json'), '{"name":"evil"}');
    f.record([{ scope, installPath }]);
    const io = kind === 'foreign-owner' ? { ...fs, lstatSync: p => {
      const st = fs.lstatSync(p); if (p === candidate) Object.defineProperty(st, 'uid', { value: process.getuid() + 1 }); return st;
    } } : fs;
    if (kind === 'writable-parent') {
      assert.throws(() => resolveShimLauncher({ ...f, fs: io, path }), /no installed sleight launcher found/);
      fs.chmodSync(path.dirname(candidate), 0o755);
    } else assert.equal(resolveShimLauncher({ ...f, fs: io, path }), path.join(f.recorded, 'bin/sleight-mcp'));
  });
}
test('shim refuses changed bytes and unsafe or missing integrity receipts before dispatch', async t => {
  const f = fixture(t); await linkCommand('link', [], { ...f, ask: async () => true, out: () => {} });
  const shim = path.join(f.home, '.local/bin/.sleight-shim-v1'), command = path.join(f.home, '.local/bin/sleight');
  const receipt = path.join(f.home, 'Library/Application Support/sleight/settings-link.json');
  const original = fs.readFileSync(shim), saved = fs.readFileSync(receipt);
  const run = () => spawnSync(command, ['menu'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: f.config } });
  fs.appendFileSync(shim, '# tampered\n');
  assert.equal(run().status, 1); assert.match(run().stderr, /shim integrity/);
  fs.writeFileSync(shim, original); fs.chmodSync(receipt, 0o644);
  assert.equal(run().status, 1); fs.chmodSync(receipt, 0o600);
  fs.unlinkSync(receipt); assert.equal(run().status, 1);
  const other = path.join(f.home, 'receipt'); fs.writeFileSync(other, saved, { mode: 0o600 }); fs.symlinkSync(other, receipt);
  assert.equal(run().status, 1);
  fs.unlinkSync(receipt); fs.writeFileSync(receipt, saved, { mode: 0o600 });
  assert.equal(run().status, 0);
  assert.match(settingsDoctorLine(f.home, { PATH: '/usr/bin:/bin' }), /Settings: sleight-mcp menu/);
});
test('a forged /tmp install record cannot replace the recorded install', t => {
  const f = fixture(t), candidate = f.make('candidate');
  const outside = registerTemp(t, trackTemp(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'sleight-forged-install-'))));
  fs.cpSync(candidate, outside, { recursive: true });
  f.record([{ scope: 'user', installPath: outside }]);
  assert.equal(resolveShimLauncher({ ...f, fs, path }), path.join(f.recorded, 'bin/sleight-mcp'));
});
test('link declines EOF and handles an orphan shim without a raw EEXIST error', async t => {
  const f = fixture(t), module = new URL('../plugins/sleight/lib/settings-link.mjs', import.meta.url).href;
  const eof = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {linkCommand} from ${JSON.stringify(module)}; process.exitCode=await linkCommand('link',[],${JSON.stringify({home:f.home,recorded:f.recorded})});`],
    { encoding: 'utf8', input: '', timeout: 10000, env: { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: f.config } });
  assert.equal(eof.status, 0, eof.stderr); assert.match(eof.stdout, /No command created/);
  await linkCommand('link', [], { ...f, ask: async () => true, out: () => {} });
  fs.unlinkSync(path.join(f.home, '.local/bin/sleight'));
  const output = [];
  assert.equal(await linkCommand('link', [], { ...f, ask: async () => true, out: s => output.push(s) }), 1);
  assert.match(output.join(''), /shim already exists/);
});
test('a receipt-authenticated shim stays managed when a plugin update changes its generator', async t => {
  const f = fixture(t); await linkCommand('link', [], { ...f, ask: async () => true, out: () => {} });
  const target = path.join(f.home, '.local/bin/.sleight-shim-v1');
  fs.appendFileSync(target, '# earlier generator revision\n');
  const receipt = path.join(f.home, 'Library/Application Support/sleight/settings-link.json');
  fs.writeFileSync(receipt, JSON.stringify({ version: 1, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') }));
  assert.equal(managedShim(f.home), true);
  await linkCommand('unlink', [], { ...f, out: () => {} });
  assert.equal(fs.existsSync(target), false);
});
