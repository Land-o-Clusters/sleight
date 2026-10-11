import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwned } from '../preapproved-process.mjs';
import { runDriver } from '../driver.mjs';
import { CODEX_HOME, approveOnly, codexReady, codexConfigServers } from '../codex-arm.mjs';
import { benchAuth, runCost, addSpend } from '../api-auth.mjs';
import { guardGenericOperation } from '../generic-approval.mjs';
import { observePermission } from '../real-permission.mjs';
import { acquireLiveLock } from '../live-lock.mjs';
import { startFootprint, cpuSplit } from '../footprint.mjs';
import { probeClient } from '../double-keys-client.mjs';
import { resolveServer } from '../../plugins/sleight/lib/launch.mjs';
import { setupFixture, checkFixture, stateReadCode, targetURL } from './fixtures.mjs';
import { writeDocument } from './documents.mjs';
import { streamMetrics } from './metrics.mjs';
import { stateSetupRequest } from './scripting.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hostScript = fileURLToPath(new URL('./host.js', import.meta.url));
const tools = ['js', 'js_reset', 'open_file', 'select_window'].map(t => `mcp__plugin_sleight_computer__${t}`).join(',');
const outside = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Read', 'Skill'];
const sessionKey = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_)/;

function codexTurns(threadId) {
  if (!threadId || !/^[a-f0-9-]+$/.test(threadId)) return null;
  const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(path, e.name))
    : e.isFile() && e.name.includes(threadId) ? [join(path, e.name)] : []);
  const dir = join(CODEX_HOME, 'sessions');
  const files = existsSync(dir) ? walk(dir) : [];
  return files.length === 1 ? readFileSync(files[0], 'utf8').split('\n').filter(line => line.includes('"token_count"')).length : null;
}

