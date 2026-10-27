import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { realSession, remoteLoginPlan, remotePlan, runRemoteApproval } from '../bench/remote-approval-live.mjs';
import { REMOTE_NOTICE } from '../bench/remote-approval-evidence.mjs';
import { recordTurnEnd } from '../bench/world/arms/claude-cu/turn-ended.mjs';

for (const binding of ['valid', 'foreign nonce', 'foreign session', 'missing begin', 'stale begin', 'future begin', 'wrong trace']) test(`configured RA1 Stop hook and four-turn sequence: ${binding}`, async t => {
  const home = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-ra1-turns-'))));
  const login = remoteLoginPlan({ home, env: { PATH: process.env.PATH } });
  const bank = { bank: join(home, 'bank'), token: 'RA1-owned-fixture', fixture: 'owned-note', mail: 'Mail' };
  const prompts = [], durations = [], sessions = [];
  let clock = 0;
  const io = {
    now: () => new Date('2026-10-27T03:24:14.312Z'), hold: async () => {},
    lock: async () => async () => {}, login: async () => {}, prewarm: async () => ({ status: 'ready' }),
    prepare: async () => bank, fixture: async () => {}, cleanup: async () => true,
    evidence: async () => join(home, 'evidence'), write: () => {},
    session: async (fixture, options = {}) => {
      let plan, transcript, settings, pending, finish, submittedAt, diagnosticsFile;
      const closed = new Promise(resolve => { finish = resolve; });
      const session = await realSession(fixture, { ...options, login, hold: io.hold,
        signal: new AbortController().signal, now: () => clock, presence: async () => ({ idleSeconds: 180, locked: false }),
        wait: async ms => {
          clock += ms;
          if (!pending) return;
          pending(); pending = undefined;
          // Execute the exact command written into --settings. Never invoke Claude or the MCP server.
          const command = settings.hooks.Stop[0].hooks[0].command.match(/^"([^"]+)" "([^"]+)"$/);
          assert.ok(command, 'Stop command is an executable and a script');
          const receipt = spawnSync(command[1], [command[2]], { env: plan.env, encoding: 'utf8', timeout: 5000,
            input: JSON.stringify({ session_id: plan.env.BENCH_CU_SESSION, hook_event_name: 'Stop' }) });
          assert.equal(receipt.status, 0, 'configured Stop hook must accept the temporary RA1 receipt path');
          assert.equal(statSync(plan.env.BENCH_CU_TURN_RECEIPT).mode & 0o777, 0o600);
          if (['foreign nonce', 'foreign session'].includes(binding)) {
            const file = plan.env.BENCH_CU_TURN_RECEIPT, changed = JSON.parse(readFileSync(file, 'utf8'));
            changed[binding === 'foreign nonce' ? 'nonce' : 'sessionId'] = randomUUID();
            writeFileSync(file, JSON.stringify(changed));
          }
        },
        launch: (p, output) => {
          plan = p;
          settings = JSON.parse(readFileSync(p.args[p.args.indexOf('--settings') + 1], 'utf8'));
          const mcp = JSON.parse(readFileSync(p.args[p.args.indexOf('--mcp-config') + 1], 'utf8'));
          diagnosticsFile = mcp.mcpServers['plugin:sleight:computer'].env.RA1_DIAGNOSTICS;
          assert.equal(p.args[p.args.indexOf('--setting-sources') + 1], '');
          assert.equal(p.args.includes('--strict-mcp-config'), false);
          assert.deepEqual(settings.allowedMcpServers, [{ serverName: 'plugin:sleight:computer' }]);
          assert.equal(p.env.CLAUDE_CONFIG_DIR, login.env.CLAUDE_CONFIG_DIR);
          assert.equal(JSON.parse(readFileSync(join(p.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8')).projects[p.cwd].hasTrustDialogAccepted, true);
          const project = join(p.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
          mkdirSync(project, { recursive: true });
          transcript = join(project, p.env.BENCH_CU_SESSION + '.jsonl');
          output('❯\n');
          return { closed, async stop() { finish({ clean: true }); }, write(input) {
            const text = input.slice('\x1b[200~'.length, -'\x1b[201~\r'.length);
            prompts.push(text); submittedAt = clock;
            // Old receipts must be removed before the next prompt, including the text-only yes turn.
            assert.equal(existsSync(p.env.BENCH_CU_TURN_RECEIPT), false);
            pending = () => {
              writeFileSync(diagnosticsFile, JSON.stringify({ trace: binding === 'missing begin' ? [] : [{
                direction: binding === 'wrong trace' ? 'call-received' : 'mod-turn-begin',
                t: binding === 'stale begin' ? submittedAt - 1 : binding === 'future begin' ? clock + 1 : submittedAt,
              }] }));
              const typed = text === 'allow TextEdit', first = text.startsWith(remotePlan().first);
              const blocks = [{ type: 'text', text: typed ? fixture.token : options.upfront ? 'Please reply: allow TextEdit, Mail' : 'Please reply: allow TextEdit' }];
              const rows = [];
              if (first || typed) {
                const id = randomUUID();
                rows.push({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id,
                  name: 'mcp__plugin_sleight_computer__js', input: { code: 'nodeRepl.write(await app.getAXState())' } }] } },
                { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: typed ? fixture.token : REMOTE_NOTICE }] } });
              }
              rows.push({ type: 'assistant', message: { id: randomUUID(), content: blocks, stop_reason: 'end_turn' } });
              for (const row of rows) writeFileSync(transcript, JSON.stringify({ ...row, sessionId: p.env.BENCH_CU_SESSION,
                timestamp: new Date(clock).toISOString() }) + '\n', { flag: 'a' });
              if (typed) writeFileSync(join(p.cwd, 'approvals.jsonl'), JSON.stringify({ app: 'com.apple.TextEdit' }) + '\n');
            };
          } };
        },
      });
      sessions.push(session);
      return { diagnostics: session.diagnostics, close: () => session.close(), submit: async text => {
        const result = await session.submit(text); durations.push(clock - submittedAt); return result;
      } };
    },
  };
  t.after(async () => { for (const session of sessions) await session.close(); });
  const report = await runRemoteApproval({ ownerAway: true }, io);
  if (['foreign nonce', 'foreign session'].includes(binding)) {
    assert.equal(report.error, 'Interactive Stop receipt differs');
    assert.equal(report.passed, false);
    assert.equal(prompts.length, 1, 'a foreign receipt must not advance to yes or typed approval');
    assert.equal(report.collected, true);
    return;
  }
  if (binding !== 'valid') {
    assert.equal(report.error, 'mod did not reach the server (guard, connect or mod load)');
    assert.equal(report.passed, false);
    assert.equal(prompts.length, 1, 'missing current begin receipt must not advance to yes');
    assert.equal(report.collected, true);
    return;
  }
  assert.equal(report.error, undefined);
  assert.equal(report.passed, true);
  assert.deepEqual(report.checks, { mod: true, notice: true, yes: true, typed: true, upfront: true });
  assert.equal(prompts.length, 4);
  assert.deepEqual(prompts.slice(1), ['yes', 'allow TextEdit', remotePlan().upfront]);
  assert.deepEqual(durations, [100, 100, 100, 100]);
  assert.equal(sessions.length, 2);
  assert.deepEqual(readdirSync(dirname(login.env.CLAUDE_CONFIG_DIR)).filter(name => name.startsWith('turn-')), []);
  assert.deepEqual(JSON.parse(readFileSync(join(login.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8')), {});
});

test('explicit receipt directory preserves session, nonce, exact path and symlink checks', t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-ra1-stop-'))));
  const sessionId = randomUUID(), nonce = randomUUID(), directory = join(root, 'session');
  mkdirSync(directory);
  const file = join(directory, `turn-${sessionId}.json`);
  const env = { CLAUDE_CONFIG_DIR: join(root, 'login', 'claude'), BENCH_CU_TURN_DIR: directory,
    BENCH_CU_SESSION: sessionId, BENCH_CU_NONCE: nonce, BENCH_CU_TURN_RECEIPT: file };
  assert.throws(() => recordTurnEnd({ session_id: randomUUID() }, env), /binding/);
  assert.throws(() => recordTurnEnd({ session_id: sessionId }, { ...env, BENCH_CU_NONCE: '' }), /binding/);
  assert.throws(() => recordTurnEnd({ session_id: sessionId }, { ...env, BENCH_CU_TURN_RECEIPT: join(root, 'other.json') }), /path/);
  assert.throws(() => recordTurnEnd({ session_id: sessionId }, { ...env, BENCH_CU_TURN_DIR: 'relative',
    BENCH_CU_TURN_RECEIPT: join('relative', `turn-${sessionId}.json`) }), /path/);
  assert.throws(() => recordTurnEnd({ session_id: sessionId }, { ...env, BENCH_CU_TURN_DIR: directory + '/../session' }), /path/);
  assert.equal(existsSync(file), false);
  recordTurnEnd({ session_id: sessionId }, env);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sessionId, nonce });
  // The claude-cu arm still derives its receipt directory from its own isolated login parent.
  const { BENCH_CU_TURN_DIR: _directory, ...legacy } = env;
  recordTurnEnd({ session_id: sessionId }, { ...legacy, CLAUDE_CONFIG_DIR: join(directory, 'claude') });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sessionId, nonce });
  const alias = join(root, 'alias'); symlinkSync(directory, alias);
  assert.throws(() => recordTurnEnd({ session_id: sessionId }, { ...env,
    BENCH_CU_TURN_DIR: alias, BENCH_CU_TURN_RECEIPT: join(alias, `turn-${sessionId}.json`) }), /symlink/);
});
