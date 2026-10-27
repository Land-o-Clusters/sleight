import { remoteGuardDecision } from '../bench/remote-approval-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as live from '../bench/remote-approval-live.mjs';
import { remotePlan, runRemoteApproval, gradeRemote } from '../bench/remote-approval-live.mjs';

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
    { firstToolAt: 100, noticeAt: 250, text: '"TextEdit" needs approval on the Mac. Ask the user to reply: allow TextEdit', grants: [], complete: false },
    { text: 'Please reply: allow TextEdit', grants: [], complete: false },
    { text: 'RA1 fixture complete', grants: ['com.apple.TextEdit'], complete: true },
    { text: 'Please reply: allow TextEdit, Mail', grants: [], complete: false },
  ];
  const io = {
    hold: async () => { order.push('hold'); },
    lock: async () => { order.push('lock'); return async () => order.push('unlock'); },
    login: async () => { order.push('login'); },
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
  assert.ok(order.indexOf('close') < order.indexOf('cleanup'));
  assert.ok(order.indexOf('cleanup') < order.indexOf('unlock'));
  assert.ok(order.includes('yes')); assert.ok(order.includes('allow TextEdit'));
  assert.equal(written.length, 1);
  assert.match(written[0].path, /docs\/benchmarks\/2026-10-25-remote-approval-/);
  assert.equal(plan.app, 'TextEdit');
});

test('grading rejects hangs, a yes grant, missing mail app, model-only completion and a wrong typed grant', () => {
  const notice = { firstToolAt: 0, noticeAt: 10001, text: '"TextEdit" needs approval on the Mac. Ask the user to reply: allow TextEdit' };
  const yes = { grants: [] }, typed = { grants: ['com.apple.TextEdit'], complete: true };
  assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail' }).passed, false);
  notice.noticeAt = 9000;
  assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail' }).passed, true);
  for (const changes of [{ yes: { grants: ['com.apple.TextEdit'] } }, { typed: { grants: [], complete: true } },
    { typed: { grants: ['com.apple.TextEdit'], complete: false } }, { upfront: { text: 'allow TextEdit' } }]) {
    assert.equal(gradeRemote({ notice, yes, typed, upfront: { text: 'allow TextEdit, Mail' }, mail: 'Mail', ...changes }).passed, false);
  }
});

test('failed child collection or fixture cleanup retains the live lock and writes failure evidence', async () => {
  let released = false, writes = 0, saved;
  const io = { hold: async () => {}, lock: async () => async () => { released = true; },
    login: async () => {},
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
    assert.ok(plan.args.includes('--strict-mcp-config'));
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
