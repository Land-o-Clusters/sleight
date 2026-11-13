import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { windowsWorkerArguments } from '../plugins/sleight/lib/windows-repl/client.mjs';
import { windowsReplFixture as fixture } from './fixtures/windows-repl-client.mjs';

const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

test('fresh context contains only ECMAScript intrinsics and six sleight globals', { skip: windowsWorkerSkip }, async t => {
  const { js } = fixture(t);
  await js('void 0'); // Consume first-call docs.
  const globals = JSON.parse(text(await js('nodeRepl.write(Object.getOwnPropertyNames(globalThis).sort())')));
  const expected = [...new Set([...runInNewContext('Object.getOwnPropertyNames(globalThis)'),
    'cua', 'nodeRepl', 'sleight', 'console', 'setTimeout', 'clearTimeout'])].sort();
  assert.deepEqual(globals, expected);
  assert.deepEqual(JSON.parse(text(await js('nodeRepl.write(Object.keys(globalThis).sort())'))),
    ['clearTimeout', 'console', 'cua', 'nodeRepl', 'setTimeout', 'sleight']);
  for (const code of ['await import("node:fs")', 'await import /* comment */ ("node:timers")',
    `await eval('import("node:os")')`, `await Function('return import("node:net")')()`,
    `await cua.constructor.constructor('return import("node:os")')()`]) {
    const result = await js(code);
    assert.equal(result.isError, true, code);
    assert.match(text(result), /REPL_IMPORT_DISABLED|ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/, code);
  }
});

test('runtime without network permissions refuses before generating worker arguments', () => {
  assert.throws(() => windowsWorkerArguments(new Set(['--permission'])), /REPL_NODE_UNSUPPORTED/);
  assert.throws(() => windowsWorkerArguments(new Set()), /REPL_NODE_UNSUPPORTED/);
});

const escapes = [
  ['cua constructor', 'cua.constructor.constructor("return process")()'],
  ['console function', 'console.log.constructor("return process")()'],
  ['writer function', 'nodeRepl.write.constructor("return process")()'],
  ['timer function', 'setTimeout.constructor("return process")()'],
  ['sleight constructor', 'sleight.constructor.constructor("return process")()'],
  ['prototype walk', 'Object.getPrototypeOf(Object.getPrototypeOf(cua.getState)).constructor("return process")()'],
  ['driver error constructor', '(await cua.getApp("Absent").catch(e => e)).constructor.constructor("return process")()'],
];
for (const [name, expression] of escapes) test(`${name} escapes still deny filesystem, spawn and network`, { skip: windowsWorkerSkip }, async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-repl-isolation-')));
  t.after(() => removeTemp(root));
  const sentinel = join(root, 'sentinel.txt'), output = join(root, 'denied.txt');
  writeFileSync(sentinel, 'lane fixture');
  const { js } = fixture(t);
  // Realm escape is expected. Exercise the OS-resource checks through the actual
  // host process, not a deleted name or a missing test file.
  const result = await js(`await (async () => {
    const host = ${expression};
    const denied = [];
    const attempt = async fn => { try { await fn(); denied.push("ALLOWED"); }
      catch (e) { denied.push(e.code ?? e.cause?.code); } };
    await attempt(() => host.getBuiltinModule("fs").readFileSync(${JSON.stringify(sentinel)}));
    await attempt(() => host.getBuiltinModule("fs").writeFileSync(${JSON.stringify(output)}, "denied"));
    await attempt(() => host.getBuiltinModule("child_process").spawn(host.execPath, ["--version"]));
    await attempt(() => new (host.getBuiltinModule("worker_threads").Worker)("", {eval:true}));
    await attempt(() => new Promise((resolve, reject) => {
      const socket = host.getBuiltinModule("net").connect({host:"127.0.0.1", port:12345});
      socket.once("error", reject); socket.once("connect", () => { socket.destroy(); resolve(); });
    }));
    await attempt(() => host.constructor.constructor("return fetch")()("http://127.0.0.1:12345"));
    nodeRepl.write({version:host.version, denied});
  })()`);
  assert.equal(result.isError, false, text(result));
  const actual = JSON.parse(result.content.at(-1).text);
  assert.equal(actual.version, process.version);
  assert.deepEqual(actual.denied, Array(6).fill('ERR_ACCESS_DENIED'));
  assert.equal(existsSync(output), false);
});

test('leftover interval, immediate and microtask names are absent and send zero later driver requests', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = fixture(t);
  for (const code of ['setInterval(() => cua.getState({emit:false}), 20)',
    'setImmediate(() => cua.getState({emit:false}))', 'queueMicrotask(() => cua.getState({emit:false}))']) {
    const result = await js(code);
    assert.equal(result.isError, true); assert.match(text(result), /is not defined/);
  }
  await js('await new Promise(resolve => setTimeout(resolve, 180))');
  assert.equal(requests.length, 0);
});

test('timeouts end with their cell and reset; awaited timeout and cancellation still work', { skip: windowsWorkerSkip }, async t => {
  const { js, repl, requests } = fixture(t);
  await js('let fired = 0; let timer = setTimeout(() => { fired++; cua.getState({emit:false}); }, 40); void 0;');
  const result = await js('await new Promise(resolve => setTimeout(resolve, 100)); nodeRepl.write([fired, typeof timer, typeof timer.refresh]);');
  assert.match(text(result), /\[0,"number","undefined"\]/);
  assert.equal(requests.length, 0);
  assert.equal((await js('clearTimeout(setTimeout(() => { throw Error("cancelled") }, 20)); await new Promise(r => setTimeout(r, 60));')).isError, false);
  await js('setTimeout(() => cua.getState({emit:false}), 40); void 0;');
  await repl.reset();
  await js('await new Promise(resolve => setTimeout(resolve, 100))');
  assert.equal(requests.length, 0);
});

