import { defaultArmHome } from './world/login-readiness.mjs';
// Live dependencies stay behind the CLI entry point. Importing the grader never acquires an app.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLiveLock } from './live-lock.mjs';
import { waitForHold } from './live-checks-1-5.mjs';
import { serveWorldFixture } from './world/browser-fixtures.mjs';
import { launchRealBrowser, realBrowserPlan } from './fowl/real-browser.mjs';
import { worldCLI, WORLD_CLAUDE_VERSION, worldSettings } from './world/native-world.mjs';
import { genericSettings } from './plugin-arm.mjs';
import { sleightPluginLaunch } from './sleight-plugin-launch.mjs';
import { sleightInitProblems } from './mcp-catalog.mjs';
import { assertLogin } from './preflight.mjs';
import { benchAuth } from './api-auth.mjs';
import { benchmarkDecision } from './approve.mjs';
import { runDriver } from './driver.mjs';
import { openClient, textOf } from './compat/client.mjs';
import { engineSpan, readEngine } from './engine-version.mjs';
import { hasLabel, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { CONTROLS, CONTINUATION, INSTRUCTION, makeReport, parseEvidence, probeInitProblems, probePlan, runControl, traceCalls } from './sf6-focus-probe.mjs';
import { benchGateOpen, requireLiveBenchGate } from './runtime-options.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tests/fixtures/sf6-focus-probe.html');
const INSPECTOR = join(homedir(), '.codex/bin/codex-macos-inspect');
const SERVER = 'plugin:sleight:computer';
const tools = ['js', 'js_reset', 'drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'open_file', 'app_handoff'];
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const lines = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const utc = () => new Date().toISOString();

export function runtimeEnvironment(config, trace, inherited = process.env) {
  const base = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(CLAUDE|ANTHROPIC|SLEIGHT|BENCH|NODE_OPTIONS$|NODE_PATH$)/.test(key)));
  return { ...base, ...benchAuth({ mode: 'login' }).env, CLAUDE_CONFIG_DIR: config,
    BENCH_ROOT: ROOT, BENCH_SUITE: 'world', BENCH_WORLD_TASKS: JSON.stringify(['cc-new-tab-firefox']),
    BENCH_ARM_SERVERS: JSON.stringify([SERVER]), ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    // The benchmark allowlist answers session cards. Idle presence must not divert them to a physical card.
    SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_REMOTE_APPROVALS: '0', SLEIGHT_HAND: '0', SLEIGHT_SURFACES: 'computer',
    SLEIGHT_TRACE: trace, SLEIGHT_TRACE_CODE: '1', SLEIGHT_TRACE_CUT: '1000000' };
}

export function fixtureHandler(html, nonce, origin) {
  return (req, res) => {
    if (req.method !== 'GET' || req.url !== `/${nonce}/` || req.headers.host !== new URL(origin).host ||
      req.headers.origin && req.headers.origin !== origin) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" }).end(html);
  };
}

export function ownedFixtureObservation(text, url) {
  const window = windowFromText(text);
  if (window?.title !== 'SF6R focus probe' || window.app !== 'Firefox') return false;
  const urls = [...text.matchAll(/^\s*\d+\s+HTML Content\b[^\n]*?\bURL:\s*([^\s,]+)/gm)];
  if (urls.length !== 1) return false;
  try {
    const observed = urls[0][1];
    return new URL(observed.startsWith('http:') ? observed : 'http://' + observed).href === url;
  } catch { return false; }
}

