// Cooperative broker qualification. Importing this file never starts an engine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { InputLease, leaseKey } from '../plugins/sleight/lib/input-lease.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { baseClient } from './other-hosts-client.mjs';
import { benchmarkApproval } from './double-keys-client.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';
import { runOwned } from './preapproved-process.mjs';

const SELF = fileURLToPath(import.meta.url);
const CLI = fileURLToPath(new URL('../plugins/sleight/lib/lease-broker-cli.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./double-keys-fixture.js', import.meta.url));
const HOLD = '/tmp/sleight-hold', LOCK = '/tmp/sleight-live.lock';
const LEASES = join(homedir(), 'Library', 'Application Support', 'sleight', 'leases');
const RULE = 'Before every native computer-use input, acquire the sleight broker lease for the observed bundle ID and exact window URL or title; renew every 5 s, stop on refusal, keep the token private, and release only after input has finished. Obtain app approval in this runtime separately.';
const text = reply => (reply?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const inputCode = marker => `await app.typeText(${JSON.stringify(marker)})`;
const isInput = code => /\.(?:typeText|pressKey|click|doubleClick|drag|scroll|setValue|move|hover|paste)\s*\(/.test(code || '');
const rawReply = reply => ({ ...reply, content: reply?.content?.map(x => x.type === 'image'
  ? { type: 'image', omitted: true } : x) });

export function publicReport(report, tokens = []) {
  let output = JSON.stringify(report, (key, value) => ['token', 'transcript', 'agent_message', 'stdout', 'stderr'].includes(key)
    ? undefined : value instanceof Error ? { error: value.message } : value, 2);
  for (const token of tokens) output = output.replaceAll(token, '[private token]');
  return output.replaceAll(homedir(), '~').replace(/\/Users\/[^/\s"']+/g, '~')
    .replaceAll(userInfo().username, '[user]');
}

export async function withLiveLock(io, work) {
  if (io.exists(HOLD)) throw new Error('sleight-hold exists; no live setup');
  await io.mkdir(LOCK); // EEXIST leaves the other owner's lock untouched.
  let result;
  try {
    if (io.exists(HOLD)) { result = { cleanupConfirmed: true }; throw new Error('sleight-hold appeared before setup'); }
    result = await work();
    return result;
  } finally {
    if (result?.cleanupConfirmed === true) await io.rmdir(LOCK);
  }
}

export async function runTrials({ clients, fixture, check = () => {}, now = Date.now, wait = delay }) {
  const report = { trials: [], passed: false };
  const [window, other] = fixture.targets;
  let unsafe = false;
  const dispatch = async work => { check(); assert.ok(!unsafe, 'Input completion unconfirmed; further dispatch stopped'); return work(); };
  const act = async (name, marker, target = window, scope) => {
    try { const result = await dispatch(() => clients[name].act(target, marker, scope));
      if (result.inputEnded !== true) unsafe = true;
      return result;
    } catch (error) { unsafe = true; throw error; }
  };
  const release = name => dispatch(async () => {
    const reply = await clients[name].release(); assert.equal(reply.ok, true, 'release refused'); return reply;
  });
  const refused = result => result.ok === false && result.inputCalls === 0 && result.inputEnded === true &&
    /held by .+; \d+ s remaining/.test(result.reply?.error || text(result.reply));
  const admitted = result => result.ok === true && result.inputEnded === true && result.approval?.accepted === true;
  const trial = async (kind, work, coordinates = {}) => {
    check();
    const entry = { kind, ...coordinates, started: now(), passed: false };
    report.trials.push(entry);
    try { await work(entry); }
    catch (error) { entry.error = error.message; }
    finally {
      entry.finished = now();
      for (const name of ['sleight', 'codex']) {
        try { entry[name + 'Release'] = await release(name); }
        catch (error) { entry[name + 'ReleaseError'] = error.message; entry.passed = false; entry.unsafeStop = true; }
      }
    }
    if (entry.unsafeStop || Object.values(entry).some(value => value?.inputEnded === false)) {
      throw new Error(entry.error || entry.sleightReleaseError || entry.codexReleaseError || 'Input or release unconfirmed; further trials stopped');
    }
  };
  try {
    for (const first of ['sleight', 'codex']) for (let index = 0; index < 5; index++) {
      const second = first === 'sleight' ? 'codex' : 'sleight';
      await trial('contention', async entry => {
        await dispatch(() => fixture.reset(window));
        const a = `${first[0]}${index}A|`, b = `${second[0]}${index}B|`;
        entry.holder = await act(first, a);
        assert.ok(admitted(entry.holder), 'holder acquisition or approval unconfirmed');
        entry.contender = await act(second, b);
        entry.after = await dispatch(() => fixture.read(window));
        entry.expected = a; entry.exact = entry.after === a;
        entry.noRefusedInput = refused(entry.contender);
        assert.ok(entry.noRefusedInput, 'contender refusal or ended input unconfirmed');
        entry.release = await release(first);
        entry.handoff = await act(second, b);
        entry.handoffAfter = await dispatch(() => fixture.read(window));
        entry.handoffExpected = a + b;
        entry.handoffExact = admitted(entry.handoff) && entry.handoffAfter === a + b;
        entry.passed = entry.exact && entry.noRefusedInput && entry.handoffExact;
      }, { first, index });
    }
    await trial('different-documents', async entry => {
      for (const target of fixture.targets) await dispatch(() => fixture.reset(target));
      // Reserve without typing so neither app's selected window changes mid-input.
      entry.codex = await act('codex', '', window);
      entry.sleight = await act('sleight', '', other);
      entry.passed = admitted(entry.codex) && admitted(entry.sleight);
    });
    await trial('app-scope', async entry => {
      entry.codex = await act('codex', '', window, 'app');
      entry.sleight = await act('sleight', 'app-blocked|', other);
      entry.passed = admitted(entry.codex) && refused(entry.sleight);
    });
    await trial('renew-expire', async entry => {
      await dispatch(() => fixture.reset(window));
      entry.holder = await act('codex', 'renew|');
      assert.ok(admitted(entry.holder), 'Codex holder unconfirmed');
      const started = now(); entry.renewals = []; entry.refusals = [];
      for (let i = 0; i < 7; i++) {
        await dispatch(() => wait(5000));
        entry.renewals.push(await dispatch(() => clients.codex.renew()));
        entry.refusals.push(await act('sleight', 'blocked|'));
      }
      entry.renewedForMs = now() - started;
      const old = await dispatch(() => clients.codex.stopRenewal());
      const stopped = now();
      await dispatch(() => wait(31000));
      entry.withoutRenewalMs = now() - stopped;
      entry.successor = await act('sleight', 'successor|');
      entry.staleRelease = await dispatch(() => clients.codex.staleRelease(old));
      entry.successorActive = (await dispatch(() => clients.sleight.status()))?.active === true;
      entry.after = await dispatch(() => fixture.read(window));
      entry.expected = 'renew|successor|';
      entry.passed = entry.renewedForMs >= 35000 && entry.withoutRenewalMs >= 31000 &&
        entry.renewals.every(x => x.ok) && entry.refusals.every(refused) && admitted(entry.successor) &&
        entry.staleRelease.ok === false && entry.successorActive && entry.after === entry.expected;
    });
  } catch (error) { report.error = error.message; }
  report.passed = report.trials.length === 13 && report.trials.every(x => x.passed) && !report.error;
  report.notRun = 13 - report.trials.length;
  return report;
}

// Inspect tool events in memory. Agent prose and the rollout are never published.
export function auditCodex(events, { command, window, marker, reply, groupClean, nativeServer = 'computer' }) {
  const items = events.filter(x => x.type === 'item.completed').map(x => x.item);
  const native = item => item.type === 'mcp_tool_call' && item.tool === 'js' && item.server === nativeServer;
  const readCode = item => native(item) && /^(?:var|let|const) app = await cua\.getApp\("com\.apple\.TextEdit"\);?$/.test(item.arguments?.code || '');
  const readAt = items.findIndex(item => {
    const observed = windowFromText(text(item.result));
    return readCode(item) && !item.result?.isError && !item.error &&
      observed?.url === window.url && observed?.title === window.title && observed.app === 'TextEdit';
  });
  const exactCommand = value => value === command || ['/bin/zsh', '/bin/bash', '/bin/sh'].some(shell =>
    ['-lc', '-c'].some(flag => value === `${shell} ${flag} ${quote(command)}`));
  const acquiredAt = items.findIndex(item => item.type === 'command_execution' && exactCommand(item.command) &&
    item.exit_code === (reply?.ok ? 0 : 1));
  // Anything except the one allowed observation is conservatively an input.
  // This catches computed property access and calls through aliases too.
  const inputs = items.flatMap((item, index) => item.type === 'mcp_tool_call' && !readCode(item) ? [{ item, index }] : []);
  const commands = items.filter(item => item.type === 'command_execution');
  const inputCalls = inputs.length;
  const verified = groupClean === true && readAt >= 0 && acquiredAt > readAt && commands.length === 1 &&
    items.filter(readCode).length === 1 && !items.some(item => item.type === 'file_change') && (reply?.ok
      ? inputs.length === (marker ? 1 : 0) && inputs.every(({ item, index }) => index > acquiredAt &&
        native(item) && item.arguments.code.trim() === inputCode(marker) && !item.result?.isError && !item.error)
      : inputs.length === 0);
  return { verified, inputCalls, inputEnded: groupClean === true,
    nativeReplies: inputs.map(({ item }) => native(item) && item.arguments?.code?.trim() === inputCode(marker)
      ? rawReply(item.result) : { omitted: true, reason: 'Unexpected tool output kept out of publication', isError: !!item.result?.isError }),
    observedTarget: readAt >= 0, cliObserved: acquiredAt >= 0 };
}

async function cli(request, signal) {
  const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'], signal });
  let output = '', error = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { error += data; });
  child.stdin.on('error', () => {});
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  child.stdin.end(JSON.stringify(request));
  const code = await ended;
  const reply = JSON.parse(output);
  assert.equal(code, reply.ok ? 0 : 1, error || 'broker CLI exit mismatch');
  return reply;
}

export async function codexClient({ bank, signal, check, tokens, home = join(homedir(), '.codex-bench'), run: runProcess = runOwned, broker = cli }) {
  assert.ok(existsSync(join(home, 'auth.json')), 'Codex benchmark home needs its own login');
  let threadId, grant, timer, fault, renewing = Promise.resolve(), sequence = 0, ended = true, confirmed = true, active;
  const renew = () => renewing = renewing.then(async () => {
    if (!grant) return { ok: true };
    check();
    const reply = await broker({ operation: 'renew', key: grant.key, token: grant.token }, signal);
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  }).catch(error => { fault = error; active?.abort(error); throw error; });
  const stop = async () => { clearInterval(timer); timer = undefined; await renewing.catch(() => {}); };
  return {
    async act(window, marker, scope = 'window') {
      if (fault) throw fault;
      assert.ok(!grant, 'Codex already holds a grant');
      const requestPath = join(bank, `request-${++sequence}.json`), responsePath = join(bank, `response-${sequence}.json`);
      const label = `broker-live Codex ${bank.split('/').pop()}`;
      await writeFile(requestPath, JSON.stringify({ operation: 'acquire', client: label, window, scope }), { mode: 0o600, flag: 'wx' });
      const command = `${quote(process.execPath)} ${quote(CLI)} < ${quote(requestPath)} > ${quote(responsePath)}`;
      const prompt = `${RULE}\nThis is the owner-authorized broker trial. Only use native computer use for this owned TextEdit window: ${JSON.stringify(window)}.
First acquire TextEdit with cua.getApp("com.apple.TextEdit") in a native js tool call, read its returned URL and title, and stop if they differ from the target. Do not use getState, app lists, screenshots or other apps.
Then execute exactly this one shell command, with no wrapper, additional command or token printed:\n${command}
The CLI reads one request JSON from stdin and writes one reply JSON. A refusal exits 1. Stop immediately on refusal, with no native input. On success, ${marker ? `send exactly one native js call containing only ${inputCode(marker)}` : 'reserve only; do not call any input tool'}.
The harness watches the private reply file and renews this grant through the same CLI every 5 s while your native call or approval is pending and while this trial holds it. Keep the token out of your answer and commands. Leave the grant for the harness to release after your input and engine child have ended. Do not write or read any other file, install instructions, change approvals or run other commands. Obtain approval through this native runtime; an unanswered or declined approval is a failed trial. End your answer without quoting any transcript or UI content.`;
      const args = ['exec', ...(threadId ? ['resume'] : []), '--json', '-m', 'gpt-6.1-sol',
        '--enable', 'shell_tool',
        '-c', 'model_reasoning_effort="medium"', '-c', 'approval_policy="never"',
        '-c', 'sandbox_mode="workspace-write"', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([bank, LEASES])}`,
        '--skip-git-repo-check', ...(threadId ? [threadId] : ['-C', bank]), prompt];
      const events = [];
      let buffer = '', seenReply;
      // The lease outlives codex exec. Its only renewer is this serialized adapter.
      const poll = async () => {
        if (!seenReply && existsSync(responsePath)) {
          try { seenReply = JSON.parse(await readFile(responsePath, 'utf8')); } catch { return; }
          if (seenReply.ok) {
            grant = seenReply.lease; tokens.push(grant.token);
            timer = setInterval(() => { void renew().catch(() => {}); }, 5000);
          }
        }
      };
      let polling = Promise.resolve();
      const watcher = setInterval(() => { polling = polling.then(poll); }, 50);
      ended = false; confirmed = false; active = new AbortController();
      let run;
      try {
        run = await runProcess('codex', args, { cwd: bank, env: { ...process.env, CODEX_HOME: home },
          signal: AbortSignal.any([signal, active.signal].filter(Boolean)), timeoutMs: 180000, onStdout(data) {
            buffer += String(data);
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
              try { const event = JSON.parse(line); events.push(event);
                if (event.type === 'thread.started') threadId = event.thread_id;
              } catch {}
            }
          } });
        ended = run.groupClean === true;
      } finally { clearInterval(watcher); await polling; await poll(); }
      const reply = seenReply || { ok: false, error: 'No recorded Codex CLI reply' };
      const audit = auditCodex(events, { command, window, marker, reply, groupClean: ended, nativeServer: 'cua_repl' });
      confirmed = !!threadId && run.exit.code === 0 && !fault && audit.verified;
      return { ...audit, ok: reply.ok && confirmed, reply, threadId, inputEnded: ended && confirmed,
        failure: confirmed ? undefined : 'Codex CLI/native input evidence unconfirmed',
        exit: run.exit, timedOut: run.timedOut, cancelled: run.cancelled,
        approval: { runtime: 'codex', accepted: reply.ok && confirmed,
          evidence: marker ? 'native runtime accepted its own input call' : 'native runtime returned the observed app' } };
    },
    renew,
    async stopRenewal() { await stop(); assert.ok(ended, 'Codex input still pending'); const old = grant; grant = undefined; return old; },
    async release() {
      await stop(); assert.ok(ended && confirmed, 'Codex input completion unconfirmed');
      if (!grant) return { ok: true };
      const reply = await broker({ operation: 'release', key: grant.key, token: grant.token });
      if (reply.ok) grant = undefined;
      return reply;
    },
    staleRelease: old => broker({ operation: 'release', key: old.key, token: old.token }),
    status: async () => grant && (await broker({ operation: 'status', key: grant.key })).lease,
    async close() { await this.release(); return { inputEnded: ended && confirmed }; },
  };
}

// A private stdio adapter owns the real relay and engine. Its extra reserve RPC
// uses the very same InputLease object as ordinary sleight js calls.
export async function relayServer(label, { server = resolveServer(), directory, approve, hold = HOLD, renewMs = 5000 } = {}) {
  assert.ok(!server.error, server.error);
  const child = spawn(server.command, server.args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...server.env } });
  child.stderr.pipe(process.stderr);
  const input = new PassThrough(), output = new PassThrough();
  const lease = new InputLease({ holder: label, directory }), forwarded = new Map();
  let closed = false, stopping;
  const relay = createRelay({ clientIn: input, clientOut: output, serverIn: child.stdin, serverOut: child.stdout,
    inputLease: lease, idleTurnEndMs: 0,
    fallbackAsk: approve || (async message => (await benchmarkApproval({ message })).action),
    onLeaseFault: () => { process.exitCode = 1; void shutdown(); },
    trace(direction, msg) {
      if (direction === 'to-server' && msg.method === 'tools/call' && isInput(msg.params?.arguments?.code)) forwarded.set(msg.id, 1);
    } });
  const timer = setInterval(() => {
    try { if (existsSync(hold)) throw new Error('sleight-hold exists'); lease.renew(); }
    catch { process.exitCode = 1; void shutdown(); }
  }, renewMs);
  const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  createInterface({ input: output }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && msg.result) {
      msg.result._meta = { ...msg.result._meta, brokerLive: { inputCalls: forwarded.get(msg.id) || 0 } };
      forwarded.delete(msg.id);
    }
    send(msg);
  });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'broker-live/reserve' || msg.method === 'broker-live/status') {
      try {
        if (existsSync(hold)) throw new Error('sleight-hold exists');
        const { window, scope = 'window' } = msg.params;
        const key = msg.method.endsWith('reserve') ? lease.acquire(window, scope) : msg.params.key;
        send({ id: msg.id, result: { ok: true, lease: lease.inspect(key) } });
      } catch (error) { send({ id: msg.id, result: { ok: false, error: error.message } }); }
    } else {
      input.write(line + '\n');
    }
  });
  const stopped = new Promise(resolve => child.once('close', code => { closed = true; process.exitCode ||= code || 0; resolve(); void shutdown(); }));
  child.once('error', error => { process.stderr.write(error.message); process.exitCode = 1; input.end(); });
  function shutdown() { return stopping ||= (async () => {
    clearInterval(timer);
    const signalGroup = name => {
      if (!child.pid) return;
      try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    let drained = false;
    const gentle = setTimeout(() => { process.exitCode = 1; signalGroup('SIGTERM'); }, 3000);
    const force = setTimeout(() => { process.exitCode = 1; signalGroup('SIGKILL'); }, 5000);
    try {
      await Promise.race([relay.shutdown().then(() => { drained = true; }), stopped]);
      child.stdin.end();
      await stopped;
      // Redirected descendants can survive the leader. Collect this owned
      // engine group before allowing the adapter to report a clean disconnect.
      const alive = () => { if (!child.pid) return false;
        try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
      if (alive()) signalGroup('SIGTERM');
      for (let i = 0; i < 50 && alive(); i++) await delay(20);
      if (alive()) signalGroup('SIGKILL');
      for (let i = 0; i < 50 && alive(); i++) await delay(20);
      assert.ok(!alive(), 'owned engine group collection unconfirmed');
      if (!drained) process.exitCode = 1;
      lease.releaseChecked(); lease.close(); await relay.close(); lines.close();
    } finally { clearTimeout(gentle); clearTimeout(force); }
  })(); }
  lines.once('close', () => { if (!closed) void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

async function sleightClient({ bank, signal, check, focus }) {
  let key;
  const client = await baseClient({ command: process.execPath, args: [SELF, '--relay', `broker-live sleight ${bank.split('/').pop()}`] }, { signal });
  return {
    async act(window, marker, scope = 'window') {
      check(); await focus(window);
      const observed = await client.call('js', { code: 'var app = await cua.getApp("com.apple.TextEdit")' });
      assert.equal(windowFromText(text(observed))?.url, window.url, 'sleight selected another document');
      const reply = marker ? await client.call('js', { code: inputCode(marker) })
        : await client.request('broker-live/reserve', { window, scope });
      const ok = marker ? !reply.isError : reply.ok;
      const inputCalls = marker ? reply._meta?.brokerLive?.inputCalls ?? 0 : 0;
      if (ok) key = leaseKey(window, scope);
      const reservation = ok ? await client.request('broker-live/status', { key }) : undefined;
      return { ok, reply: rawReply(reply), reservation,
        inputCalls, inputEnded: true, approval: { runtime: 'sleight', accepted: !observed.isError && !reply.isError,
          evidence: 'TextEdit approval through the existing benchmark allowlist' } };
    },
    async release() { const reply = await client.call('turn_ended', {}); key = undefined;
      return { ok: !reply.isError, reply: rawReply(reply) }; },
    status: async () => key && (await client.request('broker-live/status', { key })).lease,
    async close() { const result = await client.close(); assert.equal(result.code, 0, 'sleight child exit unconfirmed'); return { inputEnded: true }; },
  };
}

export async function liveMain(awayWindow) {
  assert.ok(awayWindow && !awayWindow.startsWith('--'), 'Pass the owner-agreed away window');
  const report = { started: new Date().toISOString(), awayWindow, trials: [], passed: false, cleanupConfirmed: false };
  const tokens = [], controller = new AbortController();
  const interrupt = () => controller.abort(new Error('interrupted'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const check = () => { controller.signal.throwIfAborted(); if (existsSync(HOLD)) throw new Error('sleight-hold exists'); };
  try {
    await withLiveLock({ exists: existsSync, mkdir, rmdir }, async () => {
      let ctx, bank, clients = {}, watch;
      try {
        check(); bank = await mkdtemp('/private/tmp/sleight-broker-live-'); report.bank = bank;
        ctx = { dir: bank, ownerAway: true, signal: controller.signal, beforeFixtureCleanup: check };
        // A hold cancels all owned drivers and prevents further fixture actions.
        watch = setInterval(() => { if (existsSync(HOLD)) controller.abort(new Error('sleight-hold exists')); }, 100);
        const targets = [];
        for (const name of ['broker-a.txt', 'broker-b.txt']) {
          const path = join(bank, name); await writeFile(path, '', { mode: 0o600 });
          const lease = await openFixture(ctx, { app: 'TextEdit', bundle: 'com.apple.TextEdit', mode: 'document',
            target: path, token: name, refuseDialogs: true, stopOnLiveHold: true }, {
            launch: async begin => {
              // The first helper reports whether TextEdit already existed. Refuse
              // to read any of its windows when it belongs to the owner.
              if (!targets.length) assert.equal(ctx.windowLeases[0].running, false, 'TextEdit already running; leave it to its owner');
              begin(!targets.length);
              const args = ['-g', '-a', 'TextEdit', path, '--args', '-ApplePersistenceIgnoreState', 'YES',
                '-NSDocumentSaveNewDocumentsToCloud', 'NO', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO'];
              const result = await runOwned('/usr/bin/open', args, { signal: controller.signal, timeoutMs: 15000 });
              assert.ok(result.groupClean && result.exit.code === 0, 'TextEdit launch unconfirmed');
            } });
          targets.push({ appId: 'com.apple.TextEdit', title: name, url: pathToFileURL(path).href });
          assert.ok(lease.pid, 'fixture PID missing');
        }
        const fixtureOp = async (op, window) => {
          check(); const path = fileURLToPath(window.url);
          const result = await runOwned('/usr/bin/osascript', ['-l', 'JavaScript', FIXTURE, op, path], { signal: controller.signal, timeoutMs: 15000 });
          assert.ok(result.groupClean && result.exit.code === 0, 'owned fixture operation unconfirmed');
          return result.stdout;
        };
        const focus = async window => {
          check();
          const result = await runOwned('/usr/bin/open', ['-g', '-a', 'TextEdit', fileURLToPath(window.url)], { signal: controller.signal, timeoutMs: 15000 });
          assert.ok(result.groupClean && result.exit.code === 0, 'owned document selection unconfirmed');
        };
        clients.sleight = await sleightClient({ bank, signal: controller.signal, check, focus });
        clients.codex = await codexClient({ bank, signal: controller.signal, check, tokens });
        // Codex also observes the selected document before it attempts admission.
        const act = clients.codex.act.bind(clients.codex);
        clients.codex.act = async (window, ...args) => { await focus(window); return act(window, ...args); };
        Object.assign(report, await runTrials({ clients, check,
          wait: ms => delay(ms, undefined, { signal: controller.signal }),
          fixture: { targets, reset: window => fixtureOp('reset', window), read: async window => JSON.parse(await fixtureOp('read', window)).text } }));
      } catch (error) { report.error = error.message; report.passed = false; }
      finally {
        clearInterval(watch);
        report.children = await Promise.allSettled(Object.values(clients).map(client => client.close()));
        const ended = report.children.every(x => x.status === 'fulfilled' && x.value.inputEnded);
        report.inputEnded = ended;
        if (ctx && ended && !existsSync(HOLD) && !controller.signal.aborted) {
          try { await closeFixtures(ctx); report.fixtureClosed = true; }
          catch (error) { report.fixtureCloseError = error.message; }
        }
        if (ctx && !report.fixtureClosed) {
          report.helperCollection = await Promise.allSettled((ctx.windowLeases || []).map(lease => lease.dispose()));
        }
        report.fixtureDiagnostics = ctx?.fixtureDiagnostics;
        // Only inspect this run's known grants. Never delete the shared store.
        report.ownedLeaseRecords = [];
        if (bank) {
          const { readdir } = await import('node:fs/promises');
          for (const name of existsSync(LEASES) ? await readdir(LEASES) : []) if (name.endsWith('.json')) {
            const record = JSON.parse(await readFile(join(LEASES, name), 'utf8'));
            if (record.holder.includes(bank.split('/').pop())) report.ownedLeaseRecords.push({ key: name.slice(0, -5), active: record.expires > Date.now() });
          }
        }
        report.cleanupConfirmed = ended && (report.fixtureClosed === true || !ctx) && report.ownedLeaseRecords.length === 0;
        report.passed &&= report.cleanupConfirmed;
        if (report.cleanupConfirmed && bank) await rm(bank, { recursive: true });
        report.lockRetained = !report.cleanupConfirmed;
      }
      return report;
    });
  } catch (error) { report.error = error.message; report.passed = false; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  report.finished = new Date().toISOString();
  const out = fileURLToPath(new URL(`../docs/benchmarks/${report.started.slice(0, 10)}-broker-live-${randomUUID()}.json`, import.meta.url));
  await writeFile(out, publicReport(report, tokens) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(`Published ${out.replaceAll(homedir(), '~')}\n`);
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  if (process.argv[2] === '--relay') await relayServer(process.argv[3]);
  else await liveMain(process.argv[2]);
}

