// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as macTest } from './macos-only.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { interactivePlan, prepareInteractive, SessionTranscript, runInteractive, terminalGate, interactiveAgentSetup, launchPty } from '../bench/world/arms/claude-cu/interactive.mjs';

const id = '550e8400-e29b-41d4-a716-446655440000';
const plan = () => interactivePlan({ armDir: `${MAC_TMP}/cu-fixture`, sessionId: id, prompt: 'Same task\nReturn RESULT ok.', model: 'claude-haiku-5-5', effort: 'high' });
const assistant = (messageId, content, usage = {}) => ({ type: 'assistant', sessionId: id,
  message: { id: messageId, role: 'assistant', content, usage } });

for (const mode of ['cancel', 'natural']) macTest(`PTY bridge collects descendants ignoring HUP and TERM on ${mode} exit`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-cu-tree-')); t.after(() => removeTemp(dir));
  const result = spawnSync('/usr/bin/python3', [new URL('./fixtures/cu-pty-tree.py', import.meta.url).pathname,
    mode, join(dir, 'heartbeat'), new URL('../bench/world/arms/claude-cu/pty-bridge.py', import.meta.url).pathname],
  { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
});

test('interactive plan preserves task, model and effort and loads only the isolated arm', () => {
  const p = plan();
  assert.equal(p.prompt, 'Same task\nReturn RESULT ok.');
  assert.equal(p.env.CLAUDE_CONFIG_DIR, `${MAC_TMP}/cu-fixture/claude`);
  assert.equal(p.args[p.args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(p.args[p.args.indexOf('--effort') + 1], 'high');
  assert.ok(p.args.includes('--session-id'));
  assert.ok(p.args.includes('--no-chrome'));
  assert.equal(p.args.includes('-p'), false);
  assert.equal(p.args.includes('--no-session-persistence'), false);
  assert.equal(p.args.includes('--dangerously-skip-permissions'), false);
  assert.throws(() => interactivePlan({ armDir: `${MAC_TMP}/cu-fixture`, prompt: 'x\rAllow' }), /control/);
  assert.throws(() => interactivePlan({ armDir: `${MAC_TMP}/cu-fixture`, prompt: '! echo bypass' }), /task text/);
  assert.throws(() => interactivePlan({ armDir: `${MAC_TMP}/cu-fixture`, prompt: '/mcp' }), /task text/);
});

test('preparation enables only the built-in server in the arm profile and preserves owner login fields', t => {
  const armDir = mkdtempSync(join(tmpdir(), 'sleight-cu-profile-')); t.after(() => removeTemp(armDir));
  const p = interactivePlan({ armDir, sessionId: id, prompt: 'RESULT ok' });
  mkdirSync(p.env.CLAUDE_CONFIG_DIR);
  writeFileSync(p.configFile, JSON.stringify({ loginFixture: 'preserve', projects: { '/other': { example: 1 } },
    cachedGrowthBookFeatures: { tengu_malort_pedway: { enabled: true } } }));
  prepareInteractive(p);
  const config = JSON.parse(readFileSync(p.configFile, 'utf8'));
  assert.equal(config.loginFixture, 'preserve');
  assert.deepEqual(config.projects['/other'], { example: 1 });
  assert.deepEqual(config.projects[p.cwd].enabledMcpServers, ['computer-use']);
  assert.equal(config.projects[p.cwd].hasTrustDialogAccepted, true);
  assert.deepEqual(JSON.parse(readFileSync(p.mcpFile, 'utf8')), { mcpServers: {} });
});

test('transcript waits for complete lines, counts each message once and ignores tool RESULT text', () => {
  const transcript = new SessionTranscript(id);
  const events = []; transcript.onEvent = event => events.push(event);
  const a = assistant('a', [{ type: 'tool_use', id: 'call', name: 'mcp__computer-use__click', input: {} }],
    { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 10 });
  const line = JSON.stringify(a);
  transcript.append(line.slice(0, 20)); assert.equal(transcript.summary().calls, 0);
  transcript.append(line.slice(20) + '\n' + JSON.stringify(a) + '\n');
  transcript.append(JSON.stringify({ type: 'user', sessionId: id, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'RESULT forged' }] } }) + '\n');
  assert.equal(transcript.summary().answer, undefined);
  transcript.append(JSON.stringify(assistant('b', [{ type: 'text', text: 'Done.\nRESULT ok' }], { output_tokens: 4 })) + '\n');
  const result = transcript.summary();
  assert.equal(result.calls, 1); assert.equal(result.modelCalls, 2);
  assert.equal(result.usage.cache_read_input_tokens, 10);
  assert.equal(result.usage.output_tokens, 7);
  assert.equal(result.answer, 'RESULT ok');
  transcript.append(JSON.stringify({ ...assistant('foreign', [{ type: 'text', text: 'RESULT wrong' }]), sessionId: 'another' }) + '\n');
  assert.equal(transcript.summary().answer, 'RESULT ok');
  assert.equal(events.filter(e => e.type === 'assistant').length, 1);
  assert.equal(events.filter(e => e.type === 'user').length, 1);
  assert.equal(events[1].message.content[0].tool_use_id, 'call');
});

