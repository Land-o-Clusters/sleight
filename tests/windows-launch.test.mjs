import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { handSetting, readHandConfig } from '../plugins/sleight/lib/hand/settings.mjs';
import { run, doctor } from '../plugins/sleight/lib/launch.mjs';

function fixture() {
  const input = new PassThrough(), output = new PassThrough(), replies = [], calls = [];
  output.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.exitCode = null;
  child.kill = () => assert.fail('fixture must exit on stdin EOF');
  child.stdin.once('finish', () => { child.exitCode = 0; child.emit('close', 0); });
  const windows = { input, output, signals: new EventEmitter(),
    discovery: { browsers: async () => { calls.push('browsers'); return [{ name: 'Chrome', installed: true }]; } },
    host: { prepareWindowsHandHost: async options => { calls.push(['prepare', options]); return { status: 'ready', spawn(options) { calls.push(['spawn', options]); return child; } }; },
      findWindowsCompiler: () => 'C:\\Windows\\csc.exe' },
    paths: { cache: 'C:\\Users\\Lane\\AppData\\Local\\sleight' },
    setting: () => ({ enabled: true, style: 'ring', capture: 'hidden', stream: true }),
    sink: { write: event => calls.push(['event', event]), close: () => calls.push('sink-close') },
  };
  return { input, output, replies, calls, windows, child };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('injected win32 run starts without clipboard recovery or a Mac engine and serves MCP', async () => {
  const f = fixture();
  f.windows.repl = { execute: async () => ({ isError: true, content: [{ type: 'text', text: 'fixture native refusal' }] }),
    close: async () => {} };
  const runtime = await run({ platform: 'win32', windows: f.windows, recoverClipboard: () => assert.fail('Mac clipboard recovery') });
  await runtime.hostReady;
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getApp("Notepad")' } } }) + '\n');
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'https://example.invalid' } } }) + '\n');
  await tick();
  assert.equal(f.replies.find(r => r.id === 1).result.protocolVersion, '2024-11-05');
  assert.deepEqual(f.replies.find(r => r.id === 2).result.tools.map(t => t.name), ['js', 'js_reset', 'turn_ended', 'browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs']);
  assert.match(JSON.stringify(f.replies.find(r => r.id === 3)), /fixture native refusal/);
  assert.match(JSON.stringify(f.replies.find(r => r.id === 4)), /peer.*consent/i);
  assert.equal(f.calls.find(c => c[0] === 'prepare')[1].cacheRoot, 'C:\\Users\\Lane\\AppData\\Local\\sleight\\cursor-host');
  assert.deepEqual(f.calls.find(c => c[0] === 'spawn')[1], { capture: 'hidden', cursorStyle: 'ring', consent: false });
  assert.ok(f.calls.some(c => c[0] === 'event' && c[1].type === 'session'));
  await runtime.close();
  assert.equal(f.child.exitCode, 0); assert.ok(f.calls.includes('sink-close'));
});

test('Windows doctor reports capabilities without building or spawning a host', async () => {
  const f = fixture(), lines = [];
  const code = await doctor({ platform: 'win32', windows: { ...f.windows, hostBuilt: () => false }, log: line => lines.push(line),
    turbo: () => assert.fail('Mac turbo doctor') });
  assert.equal(code, 1);
  const text = lines.join('\n');
  for (const expected of [/platform\s+win32/, /Node\s+v\d/, /csc\s+found/, /host\s+not built/, /browser\s+Chrome/, /not available on Windows yet/]) assert.match(text, expected);
  assert.equal(f.calls.some(c => c[0] === 'prepare' || c[0] === 'spawn'), false);
});

test('Windows startup serves initialize while the compiler is pending, and EOF cancels it', async () => {
  const f = fixture(); let finish, signal;
  f.windows.host.prepareWindowsHandHost = options => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  const runtime = await run({ platform: 'win32', windows: f.windows });
  await tick();
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
  assert.equal(f.replies[0].result.serverInfo.name, 'sleight');
  f.input.end(); await tick(); assert.equal(signal.aborted, true);
  finish({ status: 'ready', spawn: () => assert.fail('closed session must not launch') });
  await runtime.close(); assert.equal(runtime.hostStatus, 'building');
  assert.equal(f.calls.filter(c => c === 'sink-close').length, 1);
});

test('Windows cursor off starts no compiler, host or renderer discovery', async () => {
  const f = fixture(); f.windows.setting = () => ({ enabled: false, stream: false });
  const runtime = await run({ platform: 'win32', windows: f.windows });
  await runtime.hostReady;
  assert.deepEqual(f.calls, []); await runtime.close();
});

