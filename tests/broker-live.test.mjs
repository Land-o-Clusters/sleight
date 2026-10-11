import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brokerRequest } from '../plugins/sleight/lib/lease-broker.mjs';

async function harness() {
  const module = await import('../bench/broker-live.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.runTrials, 'function', 'the live trial runner must exist');
  return module;
}

// Only the app and model are fake. Admission, expiry and stale tokens use the
// real broker in an isolated store, with a clock advanced by the trial runner.
function world(t, { duplicate = false, unsafeRefusal = false, failRelease = false, holdAt = Infinity } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-broker-live-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1000, steps = 0;
  const documents = new Map(), renewals = [], calls = [];
  const target = n => ({ appId: 'com.apple.TextEdit', title: `fixture-${n}.txt`, url: `file:///private/tmp/fixture-${n}.txt` });
  const request = r => { try { return brokerRequest(r, { directory, now: () => time }); }
    catch (error) { return { ok: false, error: error.message }; } };
  const clients = Object.fromEntries(['sleight', 'codex'].map(name => {
    let grant, renewing = true;
    return [name, {
      async act(window, marker, scope = 'window') {
        calls.push({ name, marker, scope });
        const reply = request({ operation: 'acquire', client: name, window, scope });
        if (!reply.ok) return { ok: false, reply, inputCalls: unsafeRefusal ? 1 : 0, inputEnded: true };
        grant = reply.lease; renewing = true;
        if (marker) documents.set(window.url, (documents.get(window.url) || '') + marker.repeat(duplicate ? 2 : 1));
        return { ok: true, reply, inputCalls: marker ? 1 : 0, inputEnded: true, approval: { runtime: name, accepted: true } };
      },
      async release() {
        if (failRelease) throw new Error('release unconfirmed');
        const reply = grant ? request({ operation: 'release', key: grant.key, token: grant.token }) : { ok: true };
        grant = undefined; return reply;
      },
      async renew() { const reply = request({ operation: 'renew', key: grant.key, token: grant.token });
        renewals.push({ time, name }); return reply; },
      async stopRenewal() { renewing = false; const old = { ...grant }; grant = undefined; return old; },
      async staleRelease(old) { return request({ operation: 'release', key: old.key, token: old.token }); },
      async status() { return grant ? request({ operation: 'status', key: grant.key }).lease : null; },
      async close() { if (grant && renewing) await this.release(); return { inputEnded: true }; },
    }];
  }));
  return { clients, renewals, calls, now: () => time,
    check: () => { if (++steps >= holdAt) throw new Error('sleight-hold exists'); },
    wait: async ms => { time += ms; },
    fixture: { targets: [target(1), target(2)],
      async reset(window) { documents.set(window.url, ''); },
      async read(window) { return documents.get(window.url) || ''; } },
  };
}

test('ten contention trials and ten handoffs require exact independent readback', async t => {
  const { runTrials } = await harness(), w = world(t);
  const report = await runTrials(w);
  assert.equal(report.passed, true);
  assert.equal(report.trials.filter(x => x.kind === 'contention').length, 10);
  assert.equal(report.trials.filter(x => x.kind === 'contention' && x.handoffExact).length, 10);
  assert.deepEqual(report.trials.filter(x => x.kind === 'contention').map(x => x.first),
    ['sleight', 'sleight', 'sleight', 'sleight', 'sleight', 'codex', 'codex', 'codex', 'codex', 'codex']);
  assert.equal(report.trials.find(x => x.kind === 'different-documents').passed, true);
  assert.equal(report.trials.find(x => x.kind === 'app-scope').passed, true);
});

test('Codex renews beyond 35 seconds, then expires after 31 seconds and cannot erase its successor', async t => {
  const { runTrials } = await harness(), w = world(t);
  const report = await runTrials(w), trial = report.trials.find(x => x.kind === 'renew-expire');
  assert.equal(trial.passed, true);
  assert.ok(trial.renewedForMs >= 35000);
  assert.ok(trial.withoutRenewalMs >= 31000);
  assert.equal(trial.staleRelease.ok, false);
  assert.equal(trial.successorActive, true);
  assert.equal(w.renewals.filter(x => x.name === 'codex').length, 7);
});

test('duplicate text is a failure even when both clients report success', async t => {
  const { runTrials } = await harness();
  const report = await runTrials(world(t, { duplicate: true }));
  assert.equal(report.passed, false);
  assert.equal(report.trials[0].exact, false);
  assert.equal(report.trials.filter(x => x.kind === 'contention').length, 10, 'retain every trial');
});

test('a refused client calling input fails the trial even if readback is unchanged', async t => {
  const { runTrials } = await harness();
  const report = await runTrials(world(t, { unsafeRefusal: true }));
  assert.equal(report.passed, false);
  assert.equal(report.trials[0].noRefusedInput, false);
});

test('release errors remain evidence and prevent a claimed handoff', async t => {
  const { runTrials } = await harness();
  const report = await runTrials(world(t, { failRelease: true }));
  assert.equal(report.passed, false);
  assert.match(report.trials[0].error, /release unconfirmed/);
  assert.notEqual(report.trials[0].handoffExact, true);
});

test('a new hold stops trial dispatch immediately and retains the incomplete result', async t => {
  const { runTrials } = await harness(), w = world(t, { holdAt: 3 });
  const report = await runTrials(w);
  assert.equal(report.passed, false);
  assert.match(report.error, /sleight-hold/);
  assert.ok(w.calls.length <= 2);
});

test('publishing removes grant tokens, home paths and agent transcript text', async () => {
  const { publicReport } = await harness();
  const token = 'd350bf7f-b73b-4e9f-8fd9-19f9c9eb4825';
  const output = publicReport({ grant: { token }, raw: `secret ${token}`,
    path: '/Users/example/fixture.txt', transcript: 'private owner conversation',
    trials: [{ reply: { ok: false, error: 'held by codex; 30 s remaining' } }] }, [token]);
  assert.ok(!output.includes(token));
  assert.ok(!output.includes('/Users/example'));
  assert.ok(!output.includes('private owner conversation'));
  assert.ok(output.includes('~/fixture.txt'));
  assert.ok(output.includes('30 s remaining'));
});

test('Codex evidence requires an observed target, the exact CLI command, and native input after acquisition', async () => {
  const { auditCodex } = await harness();
  const window = { appId: 'com.apple.TextEdit', title: 'fixture.txt', url: 'file:///private/tmp/fixture.txt' };
  const command = "node '/repo/lease-broker-cli.mjs' < '/tmp/request.json' > '/tmp/reply.json'";
  const read = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'computer', tool: 'js',
    arguments: { code: 'var app = await cua.getApp("com.apple.TextEdit")' },
    result: { content: [{ type: 'text', text: 'Window: "fixture.txt", App: TextEdit\nURL: file:///private/tmp/fixture.txt' }] } } };
  const acquire = { type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0 } };
  const input = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'computer', tool: 'js',
    arguments: { code: 'await app.typeText("A|")' }, result: { content: [{ type: 'text', text: 'A|' }] } } };
  const options = { window, command, marker: 'A|', reply: { ok: true }, groupClean: true };
  assert.equal(auditCodex([read, acquire, input], options).verified, true);
  assert.equal(auditCodex([read, input, acquire], options).verified, false);
  assert.equal(auditCodex([read, input], options).verified, false);
  assert.equal(auditCodex([acquire, input], options).verified, false);
  assert.equal(auditCodex([read, acquire, input], { ...options, groupClean: false }).verified, false);
  const denied = { ...acquire, item: { ...acquire.item, exit_code: 1 } };
  assert.equal(auditCodex([read, denied], { ...options, reply: { ok: false } }).verified, true);
  assert.equal(auditCodex([read, denied, input], { ...options, reply: { ok: false } }).verified, false);
  const wrapped = { ...acquire, item: { ...acquire.item, command: '/bin/zsh -lc ' + "'" + command.replaceAll("'", "'\\''") + "'" } };
  assert.equal(auditCodex([read, wrapped, input], options).verified, true);
  const wrongApp = { ...read, item: { ...read.item, result: { content: [{ type: 'text', text:
    'Window: "wrong.txt", App: TextEdit\nURL: file:///private/tmp/fixture.txt' }] } } };
  assert.equal(auditCodex([wrongApp, acquire, input], options).verified, false);
  const indirect = { ...input, item: { ...input.item, arguments: { code: 'await app["typeText"]("A|")' } } };
  assert.equal(auditCodex([read, denied, indirect], { ...options, reply: { ok: false } }).verified, false);
  assert.equal(auditCodex([read, acquire, indirect], options).verified, false);
  const inventory = { ...input, item: { ...input.item, arguments: { code: 'await cua.getState()' },
    result: { content: [{ type: 'text', text: 'private unrelated owner window and conversation' }] } } };
  const failed = auditCodex([read, denied, inventory], { ...options, reply: { ok: false } });
  assert.ok(!JSON.stringify(failed).includes('private unrelated owner window and conversation'));
});

