// Small live experiment, separate from run.mjs. The shell runner owns the lock.
// Never targets ChatGPT. Only benchmark apps receive approval.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { resolveServer, doctor } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { BENCH_APPS } from './tasks.mjs';
import { requirePendingKill, killHelper, requireIdleKill } from './helper-kill-protocol.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const mode = process.argv[2];
const remaining = process.argv.includes('--remaining');
assert.ok(['smoke', 'kill'].includes(mode), 'choose smoke or kill');
const bank = await mkdtemp('/private/tmp/sleight-helper-health-');
const document = join(bank, basename(bank) + '.txt');
const output = join(root, 'docs/benchmarks', `2026-10-04-helper-${mode}-${basename(bank)}.json`);
const records = [];
const clients = new Set();
let opened = false;
let stopping = false;
const sanitize = value => JSON.stringify(value, null, 2).split(homedir()).join('~');
const record = value => {
  records.push({ at: new Date().toISOString(), ...value });
  // Write after each stage, including failures and interruptions.
  return writeFile(output, sanitize({ mode, remaining, bank, engine: resolveServer().version, records }) + '\n');
};
const texts = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = op => execute('osascript', ['-l', 'JavaScript', join(root, 'bench/input-lease-fixture.js'), op, document]);
process.once('SIGINT', () => { stopping = true; for (const c of clients) c.cancel(); });
process.once('SIGTERM', () => { stopping = true; for (const c of clients) c.cancel(); });

async function descendants(pid) {
  let children;
  try { children = (await execute('/usr/bin/pgrep', ['-P', String(pid)])).stdout.trim().split(/\s+/).map(Number); }
  catch (err) { if (err.code === 1) return []; throw err; }
  const nested = await Promise.all(children.map(descendants));
  return [...children, ...nested.flat()];
}

async function helperPids() {
  try { return (await execute('/usr/bin/pgrep', ['-x', 'SkyComputerUseService'])).stdout.trim().split(/\s+/).map(Number); }
  catch (err) { if (err.code === 1) return []; throw err; }
}

async function inspect(pids) {
  if (!pids.length) return [];
  try {
    return JSON.parse((await execute('/Users/chrismenendez/.codex/bin/codex-macos-inspect', ['process-status', ...pids.map(String)])).stdout);
  } catch (err) {
    if (err.code !== 70) throw err;
    // All observed descendants may exit before the fixed process snapshot.
    // Keep the diagnostic failure as evidence, without treating it as a wedge.
    return [{ pids, inspectionUnavailable: err.stderr?.trim() || err.message }];
  }
}