test('missing Windows compiler leaves MCP available with an explicit host status', async () => {
  const f = fixture(), warnings = [];
  f.windows.host.prepareWindowsHandHost = async () => ({ status: 'unavailable', code: 'WINDOWS_COMPILER_MISSING' });
  const runtime = await run({ platform: 'win32', windows: { ...f.windows, warn: text => warnings.push(text) } });
  await runtime.hostReady; assert.equal(runtime.hostStatus, 'WINDOWS_COMPILER_MISSING');
  assert.match(warnings[0], /WINDOWS_COMPILER_MISSING/);
  f.input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  assert.deepEqual(f.replies.find(r => r.id === 2).result, {}); await runtime.close();
});

test('cursor host receives only validated projected frames, with no made-up geometry', async () => {
  const f = fixture(), frames = [];
  f.child.stdin.on('data', bytes => frames.push(JSON.parse(bytes)));
  const runtime = await run({ platform: 'win32', windows: f.windows }); await runtime.hostReady;
  const input = { call: 'a'.repeat(32), index: 0, kind: 'click', phase: 'aim', source: 'turbo', timing: 'confirmed' };
  runtime.cursor.action({ ...input, phase: 'skipped', reason: 'no-geometry' });
  assert.equal(frames.filter(f => f.hand === 'aim').length, 0);
  runtime.cursor.action({ ...input, point: [-1200, 450], window: { id: 7, pid: 42, app: 'chrome.exe', exposure: 'exposed' } });
  runtime.cursor.status('done');
  assert.deepEqual(frames.find(f => f.hand === 'aim').at, [-1200, 450]);
  assert.ok(frames.some(f => f.hand === 'status' && f.state === 'done'));
  const sequenced = frames.filter(f => f.seq);
  assert.deepEqual(sequenced.map(f => f.seq), [1, 2]);
  assert.ok(sequenced.every(f => /^[a-f0-9]{64}$/.test(f.nonce)));
  await runtime.close(); assert.equal(frames.at(-1).hand, 'hide');
});

test('Windows MCP recovers after malformed lines and bounds incomplete input', async () => {
  const f = fixture(); const runtime = await run({ platform: 'win32', windows: f.windows }); await runtime.hostReady;
  f.input.write('not JSON\r\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  assert.equal(f.replies[0].error.code, -32700); assert.deepEqual(f.replies[1].result, {});
  f.input.write('x'.repeat(1048577)); await runtime.close(); assert.equal(f.child.exitCode, 0);
});

test('Windows doctor succeeds for a built host and found compiler/browser, without compiling', async () => {
  const f = fixture(), lines = [];
  assert.equal(await doctor({ platform: 'win32', windows: { ...f.windows, hostBuilt: () => true }, log: text => lines.push(text) }), 0);
  assert.ok(lines.includes('host      built')); assert.equal(f.calls.includes('spawn'), false);
});

test('Windows CLI routes doctor and startup, refusing native subcommands before any Mac dispatch', async () => {
  const { windowsCommand } = await import('../plugins/sleight/lib/windows-launch.mjs');
  const calls = [], out = [];
  const options = { start: async () => { calls.push('start'); return 0; }, diagnose: async () => { calls.push('doctor'); return 1; }, error: text => out.push(text) };
  assert.equal(await windowsCommand([], options), 0);
  assert.equal(await windowsCommand(['--doctor'], options), 1);
  for (const args of [['js', 'code'], ['setup'], ['--socket-relay'], ['--doctor', 'Notepad']]) assert.equal(await windowsCommand(args, options), 1);
  assert.deepEqual(calls, ['start', 'doctor']); assert.equal(out.length, 4);
  assert.match(out.at(-1), /Unsupported Windows option: --doctor Notepad/);
  assert.equal(await windowsCommand(['--version'], options), 1);
  assert.match(out.at(-1), /Unsupported Windows option: --version/);
});

for (const allowed of [true, false]) test(`Windows hand settings stream follows the native inspector (${allowed})`, t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'win-hand-setting-'))));
  const path = join(root, 'hand.json');
  writeFileSync(path, JSON.stringify({ version: 1, enabled: true, stream: true, capture: 'visible', style: 'seam' }), { mode: 0o600 });
  for (const env of [{}, { SLEIGHT_HAND: '0' }]) {
    const value = handSetting({ platform: 'win32', path, env,
      read: (file, uid, options) => readHandConfig(file, uid, { ...options, privateFile: () => ({ ok: allowed }) }) });
    assert.equal(value.stream === true, allowed && env.SLEIGHT_HAND !== '0');
    assert.equal(value.capture, allowed ? 'visible' : 'hidden');
    assert.equal(value.enabled, allowed && env.SLEIGHT_HAND !== '0');
  }
});

