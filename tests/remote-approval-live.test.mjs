import { remoteGuardDecision } from '../bench/remote-approval-guard.mjs';
import * as guard from '../bench/remote-approval-guard.mjs';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as live from '../bench/remote-approval-live.mjs';
import { remotePlan, runRemoteApproval, gradeRemote } from '../bench/remote-approval-live.mjs';
import { REMOTE_NOTICE } from '../bench/remote-approval-evidence.mjs';

const TURN_END = 'mcp__plugin_sleight_computer__turn_ended';
const modCalls = [
  { sleight_turbo: { event: 'bootstrap' } },
  { sleight_turbo: { version: 1, session: 'fixture-session', nonce: 'a'.repeat(64), event: 'begin',
    turn: 'turbo-1', text: 'allow TextEdit', origin: 'composer', turbo: false } },
  { sleight_resume: true },
  ...['Stop', 'Interrupt'].flatMap(hook_event_name => [
    { hook_event_name }, { hook_event_name, sleight_stop: true },
    { hook_event_name, sleight_stats: 'fixture-turn' }, { hook_event_name, sleight_stop: true, sleight_stats: 'fixture-turn' },
  ]),
];
for (const tool_input of modCalls) test(`guard passes mod control in both modes: ${JSON.stringify(tool_input)}`, () => {
  for (const upfront of [false, true]) assert.equal(remoteGuardDecision({ tool_name: TURN_END, tool_input }, { upfront }), true);
});

for (const tool_input of [{}, { code: '1' }, { sleight_turbo: {}, code: '1' }, { sleight_turbo: {}, extra: true },
  { sleight_resume: true, app: 'Mail' }, null, [], ['sleight_stop'], 'sleight_stop', true, 1]) {
  test(`guard refuses model-shaped or malformed turn control: ${JSON.stringify(tool_input)}`, () => {
    for (const upfront of [false, true]) assert.equal(remoteGuardDecision({ tool_name: TURN_END, tool_input }, { upfront }), false);
  });
}
test('mod keys on another tool do not pass the guard', () => {
  for (const upfront of [false, true]) for (const tool_name of ['turn_ended', 'mcp__other__turn_ended', 'Bash'])
    assert.equal(remoteGuardDecision({ tool_name, tool_input: modCalls[0] }, { upfront }), false);
});

test('every mod turn_ended call stays within the guard key set, including conditional spreads', () => {
  assert.ok(guard.MOD_KEYS instanceof Set);
  assert.deepEqual([...guard.MOD_KEYS].sort(), ['sleight_turbo', 'sleight_resume', 'sleight_stop', 'sleight_stats', 'hook_event_name'].sort());
  const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('register.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let calls = 0;
  const collect = node => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) collect(property.expression);
        else {
          assert.ok(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property), 'unknown mod property');
          const name = property.name;
          assert.ok(ts.isIdentifier(name) || ts.isStringLiteral(name), 'dynamic mod key needs review');
          assert.ok(guard.MOD_KEYS.has(name.text), `guard blocks mod key ${name.text}`);
        }
      }
    } else if (ts.isParenthesizedExpression(node)) collect(node.expression);
    else if (ts.isConditionalExpression(node)) { collect(node.whenTrue); collect(node.whenFalse); }
    else assert.fail(`unknown mod argument or spread: ${node.getText(ast)}`);
  };
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'call' &&
        ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === 'turn_ended') {
      calls++; collect(node.arguments[2]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(calls >= 4, 'all current call sites were collected');
});

for (const upfront of [false, true]) test(`configured PreToolUse command passes bootstrap and begin, upfront=${upfront}`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'sleight-ra1-guard-'));
  let plan, finish, session;
  t.after(() => session?.close());
  registerTemp(t, home);
  const closed = new Promise(resolve => { finish = resolve; });
  session = await live.realSession({ bank: join(home, 'bank') }, {
    upfront, login: live.remoteLoginPlan({ home, env: { PATH: process.env.PATH } }),
    signal: new AbortController().signal, hold: async () => {}, wait: async () => {},
    launch(p, output) { plan = p; output('❯\n'); return { closed, async stop() { finish({ clean: true }); } }; },
  });
  const settings = JSON.parse(readFileSync(plan.args[plan.args.indexOf('--settings') + 1], 'utf8'));
  const hook = settings.hooks.PreToolUse[0];
  assert.equal(hook.matcher, '.*');
  const command = hook.hooks[0].command.match(/^"([^"]+)" "([^"]+)"$/);
  assert.ok(command, 'configured command is the executable and guard script');
  for (const tool_input of [modCalls[0], modCalls[1], { code: '1' }, { ...modCalls[0], extra: true }]) {
    const result = spawnSync(command[1], [command[2]], { env: plan.env, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: TURN_END, tool_input }) });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(verdict.hookEventName, 'PreToolUse');
    const allow = tool_input === modCalls[0] || tool_input === modCalls[1];
    assert.equal(verdict.permissionDecision, allow ? 'allow' : 'deny');
    if (allow) assert.equal(verdict.permissionDecisionReason, 'RA1 mod turn binding');
  }
});