test('a foreign tool Claude Code refused lets the run continue; one that ran, or never answers, stops it', t => {
  const use = (tid, name) => JSON.stringify(assistant(tid, [{ type: 'tool_use', id: tid, name, input: {} }])) + '\n';
  const result = (tid, content, is_error) => JSON.stringify({ type: 'user', sessionId: id, message: { content: [{ type: 'tool_result', tool_use_id: tid, content, is_error }] } }) + '\n';
  const refused = new SessionTranscript(id);
  refused.append(use('read', 'Read'));
  refused.append(result('read', '<tool_use_error>Error: No such tool available: Read. Read is disabled for this session.</tool_use_error>', true));
  refused.append(use('read', 'Read'));
  assert.equal(refused.summary().foreignTool, false);
  const ran = new SessionTranscript(id);
  ran.append(use('bash', 'Bash')); ran.append(result('bash', 'file contents', false));
  assert.equal(ran.summary().foreignTool, true);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const silent = new SessionTranscript(id);
  silent.append(use('bash', 'Bash'));
  assert.equal(silent.summary().foreignTool, false);
  t.mock.timers.tick(2001);
  assert.equal(silent.summary().foreignTool, true);
});

test('terminal gates reject approval, trust and login prompts even beside a ready glyph', () => {
  assert.equal(terminalGate('\x1b[32m❯ \x1b[0m\n').ready, true);
  for (const text of ['Allow for this session', 'Grant Accessibility and Screen Recording', 'Do you trust the files in this folder?', 'Sign in to Claude']) {
    const gate = terminalGate(`❯\n${text}`);
    assert.equal(gate.ready, false); assert.ok(gate.blocked);
  }
  // Live 15:55Z: Claude's own closing text ("try again", "Enter to confirm" in prose) sat above the idle input box and stopped the pass.
  const idle = '⏺ I tried three times. Options: Try again with a different drag, or Enter to confirm the change yourself.\n' +
    '────────\n❯ \n────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt\n';
  assert.deepEqual(terminalGate(idle), { blocked: undefined, ready: true });
  for (const title of ['Sign in to Claude', 'Allow for this session', 'Trust this folder']) {
    assert.ok(terminalGate(`Do not sign in.\n${title}\n❯\n`, 'Do not sign in.').blocked);
  }
  assert.equal(terminalGate('Sign in to the\ndemo shop.\n❯\n', 'Sign in to the demo shop.').ready, true);
});

function fakeSession({ blocked, timeout = false, echo = '', reply = 'RESULT ok' } = {}) {
  const writes = [], transcript = new SessionTranscript(id);
  let finish, output, exitKeys = 0;
  const closed = new Promise(resolve => { finish = resolve; });
  return { writes, transcript, launch: (_p, callback) => {
    output = callback;
    queueMicrotask(() => output(blocked ? `❯\n${blocked}` : '\n❯ \n'));
    return { closed, write: text => {
      writes.push(text);
      if (text.startsWith('\x1b[200~') && !timeout) {
        transcript.append(JSON.stringify(assistant('answer', [{ type: 'text', text: reply }], { output_tokens: 3 })) + '\n');
        output(echo + '\n❯ \n');
      }
      if (text === '/exit\r' || text === '\x04\x04' || text === '\x04' && ++exitKeys === 2) finish({ code: 0, clean: true });
    }, stop: async () => { finish({ code: 130, clean: true }); } };
  } };
}