test('unconfirmed holder input stops before a contender or the next fixture reset', async t => {
  const { runTrials } = await harness(), w = world(t);
  w.clients.sleight.act = async () => ({ ok: false, inputEnded: false, reply: { error: 'pending input' } });
  let resets = 0;
  w.fixture.reset = async () => { resets++; };
  const report = await runTrials(w);
  assert.equal(report.passed, false);
  assert.equal(resets, 1);
  assert.equal(w.calls.length, 0, 'no contender after unconfirmed holder input');
});

test('unconfirmed different-document reservation stops before selecting the other window', async t => {
  const { runTrials } = await harness(), w = world(t);
  const original = w.clients.codex.act.bind(w.clients.codex);
  w.clients.codex.act = async (window, marker, scope) => marker === ''
    ? { ok: false, inputEnded: false, reply: { error: 'pending reservation' } } : original(window, marker, scope);
  const report = await runTrials(w);
  assert.equal(report.passed, false);
  assert.equal(report.trials.length, 11);
  assert.ok(!w.calls.some(call => call.name === 'sleight' && call.marker === ''));
});

test('the stdio adapter exercises normal relay refusal and collects its fake engine', async t => {
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { baseClient } = await import('../bench/other-hosts-client.mjs');
  const bank = mkdtempSync(join(tmpdir(), 'sleight-broker-relay-test-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  writeFileSync(join(bank, 'fixture.txt'), '');
  const fixture = fileURLToPath(new URL('./fixtures/broker-live-relay.mjs', import.meta.url));
  const client = await baseClient({ command: process.execPath, args: [fixture, bank, 'normal'] });
  t.after(() => client.close());
  await client.call('js', { code: 'var app = await cua.getApp("com.apple.TextEdit")' });
  const window = { appId: 'com.apple.TextEdit', title: 'fixture.txt', url: pathToFileURL(join(bank, 'fixture.txt')).href };
  const grant = brokerRequest({ operation: 'acquire', client: 'outside holder', window }, { directory: bank }).lease;
  const denied = await client.call('js', { code: 'await app.typeText("blocked|")' });
  assert.equal(denied.isError, true);
  assert.equal(denied._meta.brokerLive.inputCalls, 0);
  brokerRequest({ operation: 'release', key: grant.key, token: grant.token }, { directory: bank });
  const allowed = await client.call('js', { code: 'await app.typeText("A|")' });
  assert.ok(!allowed.isError, JSON.stringify(allowed));
  assert.equal(allowed._meta.brokerLive.inputCalls, 1);
  assert.equal((await client.close()).code, 0);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(bank).filter(x => x.endsWith('.json')), []);
});

test('headless Codex receives the scoped rule and CLI, persists no instruction file, and releases only after collection', async t => {
  const { codexClient } = await harness();
  assert.equal(typeof codexClient, 'function', 'the actual Codex adapter must be testable');
  const bank = mkdtempSync(join(tmpdir(), 'sleight-broker-client-test-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  writeFileSync(join(bank, 'auth.json'), '{}');
  const window = { appId: 'com.apple.TextEdit', title: 'fixture.txt', url: 'file:///private/tmp/fixture.txt' };
  const broker = request => { try { return brokerRequest(request, { directory: join(bank, 'leases') }); }
    catch (error) { return { ok: false, error: error.message }; } };
  let collected = false;
  const client = await codexClient({ bank, home: bank, tokens: [], check() {}, broker,
    run: async (executable, args, options) => {
      assert.equal(executable, 'codex');
      assert.equal(options.env.CODEX_HOME, bank);
      assert.equal(args[args.indexOf('-m') + 1], 'gpt-6.1-sol');
      assert.ok(!args.includes('--disable'), 'the CLI needs shell access');
      const prompt = args.at(-1);
      assert.ok(prompt.startsWith('Before every native computer-use input, acquire the sleight broker lease for the observed bundle ID and exact window URL or title; renew every 5 s, stop on refusal, keep the token private, and release only after input has finished. Obtain app approval in this runtime separately.'));
      const command = prompt.split('\n').find(line => line.startsWith("'") && line.includes('lease-broker-cli.mjs'));
      const paths = command.match(/< '([^']+)' > '([^']+)'/);
      const reply = broker(JSON.parse(readFileSync(paths[1], 'utf8')));
      writeFileSync(paths[2], JSON.stringify(reply));
      const events = [{ type: 'thread.started', thread_id: 'fixture-thread' },
        { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js',
          arguments: { code: 'var app = await cua.getApp("com.apple.TextEdit")' },
          result: { content: [{ type: 'text', text: 'Window: "fixture.txt", App: TextEdit\nURL: file:///private/tmp/fixture.txt' }] } } },
        { type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0 } },
        { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js',
          arguments: { code: 'await app.typeText("A|")' }, result: { content: [{ type: 'text', text: 'A|' }] } } }];
      options.onStdout(events.map(JSON.stringify).join('\n') + '\n');
      collected = true;
      return { exit: { code: 0 }, groupClean: true };
    } });
  const result = await client.act(window, 'A|');
  assert.equal(result.ok, true);
  assert.equal(result.cliObserved, true);
  assert.equal(result.inputCalls, 1);
  assert.equal(collected, true);
  assert.equal((await client.close()).inputEnded, true);
  const { readdirSync } = await import('node:fs');
  assert.ok(!readdirSync(bank).includes('AGENTS.md'));
  assert.deepEqual(readdirSync(join(bank, 'leases')).filter(x => x.endsWith('.json')), []);
});

