import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { turboSetup } from '../bench/turbo/setup.mjs';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';
import { turboFirstRules } from '../plugins/sleight/lib/turbo-first-rules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const cacheSkip = !existsSync(join(cache, '.git')) && 'pinned FowlBrowser source is absent';
const fixtureTask = { name: 'fixture', browser: 'chrome', prompt: 'Read http://127.0.0.1:5431/form', result: 'the value' };
async function runner(t) {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-gate-')));
  mkdirSync(join(dir, 'tools'));
  const original = spawnSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8' });
  assert.equal(original.status, 0, original.stderr);
  const file = join(dir, 'tools/rounds.mjs'); writeFileSync(file, original.stdout);
  const applied = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const previous = process.env.SLEIGHT_REPO; process.env.SLEIGHT_REPO = root;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO = previous; });
  return { dir, file, mod: await import(pathToFileURL(file)) };
}

test('turbo arm offers the engine companion and the installed turbo skill before any tool call', t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-config-')));
  const setup = turboSetup({ task: fixtureTask, repo: root, dir, prompt: fixtureTask.prompt });
  assert.deepEqual(Object.keys(setup.mcpServers).sort(), ['plugin:sleight:computer', 'sleight-turbo']);
  const engine = setup.mcpServers['plugin:sleight:computer'];
  assert.equal(engine.command, join(root, 'plugins/sleight/bin/sleight-mcp'));
  assert.equal(engine.env.SLEIGHT_SURFACES, 'browser,computer');
  assert.equal(engine.env.SLEIGHT_SKILL, 'default', 'native acquisition still supplies its full guidance');
  assert.ok(setup.allowed.split(',').includes('mcp__plugin_sleight_computer__js'));
  assert.equal(setup.allowed.split(',').length, 8);
  const browserRules = readFileSync(join(root, 'plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md'), 'utf8').trimEnd().replace('{browser}', 'bbench').replace('{application}', ' (Google Chrome)');
  const installed = skillRules(undefined, {}).replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, browserRules + '\n');
  assert.equal(setup.promptPrefix, turboFirstRules(installed) + '\n\n', 'same first-browser projection as the product relay');
  assert.match(setup.promptPrefix, /Never translate refs or handles between paths/);
});

test('fixture and open-web tasks receive the same installed prompt and tools without per-task routing', t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-config-')));
  const tasks = [fixtureTask, { ...fixtureTask, prompt: 'Read https://example.com/' },
    { ...fixtureTask, viewport: { width: 390, height: 844 } }, { ...fixtureTask, handoff: true }];
  const setups = tasks.map(task => turboSetup({ task, repo: root, dir, prompt: task.prompt }));
  for (const setup of setups.slice(1)) {
    assert.equal(setup.promptPrefix, setups[0].promptPrefix);
    assert.equal(setup.allowed, setups[0].allowed);
    assert.deepEqual(Object.keys(setup.mcpServers), Object.keys(setups[0].mcpServers));
  }
  assert.deepEqual(JSON.parse(setups[1].mcpServers['sleight-turbo'].env.SLEIGHT_TURBO_ORIGINS), []);
});

test('the combined turbo prompt shares the screenshot A/B switch and keeps lint markers out', t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-screenshot-')));
  for (const prompt of [undefined, 'lean']) for (const flag of [undefined, '0']) {
    const env = { SLEIGHT_PROMPT: prompt, SLEIGHT_SCREENSHOT_READS: flag };
    const setup = turboSetup({ task: fixtureTask, repo: root, dir, prompt: fixtureTask.prompt, env });
    assert.doesNotMatch(setup.promptPrefix, /<!--|vale ai-tells/);
    assert.equal(setup.promptPrefix.includes('When a document pane or table exposes no text'), prompt !== 'lean' && flag !== '0');
    const native = turboFirstRules(skillRules(undefined, env)).split('## Browsers')[0];
    assert.ok(setup.promptPrefix.startsWith(native));
  }
});

test('the prompt names the task browser as the one the tools drive and sends no engine browser steps', t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-config-')));
  for (const [browser, application] of [['helium', 'Helium'], ['chrome', 'Google Chrome']]) {
    const task = { ...fixtureTask, browser };
    const { promptPrefix } = turboSetup({ task, repo: root, dir, prompt: task.prompt });
    assert.match(promptPrefix, new RegExp('Turbo selects `bbench` \\(' + application + '\\)\\.'));
    assert.match(promptPrefix, /Drive this browser with these tools, not engine `js`\. `js` serves native apps and other browsers/);
    assert.doesNotMatch(promptPrefix, /listBrowsers|createBrowserTab|extensionInstanceId|Find (Helium|Chrome)/);
  }
});