async function client(label) {
  const s = resolveServer(); assert.ok(!s.error, s.error);
  const child = spawn(s.command, s.args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...s.env } });
  let collected = false;
  const closed = new Promise(resolve => child.once('close', (code, signal) => { collected = true; resolve({ code, signal }); }));
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const pending = new Map();
  let id = 0;
  let killTimer;
  let armed;
  let killed;
  const started = Date.now();
  const cancel = () => { for (const p of pending.values()) p.reject(new Error('cancelled')); pending.clear(); };
  child.on('error', cancel);
  child.on('exit', (code, signal) => {
    for (const p of pending.values()) p.reject(new Error(`engine exited (${signal || code})`)); pending.clear();
  });
  child.stderr.setEncoding('utf8').on('data', text => records.push({ label, stderr: text }));
  const doKill = () => {
    if (stopping || !armed || killed) return;
    const receipt = { elapsedMs: Date.now() - started, pid: child.pid, target: armed.target ?? 'parent', pending: [...pending.keys()] };
    if (receipt.target === 'group') process.kill(-child.pid, 'SIGKILL');
    else if (!child.kill('SIGKILL')) return;
    killed = receipt;
    records.push({ label, event: 'SIGKILL', ...killed });
  };
  const relay = createRelay({ clientIn, clientOut, serverIn: child.stdin, serverOut: child.stdout, sessionId: label,
    ask: async message => {
      const app = /^Allow Computer Use to use "(.+)"\?$/.exec(message)?.[1];
      const action = BENCH_APPS.includes(app) ? 'accept' : 'decline';
      records.push({ label, approval: message, action });
      return action;
    },
    trace: (direction, msg) => {
      // getState inventories unrelated apps. Retain its success, not private window titles.
      if (direction === 'to-client' && msg.id === 1 && mode === 'kill') records.push({ label, direction, inventory: { isError: msg.result?.isError ?? false, error: msg.error } });
      else records.push({ label, direction, msg });
      if (armed && direction === 'to-server' && msg.result?.action === 'accept' && !killed) {
        killTimer = setTimeout(doKill, armed.delayMs);
      }
      if (armed?.afterForward && direction === 'to-server' && msg.method === 'tools/call' && msg.params?.name === 'js') {
        killTimer = setTimeout(doKill, armed.delayMs);
      }
    },
  });
  let buffer = '';
  clientOut.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (!msg.method && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    }
  });
  const send = msg => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = id++;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('request timed out')); }, 15000);
    pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
    send({ id: key, method, params });
  });
  const c = {
    child, cancel,
    read: () => c.call('let app = await cua.getApp("Calculator")'),
    call: code => request('tools/call', { name: 'js', arguments: { code, timeout_ms: 8000 } }),
    killDuring: async (code, delayMs, target, afterForward = false) => {
      armed = { delayMs, target, afterForward };
      let reply;
      try { reply = await c.call(code); } catch (err) { reply = { error: err.message }; }
      clearTimeout(killTimer); armed = undefined;
      return { reply, killed: killed ?? null, completedBeforeKill: !killed };
    },
    killIdle: target => { armed = { target }; doKill(); armed = undefined; return killed; },
    close: async () => {
      clearTimeout(killTimer); cancel();
      await Promise.race([relay.shutdown(), delay(3000)]);
      // EOF lets a surviving inner NodeREPL drain. Signal only this owned group
      // if the experiment left it behind; this is recorded as a separate effect.
      child.stdin.end();
      const gentle = setTimeout(() => {
        records.push({ label, cleanup: 'owned process group SIGTERM' });
        try { process.kill(-child.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
      }, 2500);
      const force = setTimeout(() => {
        records.push({ label, cleanup: 'owned process group SIGKILL' });
        try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
      }, 6000);
      const exit = await closed;
      clearTimeout(gentle); clearTimeout(force); relay.close(); clients.delete(c);
      await record({ label, engineCollected: collected, exit });
    },
  };
  clients.add(c);
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: label, version: '1' } });
  send({ method: 'notifications/initialized' });
  return c;
}

async function health(label) {
  const c = await client(label);
  try {
    const result = await c.read();
    const ok = !result?.isError && /Window:.*Calculator/.test(texts(result));
    await record({ label, health: ok, result });
    return ok;
  } catch (err) { await record({ label, health: false, error: err.message }); return false; }
  finally { await c.close(); }
}

async function recoverHelper(label) {
  if (stopping) throw new Error('cancelled before helper recovery');
  // Keep a reader alive: the on-demand helper can exit after its last client closes.
  const retained = await client(`${label}-retained-reader`);
  try {
    const warm = await retained.read();
    await record({ label, retainedBefore: warm });
    const before = await inspect(await helperPids());
    const expected = join(homedir(), '.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService');
    assert.equal(before.length, 1, 'refuse ambiguous helper identity');
    assert.equal(before[0].executable, expected, 'refuse any other executable');
    await record({ label, helperBefore: before });
    killHelper(before[0].pid, stopping);
    await delay(300);
    let sameReader;
    try { sameReader = await retained.read(); } catch (err) { sameReader = { error: err.message }; }
    await record({ label, retainedAfter: sameReader });
    const ok = await health(`${label}-after-helper-only-kill`);
    await record({ label, recovered: ok, helperAfter: await inspect(await helperPids()) });
    return ok;
  } finally { await retained.close(); }
}