export async function startHost(task, ctx, signal, runProcess = runOwned) {
  const control = join(ctx.dir, 'host-control.json');
  const command = value => writeFileSync(control, JSON.stringify({ command: value }), { mode: 0o600 });
  command('observe');
  const samples = [], stages = new Map(); let confirmed = false, buffer = '', details = { reasons: ['HOST_RECEIPT_MISSING'], windows: [] };
  let startStage = 'armed', windowCount = null;
  const stage = name => { if (!stages.has(name)) stages.set(name, Promise.withResolvers()); return stages.get(name); };
  const hostController = new AbortController();
  // setupFixture created this exact file in the run's private bank. Never grant a URL or another file.
  const fixturePath = task.fixtureKind === 'doc-file' && ctx.path === ctx.target &&
    ctx.dir.startsWith('/private/tmp/sleight-battery-') && dirname(ctx.path) === ctx.dir &&
    realpathSync(ctx.path) === ctx.path && realpathSync(ctx.dir) === ctx.dir ? ctx.path : undefined;
  const response = runProcess('/usr/bin/osascript', ['-l', 'JavaScript', hostScript, JSON.stringify({
    bundle: task.bundle, targetURL: targetURL(ctx.target), control, fixturePath, fixtureRoot: fixturePath ? ctx.dir : undefined })], { timeoutMs: 650000, signal: hostController.signal,
    onStdout: receive });
  function receive(data) {
    buffer += String(data);
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (Number.isInteger(event.windowCount)) windowCount = event.windowCount;
      if (event.stage === 'sample') samples.push(event.sample);
      if (event.stage === 'cleanup') { confirmed = event.confirmed === true; details = scrub(event.details ?? { reasons: ['HOST_DETAILS_MISSING'], windows: [] }); }
      stage(event.stage).resolve(event);
    }
  }
  function scrub(value) {
    if (typeof value === 'string') return value.replaceAll(homedir(), '~').replaceAll(encodeURI(homedir()), '~');
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
    return value;
  }
  async function wait(name) {
    let timer;
    try { return await Promise.race([stage('error').promise.then(event => {
      const error = new Error(event.error.message); error.hostStart = scrub(event.error); throw error;
    }), stage(name).promise, response.then(result => { throw new Error(result.spawnError || result.stderr?.trim() || 'HOST_EXITED'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HOST_DEADLINE')), 35000); })]); }
    finally { clearTimeout(timer); }
  }
  const finish = async ({ abort = false } = {}) => {
    command(abort ? 'abort' : 'finish');
    const result = await response;
    if (!result.groupClean || result.exit.code !== 0) details.reasons.push('HOST_PROCESS_UNCONFIRMED');
    return { confirmed: confirmed && result.groupClean && result.exit.code === 0, details, samples };
  };
  try {
    const armed = await wait('armed');
    signal.throwIfAborted();
    if (ctx.target || !armed.wasRunning) {
      startStage = 'open';
      const opened = await runProcess('/usr/bin/open', ['-g', '-b', task.bundle, ...(ctx.target ? [ctx.target] : []),
        ...(!armed.wasRunning ? ['--args', '-ApplePersistenceIgnoreState', 'YES'] : [])], { signal, timeoutMs: 30000 });
      if (opened.exit.code !== 0 || !opened.groupClean) throw new Error(opened.spawnError || opened.stderr?.trim() || 'FIXTURE_OPEN_FAILED');
    }
    command('launched');
    startStage = 'ready';
    await wait('ready');
    return { finish, abort: () => command('abort') };
  } catch (error) {
    command('abort'); hostController.abort();
    const result = await response.catch(() => null);
    if (!stages.has('cleanup')) details = { reasons: ['HOST_NOT_STARTED'], windows: [] };
    details.startError = scrub(error.hostStart ?? { message: String(error.message || error).slice(0, 500), stage: startStage, windowCount });
    if (!result?.groupClean || result.exit.code !== 0) details.reasons.push('HOST_PROCESS_UNCONFIRMED');
    error.hostCleanup = { confirmed: false, details, samples };
    throw error;
  }
}

export async function liveRuntime({ pass, option, localFixtures, ownerPresent, cleanArms }) {
  const ready = codexReady(); if (ready !== true) throw new Error('CODEX_NOT_READY');
  if (cleanArms && codexConfigServers().length !== 1) throw new Error('CODEX_CLEAN_CONFIG_REQUIRED');
  if (existsSync('/tmp/sleight-hold')) throw new Error('LIVE_HOLD');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const unlock = await acquireLiveLock(undefined, { signal: controller.signal });
  let restore, closed = false, preflightClean = true;
  const bank = mkdtempSync('/private/tmp/sleight-battery-');
  const output = join(root, 'bench/results', `${new Date().toISOString().replace(/[:.]/g, '-')}-battery.json`);
  const stopFile = join(bank, 'approval-stop');
  let blocked = false;
  const guard = async operation => {
    const response = await guardGenericOperation(operation, { signal: controller.signal, stopFile, permissionCheck: observePermission });
    if (response.approvalStop) { blocked = true; controller.abort(); }
    return response;
  };
  try {
    const auth = benchAuth({ mode: option('auth', 'auto') });
    const hostFree = Object.fromEntries(Object.entries(process.env).filter(([key]) => !sessionKey.test(key)));
    const env = { ...hostFree, ...auth.env, BENCH_ROOT: root, BENCH_SUITE: 'battery', BENCH_OWNER_PRESENT: ownerPresent ? '1' : '',
      BENCH_APPROVAL_STOP: stopFile, BENCH_ARM_SERVERS: JSON.stringify(['plugin:sleight:computer']), SLEIGHT_APPROVAL_PROMPT: 'client',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false', SLEIGHT_TRACE: '', BENCH_HOOK_LOG: '', SLEIGHT_RECEIPTS: '0',
      DISABLE_TELEMETRY: '1', OTEL_LOG_RAW_API_BODIES: '0', OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '0', OTEL_LOG_TOOL_CONTENT: '0' };
    for (const key of auth.unset) delete env[key];
    const cwd = { sleight: join(bank, 'sleight-arm'), codex: join(bank, 'codex-arm') };
    for (const path of Object.values(cwd)) {
      mkdirSync(path, { mode: 0o700 });
      try { runGit(path); throw new Error('ARM_INSIDE_REPO'); } catch (error) { if (error.message === 'ARM_INSIDE_REPO') throw error; }
    }
    const mcp = join(bank, 'mcp.json'), settings = join(bank, 'settings.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { 'plugin:sleight:computer': { command: join(root, 'plugins/sleight/bin/sleight-mcp') } } }), { mode: 0o600 });
    const baseSettings = JSON.parse(readFileSync(join(root, 'bench/settings.json'), 'utf8'));
    writeFileSync(settings, JSON.stringify(baseSettings), { mode: 0o600 });
    // Same temporary approval transaction as bench/run.mjs. Restore even after a safety stop.
    restore = approveOnly([...new Set(pass.runs.map(row => row.bundle))], join(bank, 'approvals-before.json'));
    const claudeArgs = ['--plugin-dir', join(root, 'plugins/sleight'), '--allowedTools', tools,
      ...(cleanArms ? ['--mcp-config', mcp, '--strict-mcp-config', '--setting-sources', ''] : []),
      '--no-session-persistence', '--disallowedTools', outside.join(','), '--settings', settings,
      '--output-format', 'stream-json', '--verbose', '--model', option('model', 'claude-haiku-5-5'), '--effort', option('effort', 'high')];
    let catalog;
    const discovery = streamMetrics('sleight');
    const discover = new AbortController();
    const preflight = await guard(signal => runOwned(process.env.CLAUDE_BIN || 'claude', ['-p', 'hi', ...claudeArgs], {
      cwd: cwd.sleight, env, timeoutMs: 60000, signal: AbortSignal.any([signal, discover.signal]),
      onStdout: data => {
        discovery.receive(data); catalog = discovery.finish().catalog;
        if (catalog) discover.abort();
      } }));
    preflightClean = preflight.groupClean === true;
    if (preflight.approvalStop || !preflight.groupClean || !catalog ||
      catalog.mcp_servers?.find(s => s.name === 'plugin:sleight:computer')?.status !== 'connected' ||
      catalog.mcp_servers?.some(s => s.name !== 'plugin:sleight:computer' && (cleanArms || s.name === 'lcu')) ||
      (auth.mode === 'api' && catalog.apiKeySource !== 'ANTHROPIC_API_KEY')) throw new Error('ARM_PREFLIGHT_FAILED');
    return {
      async setupPair(task, row) {
        controller.signal.throwIfAborted();
        const ctx = { dir: join(bank, `${row.task}-${row.run}`), marker: row.marker,
          scripted: Boolean(task.scripting && localFixtures[task.id]) };
        mkdirSync(ctx.dir, { mode: 0o700 });
        await setupFixture(task, ctx); return ctx;
      },
      async resetFixture(task, ctx) {
        controller.signal.throwIfAborted();
        if (ctx.path) writeDocument(ctx.path, task.format, ctx.marker);
      },
      async startHost(task, ctx) {
        const observed = await guard(async signal => ({ host: await startHost(task, ctx, signal), groupClean: true }));
        if (!observed.host || observed.approvalStop) { await observed.host?.finish({ abort: true }); throw new Error('HOST_STOP'); }
        if (ctx.scripted && !ctx.stateCreated) {
          const created = await guard(signal => runOwned('/usr/bin/osascript', ['-l', 'JavaScript',
            fileURLToPath(new URL('./state-setup.js', import.meta.url)),
            JSON.stringify(stateSetupRequest(task, ctx.marker, localFixtures[task.id]))], { signal, timeoutMs: 30000 }));
          if (created.approvalStop || created.exit?.code !== 0 || !created.groupClean || created.stdout?.trim() !== '{"created":true}') {
            await observed.host.finish({ abort: true }); throw new Error('LOCAL_FIXTURE_SETUP_FAILED');
          }
          ctx.stateCreated = true;
        }
        return { async finish(options) {
          if (blocked || controller.signal.aborted) return observed.host.finish({ abort: true });
          const collected = await guard(async signal => {
            signal.addEventListener('abort', observed.host.abort, { once: true });
            try { return { ...(await observed.host.finish(options)), groupClean: true }; }
            finally { signal.removeEventListener('abort', observed.host.abort); }
          });
          if (collected.approvalStop) await observed.host.finish({ abort: true });
          return { ...collected, confirmed: collected.confirmed && !collected.approvalStop };
        } };
      },
      async drive(arm, prompt, task) {
        const stream = streamMetrics(arm);
        let stopCPU;
        const onSpawn = pgid => { stopCPU = startFootprint({ pgid, apps: [task.app] }); };
        let response, footprint;
        try {
          response = await guard(signal => arm === 'sleight'
            ? runDriver(process.env.CLAUDE_BIN || 'claude', ['-p', prompt, ...claudeArgs], {
              cwd: cwd.sleight, env, signal, timeoutMs: 300000, format: 'stream-json', onSpawn, onStdout: stream.receive,
              onPermissionRefusal: () => { blocked = true; controller.abort(); } })
            : runOwned('codex', ['exec', '--json', '-s', 'read-only', '--disable', 'shell_tool', '-m', option('codex-model', 'gpt-6.1-sol'),
              '-c', `model_reasoning_effort="${option('codex-effort', option('effort', 'high'))}"`, '--skip-git-repo-check', '-C', cwd.codex, prompt], {
              cwd: cwd.codex, env: { ...env, CODEX_HOME }, signal, timeoutMs: 300000, onSpawn, onStdout: stream.receive }));
        } finally { footprint = await stopCPU?.(); }
        const metrics = stream.finish(), cost = arm === 'sleight' ? runCost(metrics.result) : undefined;
        if (auth.mode === 'api' && cost && addSpend(cost) >= auth.capUsd) { blocked = true; controller.abort(); }
        return { ...metrics, code: response.code ?? response.exit?.code ?? 1, groupClean: response.groupClean,
          approvalStop: response.approvalStop || (blocked ? 'SAFETY_STOP' : undefined),
          turns: arm === 'sleight' ? metrics.result?.num_turns ?? null : codexTurns(metrics.threadId),
          costUsd: cost, footprint: footprint ? { ...footprint, split: cpuSplit(footprint, { client: arm === 'sleight' ? 'claude' : 'codex' }) } : null };
      },
      async check(task, ctx, answer) {
        const checked = await guard(async () => ({ verdict: await checkFixture(task, ctx, answer, { readState: async bundle => {
          const server = resolveServer(); if (server.error) throw new Error('STATE_ENGINE_UNAVAILABLE');
          const client = await probeClient(server, { relay: false, record: () => {}, approve: async () => ({ action: 'decline' }) });
          try {
            const reply = await client.call('js', { code: stateReadCode(bundle) });
            if (reply.isError) throw new Error('STATE_READ_FAILED');
            return (reply.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          } finally { await client.close(); }
        } }), groupClean: true }));
        return checked.approvalStop ? 'PERMISSION_STOP' : checked.verdict;
      },
      publish(results) {
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, JSON.stringify({ suite: 'battery', counts: pass.counts, armSetup: cleanArms ? 'clean' : 'normal',
          ownerPresent, auth: auth.mode, plannedRuns: pass.runs.length, completedRuns: results.length, results }, null, 2) + '\n', { mode: 0o600 });
        const latest = results.at(-1);
        console.log(`${latest.passed ? 'PASS' : 'FAIL'} ${latest.arm} ${latest.task} #${latest.run}: ${latest.checkCode}`);
      },
      async closePair(ctx) { await ctx.closeServer?.(); },
      async close({ confirmed }) {
        if (closed) return; closed = true;
        try { restore?.(); } finally {
          process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
          if (confirmed && !blocked) await unlock();
          else console.error('BATTERY_STOP: live lock and fixtures retained for sleight-arch.');
          console.log(`results: ${output.replace(homedir(), '~')}`);
        }
      },
    };
  } catch (error) {
    restore?.();
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    // No app launch has happened before the runtime is returned.
    if (preflightClean && !blocked) await unlock();
    else console.error('BATTERY_STOP: preflight cleanup unconfirmed, live lock retained for sleight-arch.');
    throw error;
  }
}

// Only verify the isolated arm folders. No shell or setup command is run here.
import { execFileSync } from 'node:child_process';
function runGit(path) { return execFileSync('/usr/bin/git', ['-C', path, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' }); }