// Page evidence and any available field-level AX agreement come from this one full read.
export function parseDriverEvidence(text) {
  const snapshot = parseEvidence(text);
  const focused = [...text.matchAll(/^The focused UI element is (\d+) (.+)\r?$/gm)];
  if (focused.length !== 1) throw Error('AX field focus unavailable or ambiguous');
  const [, element, body] = focused[0];
  // Match the actual row before interpreting its role. Container-only focus carries no field
  // observation, so the page sampler supplies focus evidence under the SF6U ruling.
  const tree = [...text.matchAll(/^([\t ]*)(\d+) ([^\n\r]+)\r?$/gm)]
    .map(row => ({ element: row[2], body: row[3], depth: row[1].replaceAll('\t', '    ').length }));
  const rows = tree.filter(row => row.element === element);
  if (rows.length !== 1 || rows[0].body !== body) throw Error('AX field focus does not match a unique tree row');
  const pages = tree.filter(row => /^HTML Content\b/.test(row.body));
  if (pages.length !== 1) throw Error('AX field focus requires one unambiguous fixture page');
  if (/^container(?: \([^)]*\))*(?: |$)/.test(body))
    return { ...snapshot, axFocus: { element: Number(element), field: null, diagnostic: 'AX field focus unavailable (container only)' } };
  if (!/^text field(?: \([^)]*\))* /.test(body))
    throw Error(`AX field focus unavailable: engine reports ${body} (element ${element})`);
  const start = tree.indexOf(pages[0]) + 1;
  const end = tree.findIndex((row, i) => i >= start && row.depth <= pages[0].depth);
  const pageRows = tree.slice(start, end < 0 ? tree.length : end);
  if (!pageRows.includes(rows[0])) throw Error('AX field focus is outside the fixture page');
  const fields = ['memo', 'reference'].filter(field => hasLabel(body, field === 'memo' ? 'Memo' : 'Reference'));
  if (fields.length !== 1 || fields[0] !== snapshot.focus) throw Error('AX and page focus disagree');
  const label = fields[0] === 'memo' ? 'Memo' : 'Reference';
  if (pageRows.filter(row => /^text field(?: \([^)]*\))* /.test(row.body) && hasLabel(row.body, label)).length !== 1)
    throw Error('AX field focus label is ambiguous in the fixture page');
  return { ...snapshot, axFocus: { element: Number(element), field: fields[0] } };
}

export function modelPlan({ command, cwd, config, dir, url, seed }) {
  const modelTrace = join(dir, 'model-trace');
  const env = runtimeEnvironment(config, modelTrace);
  const mcp = { mcpServers: { [SERVER]: { command: join(ROOT, 'plugins/sleight/bin/sleight-mcp') } } };
  const settings = worldSettings(genericSettings({ servers: [SERVER] }, ROOT));
  const launch = sleightPluginLaunch({ args: ['--plugin-dir', join(ROOT, 'plugins/sleight'), '--mcp-config', join(dir, 'mcp.json'),
    '--strict-mcp-config', '--tools', '', '--allowedTools', tools.map(t => `mcp__plugin_sleight_computer__${t}`).join(','),
    '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts', 'none'],
    env, mcpConfig: mcp, settingsOverrides: settings });
  return { command, cwd, env: launch.env, mcp, settings: launch.settingsOverrides, modelTrace,
    args: ['-p', ...launch.args, '--settings', join(dir, 'settings.json'), '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose', '--model', 'claude-haiku-5-5', '--effort', 'high'],
    // These are actual driver records, carried as user context, never fabricated
    // assistant/tool frames. No recovery advice is added to the refusal.
    first: `Use sleight in Firefox at the owned fixture ${url}.\n\n${INSTRUCTION}`,
    ...(seed ? { handoff: `Use sleight in Firefox at the owned fixture ${url}.\n\n${INSTRUCTION}\n\nDriver transcript (the requested call has completed; the driver stopped):\n${JSON.stringify({ code: seed.request.code, result: seed.result })}\n\n${CONTINUATION}` } : {}) };
}

