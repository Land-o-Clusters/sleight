// Two independent relays and engine processes; auto-approve only TextEdit.
// --baseline runs without the lease, before implementation. All output is retained.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const bank = await mkdtemp('/private/tmp/sleight-input-lease-');
const path = join(bank, basename(bank) + '.txt');
const baseline = process.argv.includes('--baseline');
const records = [];
const clients = [];
const platform = (await execute('/usr/bin/sw_vers')).stdout.trim();
let cancelled = false;
process.once('SIGINT', () => { cancelled = true; for (const c of clients) c.cancel(); });
const fixture = op => execute('osascript', ['-l', 'JavaScript', join(root, 'bench/input-lease-fixture.js'), op, path]);
const text = r => (r?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');

async function client(holder) {
  const s = resolveServer();
  assert.ok(!s.error, s.error);
  const child = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...s.env } });
  const stopped = new Promise(resolve => child.once('close', resolve));
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const pending = new Map();
  let id = 0;
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    child.stdin.end();
    const gentle = setTimeout(() => child.kill('SIGTERM'), 2000);
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    stopped.then(() => { clearTimeout(gentle); clearTimeout(force); });
  };
  const lease = baseline ? undefined : new (await import('../plugins/sleight/lib/input-lease.mjs')).InputLease({ directory: join(bank, 'leases'), holder });
  const relay = createRelay({ clientIn, clientOut, serverIn: child.stdin, serverOut: child.stdout,
    sessionId: holder, inputLease: lease,
    onLeaseFault: terminate,
    ask: async message => /^Allow Computer Use to use "(?:TextEdit|com\.apple\.TextEdit)"\?$/.test(message) ? 'accept' : 'decline',
    trace: (direction, msg) => records.push({ holder, direction, msg }) });
  const cancel = () => { for (const p of pending.values()) p.reject(new Error('cancelled')); pending.clear(); };
  child.on('error', cancel);
  child.on('exit', cancel);
  let buffer = '';
  clientOut.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    }
  });
  const send = msg => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = id++;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('request timed out')); }, 60000);
    pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
    send({ id: key, method, params });
  });
  let closing;
  const c = { cancel, call: (name, args) => request('tools/call', { name, arguments: args }),
    close: () => closing ||= (async () => {
      const snapshots = relay.snapshotDirectory;
      const deadline = setTimeout(terminate, 3000);
      await Promise.race([relay.shutdown(), stopped]);
      clearTimeout(deadline); terminate(); await stopped; relay.close();
      const snapshotsRemoved = !snapshots || !existsSync(snapshots);
      trials.push({ phase: 'engine-cleanup', holder, engineCollected: true, snapshots, snapshotsRemoved });
      assert.ok(snapshotsRemoved, 'session snapshots remain after engine cleanup');
    })() };
  clients.push(c);
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: holder, version: '1' } });
  send({ method: 'notifications/initialized' });
  const read = await c.call('js', { code: 'let app = await cua.getApp("TextEdit")' });
  assert.equal(windowFromText(text(read))?.url, pathToFileURL(path).href, text(read).slice(-2000));
  return c;
}