try {
  await record({ event: 'start', platform: (await execute('/usr/bin/sw_vers')).stdout.trim(), node: process.version });
  console.log(`Evidence: ${output.split(homedir()).join('~')}`);
  if (mode === 'smoke') {
    for (let trial = 0; trial < 3; trial++) {
      assert.ok(await health(`smoke-${trial}`), 'healthy getApp failed');
      const logs = [];
      const code = await doctor({ log: line => logs.push(line) });
      await record({ trial, doctor: { code, logs } });
      assert.equal(code, 0);
    }
  } else {
    if (!await health('pre-kill-baseline')) {
      assert.ok(await recoverHelper('already-stuck-recovery'), 'Helper remains wedged. STOP. Owner must restart ChatGPT; no kill trials.');
    }
    // Recovery viability comes first, before killing an engine mid-call.
    for (let trial = 0; trial < (remaining ? 0 : 3); trial++) {
      if (stopping) throw new Error('cancelled');
      assert.ok(await recoverHelper(`helper-only-control-${trial}`), 'helper-only kill did not recover; stop');
    }
    await writeFile(document, 'sleight helper probe\n'); await fixture('open'); opened = true;
    for (const target of ['parent', 'group']) for (const phase of ['getApp', 'action', 'idle']) {
      if (remaining && target === 'parent' && phase === 'getApp') continue;
      for (let trial = 0; trial < 3; trial++) {
        if (stopping) throw new Error('cancelled');
        const label = `${target}-${phase}-${trial}`;
        console.log(`Trial: ${label}`);
        const c = await client(label);
        try {
          // The first call is one API call; warm the REPL before timing the kill.
          const initial = await c.call('await cua.getState()');
          assert.ok(!initial.isError, texts(initial));
          const ownedDescendants = await descendants(c.child.pid);
          await record({ label, ownedBeforeKill: await inspect([c.child.pid, ...ownedDescendants]) });
          let result;
          if (phase === 'getApp') result = await c.killDuring('let app = await cua.getApp("Calculator")', [0, 20, 80][trial], target);
          else {
            // Keep a native handle: a decorated read's proxy would perform an
            // extra guard read before the action we are trying to interrupt.
            const read = await c.call('let app = await globalThis.__sleightDocumentGuard.getApp("TextEdit")');
            assert.equal(windowFromText(texts(read))?.url, pathToFileURL(document).href, 'wrong TextEdit document; refuse action');
            result = phase === 'idle' ? c.killIdle(target) : await c.killDuring('await app.pressKey("super+a")', [10, 20, 30][trial], target, true);
          }
          await record({ label, result, descendantsAfterKill: await inspect(ownedDescendants) });
          if (phase !== 'idle') requirePendingKill(result);
          else requireIdleKill(result);
          // Probe before cleanup too: parent SIGKILL can leave the inner REPL alive.
          const beforeCleanup = await health(`${label}-before-cleanup`);
          await c.close();
          const afterCleanup = await health(`${label}-after-cleanup`);
          await record({ label, beforeCleanup, afterCleanup });
          if (!afterCleanup) {
            const recovered = await recoverHelper(`${label}-recovery`);
            await record({ label, wedge: true, helperOnlyRecovered: recovered });
            if (!recovered) throw new Error('Helper remains wedged. STOP. Owner must restart ChatGPT; no further live trials.');
            // Publish and stop at the first wedge even when recovery succeeds.
            throw new Error('Engine kill caused a failed read; helper-only recovery succeeded. Stop kill trials and inspect evidence.');
          }
        } finally { if (clients.has(c)) await c.close(); }
      }
    }
    assert.equal(await readFile(document, 'utf8'), 'sleight helper probe\n');
  }
  if (stopping) throw new Error('cancelled');
  await record({ verdict: 'PASS' });
} catch (err) {
  await record({ verdict: 'FAIL', error: err.message });
  console.error(err.message); process.exitCode = 1;
} finally {
  for (const c of clients) { try { await c.close(); } catch (err) { await record({ cleanupError: err.message }); process.exitCode = 1; } }
  if (opened) { try { await fixture('close'); await record({ fixtureClosed: true }); } catch (err) { await record({ fixtureCleanupError: err.message }); process.exitCode = 1; } }
  console.log(`Published: ${output.split(homedir()).join('~')}`);
}