// A result event is the explicit model-stop boundary. Input remains open, preserving the same CLI and REPL.
export function streamSession(plan, { signal, run = runDriver, timeoutMs = 180000 } = {}) {
  const input = new PassThrough(), events = [], results = [];
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let buffer = '', current, ended, problem, starts = 0;
  const reject = error => { problem = error; current?.reject(error); current = undefined; controller.abort(error); };
  const done = run(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, format: 'stream-json', input,
    timeoutMs, signal: controller.signal, evidenceDir: plan.dir, onStdout: chunk => {
      buffer += String(chunk);
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { reject(Error('Claude stream contains invalid JSON')); continue; }
        events.push(event);
        if (event.type === 'system' && event.subtype === 'init') {
          const errors = sleightInitProblems([event], plan.mcp);
          if (errors.length) reject(Error(errors.join('; ')));
        }
        if (event.type === 'result') {
          results.push(event);
          if (event.is_error || event.subtype !== 'success') reject(Error('Claude turn did not finish successfully'));
          else {
            const errors = probeInitProblems(events, plan.mcp, starts);
            if (errors.length) reject(Error(errors.join('; ')));
            else { current?.resolve({ stopped: true, event }); current = undefined; }
          }
        }
      }
    } });
  const collected = done.then(response => {
    ended = response;
    signal?.removeEventListener('abort', abort);
    reject(Error(response.timedOut ? 'Claude session timed out' : 'Claude session exited'));
    return response;
  }, error => { signal?.removeEventListener('abort', abort); reject(error); return { groupClean: false, error: error.message }; });
  return {
    events, results,
    async turn(message) {
      if (problem || ended) throw problem ?? Error('Claude session is closed');
      if (current) throw Error('Claude turn already running');
      if (message !== INSTRUCTION && message !== CONTINUATION) throw Error('Unexpected probe turn');
      starts++;
      return new Promise((resolve, reject) => {
        current = { resolve, reject };
        const content = starts === 1 ? (message === INSTRUCTION ? plan.first : plan.handoff ?? message) : message;
        input.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      });
    },
    async close() { if (current) controller.abort(Error('Probe closing a running turn')); input.end(); return collected; },
  };
}

export function traceMatchesTranscript(events, entries) {
  const uses = events.filter(e => e.type === 'assistant').flatMap(e => e.message?.content ?? []).filter(c => c.type === 'tool_use');
  const received = entries.filter(e => e.direction === 'call-received' && e.msg.params?.name !== 'turn_ended');
  if (!uses.length || uses.some(c => c.name !== 'mcp__plugin_sleight_computer__js' || typeof c.input?.code !== 'string') ||
    received.some(e => e.msg.params?.name !== 'js' || typeof e.msg.params.code !== 'string')) return false;
  return isDeepStrictEqual(uses.map(c => c.input.code), received.map(e => e.msg.params.code));
}

function readTraces(directory) {
  const files = existsSync(directory) ? readdirSync(directory).filter(name => /^trace-\d+\.jsonl$/.test(name)).map(name => join(directory, name)) : [];
  // A model CLI should own one relay. Multiple streams cannot be totally ordered by wall-clock timestamps.
  const entries = files.length === 1 ? lines(files[0]) : [];
  return { files, entries, audit: traceCalls(entries), oneRelay: files.length === 1 };
}

async function driverConnection(env, stage, dir, connect = openClient) {
  const trace = join(dir, `driver-${stage}`); mkdirSync(trace, { mode: 0o700 });
  return connect({ command: join(ROOT, 'plugins/sleight/bin/sleight-mcp'), env: { ...env, SLEIGHT_TRACE: trace },
    requireGroupCollection: true, name: 'sf6-fixture-driver',
    approve: params => {
      const choice = benchmarkDecision({ mcp_server_name: SERVER, message: params.message, requested_schema: params.requestedSchema }, env)?.hookSpecificOutput;
      return choice?.action === 'accept' ? { action: 'accept', content: choice.content ?? {} } : { action: 'decline' };
    } });
}