const trials = [];
let opened = false;
try {
  await writeFile(path, '');
  await fixture('open'); opened = true;
  let a = await client('lease-bench-A'), b = await client('lease-bench-B');
  for (let i = 0; i < 5; i++) {
    if (cancelled) throw new Error('cancelled');
    await a.call('turn_ended', {}); await b.call('turn_ended', {});
    await fixture('reset');
    for (const c of [a, b]) {
      const r = await c.call('js', { code: 'await app.getAXState({ disableDiffing: true })' });
      assert.equal(windowFromText(text(r))?.url, pathToFileURL(path).href);
    }
    const token = `LEASE${i}|`;
    const replies = await Promise.all([a, b].map(c => c.call('js', { code: `await app.typeText(${JSON.stringify(token)})` })));
    const after = JSON.parse((await fixture('read')).stdout).text;
    const trial = { token, replies, after, copies: after.split(token).length - 1 };
    trials.push(trial);
    if (baseline) { assert.equal(trial.copies, 2); assert.ok(replies.every(r => !r.isError)); }
    else { assert.equal(trial.copies, 1); assert.equal(replies.filter(r => r.isError && /Input lease/.test(text(r))).length, 1); }
  }
  console.log(JSON.stringify({ baseline, copies: trials.map(t => t.copies), refusals: trials.map(t => t.replies.filter(r => r.isError).length), bank }));
  if (!baseline) {
    await a.call('turn_ended', {});
    const handoff = await b.call('js', { code: 'await app.typeText("HANDOFF|")' });
    trials.push({ phase: 'turn-release', reply: handoff }); assert.ok(!handoff.isError, text(handoff));
    await b.call('turn_ended', {});
    console.log('Checking heartbeat beyond the 30 s lease expiry.');
    const started = Date.now();
    const long = a.call('js', { code: 'await new Promise(resolve => setTimeout(resolve, 35000)); await app.typeText("LONG|")', timeout_ms: 50000 });
    await new Promise(resolve => setTimeout(resolve, 31000));
    const during = await b.call('js', { code: 'await app.typeText("MUST NOT APPEAR|")' });
    assert.equal(during.isError, true); assert.match(text(during), /Input lease.*lease-bench-A/);
    const longReply = await long;
    trials.push({ phase: 'long-action', elapsedMs: Date.now() - started, during, longReply });
    assert.ok(!longReply.isError, text(longReply));
    // TextEdit may autosave after the result. Another relay's saved edits must
    // remain outside this session's review attribution, so start a fresh reader.
    await b.close(); b = await client('lease-bench-B-after-idle');
    console.log('Checking takeover after 31 s without renewal.');
    await new Promise(resolve => setTimeout(resolve, 31000));
    const expired = await b.call('js', { code: 'await app.typeText("EXPIRED|")' });
    trials.push({ phase: 'idle-expiry', reply: expired }); assert.ok(!expired.isError, text(expired));
    await a.call('turn_ended', {}); // stale owner must not erase B's lease.
    const stale = await a.call('js', { code: 'await app.typeText("MUST NOT APPEAR|")' });
    trials.push({ phase: 'stale-release', reply: stale }); assert.equal(stale.isError, true); assert.match(text(stale), /Input lease/);
    // B's edits belong to B. A fresh session snapshots their current saved file.
    await a.close(); a = await client('lease-bench-A-after-handoff');
    const beforeExit = await a.call('js', { code: 'await app.typeText("MUST NOT APPEAR|")' });
    trials.push({ phase: 'before-session-close', reply: beforeExit });
    assert.equal(beforeExit.isError, true); assert.match(text(beforeExit), /Input lease/);
    await b.close();
    const exited = await a.call('js', { code: 'await app.typeText("EXIT|")' });
    trials.push({ phase: 'session-close', reply: exited }); assert.ok(!exited.isError, text(exited));
    const after = JSON.parse((await fixture('read')).stdout).text;
    assert.equal(after, 'LEASE4|HANDOFF|LONG|EXPIRED|EXIT|');
    trials.push({ phase: 'final-text', after });
    console.log('PASS: heartbeat, idle expiry, turn release, stale-owner fencing and session close.');
  }
} catch (err) { trials.push({ error: err.message }); process.exitCode = 1; console.error(err.message); }
finally {
  for (const c of clients) { try { await c.close(); } catch (err) { trials.push({ engineCleanupError: err.message }); process.exitCode = 1; } }
  const leasesRemaining = existsSync(join(bank, 'leases')) ? readdirSync(join(bank, 'leases')).filter(f => f.endsWith('.json')).length : 0;
  trials.push({ phase: 'lease-cleanup', leasesRemaining });
  if (leasesRemaining) process.exitCode = 1;
  if (opened) { try { await fixture('close'); trials.push({ fixtureClosed: true }); } catch (err) { trials.push({ fixtureCleanupError: err.message }); process.exitCode = 1; } }
  await writeFile(join(bank, 'results.json'), JSON.stringify({ baseline, platform, node: process.version, path, trials, records }, null, 2) + '\n');
  console.log(`Evidence: ${bank}/results.json`);
}