test('Windows doctor accepts an unbuilt host while the hand is off and enforces Node 24', async () => {
  const f = fixture();
  for (const [nodeVersion, code] of [['v24.0.0', 0], ['v25.0.0', 0], ['v22.20.0', 1]]) {
    const lines = [];
    assert.equal(await doctor({ platform: 'win32', log: line => lines.push(line), windows: {
      ...f.windows, setting: () => ({ enabled: false }), nodeVersion, hostBuilt: () => false,
      versionOptions: { pluginRoot: '/missing-win6r-manifest' },
    } }), code);
    assert.ok(lines.includes('host      not built'));
    assert.ok(lines.includes('hand      off (SLEIGHT_HAND=1 builds the ring host)'));
    assert.match(lines[0], /version unavailable/);
    assert.equal(lines.some(line => /requires Node 24/.test(line)), code === 1);
  }
});

test('Windows doctor reports import and query failures with their reasons', async () => {
  const f = fixture();
  for (const injected of [
    { host: undefined, loadHost: async () => { throw Error('import refused'); } },
    { host: { findWindowsCompiler: () => { throw Error('compiler query refused'); } }, hostBuilt: () => { throw Error('cache query refused'); } },
    { discovery: { browsers: async () => { throw Error('account folder refused'); } }, hostBuilt: () => true },
  ]) {
    const lines = [];
    assert.equal(await doctor({ platform: 'win32', log: line => lines.push(line), windows: { ...f.windows, ...injected } }), 1);
    assert.match(lines.join('\n'), /check failed: (import|compiler query|account folder) refused/);
    assert.doesNotMatch(lines.join('\n'), /not found/);
    if (injected.hostBuilt && !injected.discovery) assert.match(lines.join('\n'), /host\s+check failed: cache query refused/);
  }
});

test('Windows doctor imports and reports a fallback when the installed manifest is missing', () => {
  const module = new URL('../plugins/sleight/lib/windows-launch.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      if (String(file).endsWith('/.claude-plugin/plugin.json')) throw Error('manifest missing');
      return read(file, ...args);
    };
    syncBuiltinESMExports();
    const { windowsDoctor } = await import(${JSON.stringify(module)});
    const lines = [];
    assert.equal(await windowsDoctor({ log: line => lines.push(line), nodeVersion: 'v24.0.0',
      paths: { cache: 'C:\\\\Users\\\\Lane\\\\AppData\\\\Local\\\\sleight' }, setting: () => ({ enabled: false }),
      discovery: { browsers: async () => [{ installed: true, name: 'Edge' }] },
      host: { findWindowsCompiler: () => 'csc.exe', windowsHandHostBuilt: () => false },
    }), 0);
    assert.match(lines[0], /version unavailable/);
  `], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
});

test('unknown Windows tool names use an unknown-tool error', async () => {
  const f = fixture(); f.windows.setting = () => ({ enabled: false, stream: false });
  const runtime = await run({ platform: 'win32', windows: f.windows });
  try {
    for (const [id, name] of ['replay', 'session', 'missing_tool'].entries()) {
      f.input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }) + '\n');
      assert.deepEqual(f.replies.at(-1).error, { code: -32602, message: `Unknown tool: ${name}` });
    }
  } finally { await runtime.close(); }
});

test('launch.mjs main dispatch reaches Windows before any Mac settings or socket command', () => {
  const launch = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url);
  for (const args of [[], ['--doctor'], ['hand', 'on'], ['session']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === './windows-launch.mjs') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
          'export async function windowsCommand(args) { console.log(JSON.stringify(args)); return 7; }') };
        return next(specifier, context);
      } });
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(launch))}, ...${JSON.stringify(args)}];
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await import(${JSON.stringify(launch.href)});
    `], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assertChildStatus(result, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  }
});

test('unknown Windows arguments do not import the settings dispatcher', () => {
  const module = new URL('../plugins/sleight/lib/windows-launch.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.endsWith('windows-settings.mjs')) throw Error('settings import forbidden for unknown arguments');
      return next(specifier, context);
    } });
    const { windowsCommand } = await import(${JSON.stringify(module)});
    for (const args of [['--version'], ['session'], ['stream', 'on']]) {
      if (await windowsCommand(args, { error: () => {} }) !== 1) throw Error('wrong result');
    }
  `], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
});

test('Windows doctor needs a compiler and built host only while the hand is on', async () => {
  const f = fixture();
  for (const [enabled, code] of [[false, 0], [true, 1]]) {
    assert.equal(await doctor({ platform: 'win32', log: () => {}, windows: { ...f.windows,
      host: { findWindowsCompiler: () => undefined }, hostBuilt: () => false, setting: () => ({ enabled }),
    } }), code);
  }
});


test('session close cancels settings startup before awaiting host readiness', async () => {
  const f = fixture(); let cancel;
  f.windows.setting.ready = () => new Promise(resolve => { cancel = resolve; });
  let closes = 0;
  f.windows.setting.close = async () => { closes++; cancel(); };
  const runtime = await run({ platform: 'win32', windows: f.windows });
  await tick();
  const closing = runtime.close(); await tick();
  assert.equal(closes, 1, 'close must cancel the 20-second settings startup immediately');
  await closing;
  assert.equal(f.calls.some(c => c[0] === 'prepare'), false);
});