test('dry-run has no live effects, fixes TextEdit, loads the mod and uses an interactive session', async () => {
  const result = await runRemoteApproval({ dryRun: true }, new Proxy({}, { get: () => () => assert.fail('dry-run touched live IO') }));
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.app, 'TextEdit');
  assert.equal(result.plan.interactive, true);
  assert.ok(result.plan.args.includes('--plugin-dir'));
  assert.ok(!result.plan.args.includes('-p'));
  assert.equal(result.plan.approvals, 'empty arm store; no persistent writes');
});

test('live requires owner-away, takes and releases only its own lock, waits on hold, and scrubs evidence', async () => {
  const order = [], written = [];
  const plan = remotePlan();
  const turns = [
    { submitAt: 50, modTurnBegin: { t: 75, direction: 'mod-turn-begin' }, firstToolAt: 100,
      noticeResult: { t: 250, text: REMOTE_NOTICE }, grants: [], complete: false },
    { submitAt: 300, modTurnBegin: { t: 300, direction: 'mod-turn-begin' }, text: 'Please reply: allow TextEdit', grants: [], complete: false },
    { submitAt: 400, modTurnBegin: { t: 400, direction: 'mod-turn-begin' }, text: 'RA1 fixture complete', grants: ['com.apple.TextEdit'], complete: true },
    { text: 'Please reply: allow TextEdit, Mail', grants: [], complete: false },
  ];
  const io = {
    hold: async () => { order.push('hold'); },
    lock: async () => { order.push('lock'); return async () => order.push('unlock'); },
    login: async () => { order.push('login'); },
    prewarm: async () => { order.push('prewarm'); return { status: 'ready' }; },
    evidence: async () => { order.push('evidence'); return '/fixture/evidence'; },
    prepare: async () => ({ fixture: 'RA1 fixture', mail: 'Mail', bank: '/fixture/bank' }),
    fixture: async () => { order.push('fixture'); },
    session: async () => ({ submit: async text => { order.push(text); return turns.shift(); }, close: async () => { order.push('close'); return { clean: true }; } }),
    cleanup: async () => { order.push('cleanup'); return true; },
    write: (path, value) => written.push({ path, value }),
    now: () => new Date('2026-10-25T01:02:03Z'),
  };
  await assert.rejects(runRemoteApproval({}, io), /owner-away/);
  const result = await runRemoteApproval({ ownerAway: true }, io);
  assert.equal(result.passed, true);
  assert.ok(order.indexOf('hold') < order.indexOf('fixture'));
  assert.ok(order.indexOf('lock') < order.indexOf('fixture'));
  assert.ok(order.indexOf('login') >= 0 && order.indexOf('login') < order.indexOf('fixture'));
  assert.ok(order.indexOf('prewarm') > order.indexOf('login') && order.indexOf('prewarm') < order.indexOf('fixture'));
  assert.ok(order.indexOf('evidence') < order.indexOf('cleanup'));
  assert.equal(result.noticeMs, 150);
  assert.ok(order.indexOf('close') < order.indexOf('cleanup'));
  assert.ok(order.indexOf('cleanup') < order.indexOf('unlock'));
  assert.ok(order.includes('yes')); assert.ok(order.includes('allow TextEdit'));
  assert.equal(written.length, 1);
  assert.equal(written[0].path, '/fixture/evidence/report.json');
  assert.equal(plan.app, 'TextEdit');
});

test('grading rejects hangs, a yes grant, missing mail app, model-only completion and a wrong typed grant', () => {
  const notice = { submitAt: 0, modTurnBegin: { t: 0, direction: 'mod-turn-begin' }, firstToolAt: 0, noticeResult: { t: 45001, text: REMOTE_NOTICE } };
  const begin = { submitAt: 1, modTurnBegin: { t: 1, direction: 'mod-turn-begin' } };
  const yes = { ...begin, grants: [] }, typed = { ...begin, grants: ['com.apple.TextEdit'], complete: true };
  assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail' }).passed, false);
  notice.noticeResult.t = 44000;
  assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail' }).passed, true);
  for (const changes of [{ yes: { ...yes, modTurnBegin: null } }, { typed: { ...typed, modTurnBegin: null } },
    { yes: { ...yes, grants: ['com.apple.TextEdit'] } }, { typed: { ...typed, grants: [], complete: true } },
    { typed: { ...typed, grants: ['com.apple.TextEdit'], complete: false } }, { upfront: { text: 'allow TextEdit' } },
    { notice: { ...notice, modTurnBegin: null } }, { notice: { ...notice, modTurnBegin: { t: -1, direction: 'mod-turn-begin' } } }]) {
    assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail', ...changes }).passed, false);
  }
});