test('escaped timer callbacks retain their originating cell and cannot borrow another cell', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = fixture(t);
  await js(`const host = cua.constructor.constructor("return process")();
    host.getBuiltinModule("timers").setTimeout(() => {
      nodeRepl.write("stale"); cua.getState({emit:false}).catch(() => {});
    }, 60); void 0;`);
  const result = await js('await new Promise(resolve => setTimeout(resolve, 150)); nodeRepl.write("current");');
  assert.equal(text(result), 'current'); assert.equal(requests.length, 0);
});

test('escaped intervals and immediates are cancelled when their cell ends', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = fixture(t);
  const scheduled = await js(`const timers = cua.constructor.constructor("return process")().getBuiltinModule("timers");
    let late = 0;
    const callback = () => { late++; cua.getState({emit:false}).catch(() => {}); };
    timers.setInterval(callback, 20); timers.setImmediate(callback); void 0;`);
  assert.equal(scheduled.isError, false, text(scheduled));
  await js('await new Promise(resolve => setTimeout(resolve, 160));');
  assert.equal(text(await js('late')), '0'); assert.equal(requests.length, 0);
});

test('a promise continuation from a finished cell cannot emit or call the driver in a later cell', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = fixture(t);
  await js(`let release;
    new Promise(resolve => { release = resolve; }).then(() => {
      nodeRepl.write("stale"); cua.getState({emit:false}).catch(() => {});
    }); void 0;`);
  const result = await js('release(); await new Promise(resolve => setTimeout(resolve, 50)); nodeRepl.write("current");');
  assert.equal(text(result), 'current'); assert.equal(requests.length, 0);
});

test('console info, warn, debug, dir and table collect output like log', { skip: windowsWorkerSkip }, async t => {
  const { js } = fixture(t);
  await js('void 0');
  const result = await js('console.info("info", 1); console.warn("warn", 2); console.debug("debug"); console.dir({x:3}); console.table([{x:4}]);');
  assert.equal(result.isError, false, text(result));
  assert.equal(result.content.length, 5);
  assert.match(text(result), /info 1\nwarn 2\ndebug\n.*x: 3.*\n.*x: 4/);
});

test('reset hard-kills its own SIGTERM-resistant child after the two-second deadline', { skip: windowsWorkerSkip || (process.platform === 'win32' && 'SIGTERM resistance requires POSIX signals') }, async t => {
  const { repl, js, workers } = fixture(t);
  await js('cua.constructor.constructor("return process")().on("SIGTERM", () => {}); void 0;');
  await repl.reset();
  assert.equal(workers[0].signalCode, 'SIGKILL');
  assert.equal((await js('1')).isError, false);
});

test('escaped process cannot signal a same-user pid through public or native entry points', { skip: windowsWorkerSkip }, async t => {
  const { js } = fixture(t);
  const result = await js(`await (async () => {
    const host = cua.constructor.constructor("return process")();
    const results = [];
    for (const fn of [() => host.kill(${process.pid}, 0), () => host._kill(${process.pid}, 0),
      () => { if (host._debugProcess !== host.kill) throw Error("unguarded debug signal entry point"); return host._debugProcess(${process.pid}); },
      () => host.binding("process_methods"), () => host._linkedBinding("process_methods")]) {
      try { fn(); results.push("ALLOWED"); } catch (error) { results.push(error.code); }
    }
    Reflect.set(host, "kill", () => 0);
    try { host.kill(${process.pid}, 0); results.push("ALLOWED"); } catch (error) { results.push(error.code); }
    nodeRepl.write(results);
  })()`);
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(JSON.parse(result.content.at(-1).text), Array(6).fill('ERR_ACCESS_DENIED'));
});

test('host intervals created by a stale promise are cleared before their callbacks run', { skip: windowsWorkerSkip }, async t => {
  const { js } = fixture(t);
  await js(`const host = cua.constructor.constructor("return process")();
    let releaseLate, lateTicks = 0;
    new Promise(resolve => { releaseLate = resolve; }).then(() => {
      host.getBuiltinModule("timers").setInterval(() => lateTicks++, 5);
      host.getBuiltinModule("timers").setImmediate(() => lateTicks++);
    }); void 0;`);
  const result = await js('releaseLate(); await new Promise(resolve => setTimeout(resolve, 80)); nodeRepl.write(lateTicks);');
  assert.equal(text(result), '0');
  const resources = await js('nodeRepl.write(host.getActiveResourcesInfo().filter(type => type === "Timeout"));');
  assert.equal(text(resources), '[]');
});

test('escaped os priority and process abort cannot control the relay or worker', { skip: windowsWorkerSkip }, async t => {
  const { js } = fixture(t);
  const result = await js(`const proc = cua.constructor.constructor("return process")();
    const os = proc.getBuiltinModule("os");
    const denied = [];
    for (const fn of [() => os.setPriority(proc.ppid, os.getPriority(proc.ppid)),
      () => proc.abort(), () => proc.chdir("/"), () => proc.umask(0)]) {
      try { fn(); denied.push("ALLOWED"); } catch (error) { denied.push(error.code); }
    }
    Reflect.set(os, "setPriority", () => 0);
    try { os.setPriority(proc.ppid, 0); denied.push("ALLOWED"); } catch (error) { denied.push(error.code); }
    nodeRepl.write(denied);`);
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(JSON.parse(result.content.at(-1).text), Array(5).fill('ERR_ACCESS_DENIED'));
});