test('renewal refusal cancels the active Codex child and preserves its failed raw receipt', async t => {
  const { codexClient } = await harness();
  const bank = mkdtempSync(join(tmpdir(), 'sleight-broker-cancel-test-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  writeFileSync(join(bank, 'auth.json'), '{}');
  const window = { appId: 'com.apple.TextEdit', title: 'fixture.txt', url: 'file:///private/tmp/fixture.txt' };
  let cancelled = false;
  const client = await codexClient({ bank, home: bank, tokens: [], check() {},
    broker: async () => ({ ok: false, error: 'ownership lost' }),
    run: async (_executable, args, options) => {
      const command = args.at(-1).split('\n').find(line => line.startsWith("'") && line.includes('lease-broker-cli.mjs'));
      const responsePath = command.match(/> '([^']+)'/)[1];
      writeFileSync(responsePath, JSON.stringify({ ok: true, lease: { key: 'a'.repeat(64), token: 'private-grant' } }));
      options.onStdout(JSON.stringify({ type: 'thread.started', thread_id: 'cancel-thread' }) + '\n');
      await new Promise(resolve => options.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
      options.onStdout(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js',
        arguments: { code: 'await app.typeText("A|")' }, result: { isError: true, content: [{ type: 'text', text: 'cancelled input' }] } } }) + '\n');
      return { exit: { code: 1 }, groupClean: true, cancelled: true };
    } });
  const result = await client.act(window, 'A|');
  assert.equal(cancelled, true);
  assert.equal(result.ok, false);
  assert.equal(result.inputEnded, false);
  assert.equal(result.reply.ok, true, 'retain the CLI grant despite the failed trial');
  assert.equal(result.nativeReplies[0].isError, true);
  await assert.rejects(client.close(), /completion unconfirmed/);
});

