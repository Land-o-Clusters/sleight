import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { fowlPreflight } from '../bench/fowl/preflight.mjs';
const cacheSkip = !existsSync(join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/.git')) && 'pinned FowlBrowser cache is absent';

const root = fileURLToPath(new URL('..', import.meta.url));
const task = { name: 'fixture', browser: 'chrome', prompt: 'Read the value at http://127.0.0.1:4811/t/fixture/', result: 'the value' };
test('runner-dependent tests name their missing pinned cache requirement', t => {
  const home = temp(t);
  const env = { ...process.env, HOME: home }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', 'both.*round arms', fileURLToPath(import.meta.url)], {
    encoding: 'utf8', env,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /pinned FowlBrowser cache is absent/);
  assert.match(run.stdout, /skipped 2/);
});

test('both Claude round arms pin their background model to Haiku 5.5', { skip: cacheSkip }, async t => {
  const { dir, file } = runner(t), previous = process.env.SLEIGHT_REPO;
  process.env.SLEIGHT_REPO = root;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO = previous; });
  const mod = await import(pathToFileURL(file));
  for (const surface of ['sleight', 'fowlbrowser']) {
    for (const world of [false, true]) {
      const setup = mod.agentSetup({ task, surface, dir, mcpRoot: '/fixture/mcp', settings: '/fixture/settings.json',
        model: 'haiku', effort: 'high', world });
      assert.equal(setup.env?.ANTHROPIC_SMALL_FAST_MODEL, 'claude-haiku-5-5');
    }
  }
});
function temp(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-review-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function runner(t) {
  const dir = temp(t);
  const original = spawnSync('/usr/bin/git', ['-C', join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser'), 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(original.status, 0, original.stderr);
  mkdirSync(join(dir, 'tools'));
  writeFileSync(join(dir, 'tools/rounds.mjs'), original.stdout);
  const applied = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  return { dir, file: join(dir, 'tools/rounds.mjs') };
}

test('both round arms use explicit 5.5 model IDs and the token price in their report grade', { skip: cacheSkip }, async t => {
  const {dir,file}=runner(t), tasks=join(dir,'models.json');
  writeFileSync(tasks,JSON.stringify(['sleight','fowlbrowser'].map(surface=>({...task,name:surface,surface}))));
  for(const alias of ['haiku','sonnet','opus']) {
    const run=spawnSync(process.execPath,[file,'--tasks',tasks,'--world','--dry-run','--model',alias],
      {encoding:'utf8',env:{...process.env,SLEIGHT_REPO:root}});
    assert.equal(run.status,0,run.stderr);
    for(const plan of JSON.parse(run.stdout)) assert.equal(plan.args[plan.args.indexOf('--model')+1],`claude-${alias}-5-5`);
  }
  const previous=process.env.SLEIGHT_REPO; process.env.SLEIGHT_REPO=root;
  t.after(()=>{if(previous===undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO=previous;});
  const mod=await import(pathToFileURL(file));
  const recorded=JSON.parse(readFileSync(new URL('fixtures/fowl-haiku-5-5-result.json',import.meta.url)));
  assert.equal(mod.gradeTokens({result:recorded}).cost,0.0016165);
});

test('setup runs only the pinned Claude installer after npm and validates its executable', async (t) => {
  const { setupPlan } = await import('../bench/world/arms/browser.mjs');
  const dir = join(temp(t), 'playwright-mcp');
  const plan = setupPlan('playwright-mcp', dir, '@playwright/mcp@0.0.83', '@anthropic-ai/claude-code@2.1.289');
  assert.ok(plan.claudeInstaller, 'setup must explicitly install Claude after npm');
  const { installArm } = await import('../bench/world/arms/install.mjs');
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('--version')) return { status: 0, stdout: '2.1.289 (Claude Code)\n' };
    return { status: 0 };
  };
  assert.equal(installArm(plan, { run }), 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, 'npm');
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[1].args, [join(dir, 'node_modules/@anthropic-ai/claude-code/install.cjs')]);
  assert.equal(calls[2].command, join(dir, 'node_modules/.bin/claude'));
  assert.deepEqual(calls[2].args, ['--version']);
  assert.equal(calls[2].options.env.CLAUDE_CONFIG_DIR, join(dir, 'claude-config'));
  assert.throws(() => installArm(plan, { run: (command, args) => args.includes('--version') ? { status: 1, stderr: 'claude native binary not installed' } : { status: 0 } }), /native binary not installed/);
  assert.throws(() => installArm(plan, { run: (command, args) => args.includes('--version') ? { status: 0, stdout: '2.1.288 (Claude Code)' } : { status: 0 } }), /2.1.289/);
  let count = 0;
  assert.throws(() => installArm(plan, { run: () => { count++; return { status: 7 }; } }), /7/);
  assert.equal(count, 1);
});

test('world configuration is identical for legacy arms and discards host Claude configuration', async (t) => {
  const { worldAgentSetup } = await import('../bench/world/arms/browser.mjs');
  const dir = temp(t);
  for (const surface of ['sleight', 'fowlbrowser', 'fowl+sleight', 'codex', 'devtools', 'playwright-mcp', 'chrome-devtools-mcp']) {
    const setup = worldAgentSetup({ surface, dir: join(dir, 'runs', surface), armRoot: join(dir, 'arms'), hostEnv: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/owner', CLAUDE_CODE_OAUTH_TOKEN: 'owner', DISABLE_TELEMETRY: '0' } });
    assert.equal(setup.command, join(dir, 'arms', surface, 'node_modules/.bin/claude'));
    assert.equal(setup.env.CLAUDE_CONFIG_DIR, join(dir, 'arms', surface, 'claude-config'));
    assert.equal(setup.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(setup.env.DISABLE_TELEMETRY, '1');
    assert.equal(setup.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(setup.args[setup.args.indexOf('--setting-sources') + 1], '');
    assert.equal(setup.metadata.claudeVersion, '2.1.289');
    assert.equal(setup.metadata.settingSources, '');
    assert.deepEqual(setup.settings.claudeMdExcludes, ['**']);
    assert.equal(setup.settings.autoMemoryEnabled, false);
  }
});

test('world dry-run gives every Claude arm the same prefix, isolation, version and settings source', { skip: cacheSkip }, async (t) => {
  const { dir, file } = runner(t);
  const tasks = join(dir, 'tasks.json');
  const entry = join(dir, 'codex-entry.json');
  writeFileSync(entry, JSON.stringify({ command: process.execPath, args: ['/fixture/codex-proxy.mjs'] }));
  const names = ['sleight', 'fowlbrowser', 'fowl+sleight', 'codex', 'devtools', 'playwright-mcp', 'chrome-devtools-mcp'];
  writeFileSync(tasks, JSON.stringify(names.map(surface => ({ ...task, name: surface.replaceAll('+', '-'), surface }))));
  const config = join(dir, 'rounds.json');
  writeFileSync(config, JSON.stringify({ devtools: { command: '/fixture/devtools', env: { chrome: {} } } }));
  const run = spawnSync(process.execPath, [file, '--tasks', tasks, '--codex-entry', entry, '--world', '--dry-run', '--model', 'claude-haiku-5-5', '--effort', 'high', '--out', join(dir, 'never')],
    { encoding: 'utf8', env: { ...process.env, SLEIGHT_REPO: root, FOWLBROWSER_ROUNDS_CONFIG: config } });
  assert.equal(run.status, 0, run.stderr);
  const plans = JSON.parse(run.stdout);
  assert.equal(plans.length, names.length);
  assert.equal(new Set(plans.map(p => p.prompt.replaceAll(p.task,'<task>'))).size, 1);
  for (const plan of plans) {
    assert.equal(plan.supported, true, plan.reason);
    assert.ok(plan.command.endsWith(`/${plan.surface}/node_modules/.bin/claude`));
    assert.equal(plan.metadata.claudeVersion, '2.1.289');
    assert.equal(plan.metadata.settingSources, '');
    assert.equal(plan.metadata.versionVerified, false);
    assert.ok(!plan.command.includes('ssh'));
    assert.equal(plan.args[plan.args.indexOf('--setting-sources') + 1], '');
    assert.equal(plan.args[plan.args.indexOf('--effort') + 1], 'high');
    assert.ok(plan.prompt.includes(`sessionName: '🧪 ${plan.task}'`),plan.surface+' lost the task label');
    if (['sleight', 'codex'].includes(plan.surface)) assert.match(plan.prompt, /cua\.createBrowserTab[^\n]*\{ sessionName: '🧪 [^']+' \}/);
  }
  assert.equal(existsSync(join(dir, 'never')), false);
});

test('world executable preflight checks every selected arm before server and monitor startup', { skip: cacheSkip }, async t => {
  const {dir,file}=runner(t), previous=process.env.SLEIGHT_REPO; process.env.SLEIGHT_REPO=root;
  t.after(()=>{if(previous===undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO=previous;});
  const mod=await import(pathToFileURL(file)); const calls=[];
  const tasks=['sleight','fowl+sleight','fowlbrowser','codex','devtools','playwright-mcp','chrome-devtools-mcp','claude-in-chrome'].map(surface=>({...task,surface}));
  const verified=mod.verifyWorldAgents(tasks,{surfaceOf:t=>t.surface,dir,armRoot:join(dir,'arms'),run:(command,args)=>{
    calls.push({command,args}); return {status:0,stdout:'2.1.289 (Claude Code)\n'};
  }});
  assert.equal(verified.size,8); assert.equal(calls.length,8);
  for(const call of calls) assert.deepEqual(call.args,['--version']);
  assert.throws(()=>mod.verifyWorldAgents(tasks,{surfaceOf:t=>t.surface,dir,armRoot:join(dir,'arms'),run:()=>({status:0,stdout:'2.1.288 (Claude Code)'})}),/Pinned Claude/);
  const source=readFileSync(file,'utf8'), main=source.slice(source.indexOf('async function main()'));
  assert.ok(main.indexOf('verifyWorldAgents(')>=0);
  assert.ok(main.indexOf('verifyWorldAgents(')<main.indexOf('await openRemote('));
  assert.ok(main.indexOf('verifyWorldAgents(')<main.indexOf('let server ='));
  assert.ok(main.indexOf('verifyWorldAgents(')<main.indexOf('await startMonitor('));
});

test('all world surfaces use the same eager tool-loading mode despite the host setting', async t => {
  const {worldAgentSetup,WORLD_SURFACES}=await import('../bench/world/arms/browser.mjs'); const dir=temp(t);
  for(const surface of WORLD_SURFACES) {
    const plan=worldAgentSetup({surface,dir:join(dir,'run'),armRoot:join(dir,'arms'),hostEnv:{ENABLE_TOOL_SEARCH:'auto'}});
    assert.equal(plan.env.ENABLE_TOOL_SEARCH,'false',surface);
    assert.equal(plan.metadata.toolLoading,'eager',surface);
  }
});

test('unobservable browser checks report not measured and do not alter site outcomes', { skip: cacheSkip }, async (t) => {
  const { file } = runner(t);
  const mod = await import(pathToFileURL(file));
  for (const surface of ['playwright-mcp', 'chrome-devtools-mcp', 'claude-in-chrome', 'browser-use']) {
    assert.equal(mod.surfaceObserved(surface), false);
    const grade = mod.observationGrade(surface, () => { throw new Error('unobservable check ran'); });
    assert.equal(grade.ok, null);
    assert.equal(grade.cell, 'not measured');
    assert.deepEqual(grade.problems, []);
    const outcome = mod.gradeOutcome({ task: { ...task, keepMin: 2, downloads: { min: 1 } }, run: { exitCode: 0, result: { result: 'RESULT: the value' } }, journal: [], after: {}, startKeys: new Set(), observed: false });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.ok(!outcome.cell.includes('FAIL'));
  }
  assert.equal(mod.surfaceObserved('sleight'), true);
  assert.equal(mod.observationGrade('sleight', () => ({ ok: false, cell: 'FAIL', problems: ['actual'] })).ok, false);
});

test('unsupported task pairs are written before any remote or browser connection', { skip: cacheSkip }, (t) => {
  const { dir, file } = runner(t);
  const tasks = join(dir, 'tasks.json');
  writeFileSync(tasks, JSON.stringify([{ ...task, surface: 'claude-cu' }, { ...task, name: 'native', browser: 'native', surface: 'playwright-mcp' }]));
  const out = join(dir, 'out');
  const run = spawnSync(process.execPath, [file, '--tasks', tasks, '--remote', 'never-connect.invalid', '--out', out, '--world'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, SLEIGHT_REPO: root } });
  assert.equal(run.status, 0, run.stderr);
  const rows = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'not supported');
    assert.equal(row.wallMs, null);
    assert.equal(row.cost, null);
    assert.ok(row.reason);
  }
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /not supported/);
  assert.equal(existsSync(join(out, 'monitor.jsonl')), false);
});

test('runner support boundaries agree with offline admission without mutating task rows', { skip: cacheSkip }, async t => {
  const { file } = runner(t), previous = process.env.SLEIGHT_REPO;
  process.env.SLEIGHT_REPO = root;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO = previous; });
  const { taskSupport } = await import(pathToFileURL(file));
  const cases = [
    ['claude-in-chrome', 'helium', { world: true }, /requires.*Chrome/],
    ['codex-agent', 'chrome', { world: true }, /does not run Claude/],
    ['sleight-turbo', 'chrome', { remote: 'fixture' }, /local only/],
    ['sleight', 'chrome', { world: true, remote: 'fixture' }, /world arms/],
    ['browser-use', 'chrome', { remote: 'fixture' }, /remote configuration/],
    ['playwright-mcp', 'native', {}, /browser tasks only/],
    ['claude-in-chrome', 'chrome', { world: true }, null],
    ['sleight-turbo', 'chrome', { world: true }, null],
    ['sleight', 'helium', {}, null],
  ];
  for (const [surface, browser, options, reason] of cases) {
    const selected = { ...task, surface, browser }, tasks = [selected], calls = [];
    const actual = taskSupport(selected, surface, options);
    if (reason) assert.match(actual, reason); else assert.equal(actual, null);
    await fowlPreflight({ tasks, model: 'opus', home: '/fixture', ...options }, {
      spend() { calls.push('spend'); }, fowlSocket() { calls.push('socket'); },
      engineSockets() { calls.push('engine'); }, login() { calls.push('login'); },
    });
    assert.equal(calls.length === 0, !!reason, JSON.stringify([surface, browser, options]));
    assert.equal(tasks[0], selected, 'admission preserves the runner task and its unsupported row');
  }
});

test('agent timeout collects its whole process group and stops signaling after collection', { skip: cacheSkip }, async (t) => {
  const { EventEmitter } = await import('node:events');
  const { file } = runner(t);
  const { startAgent } = await import(pathToFileURL(file));
  const child = new EventEmitter();
  child.pid = 4242;
  const signals = [];
  const agent = startAgent({ command: 'fake-claude', args: ['-p'], env: { FIXTURE: '1' } }, '/fixture', {
    spawnAgent: (command, args, options) => {
      assert.equal(command, 'fake-claude');
      assert.deepEqual(args, ['-p']);
      assert.equal(options.detached, true);
      assert.deepEqual(options.env, { FIXTURE: '1', DISABLE_TELEMETRY: '1' });
      return child;
    }, signalGroup: (pid, signal) => signals.push({ pid, signal }),
  });
  agent.kill('SIGKILL');
  assert.deepEqual(signals, [{ pid: -4242, signal: 'SIGKILL' }]);
  child.emit('close', 0);
  agent.kill('SIGTERM');
  assert.equal(signals.length, 1);
});

test('Chrome profile lookup takes only the exact benchmark name and refuses ambiguous mappings', async (t) => {
  const dir = temp(t);
  const file = join(dir, 'Local State');
  const { benchmarkProfile } = await import('../bench/world/arms/chrome.mjs');
  writeFileSync(file, JSON.stringify({ profile: { info_cache: { Default: { name: 'owner' }, 'Profile 7': { name: 'sleight benchmark', ignored: 'fixture' } } } }));
  assert.equal(benchmarkProfile(file), 'Profile 7');
  writeFileSync(file, JSON.stringify({ profile: { info_cache: { Default: { name: 'owner' } } } }));
  assert.throws(() => benchmarkProfile(file), /missing/);
  writeFileSync(file, JSON.stringify({ profile: { info_cache: { Default: { name: 'sleight benchmark' }, 'Profile 7': { name: 'sleight benchmark' } } } }));
  assert.throws(() => benchmarkProfile(file), /ambiguous/);
  writeFileSync(file, JSON.stringify({ profile: { info_cache: { '../owner': { name: 'sleight benchmark' } } } }));
  assert.throws(() => benchmarkProfile(file), /folder/);
});

test('Chrome world setup preserves device selection, hooks and --chrome', { skip: cacheSkip }, async (t) => {
  const { dir, file } = runner(t);
  const previous = process.env.SLEIGHT_REPO; process.env.SLEIGHT_REPO = root;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO = previous; });
  const { agentSetup, taskSupport } = await import(pathToFileURL(file));
  const chromeFiles = { deviceFile: join(dir,'device'), localState: join(dir,'Local State'), manifest: join(dir,'manifest'), backupDir: join(dir,'backups') };
  const device = '83e6d921-8a11-4c87-a945-cbd5b5b883d6';
  writeFileSync(chromeFiles.deviceFile, device+'\n', {mode:0o600});
  writeFileSync(chromeFiles.localState, JSON.stringify({profile:{info_cache:{'Profile 7':{name:'sleight benchmark'}}}}));
  const plan = agentSetup({task,surface:'claude-in-chrome',dir:join(dir,'run'),settings:join(dir,'settings.json'),model:'claude-haiku-5-5',effort:'high',world:true,chromeFiles});
  assert.equal(taskSupport(task,'claude-in-chrome',{world:true}),null);
  assert.ok(plan.prompt.includes(device));
  assert.ok(plan.prompt.indexOf('select_browser') < plan.prompt.indexOf(task.prompt));
  assert.equal(plan.metadata.chrome.deviceId,device);
  assert.equal(plan.env.ENABLE_TOOL_SEARCH,'false');
  assert.ok(plan.settingsOverrides.hooks.PreToolUse);
  assert.ok(plan.args.includes('--chrome'));
  assert.ok(!plan.args.includes('--no-chrome'));
});