test('fake interactive session sends the exact task once and exits after a transcript RESULT', async () => {
  const h = fakeSession(), p = plan();
  const result = await runInteractive(p, { prepare() {}, verify() {}, serverReady: () => true, launch: h.launch, transcript: h.transcript, turnEnded: () => true, pollMs: 1 });
  assert.deepEqual(h.writes, ['\x1b[200~' + p.prompt + '\x1b[201~\r', '\x04', '\x04']);
  assert.equal(result.result, 'RESULT ok'); assert.equal(result.is_error, false);
  assert.deepEqual(result.agentTiming, { start: 'ready-prompt-and-mcp-submit', end: 'result-and-idle', startupIncluded: false });
  assert.equal(result.num_turns, 1); assert.equal(result.groupClean, true);
  assert.equal(result.usage.output_tokens, 3);
});

// World task prompts ask for the number, not a RESULT line (live claude-cu run, 2026-10-17 12:54Z, waited 300 s).
test('a plain final reply ends the session once the turn has ended', async () => {
  const h = fakeSession({ reply: '**738**' }), p = { ...plan(), timeoutMs: 2000 };
  const result = await runInteractive(p, { prepare() {}, verify() {}, serverReady: () => true, launch: h.launch, transcript: h.transcript, turnEnded: () => true, pollMs: 1 });
  assert.equal(result.is_error, false, result.reason); assert.equal(result.timedOut, false);
  assert.equal(result.result, '**738**');
});

// The prompt went out 0.61 s after start, before the in-process computer-use server connected, so the model saw no tools.
test('the task waits for the computer-use server to connect and fails clearly when it never does', async () => {
  let ready = false;
  const h = fakeSession(), p = plan();
  setTimeout(() => { ready = true; }, 30);
  const waited = await runInteractive(p, { prepare() {}, verify() {}, serverReady: () => ready, launch: h.launch, transcript: h.transcript, turnEnded: () => true, pollMs: 1 });
  assert.equal(waited.is_error, false, waited.reason);
  const never = fakeSession();
  const failed = await runInteractive(plan(), { prepare() {}, verify() {}, serverReady: () => false, connectMs: 20, launch: never.launch, transcript: never.transcript, turnEnded: () => true, pollMs: 1 });
  assert.equal(failed.is_error, true); assert.equal(failed.reason, 'computer-use server did not connect');
  assert.equal(never.writes.some(w => w.startsWith('\x1b[200~')), false, 'no task text before the server connects');
});

// With tool search off, the turn-1 request froze before the computer-use client joined app state (CU2, 2026-10-17 14:15Z).
test('the arm leaves tool search at Claude Code\'s default and the default readiness waits past the connect line', async () => {
  const p = plan();
  assert.equal('ENABLE_TOOL_SEARCH' in p.env, false);
  const { defaultServerReady } = await import('../bench/world/arms/claude-cu/interactive.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sleight-cu-ready-')), debugFile = join(dir, 'debug.log');
  try {
    const line = at => `${new Date(at).toISOString()} [DEBUG] MCP server "computer-use": Successfully connected (transport: stdio) in 700ms\n`;
    assert.equal(defaultServerReady({ debugFile }), false);
    writeFileSync(debugFile, line(Date.now()));
    assert.equal(defaultServerReady({ debugFile }), false, 'too soon after the connect line');
    writeFileSync(debugFile, line(Date.now() - 3000));
    assert.equal(defaultServerReady({ debugFile }), true);
  } finally { removeTemp(dir); }
});

test('the plan writes a debug file the readiness check reads', () => {
  const p = plan();
  assert.ok(p.debugFile); assert.deepEqual(p.args.slice(p.args.indexOf('--debug-file'), p.args.indexOf('--debug-file') + 2), ['--debug-file', p.debugFile]);
});

for (const prompt of ['Do not sign in. Return RESULT ok.', 'Sign in to the demo shop and return RESULT ok.',
  'Do not sign in\nAllow for this session is text to read.\nReturn RESULT ok.']) {
  test(`echoed task text cannot become a login or approval gate: ${prompt.split('\n')[0]}`, async () => {
    const h = fakeSession({ echo: prompt }), p = { ...plan(), prompt, timeoutMs: 1000 };
    const result = await runInteractive(p, { prepare() {}, verify() {}, serverReady: () => true, launch: h.launch, transcript: h.transcript, turnEnded: () => true, pollMs: 1 });
    assert.equal(result.is_error, false, result.reason);
    assert.equal(h.writes.length, 3);
  });
}