test('disconnecting a pending relay call collects its fake engine and reports failure', async t => {
  const { fileURLToPath } = await import('node:url');
  const { baseClient } = await import('../bench/other-hosts-client.mjs');
  const bank = mkdtempSync(join(tmpdir(), 'sleight-broker-hung-test-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  writeFileSync(join(bank, 'fixture.txt'), '');
  const fixture = fileURLToPath(new URL('./fixtures/broker-live-relay.mjs', import.meta.url));
  const client = await baseClient({ command: process.execPath, args: [fixture, bank, 'hang'] }, { timeoutMs: 5000 });
  t.after(() => client.close());
  await client.call('js', { code: 'var app = await cua.getApp("com.apple.TextEdit")' });
  await assert.rejects(client.call('js', { code: 'await app.typeText("A|")' }), /timed out/);
  assert.equal((await client.close()).code, 1, 'unconfirmed input must retain the live lock');
});

test('an existing lock or hold prevents setup, and unconfirmed cleanup keeps an owned lock', async () => {
  const { withLiveLock } = await harness();
  const calls = [];
  const io = { exists: () => false, mkdir: async () => { calls.push('mkdir'); }, rmdir: async () => { calls.push('rmdir'); } };
  const work = async () => { calls.push('work'); return { cleanupConfirmed: true }; };
  await assert.rejects(withLiveLock({ ...io, exists: () => true }, work), /hold/);
  assert.deepEqual(calls, []);
  await assert.rejects(withLiveLock({ ...io, mkdir: async () => { throw new Error('EEXIST'); } }, work), /EEXIST/);
  assert.deepEqual(calls, []);
  await withLiveLock(io, work);
  assert.deepEqual(calls, ['mkdir', 'work', 'rmdir']);
  calls.length = 0;
  await withLiveLock(io, async () => ({ cleanupConfirmed: false }));
  assert.deepEqual(calls, ['mkdir']);
});