test('Chrome manifest backup restores bytes and mode on success and failure, including an absent manifest', async (t) => {
  const { statSync, symlinkSync } = await import('node:fs');
  const { withManifestBackup } = await import('../bench/world/arms/chrome.mjs');
  const dir = temp(t);
  const manifest = join(dir, 'native-host.json');
  const backupDir = join(dir, 'backups');
  const original = Buffer.from('{"name":"owner fixture"}\n');
  writeFileSync(manifest, original, { mode: 0o640 });
  assert.equal(await withManifestBackup(manifest, backupDir, async () => { writeFileSync(manifest, 'benchmark'); return 'done'; }), 'done');
  assert.deepEqual(readFileSync(manifest), original);
  assert.equal(statSync(manifest).mode & 0o777, 0o640);
  await assert.rejects(withManifestBackup(manifest, backupDir, async () => { writeFileSync(manifest, 'benchmark'); throw new Error('fixture failure'); }), /fixture failure/);
  assert.deepEqual(readFileSync(manifest), original);
  rmSync(manifest);
  await withManifestBackup(manifest, backupDir, async () => writeFileSync(manifest, 'benchmark'));
  assert.equal(existsSync(manifest), false);
  const target = join(dir, 'owner.json');
  writeFileSync(target, original);
  symlinkSync(target, manifest);
  let called = false;
  await assert.rejects(withManifestBackup(manifest, backupDir, async () => { called = true; }), /ordinary file/);
  assert.equal(called, false);
  assert.deepEqual(readFileSync(target), original);
});