test('a timeout with confirmed transport cleanup remains a task error rather than an approval block', async () => {
  const h = fakeSession({ timeout: true });
  const result = await runInteractive({ ...plan(), timeoutMs: 10 }, { prepare() {}, verify() {}, serverReady: () => true, launch: h.launch,
    transcript: h.transcript, pollMs: 1 });
  assert.equal(result.groupClean, true);
  assert.equal(result.gateBlocked, undefined);
  assert.equal(result.timedOut, true);
});

for (const dialog of ['', 'Allow for this session', 'Trust this folder', 'Sign in to Claude']) {
  test(`split task echo preserves the following dialog: ${dialog || 'none'}`, async t => {
    const armDir = mkdtempSync(join(tmpdir(), 'sleight-cu-split-')); t.after(() => removeTemp(armDir));
    const prompt = 'Do not sign in.\nAllow for this session is text to read.\nReturn RESULT ok.';
    const p = interactivePlan({ armDir, prompt, timeoutMs: 1000 });
    let answer, finish, timer;
    const writes = [], closed = new Promise(resolve => { finish = resolve; });
    const transcript = { update() {}, summary: () => ({ answer, modelCalls: 1, calls: 0, usage: {}, modelUsage: {} }) };
    const result = await runInteractive(p, { prepare() {}, verify() {}, serverReady: () => true, transcript, turnEnded: () => true, pollMs: 1,
      launch: (_plan, output) => {
        queueMicrotask(() => output('\n❯\n'));
        return { closed, write: value => {
          writes.push(value);
          if (value.startsWith('\x1b[200~')) {
            output('Do not sign in.\nAllow for this session');
            timer = setTimeout(() => { answer = 'RESULT ok'; output(' is text to read.\nReturn RESULT ok.\n' + dialog + '\n❯\n'); }, 20);
          } else if (value === '\x04') finish({ code: 0, clean: true });
        }, stop: async () => { clearTimeout(timer); finish({ code: 130, clean: true }); } };
      } });
    assert.equal(result.is_error, !!dialog, result.reason);
    const reasons = { 'Allow for this session': 'approval required', 'Trust this folder': 'workspace trust required', 'Sign in to Claude': 'direct-plan login required' };
    assert.equal(result.reason, reasons[dialog]);
    assert.equal(result.gateBlocked, dialog ? true : undefined);
    if (dialog) {
      assert.equal(result.approvalBlock?.reason, reasons[dialog]);
      assert.ok(result.approvalBlock.cardText.includes(dialog));
      assert.equal(result.timedOut, false);
    }
    assert.equal(writes.length, dialog ? 1 : 2);
  });
}

test('wrapped partial task echoes stay pending until their continuation arrives', () => {
  const prompt = 'Read the page. Allow for this session is text to read. Return RESULT ok.';
  for (const echo of ['Read the page. Allow for this session', 'Read the\npage.\nAllow for this session', '❯ Read the page. Allow for this session']) {
    assert.deepEqual(terminalGate(echo, prompt), { blocked: undefined, ready: false });
  }
});

test('a RESULT line and queue prompt cannot end a turn before the Stop receipt', async () => {
  const h = fakeSession();
  const result = await runInteractive({ ...plan(), timeoutMs: 10 }, { prepare() {}, verify() {}, serverReady: () => true, launch: h.launch,
    transcript: h.transcript, turnEnded: () => false, pollMs: 1 });
  assert.equal(result.is_error, true);
  assert.equal(result.timedOut, true);
  assert.equal(h.writes.length, 1);
});

test('approval and timeout paths send no acceptance, prompt replay or exit command into a card', async () => {
  const blocked = fakeSession({ blocked: 'Allow for this session' });
  const result = await runInteractive(plan(), { prepare() {}, verify() {}, serverReady: () => true, launch: blocked.launch, transcript: blocked.transcript, pollMs: 1 });
  assert.equal(result.is_error, true); assert.equal(result.reason, 'approval required');
  assert.equal(result.approvalBlock?.reason, 'approval required');
  assert.equal(result.timedOut, false);
  assert.deepEqual(blocked.writes, []);
  const timeout = fakeSession({ timeout: true });
  const stopped = await runInteractive({ ...plan(), timeoutMs: 10 }, { prepare() {}, verify() {}, serverReady: () => true, launch: timeout.launch, transcript: timeout.transcript, pollMs: 1 });
  assert.equal(stopped.timedOut, true); assert.equal(timeout.writes.length, 1);
  assert.equal(timeout.writes.includes('/exit\r'), false);
});