export async function liveControl(control, { dir, config, command, signal, gate, save }, services = {}) {
  const launchBrowser = services.launchBrowser ?? launchRealBrowser;
  const startSession = services.startSession ?? streamSession;
  const engineRead = services.engineRead ?? readEngine;
  const inspectWindows = services.inspectWindows ?? (pid => JSON.parse(execFileSync(INSPECTOR,
    ['windows-for-pid', String(pid), '--scope', 'all'], { encoding: 'utf8', timeout: 60000 })));
  mkdirSync(dir, { mode: 0o700 });
  const ctx = { nonce: randomUUID(), dir }, cleanup = { browserClosed: null, profileDeleted: null, noWindows: null,
    driverCollected: true, modelCollected: true, serverClosed: null };
  const journal = [], driverArtifacts = [], transcript = join(dir, 'transcript.jsonl');
  let browser, session, plan, stage = 0, snapshotCount = 0, modelTurns = 0, refusalAudit, seed, browserPid, modelExit;
  const record = (event, detail = {}) => {
    const entry = { order: journal.length, at: utc(), event, ...detail }; journal.push(entry);
    appendFileSync(join(dir, 'driver.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  };
  const startEngine = engineRead();
  const driver = async work => {
    await gate(); signal.throwIfAborted();
    const key = String(++stage), env = runtimeEnvironment(config, join(dir, 'unused-driver-trace'));
    let client;
    try {
      cleanup.driverCollected = false;
      try { client = await driverConnection(env, key, dir, services.connect); }
      catch (error) {
        cleanup.driverCollected = error.cleanupReceipt?.childCollected === true && error.cleanupReceipt?.groupCollected === true;
        record('driver-start-failed', { stage: key, receipt: error.cleanupReceipt, error: error.message });
        throw error;
      }
      let reply = await client.call('js', { code: 'var app = await cua.getApp("org.mozilla.firefox");', title: 'Read owned SF6 fixture' });
      record('driver-acquire', { stage: key, result: reply });
      // Restore ce6a8718:bench/sf6-focus-runtime.mjs:195's first-read compatibility rule.
      // This exception applies only to acquisition; the explicit full read below must succeed.
      if (reply.isError && !/getAXState/.test(textOf(reply))) throw Error(`Driver app acquisition refused (org.mozilla.firefox, stage ${key}): ${textOf(reply)}`);
      reply = await client.call('js', { code: 'await app.getAXState({disableDiffing:true});', title: 'Read SF6 fixture evidence' });
      record('driver-read', { stage: key, result: reply });
      if (reply.isError || !ownedFixtureObservation(textOf(reply), ctx.url)) throw Error('Owned fixture window identity unproved');
      signal.throwIfAborted();
      return await work(client, reply);
    } finally {
      if (client) {
        const closed = await client.close(); const receipt = client.cleanupReceipt();
        cleanup.driverCollected = closed === true && receipt?.groupCollected === true;
        record('driver-collected', { stage: key, receipt });
        if (!cleanup.driverCollected) throw Error('Driver process group cleanup unproved');
      }
      if (existsSync(join(dir, `driver-${key}`))) driverArtifacts.push(...readdirSync(join(dir, `driver-${key}`)).filter(n => n.endsWith('.jsonl')).map(n => join(dir, `driver-${key}`, n)));
    }
  };
  const io = {
    snapshot: async () => {
      if (!browser) {
        await gate();
        cleanup.serverClosed = false;
        await serveWorldFixture(ctx, origin => fixtureHandler(readFileSync(FIXTURE, 'utf8'), ctx.nonce, origin));
        const browserPlan = realBrowserPlan({ browser: 'firefox', round: `sf6-${control}-${ctx.nonce}`, profile: 'fresh' });
        record('browser-setup-start', { profile: browserPlan.profileRoot, url: ctx.url });
        // The world suite's lifecycle retains PID, start time and unique profile ownership across quit.
        cleanup.browserClosed = cleanup.profileDeleted = cleanup.noWindows = false;
        try { browser = await launchBrowser(browserPlan, { initialPage: { url: ctx.url, title: 'SF6R focus probe' } }); }
        catch (error) { record('browser-setup-failed', { receipt: error.browserReceipt }); throw error; }
        browserPid = browser.pid; record('browser-owned', { pid: browserPid, profile: browser.profileRoot, ownerCheck: browser.ownerCheck });
      }
      const snapshot = await driver(async (_client, reply) => parseDriverEvidence(textOf(reply)));
      record('snapshot', { index: ++snapshotCount, snapshot });
      return snapshot;
    },
    turn: async message => {
      await gate();
      if (!session) {
        if (!seed) throw Error('Driver refusal transcript unavailable');
        const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'sf6-arm-'));
        plan = { ...modelPlan({ command, cwd, config, dir, url: ctx.url, seed }), dir };
        json(join(dir, 'mcp.json'), plan.mcp); json(join(dir, 'settings.json'), plan.settings);
        cleanup.modelCollected = false; session = startSession(plan, { signal });
        record('model-start', { cwd, command, model: 'claude-haiku-5-5', effort: 'high' });
      }
      record('turn-submitted', { message, content: modelTurns++ === 0 ? plan.handoff ?? message : message });
      const result = await session.turn(message);
      record('model-stopped', { sessionId: result.event.session_id, subtype: result.event.subtype });
      return result;
    },
    refusal: async () => {
      seed = await driver(async (client, reply) => {
        const text = textOf(reply);
        const matches = [...text.matchAll(/^\s*(\d+)\s+text field\b[^\n]*\bMemo\b[^\n]*$/gm)];
        if (matches.length !== 1) throw Error('Unique current Memo element unproved');
        const request = { code: `await app.typeText(${Number(matches[0][1])}, "cobalt heron 47");`, title: 'Refuse numeric-target Memo input' };
        const result = await client.call('js', request);
        record('driver-refused-call', { request, result });
        return { request, result };
      });
      json(join(dir, 'refusal-transcript.json'), seed);
      const traced = readTraces(join(dir, `driver-${stage}`)); refusalAudit = traced.audit;
      record('refusal-audit', { trace: traced.files, audit: refusalAudit });
      const r = refusalAudit.refusals;
      const call = traced.entries.findIndex(e => e.direction === 'call-received' && e.msg.id === r[0]?.callId);
      const reply = traced.entries[r[0]?.order];
      const forwarded = call < 0 || traced.entries.slice(call, r[0]?.order).some(e => e.direction === 'to-server' && e.msg.method === 'tools/call');
      const matched = traced.entries[call]?.msg.params.code === seed.request.code && isDeepStrictEqual(reply?.msg.result, seed.result);
      const accepted = traced.oneRelay && matched && !forwarded && seed.result.isError === true && refusalAudit.complete && r.length === 1 &&
        refusalAudit.actions.length === 1 && refusalAudit.unknown.length === 0;
      record('driver-stopped', { accepted, forwarded });
      return accepted ? { ...r[0], stopped: true, forwardedCalls: 0 } : null;
    },
    move: async () => driver(async (client, reply) => {
      const text = textOf(reply);
      const label = 'Move focus to Reference after refusal';
      const matches = [...text.matchAll(/^\s*(\d+)\s+(?:button|push button)\b[^\n]*Move focus to Reference after refusal[^\n]*$/gm)];
      if (matches.length !== 1) throw Error('Unique labeled driver button unproved');
      record('focus-button-before', { action: 'AXPress', label, element: Number(matches[0][1]) });
      const result = await client.call('js', { code: `await app.performSecondaryAction({label:${JSON.stringify(label)}}, "Press");`, title: 'Press SF6 fixture focus button' });
      record('focus-button-result', { result });
      if (result.isError) throw Error('Driver button AX Press refused; no pointer fallback');
    }),
    cleanup: async () => {
      const failures = [];
      if (session) {
        try {
          const collected = await session.close(); cleanup.modelCollected = collected.groupClean === true;
          modelExit = { code: collected.code ?? null, timedOut: collected.timedOut ?? false, cancelled: collected.cancelled ?? false };
          record('model-collected', { ...modelExit, groupClean: collected.groupClean });
          if (!cleanup.modelCollected) failures.push('model process group');
          // Only this run's empty model folder is disposable. The transcript remains in dir.
          if (cleanup.modelCollected) rmSync(plan.cwd, { recursive: true });
        } catch (error) { failures.push(error.message); }
      }
      if (browser) {
        try {
          const receipt = await browser.stop(); Object.assign(cleanup, receipt);
          record('browser-collected', { receipt, collections: browser.collections, profileAudit: browser.profileAudit });
          const windows = await inspectWindows(browserPid);
          cleanup.noWindows = Array.isArray(windows) && windows.length === 0;
          record('window-cleanup', { pid: browserPid, windows });
        } catch (error) { failures.push(error.message); }
      }
      if (ctx.closeServer) {
        try { await ctx.closeServer(); cleanup.serverClosed = true; } catch (error) { failures.push(error.message); }
      } else if (cleanup.serverClosed !== false) cleanup.serverClosed = true;
      record('cleanup', { cleanup, failures });
      save?.({ control, cleanup });
      return cleanup;
    },
    finish: async () => {
      const traced = plan ? readTraces(plan.modelTrace) : { files: [], entries: [], audit: { complete: false, unknown: [], actions: [] }, oneRelay: false };
      const modelIds = [...new Set((session?.events ?? []).flatMap(e => [e.message?.model, ...Object.keys(e.modelUsage ?? {})]).filter(Boolean))];
      const sessionIds = [...new Set((session?.events ?? []).map(e => e.session_id).filter(Boolean))];
      const endEngine = engineRead();
      return { ...(modelExit && (modelExit.code !== 0 || modelExit.timedOut || modelExit.cancelled) ? { error: 'Model exit was not successful' } : {}),
        trace: [...traced.files, ...driverArtifacts], transcripts: existsSync(transcript) ? [transcript] : [], journal: join(dir, 'driver.jsonl'),
        modelIds, sessionIds, engine: engineSpan(startEngine, endEngine), engineVersion: engineSpan(startEngine, endEngine).version,
        recovery: { traceComplete: traced.oneRelay && traced.audit.complete && traceMatchesTranscript(session?.events ?? [], traced.entries), unknown: traced.audit.unknown,
          actions: traced.audit.actions },
        modelExit, refusalTrace: refusalAudit, refusalSource: 'driver',
        refusalTranscript: seed && join(dir, 'refusal-transcript.json'),
        browser: browser && { pid: browserPid, profile: browser.profileRoot, version: browser.version }, cleanup };
    },
  };
  return runControl(control, io);
}

export function staticChecks(config) {
  const armHome = process.env.BENCH_ARM_HOME || join(homedir(), 'Library/Caches/sleight-bench');
  const command = worldCLI(armHome);
  const required = [FIXTURE, command, '/Applications/Firefox.app/Contents/MacOS/firefox', INSPECTOR,
    join(ROOT, 'plugins/sleight/bin/sleight-mcp')];
  const checks = required.map(path => ({ path, exists: existsSync(path) }));
  const engine = readEngine();
  return { command, checks, fixtureSHA256: createHash('sha256').update(readFileSync(FIXTURE)).digest('hex'), engine,
    config: { path: config ?? null, present: !!config && existsSync(config), accountLogin: 'deferred to live admission; no Claude or keychain call in dry-run' },
    ready: checks.every(c => c.exists) && !!engine.version };
}

function privateConfig(path) {
  if (!path) throw Error('Set CLAUDE_CONFIG_DIR to a disposable /tmp/lane-claude-* config with account login');
  const real = realpathSync(path), stat = lstatSync(path);
  // The world suite's sleight arm config already holds the account login (logins live per config folder), so it is accepted too.
  const armConfig = join(defaultArmHome(), 'sleight-arm', 'claude');
  const allowed = /^\/private\/tmp\/lane-claude-[A-Za-z0-9]+$/.test(real) || existsSync(armConfig) && real === realpathSync(armConfig);
  if (!allowed || !stat.isDirectory() || stat.isSymbolicLink() ||
    stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('CLAUDE_CONFIG_DIR must be an owned private /tmp/lane-claude-* directory or the sleight arm config');
  return real;
}

export async function main(argv) {
  let dryRun = false, ownerAway = false, out;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (seen.has(argv[i])) throw Error(`Repeated argument ${argv[i]}`); seen.add(argv[i]);
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--owner-away') ownerAway = true;
    else if (argv[i] === '--out' && argv[i + 1] && !argv[i + 1].startsWith('--')) out = resolve(argv[++i]);
    else throw Error(`Unknown or incomplete option ${argv[i]}`);
  }
  if (!dryRun) requireLiveBenchGate();
  const admission = staticChecks(process.env.CLAUDE_CONFIG_DIR);
  if (dryRun) { console.log(JSON.stringify({ ...probePlan(), admission }, null, 2)); return admission.ready ? 0 : 1; }
  if (!ownerAway) throw Error('Live focus probes require --owner-away');
  out ??= join(realpathSync(tmpdir()), `sf6-focus-${randomUUID()}`);
  mkdirSync(out, { mode: 0o700 });
  const controller = new AbortController();
  const stop = () => controller.abort(Error('SF6 probe interrupted'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const gate = async () => {
    while (!benchGateOpen()) await sleep(60000, undefined, { signal: controller.signal });
    await waitForHold({ signal: controller.signal });
    controller.signal.throwIfAborted();
  };
  let release, lockReleased = false, monitor, version = null, error;
  const rows = [], startedAt = utc();
  const commit = execFileSync('/usr/bin/git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const save = () => json(join(out, 'report.json'), makeReport(rows, { startedAt, endedAt: utc(), commit, claudeVersion: version,
    ...(error ? { error } : {}), lockReleased, liveLockRetained: !!release && !lockReleased, output: out }));
  try {
    if (!admission.ready) throw Error('Static admission failed; inspect --dry-run');
    const config = privateConfig(process.env.CLAUDE_CONFIG_DIR);
    const env = runtimeEnvironment(config, '');
    await gate();
    // Read-only CLI checks also use the disposable config. No auto-login or API fallback.
    version = execFileSync(admission.command, ['--version'], { env, encoding: 'utf8', timeout: 10000 }).trim();
    if (!version.startsWith(WORLD_CLAUDE_VERSION + ' ') && version !== WORLD_CLAUDE_VERSION) throw Error(`World CLI ${WORLD_CLAUDE_VERSION} required`);
    assertLogin({ command: admission.command, cwd: config, env });
    await gate(); release = await acquireLiveLock(undefined, { signal: controller.signal, wait: false });
    await gate();
    // A new quiet window stops active driving, then cleanup runs under the retained lock.
    monitor = setInterval(() => {
      if (existsSync('/tmp/sleight-hold') || !benchGateOpen()) controller.abort(Error('Quiet-window gate changed during the probe'));
    }, 500);
    for (const control of CONTROLS) {
      rows.push(await liveControl(control, { dir: join(out, control), config, command: admission.command, signal: controller.signal, gate }));
      save();
      if (!rows.at(-1).cleanup || Object.values(rows.at(-1).cleanup).some(value => value !== true) || controller.signal.aborted) break;
    }
  } catch (caught) { error = caught.message; }
  finally {
    clearInterval(monitor);
    if (release && rows.every(r => r.cleanup && ['browserClosed', 'profileDeleted', 'noWindows', 'driverCollected', 'modelCollected', 'serverClosed'].every(k => r.cleanup[k] === true))) {
      try { await release(); lockReleased = true; } catch (caught) { error = `Live lock: ${caught.message}`; }
    }
    save(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ report: join(out, 'report.json'), status: report.status, counts: report.counts,
    focusSampling: report.focusSampling, lockReleased }));
  return report.status === 'pass' && lockReleased && !error ? 0 : 1;
}