for (const presence of [undefined, { locked: false, idleSeconds: 0 }, { locked: false, idleSeconds: 119.9 },
  { locked: false, idleSeconds: 120 }, { locked: true, idleSeconds: 0 }, { locked: false, idleSeconds: -1 }])
test(`missing mod begin receipt stops before yes with cleanup, presence=${JSON.stringify(presence)}`, async () => {
  const prompts = [];
  let closed = 0, cleaned = 0, released = 0, saved;
  const io = {
    now: () => new Date('2026-10-27T06:06:22Z'), hold: async () => {}, login: async () => {},
    lock: async () => async () => { released++; }, prewarm: async () => ({ status: 'ready' }),
    prepare: async () => ({ fixture: 'owned', mail: 'Mail' }), fixture: async () => {},
    session: async () => ({ submit: async text => {
      prompts.push(text);
      return { presence, submitAt: 0, firstToolAt: 1, noticeResult: { t: 2, text: REMOTE_NOTICE }, grants: [], complete: false };
    }, close: async () => { closed++; return { clean: true }; } }),
    evidence: async () => '/fixture/evidence', cleanup: async () => { cleaned++; return true; },
    write: (_path, report) => { saved = report; },
  };
  const report = await runRemoteApproval({ ownerAway: true }, io);
  assert.equal(report.passed, false);
  assert.match(report.error, /mod did not reach the server for notice/);
  const skip = presence?.locked === false && presence.idleSeconds >= 0 && presence.idleSeconds < 120;
  if (skip) { assert.match(report.error, /person-present skip possible with turbo off/); assert.doesNotMatch(report.error, /guard, connect or mod load/); }
  else assert.match(report.error, /guard, connect or mod load; check for a presence change since submit/);
  assert.equal(prompts.length, 1, 'no yes or typed approval without a begin receipt');
  assert.equal(closed, 1); assert.equal(cleaned, 1); assert.equal(released, 1);
  assert.equal(saved.error, report.error);
});

test('failed child collection or fixture cleanup retains the live lock and writes failure evidence', async () => {
  let released = false, writes = 0, saved;
  const io = { hold: async () => {}, lock: async () => async () => { released = true; },
    login: async () => {},
    prewarm: async () => ({ status: 'ready' }), evidence: async () => '/fixture/evidence',
    prepare: async () => ({ fixture: 'RA1 fixture', mail: 'Mail' }), fixture: async () => {},
    session: async () => ({ submit: async () => { throw Error('fixture refusal sk-ant-fixture123'); }, close: async () => ({ clean: false }) }),
    cleanup: async () => true, write: (_path, value) => { writes++; saved = value; }, now: () => new Date('2026-10-25T01:02:03Z') };
  const result = await runRemoteApproval({ ownerAway: true }, io);
  assert.equal(result.passed, false); assert.equal(result.lockRetained, true);
  assert.equal(released, false); assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(saved), /sk-ant-fixture123/);
  assert.match(saved.error, /redacted/);
});

test('missing account login fails before preparing or opening the fixture and prints one login command', async t => {
  const home = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ra1-login-')));
  const target = live.remoteLoginPlan({ home, env: { HOME: home, PATH: '/usr/bin', USER: 'bench', LOGNAME: 'bench',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_API_KEY: 'never-forward' } });
  const config = join(home, 'Library', 'Caches', 'sleight-bench', 'remote-approval', 'claude');
  assert.equal(target.env.CLAUDE_CONFIG_DIR, config);
  assert.equal(target.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(target.command, 'claude');
  let released = false, checked = 0;
  const io = { now: () => new Date('2026-10-25T01:02:03Z'), hold: async () => {},
    evidence: async () => '/fixture/evidence',
    lock: async () => async () => { released = true; }, write() {},
    login: () => live.assertRemoteLogin(target, { home, run(command, args, options) {
      checked++;
      assert.equal(command, 'claude');
      assert.deepEqual(args, ['auth', 'status', '--json']);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, config);
      assert.equal(options.env.USER, 'bench');
      return JSON.stringify({ loggedIn: false });
    } }),
    prepare: () => assert.fail('login failure prepared a fixture'),
    fixture: () => assert.fail('login failure launched an app'),
    session: () => assert.fail('login failure started a PTY') };
  const result = await runRemoteApproval({ ownerAway: true }, io);
  assert.equal(checked, 1);
  assert.equal(result.passed, false);
  assert.equal(released, true);
  assert.equal(result.cleanup, true);
  assert.match(result.error, /Not logged in/);
  assert.equal(result.error.match(/auth login/g)?.length, 1);
  assert.ok(result.error.includes('env CLAUDE_CONFIG_DIR="$HOME/Library/Caches/sleight-bench/remote-approval/claude" claude auth login'));
  assert.equal(existsSync(config), false, 'readiness must not create or alter login files');
});