test('dry execution creates nothing and starts no executable', async () => {
  const p = interactivePlan({ armDir: `${MAC_TMP}/absent-cu-arm-for-dry`, prompt: 'RESULT ok' });
  const before = existsSync(p.armDir);
  const result = await runInteractive(p, { dryRun: true, prepare: () => assert.fail('dry preparation'), verify: () => assert.fail('dry version'), launch: () => assert.fail('dry launch') });
  assert.equal(result.dryRun, true); assert.equal(existsSync(p.armDir), before);
});

test('a reused session transcript refuses before launching another task', t => {
  const armDir = mkdtempSync(join(tmpdir(), 'sleight-cu-stale-')); t.after(() => removeTemp(armDir));
  const p = interactivePlan({ armDir, sessionId: id, prompt: 'RESULT new' });
  const project = join(p.env.CLAUDE_CONFIG_DIR, 'projects', 'work');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, id + '.jsonl'), JSON.stringify(assistant('old', [{ type: 'text', text: 'RESULT stale' }])) + '\n');
  assert.throws(() => prepareInteractive(p), /session.*exists/);
});

test('transcript tailing preserves UTF-8 split across its read buffer', t => {
  const armDir = mkdtempSync(join(tmpdir(), 'sleight-cu-unicode-')); t.after(() => removeTemp(armDir));
  const p = interactivePlan({ armDir, sessionId: id, prompt: 'RESULT café' });
  const project = join(p.env.CLAUDE_CONFIG_DIR, 'projects', 'work'); mkdirSync(project, { recursive: true });
  let count = 65000, line;
  do { line = JSON.stringify(assistant('a', [{ type: 'text', text: 'x'.repeat(count++) + '\nRESULT caf😀é' }])) + '\n'; }
  while ((Buffer.from(line)[65536] & 0xc0) !== 0x80);
  writeFileSync(join(project, id + '.jsonl'), line);
  const transcript = new SessionTranscript(id); transcript.update(p);
  assert.equal(transcript.summary().answer, 'RESULT caf😀é');
  assert.equal(transcript.pending, '');
});

test('already cancelled runs start no preparation, CLI or PTY', async () => {
  const signal = AbortSignal.abort();
  const result = await runInteractive(plan(), { signal, prepare: () => assert.fail('cancelled setup'),
    verify: () => assert.fail('cancelled version'), launch: () => assert.fail('cancelled PTY') });
  assert.equal(result.is_error, true); assert.equal(result.reason, 'cancelled');
});