test('the runner adds no engine find-and-open sentence for turbo, in either prompt mode and both browser orders',
  { skip: cacheSkip }, async t => {
    const { dir, mod } = await runner(t);
    for (const world of [false, true]) for (const browser of ['helium', 'chrome']) {
      const task = { ...fixtureTask, browser, prompt: 'look up a page in {browser}' };
      const { prompt } = mod.agentSetup({ task, surface: 'sleight-turbo', dir, mcpRoot: '/fixture/mcp',
        settings: '/fixture/settings.json', model: 'haiku', effort: 'high', world });
      assert.doesNotMatch(prompt, /listBrowsers|createBrowserTab|getBrowser\(|extensionInstanceId/, `${browser} world=${world}`);
      assert.match(prompt, new RegExp('Turbo selects `bbench` \\(' + (browser === 'helium' ? 'Helium' : 'Google Chrome') + '\\)'));
      assert.match(prompt, /look up a page in (Helium|Chrome)/);
    }
    // The engine arms keep their find-and-open sentence.
    const engine = mod.agentSetup({ task: { ...fixtureTask, browser: 'helium' }, surface: 'sleight', dir, mcpRoot: '/fixture/mcp',
      settings: '/fixture/settings.json', model: 'haiku', effort: 'high', world: false });
    assert.match(engine.prompt, /cua\.listBrowsers\(\)/);
  });

test('the gate tasks and optional takeover in both browser orders keep both servers and are supported',
  { skip: cacheSkip }, async t => {
    const { dir, mod } = await runner(t);
    const tasks = JSON.parse(readFileSync(join(cache, 'tools/agents/codex-h2h.json')));
    assert.equal(tasks.length, 14);
    for (const world of [false, true]) {
      const external = { ...fixtureTask, prompt: 'Read https://example.com/', viewport: { width: 390, height: 844 } };
      const setup = task => mod.agentSetup({ task, surface: 'sleight-turbo', dir, mcpRoot: '/fixture/mcp',
        settings: '/fixture/settings.json', model: 'haiku', effort: 'high', world });
      const fixture = setup(fixtureTask), openWeb = setup(external);
      assert.equal(fixture.prompt.slice(0, fixture.prompt.indexOf(fixtureTask.prompt)),
        openWeb.prompt.slice(0, openWeb.prompt.indexOf(external.prompt)));
      assert.deepEqual(fixture.args, openWeb.args);
      assert.deepEqual(Object.keys(fixture.mcpConfig.mcpServers), Object.keys(openWeb.mcpConfig.mcpServers));
    }
    for (const swap of [false, true]) for (const original of tasks) {
      const task = { ...original, browser: swap ? original.browser === 'chrome' ? 'helium' : 'chrome' : original.browser };
      assert.equal(mod.taskSupport(task, 'sleight-turbo'), null, task.name);
      const setup = mod.agentSetup({ task, surface: 'sleight-turbo', dir, mcpRoot: '/fixture/mcp',
        settings: '/fixture/settings.json', model: 'haiku', effort: 'high', world: true });
      assert.deepEqual(Object.keys(setup.mcpConfig.mcpServers).sort(), ['plugin:sleight:computer', 'sleight-turbo'], task.name);
      assert.ok(setup.args[setup.args.indexOf('--allowedTools') + 1].split(',').includes('mcp__plugin_sleight_computer__js'),
        'native tools stay available while native how-to is deferred');
      assert.equal(mod.surfaceObserved('sleight-turbo', task), false, 'route choice cannot prove extension tab ownership');
    }
    const settings = mod.roundSettings('sleight-turbo', { mcpRoot: '/fixture/mcp' });
    assert.ok(settings.hooks.Elicitation.some(entry => entry.matcher === 'plugin:sleight:computer'));
    assert.ok(settings.hooks.Stop.length);
    assert.ok(mod.taskSupport(fixtureTask, 'sleight-turbo', { remote: {} }), 'remote turbo remains unsupported');
    const handoff = tasks.find(task => task.name === 'handoff');
    assert.deepEqual(mod.gradeHandoff({ task: handoff, surface: 'sleight-turbo', site: { lines: [] },
      afterExit: { 'chrome:1': { url: 'http://127.0.0.1:5420/checkout/signin' } } }).problems, []);
    assert.ok(mod.gradeHandoff({ task: handoff, surface: 'sleight-turbo', site: { lines: [] }, afterExit: {} }).problems.length);
  });

test('fake Claude receives both servers and EOF collects each owned server before the runner completes',
  { skip: cacheSkip, timeout: 10000 }, async t => {
    const { dir, mod } = await runner(t);
    const setup = mod.agentSetup({ task: fixtureTask, surface: 'sleight-turbo', dir, mcpRoot: '/fixture/mcp',
      settings: '/fixture/settings.json', model: 'haiku', effort: 'high', world: true });
    assert.deepEqual(Object.keys(setup.mcpConfig.mcpServers).sort(), ['plugin:sleight:computer', 'sleight-turbo']);
    const serverFile = join(dir, 'fake-server.mjs'), claudeFile = join(dir, 'fake-claude.mjs'), configFile = join(dir, 'mcp.json');
    // Replace only the external launch boundary: no model, browser or engine runs.
    writeFileSync(serverFile, `process.stdin.resume(); process.stdin.once('end', () => {
      process.stdout.write(JSON.stringify({closed:process.argv[2]})+'\\n'); });\n`);
    const servers = Object.fromEntries(Object.keys(setup.mcpConfig.mcpServers).map(name => [name,
      { command: process.execPath, args: [serverFile, name] }]));
    writeFileSync(configFile, JSON.stringify({ mcpServers: servers }));
    writeFileSync(claudeFile, `import {readFileSync} from 'node:fs'; import {spawn} from 'node:child_process';
      const config=JSON.parse(readFileSync(process.argv[2]));
      const children=Object.entries(config.mcpServers).map(([name,s])=>{
        const child=spawn(s.command,s.args,{stdio:['pipe','pipe','inherit']});
        child.stdout.pipe(process.stdout,{end:false});
        return {child,closed:new Promise(resolve=>child.once('close',resolve))}; });
      process.stdout.write(JSON.stringify({servers:Object.keys(config.mcpServers)})+'\\n');
      process.stdin.resume(); process.stdin.once('end',async()=>{
        for(const {child} of children) child.stdin.end();
        await Promise.all(children.map(c=>c.closed)); });\n`);
    const started = mod.startAgent({ ...setup, command: process.execPath, args: [claudeFile, configFile] }, dir,
      { spawnAgent: spawn, signalGroup: () => assert.fail('EOF should collect both fake children without signaling') });
    const { child } = started; let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const exited = once(child, 'close').then(([code]) => { assert.equal(code, 0); });
    t.after(async () => { child.stdin.end(); await exited; });
    const run = {};
    await mod.finishAgent(run, { child, hosts: {}, exited, kill: started.kill });
    const messages = output.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(messages[0].servers.sort(), ['plugin:sleight:computer', 'sleight-turbo']);
    assert.deepEqual(messages.filter(message => message.closed).map(message => message.closed).sort(),
      ['plugin:sleight:computer', 'sleight-turbo']);
    assert.equal(run.killed, undefined);
    assert.deepEqual(run.afterExit, {});
  });

test('the full gate dry plan has twenty-six supported rows across both browser orders',
  { skip: cacheSkip }, async t => {
    const { dir, file } = await runner(t); let count = 0;
    for (const swap of [false, true]) {
      const plan = spawnSync(process.execPath, [file, '--tasks', join(cache, 'tools/agents/codex-h2h.json'),
        '--surface', 'sleight-turbo', '--world', '--dry-run', '--model', 'haiku', '--effort', 'high',
        '--out', join(dir, swap ? 'swap' : 'normal'), ...(swap ? ['--swap'] : [])],
      { encoding: 'utf8', env: { ...process.env, SLEIGHT_REPO: root }, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(plan.status, 0, plan.stderr);
      const rows = JSON.parse(plan.stdout.slice(plan.stdout.indexOf('[\n')));
      assert.equal(rows.length, 13, 'takeover stays behind the existing --gui requirement');
      for (const row of rows) {
        assert.equal(row.supported, true, row.task + ': ' + row.reason);
        assert.ok(row.mcpConfig.mcpServers['plugin:sleight:computer']);
        assert.ok(row.mcpConfig.mcpServers['sleight-turbo']);
        assert.equal(row.args[row.args.indexOf('--plugin-dir') + 1], join(root, 'plugins/sleight'));
      }
      count += rows.length;
    }
    assert.equal(count, 26);
  });