for (const failure of ['none', 'blocked', 'launch', 'close']) test(`fixed login and temporary trust cleanup: ${failure}`, async t => {
  const home = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ra1-session-')));
  const login = live.remoteLoginPlan({ home, env: { HOME: home, PATH: '/usr/bin', USER: 'bench' } });
  const config = login.env.CLAUDE_CONFIG_DIR, configFile = join(config, '.claude.json');
  mkdirSync(config, { recursive: true });
  writeFileSync(configFile, JSON.stringify({ accountFixture: 'preserve', hasCompletedOnboarding: true,
    projects: { '/other-fixture': { keep: true } } }));
  const bank = { bank: join(home, 'run'), token: 'RA1-fixture' };
  let captured, stopped = 0, finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const launch = (plan, output) => {
    captured = plan;
    assert.equal(plan.env.CLAUDE_CONFIG_DIR, config);
    assert.equal(plan.env.USER, 'bench');
    const settings = JSON.parse(readFileSync(plan.args[plan.args.indexOf('--settings') + 1], 'utf8'));
    assert.deepEqual(settings.enabledPlugins, {});
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /remote-approval-guard\.mjs/);
    const mcp = JSON.parse(readFileSync(plan.args[plan.args.indexOf('--mcp-config') + 1], 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['plugin:sleight:computer']);
    assert.ok(plan.args.includes('--plugin-dir'));
    assert.equal(plan.args.includes('--strict-mcp-config'), false);
    assert.deepEqual(settings.allowedMcpServers, [{ serverName: 'plugin:sleight:computer' }]);
    assert.equal(plan.args[plan.args.indexOf('--setting-sources') + 1], '');
    const current = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(current.projects[plan.cwd].hasTrustDialogAccepted, true);
    assert.deepEqual(current.projects[plan.cwd].enabledMcpServers, ['plugin:sleight:computer']);
    // Claude can refresh account metadata while running. Cleanup must preserve that write.
    writeFileSync(configFile, JSON.stringify({ ...current, accountFixture: 'refreshed' }));
    if (failure === 'launch') throw Error('launch failed');
    output(failure === 'blocked' ? 'Sign in to Claude\n' : '❯\n');
    return { closed, async stop() { stopped++; finish({ clean: true }); if (failure === 'close') throw Error('close failed'); } };
  };
  const pending = live.realSession(bank, { login, launch, hold: async () => {}, signal: new AbortController().signal });
  if (failure === 'launch') await assert.rejects(pending, /launch failed/);
  else if (failure === 'blocked') await assert.rejects(pending, /startup is not ready/);
  else {
    const session = await pending;
    if (failure === 'close') await assert.rejects(session.close(), /close failed/);
    else assert.deepEqual(await session.close(), { clean: true });
  }
  assert.equal(stopped, failure === 'launch' ? 0 : 1);
  const after = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(after.accountFixture, 'refreshed');
  assert.deepEqual(after.projects, { '/other-fixture': { keep: true } });
  assert.equal(existsSync(join(config, '.credentials.json')), false);
  assert.notEqual(captured.cwd, config);
});

for (const [code, expected] of [
  ['let app = await cua.getApp("TextEdit")', true],
  ['let app = await cua.getApp("com.apple." + "Text" + "Edit")', true],
  ['nodeRepl.write(await app.getAXState({disableDiffing:true}))', true],
  ['let state = await app.getAXState(); nodeRepl.write(state)', true],
  ['await cua.getApp("Mail")', false], ['await app.click(1)', false],
  ['await cua.getState()', false], ['let app = await cua.getApp("TextEdit"); await app.typeText("x")', false],
  ['nodeRepl.write(await fetch("https://example.test"))', false], ['let state = await app.getAXState({ x: shell() })', false],
]) test(`live arm read guard: ${code}`, () => {
  const event = { tool_name: 'mcp__plugin_sleight_computer__js', tool_input: { code } };
  assert.equal(remoteGuardDecision(event), expected);
  assert.equal(remoteGuardDecision(event, { upfront: true }), false);
});