test('round adapter carries the original task and budget into the interactive arm', () => {
  const setup = interactiveAgentSetup({ dir: `${MAC_TMP}/cu-run`, prompt: 'RESULT original', model: 'claude-opus-5-5', effort: 'high',
    task: { budgetSeconds: 45 }, armDir: `${MAC_TMP}/cu-fixture` });
  assert.equal(setup.command, process.execPath);
  assert.equal(setup.args[setup.args.indexOf('--prompt') + 1], 'RESULT original');
  assert.equal(setup.args[setup.args.indexOf('--timeout-ms') + 1], '45000');
  assert.equal(setup.args[setup.args.indexOf('--work-dir') + 1], `${MAC_TMP}/cu-run`);
  assert.equal(setup.args.includes('-p'), false);
  const api = interactiveAgentSetup({ dir: `${MAC_TMP}/cu-run`, prompt: 'RESULT original',
    hostEnv: { ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_AUTH_TOKEN: 'fixture-token' } });
  assert.equal(api.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(api.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

macTest('script PTY runs a fake Claude with TTY input and derives its result from JSONL', async t => {
  const armDir = mkdtempSync(join(tmpdir(), 'sleight-cu-pty-')); t.after(() => removeTemp(armDir));
  const command = join(armDir, 'fake-claude');
  writeFileSync(command, `#!${process.execPath}\n` + `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2), id = args[args.indexOf('--session-id') + 1];
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake'); fs.mkdirSync(dir, { recursive: true });
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(90);
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
let input = '';
process.stdin.on('data', data => {
 input += data;
 if (input.includes('/exit\\r') || input.includes('\\x04\\x04')) { process.stdin.setRawMode(false); process.exit(0); }
 if (input.includes('\\x1b[201~\\r')) {
  const prompt = input.slice(input.indexOf('\\x1b[200~') + 6, input.indexOf('\\x1b[201~'));
  fs.writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ type: 'assistant', sessionId: id,
   message: { id: 'fake-answer', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'RESULT ' + crypto.createHash('sha256').update(prompt).digest('hex') }], usage: { output_tokens: 5 } } }) + '\\n');
  fs.writeFileSync(process.env.BENCH_CU_TURN_RECEIPT, JSON.stringify({ sessionId: id, nonce: process.env.BENCH_CU_NONCE }));
  input = ''; process.stdout.write('\\n❯ \\n');
 }
});
process.stdout.write('\\n❯ \\n');
`, { mode: 0o700 });
  const prompt = 'exact task ' + 'é😀'.repeat(12000);
  const p = interactivePlan({ armDir, command, sessionId: id, prompt, timeoutMs: 10000 });
  mkdirSync(p.env.CLAUDE_CONFIG_DIR);
  writeFileSync(p.configFile, JSON.stringify({ cachedGrowthBookFeatures: { tengu_malort_pedway: { enabled: true } } }));
  let terminal = '';
  const result = await runInteractive(p, { verify() {}, serverReady: () => true, pollMs: 10, launch: (plan, callback) => launchPty(plan, data => { terminal += data; callback(data); }) });
  assert.equal(result.is_error, false, JSON.stringify(result) + '\n' + terminal);
  assert.equal(result.result, 'RESULT ' + createHash('sha256').update(prompt).digest('hex'));
  assert.equal(result.modelUsage['claude-haiku-5-5'].outputTokens, 5);
  assert.equal(result.total_cost_usd, 0.0000025);
  assert.equal(result.groupClean, true);
});

for (const dialog of ['', 'Allow for this session', 'Trust this folder', 'Sign in to Claude']) {
  test(`split task echo preserves the following dialog: ${dialog || 'none'}`, async t => {
    const armDir = mkdtempSync(join(tmpdir(), 'sleight-cu-split-')); t.after(() => removeTemp(armDir));
    const prompt = 'Do not sign in.\nAllow for this session is text to read.\nReturn RESULT ok.';
    const p = interactivePlan({ armDir, prompt, timeoutMs: 1000 });
    let answer, finish, timer;
    const writes = [], closed = new Promise(resolve => { finish = resolve; });
    const transcript = { update() {}, summary: () => ({ answer, modelCalls: 1, calls: 0, usage: {}, modelUsage: {} }) };
    const result = await runInteractive(p, { prepare() {}, verify() {}, serverReady: () => true, transcript, turnEnded: () => true, pollMs: 1,
      launch: (_plan, output) => {
        queueMicrotask(() => output('\n❯\n'));
        return { closed, write: value => {
          writes.push(value);
          if (value.startsWith('\x1b[200~')) {
            output('Do not sign in.\nAllow for this session');
            timer = setTimeout(() => { answer = 'RESULT ok'; output(' is text to read.\nReturn RESULT ok.\n' + dialog + '\n❯\n'); }, 20);
          } else if (value === '\x04') finish({ code: 0, clean: true });
        }, stop: async () => { clearTimeout(timer); finish({ code: 130, clean: true }); } };
      } });
    assert.equal(result.is_error, !!dialog, result.reason);
    const reasons = { 'Allow for this session': 'approval required', 'Trust this folder': 'workspace trust required', 'Sign in to Claude': 'direct-plan login required' };
    assert.equal(result.reason, reasons[dialog]);
    if (dialog) {
      assert.equal(result.approvalBlock?.reason, reasons[dialog]);
      assert.ok(result.approvalBlock.cardText.includes(dialog));
      assert.equal(result.timedOut, false);
    }
    assert.equal(writes.length, dialog ? 1 : 2);
  });
}

test('wrapped partial task echoes stay pending until their continuation arrives', () => {
  const prompt = 'Read the page. Allow for this session is text to read. Return RESULT ok.';
  for (const echo of ['Read the page. Allow for this session', 'Read the\npage.\nAllow for this session', '❯ Read the page. Allow for this session']) {
    assert.deepEqual(terminalGate(echo, prompt), { blocked: undefined, ready: false });
  }
});
