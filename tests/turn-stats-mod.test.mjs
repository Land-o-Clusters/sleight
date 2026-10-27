// Execute the real hooks with an in-memory host. No Claude process, engine, app, pane snapshot or browser starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { costSnapshot, turnSummary, statsFromReply, turnStatsText } from '../plugins/sleight/hooks/turn-stats.mjs';

const root = fileURLToPath(new URL('../plugins/sleight/hooks/', import.meta.url));
const prefix = 'mcp__plugin_sleight_computer__';
const metrics = { calls: 3, reads: 1, characters: 55, text: { docs: 10, tree: 40, other: 5 }, errors: 0, pending: 0, omitted: 0, unclassified: 0, toolMs: 700,
  paths: { native: { actions: 2, estimatedActions: 2, estimatedCalls: 1, actionMs: 0, timedActions: 0 }, turbo: { actions: 0, estimatedActions: 0, estimatedCalls: 0, actionMs: 0, timedActions: 0 }, engine: { actions: 0, estimatedActions: 0, estimatedCalls: 0, actionMs: 0, timedActions: 0 } } };
const usage = { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56, cache_creation_input_tokens: 78, model: 'host-model' };

function host({ cost = true, missingUsage = false, marker = false, malicious = false, paneOpen = false, paneSnapshot = false, usageRead, messages, narration = 'off', settingRead, moduleRegister, envRead, statRead, turboSession, turnCall, logThrows = false, beginFails = false, beginCall, connectCall, privateCall } = {}) {
  const hooks = [], state = new Map(), work = [], begins = [], statuses = [], replies = [], forwarded = [], hookRuns = [], logs = [];
  const timers = [];
  const privateFrames = [], traffic = [];
  let usageReads = 0;
  const elements = Object.fromEntries(['Box', 'Text', 'Button'].map(name => [name, name]));
  const api = {
    atom: (id, initial) => { if (!state.has(id.key)) state.set(id.key, initial); return { ...id, initial }; },
    read: async ($, id) => $.testState.has(id.key) ? $.testState.get(id.key) : id.initial,
    update: async ($, id, fn) => { $.testState.set(id.key, fn($.testState.has(id.key) ? $.testState.get(id.key) : id.initial)); },
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file.replace(/\.mjs$/, '.ts'),
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
    const require = name => {
      if (name === 'claude-code') return api;
      assert.ok(name.startsWith('.'), `unexpected runtime dependency ${name}`);
      let target = resolve(dirname(file), name);
      if (!existsSync(target)) target += '.ts';
      return load(target);
    };
    runInNewContext('(function(require,module,exports){' + source + '\n})', { h: (type, props, ...children) => ({ type, props, children }), console })(require, module, module.exports);
    return module.exports;
  }
  const registerMod = moduleRegister ?? load(resolve(root, 'register.tsx')).register;
  registerMod((name, filter, handler) => {
    if (typeof filter === 'function') { handler = filter; filter = {}; }
    const hook = { name, filter, handler }; hooks.push(hook);
    return { catch(handler) { hook.errorHandler = handler; } };
  });
  let usd = 1;
  const $ = {
    testState: state,
    env: { get: async key => envRead ? envRead(key) : key === 'HOME' ? '/fixture/home' : undefined },
    fs: { stat: async path => statRead ? statRead(path) : ({ realPath: path }) },
    ui: { status: text => statuses.push(text), log: (text, options) => { logs.push({ text, options }); if (logThrows) throw Error('debug unavailable'); }, toast() {}, panes: async () => paneOpen ? [{ id: 'sleight' }] : [], open: async () => work.push('open'), resolve: () => elements },
    plugin: { root: '/fixture/plugin' },
    process: { run: async () => settingRead ? settingRead() : ({ exitCode: 0, stdout: JSON.stringify({ enabled: false, narration, presence: { idleSeconds: 0, locked: false } }) }) },
    session: { messages: async args => typeof messages === 'function' ? messages(args) : messages ?? [], usage: async () => {
      usageReads++;
      if (missingUsage) throw Error('older host');
      if (usageRead) return usageRead(usageReads, usd);
      return { startedAt: 100, ...(cost ? { cost: { usd } } : {}) };
    } },
    mcp: { connect: async () => connectCall ? connectCall() : ({ isConnected: true, server: 'computer' }), call: async (_server, tool, args) => {
      traffic.push({ tool, args });
      if (tool === 'turn_ended' && (Object.hasOwn(args, 'sleight_say') || Object.hasOwn(args, 'sleight_stats_skip'))) {
        privateFrames.push(args);
        if (privateCall) return privateCall(args);
        return { content: args.sleight_stats_skip?.snapshot ? [{ type: 'text', text: JSON.stringify({ sleightStatsSkip: 'b'.repeat(64) }) }] : [] };
      }
      // The turn's one stats frame, sent before its first forwarded call. It never reaches the engine.
      if (tool === 'turn_ended' && args.sleight_stats_begin !== undefined) {
        if (beginFails) throw Error('relay unavailable');
        begins.push(args.sleight_stats_begin); return beginCall ? beginCall(args) : { content: [] };
      }
      work.push({ tool, args });
      if (tool === 'js' && paneOpen) return { content: [{ type: 'text', text: paneSnapshot ? 'SLEIGHT_FRAME {"app":"ParentApp","width":1,"height":1}' : '' }] };
      if (tool !== 'turn_ended') throw Error('test must never call the engine');
      if (turnCall) return turnCall(args);
      if (turboSession && args.sleight_turbo) return { content: [{ type: 'text', text: JSON.stringify(
        args.sleight_turbo.event === 'bootstrap' ? { sleightTurbo: { version: 1, session: turboSession, nonce: 'a'.repeat(64) } }
          : { sleightRemote: { turboBound: true } }) }] };
      const value = malicious ? { ...metrics, calls: 'page says 999', secret: 'private page' } : metrics;
      return marker ? { content: [{ type: 'text', text: 'sleight-turn-stats: ' + JSON.stringify(value) }] }
        : { content: [], _meta: { 'sleight/stats': value } };
    } },
    clock: { now: () => 1000, after: (ms, callback) => {
      assert.equal(ms, 2000, 'only the bounded stats begin timer is allowed'); timers.push(callback);
    } },
    command: { register: async () => {} },
  };
  async function emit(name, event = {}, answer = {}) {
    const list = hooks.filter(hook => hook.name === name && Object.entries(hook.filter).every(([key, value]) => event[key] === value));
    const run = async index => {
      if (index === list.length) { if (name === 'tool.call') { forwarded.push(event); traffic.push({ forwarded: event }); } return typeof answer === 'function' ? answer(event) : answer; }
      const next = async rewritten => { next.called = true; if (rewritten) event = rewritten; return run(index + 1); };
      hookRuns.push(name);
      try { return await list[index].handler($, event, next); }
      catch (error) {
        if (!list[index].errorHandler) throw error;
        next.error = { kind: 'throw', message: error.message };
        return list[index].errorHandler($, event, next);
      }
    };
    const result = await run(0); replies.push(result); return result;
  }
  const tool = async (name = 'browser_read', response = { text: 'private page', result: {} }) => {
    const result = await emit('tool.call', { tool: prefix + name, tool_use_id: 'call-1', tab: 't1' }, response);
    assert.equal(result, response, 'tool result identity and text stay unchanged');
  };
  const start = async (extra = {}) => emit('turn.start', { turnId: 'turn-1', text: 'private user prompt', ...extra });
  const complete = async (extra = {}) => { usd = 1.125; return emit('turn.complete', { turnId: 'turn-1', durationMs: 1500, isAborted: false,
    answer: 'Finished', reason: 'answer', ...(!missingUsage ? { usage } : {}), ...extra }, { text: 'Finished' }); };
  const command = args => emit('command.run', { command: 'sleight', args });
  async function pane() {
    const tree = await emit('ui.render', { component: 'Pane', requestId: 'sleight', surface: 'terminal', props: { bodyColumns: 80, scroll: { bodyRows: 30 } } });
    const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('\n') : value?.children ? text(value.children) : '';
    return text(tree);
  }
  return { start, complete, tool, command, pane, work, begins, privateFrames, traffic, state, emit, forwarded, hookRuns, logs, timers, registerMod, get usageReads() { return usageReads; } };
}

for (const failure of ['bootstrap throw', 'bootstrap refusal', 'begin throw', 'begin refusal', 'retry', 'none'])
  test(`mod logs one payload-free line when turn binding fails: ${failure}`, async () => {
    let begins = 0;
    const envelope = { version: 1, session: 'fixture-session', nonce: 'a'.repeat(64) };
    const h = host({ turnCall: args => {
      const bootstrap = args.sleight_turbo.event === 'bootstrap';
      if (!bootstrap) begins++;
      if (failure === (bootstrap ? 'bootstrap throw' : 'begin throw')) throw Error('private refusal text');
      if (failure === (bootstrap ? 'bootstrap refusal' : 'begin refusal') || failure === 'retry' && !bootstrap && begins === 1)
        return { isError: true, content: [{ type: 'text', text: 'private refusal text' }] };
      return { content: [{ type: 'text', text: JSON.stringify(bootstrap ? { sleightTurbo: envelope } : { sleightRemote: {} }) }] };
    } });
    const result = await h.emit('prompt.submit', { text: 'allow TextEdit private user text', origin: { kind: 'composer' } }, event => event);
    assert.equal(result.context, undefined, 'failure diagnostics never enter model context');
    assert.equal(h.logs.length, ['retry', 'none'].includes(failure) ? 0 : 1);
    for (const row of h.logs) {
      assert.match(row.text, /turn_ended.*typed approvals/);
      assert.equal(row.options.to, 'debug');
      assert.doesNotMatch(row.text, /private|TextEdit|fixture-session|aaaa/);
    }
    assert.equal(begins, failure.startsWith('bootstrap') ? 0 : failure === 'none' ? 1 : 2);
  });

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const nextTick = () => new Promise(resolve => setImmediate(resolve));

test('three parallel main calls share one begin and all wait for its reply', async () => {
  const begin = deferred(), h = host({ beginCall: () => begin.promise }); await h.start();
  const calls = ['js', 'replay', 'browser_read'].map(name => h.tool(name));
  await nextTick();
  assert.deepEqual(h.begins, ['turn-1']); assert.equal(h.forwarded.length, 0);
  begin.resolve({ content: [] }); await Promise.all(calls);
  assert.equal(h.forwarded.length, 3);
  assert.equal(h.timers.length, 1, 'the timeout is cached with the begin');
});

test('a turn with subagent calls reports counters unavailable even if a child precedes the begin', async () => {
  const begin = deferred(), h = host({ beginCall: () => begin.promise }); await h.start();
  const main = h.tool(); await nextTick();
  await h.emit('tool.call', { tool: prefix + 'browser_read', agentId: 'child', tab: 't1' });
  begin.resolve({ content: [] }); await main; await h.complete();
  assert.match((await h.command('stats')).text, /stats unavailable/i);
  await h.start({ turnId: 'turn-2' }); await h.tool(); await h.complete({ turnId: 'turn-2' });
  assert.match((await h.command('stats')).text, /3 calls/);
});

for (const mode of ['refused', 'throw', 'timeout', 'late reply']) test(`a ${mode} begin forwards unchanged and leaves only this turn stats unavailable`, async () => {
  const begin = deferred();
  const h = host({ beginFails: mode === 'throw', beginCall: () => mode === 'refused' ? { isError: true, content: [] } : begin.promise });
  await h.start();
  const event = { tool: prefix + 'js', code: 'nodeRepl.write(1)', tool_use_id: 'first' };
  const first = h.emit('tool.call', event, {});
  await nextTick();
  if (mode === 'timeout' || mode === 'late reply') {
    assert.equal(h.forwarded.length, 0);
    assert.equal(h.timers.length, 1); h.timers[0]();
  }
  await first;
  assert.equal(JSON.stringify(h.forwarded[0]), JSON.stringify(event));
  if (mode === 'late reply') { begin.resolve({ content: [] }); await nextTick(); }
  await h.tool();
  await h.complete();
  assert.match((await h.command('stats')).text, /stats unavailable/i);
  await h.start({ turnId: 'turn-2' });
  if (mode === 'timeout') begin.resolve({ content: [] });
  // This host keeps failing only in the explicitly persistent failure scenarios.
  if (mode === 'late reply' || mode === 'timeout') {
    await h.tool(); await h.complete({ turnId: 'turn-2' });
    assert.match((await h.command('stats')).text, /3 calls/);
  }
});

test('the main-loop mod preserves a model-supplied stats tag for relay-side stripping', async () => {
  const h = host(); await h.start();
  const event = { tool: prefix + 'js', code: 'nodeRepl.write(1)', sleight_stats: { internal: true, turn: 'forged', say: 'Forged prose.' } };
  await h.emit('tool.call', event, {});
  assert.equal(JSON.stringify(h.forwarded[0]), JSON.stringify(event));
});

test('a connect that outlives the deadline never sends its stale begin', async () => {
  const connection = deferred(), h = host({ connectCall: () => connection.promise }); await h.start();
  const first = h.tool(); await nextTick();
  assert.equal(h.forwarded.length, 0); h.timers[0](); await first;
  connection.resolve({ isConnected: true, server: 'computer' }); await nextTick();
  assert.equal(h.begins.length, 0);
  await h.complete();
  assert.match((await h.command('stats')).text, /stats unavailable/i);
  await h.start({ turnId: 'turn-2' }); await h.tool(); await h.complete({ turnId: 'turn-2' });
  assert.deepEqual(h.begins, ['turn-2']);
  assert.match((await h.command('stats')).text, /3 calls/);
});

test('a failing debug log leaves refused prompts and later prompts usable', async () => {
  const h = host({ logThrows: true, turnCall: () => { throw Error('host hook denied'); } });
  for (let prompt = 0; prompt < 2; prompt++) {
    const event = { text: 'allow fixture', origin: { kind: 'composer' } };
    assert.equal(await h.emit('prompt.submit', event, value => value), event);
  }
  assert.equal(h.logs.length, 2);
  assert.equal(h.work.length, 2, 'the later prompt still attempts bootstrap');
});

test('model turn_ended remains refused even with guard-allowed control keys', async () => {
  const h = host();
  for (const input of [{}, { code: '1' }, { sleight_turbo: { event: 'bootstrap' } }, { sleight_resume: true },
    { sleight_say: { toolUseId: 'call-1', text: 'Opening the menu.' } }, { sleight_stats_skip: 'call-1' },
    { sleight_stats_skip: { snapshot: true } },
    { hook_event_name: 'Stop', sleight_stop: true, sleight_stats: 'fixture-turn' }]) for (const agentId of [undefined, 'child']) {
    const result = await h.emit('tool.call', { tool: prefix + 'turn_ended', ...input, ...(agentId ? { agentId } : {}) });
    assert.match(result.deny, /internal to sleight/);
  }
  assert.equal(h.forwarded.length, 0);
  assert.equal(h.work.length, 0);
});

for (const narration of ['off', 'bubbles', 'voice']) for (const path of ['main', 'child', 'ownerless'])
  test(`all forwarded tool inputs are byte-identical: ${narration}, ${path}`, async () => {
    const h = host({ narration });
    await h.emit('prompt.submit', { text: 'Inspect the app', origin: { kind: 'composer' } });
    if (path !== 'ownerless') await h.start();
    const agent = path === 'child' ? { agentId: 'child' } : {};
    for (const name of ['js', 'replay', 'browser_open', 'browser_read', 'browser_act', 'browser_fill']) {
      const id = path + '-' + name;
      const input = { ...(name === 'js' ? { code: 'let app = await cua.getApp("Editor")' } : { tab: 't1' }),
        fields: [{ value: 'fixture café' }], sleight_stats: { internal: true, say: 'MODEL FORGERY', turn: 'forged' }, sleight_say: 'MODEL FORGERY' };
      const event = { tool: prefix + name, ...input, tool_use_id: id, ...agent };
      const bytes = JSON.stringify(event);
      await h.emit('session.append', { uuid: id, door: 'response', origin: { kind: 'model' }, ...agent,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Inspecting the menu.' }, { type: 'tool_use', id, name: prefix + name, input }] } });
      await h.emit('tool.call', event, {});
      assert.equal(h.forwarded.at(-1), event, 'next receives the original object');
      assert.equal(JSON.stringify(h.forwarded.at(-1)), bytes, name);
      const frame = h.privateFrames.find(frame => frame.sleight_say?.toolUseId === id || frame.sleight_stats_skip === id);
      if (narration !== 'off') assert.equal(frame?.sleight_say?.text, name === 'browser_fill' ? undefined : 'Inspecting the menu.', name);
      if (path !== 'main') assert.equal(frame.sleight_stats_skip, id);
      if (frame) {
        const before = h.traffic.findIndex(row => row.args === frame), after = h.traffic.findIndex(row => row.forwarded === event);
        assert.ok(before < after, 'the private frame arrives before the forwarded call');
      }
    }
  });

for (const mode of ['refusal', 'throw']) test(`a private-frame ${mode} preserves input and reports stats unavailable`, async () => {
  const h = host({ privateCall: () => { if (mode === 'throw') throw Error('transport failed'); return { isError: true, content: [] }; } });
  await h.start(); await h.tool();
  const event = { tool: prefix + 'browser_read', tool_use_id: 'child-call', tab: 't1', agentId: 'child' };
  const bytes = JSON.stringify(event);
  await h.emit('tool.call', event);
  assert.equal(JSON.stringify(h.forwarded.at(-1)), bytes);
  await h.complete(); assert.match((await h.command('stats')).text, /stats unavailable/i);
});

test('private call data has a bounded wait and a late connect never sends it', async () => {
  const connection = deferred(); let connects = 0;
  const h = host({ connectCall: () => ++connects === 1 ? { isConnected: true, server: 'computer' } : connection.promise });
  await h.start(); await h.tool();
  const event = { tool: prefix + 'browser_read', tool_use_id: 'child-call', agentId: 'child', tab: 't1' };
  const pending = h.emit('tool.call', event); await nextTick();
  assert.equal(h.forwarded.length, 1); assert.equal(h.timers.length, 2);
  h.timers[1](); await pending;
  assert.equal(h.forwarded.at(-1), event);
  connection.resolve({ isConnected: true, server: 'computer' }); await nextTick();
  assert.equal(h.privateFrames.length, 0, 'the expired exclusion never arrives on a later turn');
  await h.complete(); assert.match((await h.command('stats')).text, /stats unavailable/i);
});

test('a refused pane exclusion skips the snapshot and still ends the turn', async () => {
  const h = host({ paneOpen: true, privateCall: () => ({ isError: true, content: [] }) }); await h.start();
  await h.emit('tool.call', { tool: prefix + 'js', tool_use_id: 'main', code: 'let app = await cua.getApp("Editor")' }, { text: 'App: Editor.' });
  await h.complete();
  assert.deepEqual(h.work.map(row => row.tool), ['turn_ended']);
  assert.equal(h.state.get('view').kind, 'error');
});

test('pane snapshots request a one-shot exclusion before their own js call', async () => {
  const h = host({ paneOpen: true, paneSnapshot: true }); await h.start();
  await h.emit('tool.call', { tool: prefix + 'js', tool_use_id: 'main', code: 'let app = await cua.getApp("Editor")' }, { text: 'App: Editor.' });
  await h.complete();
  const index = h.traffic.findIndex(row => row.args?.sleight_stats_skip?.snapshot === true);
  assert.ok(index >= 0);
  assert.equal(h.traffic[index + 1].tool, 'js');
  assert.equal(h.traffic[index + 1].args.sleight_stats.internal, 'b'.repeat(64));
  assert.equal(h.traffic[index + 2].args.hook_event_name, 'Stop');
});

// Public hook JSON has snake_case identity and nested arguments. The mod's
// published ToolCallEnvelope flattens the arguments; tool.call adds agentId.
const teammatePayload = (tool, input, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'teammate-session',
  transcript_path: '/fixture/config/projects/repo/teammate-session.jsonl', cwd: '/fixture/worktree',
  tool_name: tool, tool_input: input, tool_use_id: 'same-call-id', ...extra,
});
const modEnvelope = payload => ({ ...payload.tool_input, tool: payload.tool_name, tool_use_id: payload.tool_use_id,
  ...(payload.agent_id !== undefined ? { agentId: payload.agent_id } : {}) });

for (const identity of [{}, { prompt_id: null }, { agent_id: 'teammate-a', agent_type: 'general-purpose' },
  { session_id: undefined, transcript_path: undefined, cwd: undefined, tool_use_id: undefined }])
  test(`teammate guards do not need prompt or transcript identity: ${JSON.stringify(identity)}`, async () => {
    const h = host({ messages: () => { throw Error('parent transcript read'); } });
    const path = '/fixture/home/Library/Application Support/sleight/hand.json';
    for (const [tool, input] of [['Write', { file_path: path, content: '{}' }], ['Bash', { command: `rm '${path}'` }],
      ['Bash', { command: 'sleight-mcp cursor import fixture' }],
      ['Edit', { file_path: '/fixture/settings.json', new_string: 'SLEIGHT_ACTION_LOG=1' }]]) {
      const payload = teammatePayload(tool, input, identity);
      // classic.PreToolUse carries no loop id. None is needed for a stateless refusal.
      const event = modEnvelope(payload); delete event.agentId;
      for (const shape of [event, payload]) assert.match((await h.emit('classic.PreToolUse', shape)).deny, /Only the user/);
    }
    assert.equal(h.work.length, 0);
  });

for (const prompt_id of [undefined, null]) test(`promptless separate teammate completes with prompt_id ${prompt_id}`, async () => {
  const h = host();
  await h.start();
  await h.emit('tool.call', modEnvelope(teammatePayload(prefix + 'browser_read', { tab: 'fixture' }, { prompt_id })));
  await h.complete();
  assert.equal(h.work.length, 1);
  assert.equal(h.work[0].args.hook_event_name, 'Stop');
  assert.equal(h.forwarded[0].sleight_stats, undefined, 'the main loop forwards the model input as sent');
  assert.deepEqual(h.begins, ['turn-1']);
});

test('in-process teammates keep shell fences when another loop completes', async () => {
  const h = host(), command = 'open fixture.pdf';
  const shell = agentId => h.emit('tool.call', { tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) }, { allowed: true });
  for (const agent_id of ['teammate-a', 'teammate-b'])
    await h.emit('tool.call', modEnvelope(teammatePayload(prefix + 'browser_read', { tab: 'fixture' }, { agent_id })));
  assert.match((await shell('teammate-a')).deny, /shell guard/);
  assert.match((await shell('teammate-b')).deny, /shell guard/);
  assert.match((await shell()).deny, /shell guard/, 'child work fences every caller');
  assert.match((await shell('unused-teammate')).deny, /shell guard/);
  await h.complete();
  assert.match((await shell('teammate-a')).deny, /shell guard/, 'main completion cannot clear the child fence');
  await h.complete({ agentId: 'teammate-a' });
  assert.match((await shell('teammate-a')).deny, /shell guard/, 'the other child still owns its fence');
  assert.match((await shell('teammate-b')).deny, /shell guard/);
  await h.complete({ agentId: 'teammate-b' });
  assert.equal((await shell('teammate-b')).allowed, true);
});

test('lead sleight work refuses a teammate launcher until every loop completes', async () => {
  const h = host(); await h.start(); await h.tool();
  const shell = () => h.emit('tool.call', { tool: 'Bash', agentId: 'teammate', command: 'open -a Safari' }, { allowed: true });
  assert.match((await shell()).deny, /shell guard/);
  await h.emit('tool.call', { tool: prefix + 'browser_read', agentId: 'teammate' });
  await h.complete();
  assert.match((await shell()).deny, /shell guard/);
  await h.complete({ agentId: 'teammate' });
  assert.equal((await shell()).allowed, true);
});

test('a malformed loop id cannot choose an inactive shell fence', async () => {
  const h = host();
  for (const agentId of [null, '', 7, {}]) {
    const result = await h.emit('tool.call', { tool: 'Bash', command: 'open fixture.pdf', agentId });
    assert.match(result.deny, /shell guard/);
  }
});

test('guard environment failures refuse the call instead of skipping protection', async () => {
  const h = host({ envRead: () => { throw Error('identity environment unavailable'); } });
  assert.match((await h.emit('classic.PreToolUse', { tool: 'Write', file_path: '/fixture/file' })).deny, /guard unavailable/);
  await h.tool();
  assert.match((await h.emit('tool.call', { tool: 'Bash', command: 'open fixture.pdf' })).deny, /shell guard/);
});

for (const unavailable of ['root', 'component']) test(`an unavailable guard ${unavailable} refuses an alias write`, async () => {
  const h = host({
    statRead: path => unavailable === 'root' ? undefined : unavailable === 'component' && path === '/fixture' ? { isLink: true } : { realPath: path },
  });
  assert.match((await h.emit('classic.PreToolUse', { tool: 'Write', file_path: '/fixture/alias' })).deny, /cannot resolve.*path/i);
});

for (const key of ['HOME', 'CLAUDE_CONFIG_DIR']) for (const value of [undefined, 'relative', null])
  test(`an unavailable ${key} only refuses paths that need it: ${String(value)}`, async () => {
    const h = host({ envRead: name => name === key ? value : name === 'HOME' ? '/fixture/home' : undefined });
    for (const command of ['ls', 'ls /fixture', 'printf ok > /fixture/output']) {
      const result = await h.emit('classic.PreToolUse', { tool: 'Bash', command }, { allowed: true });
      assert.equal(result.allowed, true, command);
    }
    assert.equal((await h.emit('classic.PreToolUse', { tool: 'Write', file_path: '/fixture/output' }, { allowed: true })).allowed, true);
    const paths = key === 'HOME' ? ['~/notes', '$HOME/notes', '${HOME}/notes', '~/notes with spaces']
      : ['$CLAUDE_CONFIG_DIR/notes', '${CLAUDE_CONFIG_DIR}/notes', '$CLAUDE_CONFIG_DIR/notes with spaces'];
    // An unset CLAUDE_CONFIG_DIR is Claude Code's default, ~/.claude, so its paths resolve against HOME.
    const resolves = key === 'CLAUDE_CONFIG_DIR' && value === undefined;
    for (const path of paths) {
      for (const event of [{ tool: 'Write', file_path: path }, { tool: 'Bash', command: `printf ok > "${path}"` }]) {
        if (resolves) assert.equal((await h.emit('classic.PreToolUse', event, { allowed: true })).allowed, true, JSON.stringify(event));
        else assert.match((await h.emit('classic.PreToolUse', event)).deny, /cannot resolve.*path/i, JSON.stringify(event));
      }
    }
    if (resolves) assert.ok((await h.emit('classic.PreToolUse', { tool: 'Bash', command: 'rm -rf "$CLAUDE_CONFIG_DIR/plugins"' })).deny,
      'the default config folder keeps sleight\'s plugin install protected');
    assert.match((await h.emit('classic.PreToolUse', { tool: 'Write', file_path: '/fixture/home/Library/Application Support/sleight/hand.json' })).deny, /Only the user/);
  });

test('missing home still resolves literal aliases before allowing a write', async () => {
  const h = host({ envRead: () => undefined, statRead: path => ({ realPath: path === '/fixture/alias' ? '/fixture/home/Library/Application Support/sleight/hand.json' : path }) });
  assert.match((await h.emit('classic.PreToolUse', { tool: 'Write', file_path: '/fixture/alias' })).deny, /Only the user/);
});

test('unreadable or conflicting classic hook envelopes refuse without a session fallback', async () => {
  const h = host();
  for (const event of [{}, { tool_name: 'Write' }, { tool: 'Read', tool_name: 'Write', tool_input: { file_path: '/fixture/file' } }])
    assert.match((await h.emit('classic.PreToolUse', event)).deny, /guard unavailable/);
  const raw = teammatePayload('Read', { file_path: '/fixture/file' });
  assert.equal(await h.emit('classic.PreToolUse', raw, raw), raw, 'valid reads still pass unchanged');
});

test('a child prompt cannot lift Stop or consume a parent pane notice', async () => {
  const h = host();
  await h.command('stop');
  const before = h.work.length;
  await h.emit('prompt.submit', { text: 'inbox work', agentId: 'teammate', origin: { kind: 'composer' } });
  assert.equal(h.state.get('stopped'), true);
  assert.equal(h.work.length, before, 'no relay resume or approval bootstrap');
  assert.match((await h.emit('tool.call', { tool: prefix + 'browser_read', agentId: 'teammate' })).deny, /user stopped/);
});

test('child tools leave the main pane app, log and stats untouched', async () => {
  const h = host(); await h.start();
  await h.emit('tool.call', { tool: prefix + 'js', code: 'await cua.getApp("ParentApp")', tool_use_id: 'same' }, { text: 'App: ParentApp.' });
  const before = JSON.stringify(h.state.get('log'));
  await h.emit('tool.call', { tool: prefix + 'js', agentId: 'teammate', code: 'await cua.getApp("ChildApp")', tool_use_id: 'same' }, { text: 'App: ChildApp.' });
  assert.equal(JSON.stringify(h.state.get('log')), before);
  assert.equal(h.state.get('frame'), null);
  assert.equal(h.forwarded.at(-1).sleight_stats, undefined);
  assert.equal(h.privateFrames.at(-1).sleight_stats_skip, 'same');
  assert.doesNotMatch(await h.pane(), /ChildApp/);
});

for (const caller of [undefined, 'teammate']) test(`a js call clears only its loop's pane notice: ${caller ?? 'lead'}`, async () => {
  const h = host({ paneOpen: true, paneSnapshot: true });
  await h.start();
  await h.start({ agentId: 'teammate' });
  await h.emit('tool.call', { tool: prefix + 'js', code: 'await cua.getApp("ParentApp")' }, { text: 'App: ParentApp.' });
  await h.complete();
  await h.emit('tool.call', { tool: prefix + 'js', ...(caller ? { agentId: caller } : {}), code: 'await app.getAXState()' });
  const prompt = async agentId => h.emit('prompt.submit', { text: 'continue', ...(agentId ? { agentId } : {}) }, e => e);
  const lead = await prompt(), child = await prompt('teammate');
  assert.equal(JSON.stringify(lead.context ?? []).includes('disableDiffing'), caller !== undefined);
  assert.equal(JSON.stringify(child.context ?? []).includes('disableDiffing'), caller === undefined);
  assert.equal((await prompt('teammate')).context, undefined, 'the child consumes its own notice once');
});

for (const start of [true, false]) test(`a child busy fence ends with its own completion, turn.start ${start}`, async () => {
  const h = host();
  if (start) await h.start({ agentId: 'teammate', turnId: 'child-turn' });
  else await h.emit('tool.call', { tool: prefix + 'browser_read', agentId: 'teammate' });
  assert.match((await h.command('record')).text, /Wait for the current run/);
  await h.complete({ agentId: 'teammate', turnId: 'child-turn' });
  assert.ok((await paneLabels(h)).includes('Refresh'));
  assert.doesNotMatch((await h.command('replay')).text, /Wait for the current run/);
});

for (const boundary of ['session.start', 'session.compact', 'stop', 'lead.complete'])
  test(`an abandoned child cannot hold refresh, record or replay after ${boundary}`, async () => {
    const h = host(); await h.start(); await h.start({ agentId: 'abandoned' });
    await h.emit('tool.call', { tool: prefix + 'browser_read', agentId: 'abandoned' });
    assert.match((await h.command('record')).text, /Wait for the current run/);
    if (boundary === 'lead.complete') await h.complete();
    else if (boundary === 'stop') await h.command('stop');
    // Compaction lands mid-turn and keeps the lead's turn running; the lead's next completion then frees the child's hold.
    else if (boundary === 'session.compact') { await h.emit(boundary); await h.complete(); }
    else await h.emit(boundary);
    assert.ok((await paneLabels(h)).includes('Refresh'));
    assert.doesNotMatch((await h.command('record')).text, /Wait for the current run/);
    assert.doesNotMatch((await h.command('replay fixture.json')).text, /Wait for the current run/);
    const shell = await h.emit('tool.call', { tool: 'Bash', command: 'open -a Safari' }, { allowed: true });
    if (boundary === 'lead.complete' || boundary === 'session.compact') assert.match(shell.deny, /shell guard/, 'busy expiry must preserve the shell fence');
    else assert.equal(shell.allowed, true);
  });

test('a child call after its completion expires at the next lead completion', async () => {
  const h = host(); await h.start({ agentId: 'late' }); await h.complete({ agentId: 'late' });
  await h.emit('tool.call', { tool: prefix + 'browser_read', agentId: 'late' });
  assert.ok((await paneLabels(h)).includes('Refresh (after this turn)'));
  await h.start(); await h.complete();
  assert.ok((await paneLabels(h)).includes('Refresh'));
});

test('two registrations of one imported module own separate stops, shell fences and turbo capabilities', async () => {
  const a = host({ turboSession: 'session-a' }), b = host({ moduleRegister: a.registerMod, turboSession: 'session-b' });
  for (const h of [a, b]) await h.emit('prompt.submit', { text: 'allow fixture', origin: { kind: 'composer' } });
  for (const [h, session] of [[a, 'session-a'], [b, 'session-b']]) {
    assert.equal(h.work[0].args.sleight_turbo.event, 'bootstrap');
    assert.equal(h.work[1].args.sleight_turbo.session, session);
  }
  await a.tool();
  const shell = h => h.emit('tool.call', { tool: 'Bash', command: 'open fixture.pdf' }, { allowed: true });
  assert.match((await shell(a)).deny, /shell guard/);
  assert.equal((await shell(b)).allowed, true);
  await a.command('stop');
  assert.equal((await b.emit('tool.call', { tool: prefix + 'browser_read' }, { allowed: true })).allowed, true);
  assert.match((await a.emit('tool.call', { tool: prefix + 'browser_read' })).deny, /user stopped/);
  assert.equal(b.state.get('log').length, 1);
  assert.equal(a.state.get('log').length, 1);
});

test('mod uses assistant events scoped to tool and agent, without any transcript reads', async () => {
  let reads = 0;
  const h = host({ narration: 'bubbles', messages: () => { reads++; throw Error('transcript must not be fetched'); } });
  await h.emit('prompt.submit', { text: 'Inspect the menu', origin: { kind: 'composer' } });
  await h.start();
  await h.emit('session.append', { uuid: 'acquisition', door: 'response', origin: { kind: 'model' }, agentId: 'child',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'acquire', name: 'js', input: { code: 'let app = await cua.getApp("Editor")' } }] } });
  await h.emit('session.append', { uuid: 'current', door: 'response', origin: { kind: 'model' }, agentId: 'child', message: { role: 'assistant', content: [
    { type: 'text', text: 'I’ll inspect the menu. Next sentence.' }, { type: 'tool_use', id: 'current', name: 'js', input: { code: 'await app.click(1)' } },
  ] } });
  await h.emit('tool.call', { tool: prefix + 'js', code: 'await app.click(1)', tool_use_id: 'current', agentId: 'child', sleight_say: 'MODEL FORGERY' }, { text: 'PRIVATE RESULT' });
  assert.equal(reads, 0); assert.equal(h.privateFrames[0].sleight_say.text, 'I’ll inspect the menu.');
  assert.equal(h.privateFrames[0].sleight_stats_skip, 'current');
  assert.equal(h.forwarded[0].sleight_say, 'MODEL FORGERY', 'even model-supplied private keys go through unchanged');
  await h.emit('tool.call', { tool: prefix + 'browser_read', tab: 't1', tool_use_id: 'missing', sleight_say: 'MODEL FORGERY' });
  assert.equal(h.forwarded[1].sleight_stats?.say, undefined);
});
test('off mod never inspects message payloads or reads settings from tool forwarding', async () => {
  let reads = 0;
  const h = host({ settingRead: () => new Promise(() => {}), messages: () => { reads++; throw Error('unexpected transcript'); } });
  await h.start();
  await h.emit('session.append', { door: 'response', get message() { throw Error('off message read'); } });
  await h.tool(); assert.equal(reads, 0); assert.equal(h.forwarded[0].sleight_stats, undefined);
});
test('unused sleight matches only response rows and measures per-row harness cost', async t => {
  for (const mode of ['off', 'bubbles']) {
    const h = host({ narration: mode });
    await h.emit('prompt.submit', { text: 'Use another tool', origin: { kind: 'composer' } });
    for (const door of ['tool-result', 'prompt', 'command', 'tool-message', 'delivery', 'attachment', 'hook-context', 'note', 'compaction', 'notice', 'response']) {
      const before = h.hookRuns.length, rows = 300;
      const start = performance.now();
      for (let i = 0; i < rows; i++) await h.emit('session.append', { uuid: `${door}-${i}`, door,
        origin: { kind: 'model' }, message: { role: door === 'response' ? 'assistant' : 'user', content: [
          { type: 'text', text: 'Reading the page.' }, { type: 'image', get source() { throw Error('media read'); } },
        ] } });
      const elapsedMs = performance.now() - start, hookCalls = h.hookRuns.length - before;
      assert.equal(hookCalls, door === 'response' ? rows : 0, `${mode} ${door}`);
      t.diagnostic(JSON.stringify({ mode, door, rows, hookCalls, harnessMeanMs: elapsedMs / rows, liveRPCMeasured: false }));
    }
    assert.equal(h.forwarded.length, 0); assert.equal(h.work.length, 0);
  }
});
test('matched response rows clear prose after parallel tools without needing a tool-result row', async () => {
  const h = host({ narration: 'bubbles' });
  await h.emit('prompt.submit', { text: 'Read pages', origin: { kind: 'composer' } });
  const row = (uuid, content) => h.emit('session.append', { uuid, door: 'response', origin: { kind: 'model' }, message: { role: 'assistant', content } });
  const tool = id => ({ type: 'tool_use', id, name: prefix + 'browser_read', input: { tab: 't1' } });
  await row('parallel', [{ type: 'text', text: 'Reading the page.' }, tool('a'), tool('b')]);
  // The tool-result row is deliberately absent: the host matcher must exclude it.
  await row('later', [tool('c')]);
  for (const id of ['a', 'b', 'c']) await h.emit('tool.call', { tool: prefix + 'browser_read', tab: 't1', tool_use_id: id });
  assert.deepEqual(h.privateFrames.map(e => e.sleight_say?.text), ['Reading the page.', 'Reading the page.', undefined]);
  assert.ok(h.forwarded.every(e => !Object.hasOwn(e, 'sleight_stats')));
});
async function paneLabels(h) {
  const tree = await h.emit('ui.render', { component: 'Pane', requestId: 'sleight', surface: 'terminal', props: {} });
  const labels = node => Array.isArray(node) ? node.flatMap(labels) : node && typeof node === 'object' ? [node.props?.label, ...labels(node.children)] : [];
  return labels(tree);
}

for (const extra of [{}, { agentId: 'child', turnId: 'child-turn' }]) test(`every turn start gates pane refresh, record and replay: ${JSON.stringify(extra)}`, async () => {
  const h = host(); await h.start(extra);
  assert.ok((await paneLabels(h)).includes('Refresh (after this turn)'));
  assert.match((await h.command('record')).text, /Wait for the current run/);
  assert.match((await h.command('replay fixture.json')).text, /Wait for the current run/);
  assert.equal(h.usageReads, extra.agentId ? 0 : 1);
});

test('a never-resolving usage read cannot delay turn.start or an unused turn', async () => {
  const h = host({ usageRead: () => new Promise(() => {}) });
  const start = h.start();
  assert.equal(await Promise.race([start.then(() => true), nextTick().then(() => false)]), true);
  assert.ok((await paneLabels(h)).includes('Refresh (after this turn)'));
  await h.complete();
  assert.equal(h.usageReads, 1, 'unused completion does not read usage again');
  assert.equal(h.work.length, 0);
  assert.match((await h.command('stats')).text, /No completed/);
});

test('a hung final usage read cannot delay the pane snapshot, Stop or stats command', async () => {
  const h = host({ paneOpen: true, usageRead: n => n === 1
    ? { startedAt: 100, cost: { usd: 1 } } : new Promise(() => {}) });
  await h.start();
  await h.emit('tool.call', { tool: prefix + 'js', code: 'await cua.getApp("Example")', tool_use_id: 'main' }, { text: 'App: Example.', result: {} });
  const completion = h.complete();
  assert.equal(await Promise.race([completion.then(() => true), nextTick().then(() => false)]), true,
    'completion returns even when the final usage read never resolves');
  assert.deepEqual(h.work.map(row => row.tool), ['js', 'turn_ended']);
  assert.equal(h.work[1].args.hook_event_name, 'Stop');
  assert.equal(h.work[1].args.sleight_stats, 'turn-1');
  const command = h.command('stats');
  assert.equal(await Promise.race([command.then(() => true), nextTick().then(() => false)]), true);
  const text = (await command).text;
  assert.match(text, /55 characters/);
  assert.match(text, /Host cost \(session total so far, including subagents\): unavailable/);
  assert.match(text, /since turn start: unavailable/);
  assert.match(await h.pane(), /Host cost.*unavailable/);
  assert.equal(h.usageReads, 2);
});

for (const isAborted of [false, true]) test(`throwing completion still cleans up before a hung final usage read: ${isAborted}`, async () => {
  const h = host({ paneOpen: true, usageRead: n => n === 1
    ? { startedAt: 100, cost: { usd: 1 } } : new Promise(() => {}) });
  await h.start();
  await h.emit('tool.call', { tool: prefix + 'js', code: 'await cua.getApp("Example")' }, { text: 'App: Example.' });
  const failure = Error('downstream completion failed');
  await assert.rejects(h.emit('turn.complete', { turnId: 'turn-1', isAborted }, () => { throw failure; }), error => error === failure);
  assert.deepEqual(h.work.map(row => row.tool), isAborted ? ['turn_ended'] : ['js', 'turn_ended']);
  assert.equal(h.work.at(-1).args.hook_event_name, isAborted ? 'Interrupt' : 'Stop');
  assert.equal(h.work.at(-1).args.sleight_stats, 'turn-1');
  assert.equal(h.usageReads, 2);
  assert.match((await h.command('stats')).text, /55 characters/);
  assert.ok((await paneLabels(h)).includes('Refresh'), 'turnRunning resets on a throwing completion');
  const work = h.work.length;
  await h.complete();
  assert.equal(h.work.length, work, 'usedThisTurn resets on a throwing completion');
});

test('a throwing subagent completion preserves the main turn stats and cleanup owner', async () => {
  const h = host(); await h.start(); await h.tool();
  await assert.rejects(h.emit('turn.complete', { turnId: 'child-turn', agentId: 'child' }, () => { throw Error('child failed'); }), /child failed/);
  assert.equal(h.work.length, 0);
  assert.equal(h.usageReads, 1);
  assert.match((await h.command('stats')).text, /No completed/);
  await h.complete();
  assert.equal(h.work.at(-1).args.sleight_stats, 'turn-1');
  assert.match((await h.command('stats')).text, /55 characters/);
});

test('a late final usage read patches cost after Stop while preserving the completed stats', async () => {
  const final = deferred();
  let workAtFinalRead;
  const h = host({ paneOpen: true, usageRead: n => {
    if (n === 1) return { startedAt: 100, cost: { usd: 1 } };
    workAtFinalRead = h.work.map(row => row.tool);
    return final.promise;
  } });
  await h.start();
  await h.emit('tool.call', { tool: prefix + 'js', code: 'await cua.getApp("Example")', tool_use_id: 'main' }, { text: 'App: Example.', result: {} });
  const completion = h.complete();
  assert.equal(await Promise.race([completion.then(() => true), nextTick().then(() => false)]), true);
  assert.deepEqual(workAtFinalRead, ['js', 'turn_ended'], 'read starts only after the pane snapshot and engine cleanup');
  const before = h.state.get('stats');
  assert.equal(before.costUsd, null);
  final.resolve({ startedAt: 100, cost: { usd: 1.375 } }); await nextTick();
  const after = h.state.get('stats');
  assert.equal(after.costUsd, 1.375); assert.equal(after.costDeltaUsd, 0.375);
  assert.equal(JSON.stringify({ ...after, costUsd: null, costDeltaUsd: null }), JSON.stringify(before));
  assert.match((await h.command('stats')).text, /since turn start: \$0\.3750/);
  assert.match(await h.pane(), /\$1\.3750/);
  assert.equal(h.work.length, 2, 'patching cost does not send another engine call');
});

for (const nextId of ['turn-2', 'turn-1']) test(`an older final usage read cannot patch newer completed stats: ${nextId}`, async () => {
  const old = deferred();
  const h = host({ usageRead: n => n === 2 ? old.promise
    : { startedAt: 100, cost: { usd: n === 1 ? 1 : n === 3 ? 3 : 4 } } });
  await h.start(); await h.tool();
  const completion = h.complete();
  assert.equal(await Promise.race([completion.then(() => true), nextTick().then(() => false)]), true);
  await h.start({ turnId: nextId }); await h.tool(); await h.complete({ turnId: nextId, durationMs: 2500 });
  await nextTick();
  const latest = (await h.command('stats')).text;
  assert.match(latest, /2\.5 s/); assert.match(latest, /\$4\.0000/);
  assert.match(latest, /since turn start: \$1\.0000/);
  old.resolve({ startedAt: 100, cost: { usd: 2 } }); await nextTick();
  assert.equal((await h.command('stats')).text, latest);
});

test('a late final usage read still patches the latest stats during a later unused turn', async () => {
  const final = deferred();
  const h = host({ usageRead: n => n === 2 ? final.promise : { startedAt: 100, cost: { usd: 1 } } });
  await h.start(); await h.tool();
  const completion = h.complete();
  assert.equal(await Promise.race([completion.then(() => true), nextTick().then(() => false)]), true);
  await h.start({ turnId: 'turn-2' }); await h.complete({ turnId: 'turn-2' });
  final.resolve({ startedAt: 100, cost: { usd: 1.5 } }); await nextTick();
  const text = (await h.command('stats')).text;
  assert.match(text, /1\.5 s/); assert.match(text, /since turn start: \$0\.5000/);
});

test('a checked Stop completion also returns before its final usage read', async () => {
  const final = deferred();
  const h = host({ usageRead: n => n === 1 ? { startedAt: 100, cost: { usd: 1 } } : final.promise });
  await h.start(); await h.tool(); await h.command('stop');
  const completion = h.complete({ isAborted: true });
  assert.equal(await Promise.race([completion.then(() => true), nextTick().then(() => false)]), true);
  const before = (await h.command('stats')).text;
  assert.match(before, /interrupted/); assert.match(before, /55 characters/); assert.match(before, /Host cost.*unavailable/);
  final.resolve({ startedAt: 100, cost: { usd: 1.25 } }); await nextTick();
  const after = (await h.command('stats')).text;
  assert.match(after, /interrupted/); assert.match(after, /55 characters/); assert.match(after, /since turn start: \$0\.2500/);
  assert.equal(h.work.length, 1, 'checked Stop is not sent twice');
});

test('a delayed start cost is recorded on its owner after the start hook returns', async () => {
  const baseline = deferred();
  const h = host({ usageRead: n => n === 1 ? baseline.promise : { startedAt: 100, cost: { usd: 2 } } });
  const start = h.start();
  assert.equal(await Promise.race([start.then(() => true), nextTick().then(() => false)]), true);
  baseline.resolve({ startedAt: 100, cost: { usd: 1.5 } }); await nextTick();
  await h.tool(); await h.complete();
  assert.match((await h.command('stats')).text, /since turn start: \$0\.5000/);
});

test('an unresolved baseline does not delay a used completion or invent a delta', async () => {
  const baseline = deferred();
  const h = host({ usageRead: n => n === 1 ? baseline.promise : { startedAt: 100, cost: { usd: 2 } } });
  const start = h.start();
  assert.equal(await Promise.race([start.then(() => true), nextTick().then(() => false)]), true);
  await h.tool(); await h.complete();
  const text = (await h.command('stats')).text;
  assert.match(text, /\$2\.0000/); assert.match(text, /since turn start: unavailable/);
  baseline.resolve({ startedAt: 100, cost: { usd: 1 } }); await nextTick();
  assert.equal((await h.command('stats')).text, text, 'late baseline does not revise a completed summary');
});

test('a late baseline from an older start cannot overwrite the next main turn', async () => {
  const old = deferred();
  const h = host({ usageRead: n => n === 1 ? old.promise : { startedAt: 100, cost: { usd: n === 2 ? 3 : 4 } } });
  const start = h.start();
  assert.equal(await Promise.race([start.then(() => true), nextTick().then(() => false)]), true);
  await h.start({ turnId: 'turn-2' }); await nextTick();
  old.resolve({ startedAt: 100, cost: { usd: 1 } }); await nextTick();
  await h.tool(); await h.complete({ turnId: 'turn-2' });
  assert.match((await h.command('stats')).text, /since turn start: \$1\.0000/);
});

for (const name of ['js', 'replay', 'browser_read']) test(`an interrupted pending ${name} call already owns stats`, async () => {
  const h = host(); await h.start();
  const entered = deferred(), reply = deferred();
  const running = h.emit('tool.call', { tool: prefix + name, code: 'await app.click(1)' }, () => { entered.resolve(); return reply.promise; });
  await entered.promise;
  try {
    await h.command('stop');
    assert.equal(h.work.at(-1).args.sleight_stats, 'turn-1', 'Stop collects the pending call before its reply');
    await h.complete({ isAborted: true });
    assert.match((await h.command('stats')).text, /interrupted/);
    assert.equal(h.usageReads, 2);
  } finally { reply.resolve({ text: 'done' }); await running; }
});

test('a downstream denial cannot erase another pending call from stats', async () => {
  const h = host(); await h.start();
  const entered = deferred(), reply = deferred();
  const running = h.emit('tool.call', { tool: prefix + 'js', code: 'await app.click(1)' }, () => { entered.resolve(); return reply.promise; });
  await entered.promise;
  try {
    await h.emit('tool.call', { tool: prefix + 'browser_read' }, { deny: 'host policy refused' });
    await h.complete({ isAborted: true });
    assert.equal(h.work.at(-1).args.sleight_stats, 'turn-1');
    assert.match((await h.command('stats')).text, /interrupted/);
  } finally { reply.resolve({ text: 'done' }); await running; }
});

test('a thrown downstream call still shows interrupted stats', async () => {
  const h = host(); await h.start();
  await assert.rejects(h.emit('tool.call', { tool: prefix + 'js' }, () => { throw Error('interrupted'); }), /interrupted/);
  await h.complete({ isAborted: true });
  assert.equal(h.work.at(-1).args.sleight_stats, 'turn-1');
  assert.match((await h.command('stats')).text, /interrupted/);
});

test('pane and /sleight stats show the last turn duration, counts, host tokens and cost', async () => {
  const h = host(); await h.start(); await h.tool();
  assert.equal((await h.complete()).text, 'Finished', 'turn completion does not append model-facing text');
  const result = await h.command('stats');
  assert.match(result.text, /1\.5 s/); assert.match(result.text, /3 calls/); assert.match(result.text, /1 read-only call/);
  assert.match(result.text, /55 characters/); assert.match(result.text, /2.*from code/);
  assert.match(result.text, /docs 10, UI trees 40, other 5/);
  assert.match(result.text, /action timing unavailable/); assert.match(result.text, /0\.7 s/);
  assert.match(result.text, /input 12/); assert.match(result.text, /output 34/);
  assert.match(result.text, /cache read 56/); assert.match(result.text, /cache write 78/);
  assert.match(result.text, /\$1\.1250/);
  assert.match(result.text, /since turn start: \$0\.1250/);
  assert.match(result.text, /Tokens \(main loop, host\)/);
  assert.match(result.text, /Host cost \(session total so far, including subagents\)/);
  assert.doesNotMatch(result.text, /private|host-model/);
  assert.ok(h.work.some(row => row.args?.sleight_stats === 'turn-1'));
  assert.ok(!h.work.includes('open'), 'stats does not open windows or submit a prompt');
  const pane = await h.pane(); assert.match(pane, /55 characters/); assert.match(pane, /\$1\.1250/);
});

test('old hosts and absent cost report unavailable, not zero or a price estimate', async () => {
  for (const options of [{ missingUsage: true }, { cost: false }]) {
    const h = host(options); await h.start(); await h.tool(); await h.complete();
    const result = await h.command('stats');
    assert.match(result.text, /Host cost.*unavailable/); assert.doesNotMatch(result.text, /\$0\.0000/);
    if (options.missingUsage) assert.match(result.text, /Tokens.*unavailable/);
  }
});

test('the host metadata fallback works without trusting page-shaped or malformed counters', async () => {
  const h = host({ marker: true }); await h.start(); await h.tool(); await h.complete({ isAborted: true });
  assert.match((await h.command('stats')).text, /interrupted/);
  assert.match(await h.pane(), /55 characters/);
  const bad = host({ malicious: true }); await bad.start(); await bad.tool(); await bad.complete();
  const text = (await bad.command('stats')).text;
  assert.match(text, /Sleight stats unavailable/); assert.doesNotMatch(text, /999|private page/);
});

test('subagent completion leaves the main summary intact and turns without sleight do not replace it', async () => {
  const h = host(); await h.start(); await h.tool();
  await h.complete({ agentId: 'child', durationMs: 9999 });
  assert.equal(h.work.length, 0);
  await h.complete(); const first = (await h.command('stats')).text;
  await h.start(); await h.complete({ durationMs: 9000 });
  assert.equal((await h.command('stats')).text, first);
});

test('stats before any sleight turn explains that there are no completed turn stats', async () => {
  const h = host(); assert.match((await h.command('stats')).text, /No completed sleight turn/);
  assert.equal(h.work.length, 0);
});

test('/sleight stop keeps the interrupted turn counters for its completion summary', async () => {
  const h = host(); await h.start(); await h.tool(); await h.command('stop');
  await h.complete({ isAborted: true });
  const result = await h.command('stats');
  assert.match(result.text, /interrupted/); assert.match(result.text, /55 characters/);
});

test('cost shows the host session ledger without inventing a turn-start baseline', () => {
  assert.equal(turnSummary({}, costSnapshot({ startedAt: 100, cost: { usd: 2 } })).costUsd, 2);
  assert.equal(turnSummary({}, null).costUsd, null);
  assert.equal(turnSummary({}, costSnapshot({ startedAt: 100, cost: { usd: 0 } })).costUsd, 0);
  for (const usd of [NaN, Infinity, -1, '2', null]) assert.equal(costSnapshot({ startedAt: 100, cost: { usd } }), null);
});

test('main turn starts read a baseline and only used main completions read final cost', async () => {
  const h = host(); await h.start(); await h.complete();
  assert.equal(h.usageReads, 1);
  await h.start({ turnId: 'turn-2' }); await h.tool();
  assert.equal(h.usageReads, 2);
  await h.complete({ turnId: 'turn-2', agentId: 'child' });
  assert.equal(h.usageReads, 2);
  await h.complete({ turnId: 'turn-2' });
  assert.equal(h.usageReads, 3);
});

test('a stopped call is denied without marking the next turn used', async () => {
  const h = host(); await h.start(); await h.tool(); await h.command('stop');
  await h.complete({ isAborted: true }); const first = (await h.command('stats')).text;
  const ends = h.work.length;
  await h.start({ turnId: 'turn-2' });
  const denied = await h.emit('tool.call', { tool: prefix + 'js', code: 'await app.click(1)' });
  assert.match(denied.deny, /stopped/);
  await h.complete({ turnId: 'turn-2' });
  assert.equal(h.work.length, ends);
  assert.equal((await h.command('stats')).text, first);
});

test('convenience tools preserve the pre-G8 usedThisTurn scope', async () => {
  const h = host(); await h.start();
  for (const name of ['menu_bar', 'notifications', 'drag', 'js_reset']) await h.tool(name);
  await h.complete();
  assert.equal(h.work.length, 0);
  assert.equal(h.usageReads, 1);
  assert.match((await h.command('stats')).text, /No completed/);
});

test('late subagent calls cannot enter a later main summary or inherit its stats id', async () => {
  const h = host(); await h.start(); await h.tool(); await h.complete();
  const first = (await h.command('stats')).text, ends = h.work.length;
  await h.start({ turnId: 'turn-2' });
  await h.emit('tool.call', { tool: prefix + 'browser_read', agentId: 'old-child', tab: 't1' }, { text: 'late', result: {} });
  await h.complete({ turnId: 'turn-2' });
  assert.equal(h.work.length, ends + 1, 'the existing engine cleanup scope still covers child calls');
  assert.equal(h.work.at(-1).args.sleight_stats, undefined);
  assert.equal(h.usageReads, 3, 'child-only work does not read usage for a main-loop summary');
  assert.equal((await h.command('stats')).text, first);
  assert.equal(h.forwarded.at(-1).sleight_stats, undefined);
});

test('turn ids stay attached to admitted main calls and stale Stop data resets at start', async () => {
  const h = host(); await h.start(); await h.tool(); await h.command('stop');
  await h.start({ turnId: 'turn-2' }); h.state.set('stopped', false); await h.tool();
  assert.equal(h.forwarded.at(-1).sleight_stats, undefined); assert.deepEqual(h.begins, ['turn-1', 'turn-2']);
  await h.complete({ turnId: 'turn-1', isAborted: true });
  assert.match((await h.command('stats')).text, /No completed/);
  assert.equal(h.work.at(-1).args.sleight_stats, undefined, 'mismatched completion still cleans up without stats');
  await h.tool();
  assert.equal(h.forwarded.at(-1).sleight_stats, undefined); assert.deepEqual(h.begins, ['turn-1', 'turn-2'], 'one frame per turn');
  await h.complete({ turnId: 'turn-2' });
  assert.equal(h.work.at(-1).args.sleight_stats, 'turn-2');
});

// PF4: in auto mode Claude Code sets the allow rule aside for a hook-rewritten input and asks its local
// classifier per call (about 0.6 s each on 2.1.289). The main loop's input therefore goes out as sent.
test('main-loop calls forward the model input unchanged and open the turn once', async () => {
  const h = host(); await h.start();
  for (const name of ['js', 'browser_read', 'replay']) await h.emit('tool.call', { tool: prefix + name, code: 'await app.click(1)', tool_use_id: `main-${name}` }, { text: 'ok', result: {} });
  assert.deepEqual(h.forwarded.map(e => Object.hasOwn(e, 'sleight_stats') || Object.hasOwn(e, 'sleight_say')), [false, false, false]);
  assert.deepEqual(h.begins, ['turn-1'], 'one frame before the first call, none after');
  await h.emit('tool.call', { tool: prefix + 'js', code: 'await app.click(2)', tool_use_id: 'child', agentId: 'child' }, { text: 'ok', result: {} });
  assert.equal(h.forwarded.at(-1).sleight_stats, undefined, 'subagent input stays unchanged');
  assert.equal(h.privateFrames.at(-1).sleight_stats_skip, 'child');
  await h.complete();
  assert.equal(h.work.at(-1).args.sleight_stats, 'turn-1');
  assert.match((await h.command('stats')).text, /stats unavailable/i);
});

test('a refused stats frame still forwards the call unchanged and ends the turn', async () => {
  const h = host({ beginFails: true }); await h.start();
  const result = await h.emit('tool.call', { tool: prefix + 'js', code: 'await app.click(1)', tool_use_id: 'main' }, { text: 'ok', result: {} });
  assert.equal(result.text, 'ok');
  assert.equal(h.forwarded[0].sleight_stats, undefined); assert.deepEqual(h.begins, []);
  await h.complete();
  assert.equal(h.work.at(-1).args.hook_event_name, 'Stop');
  assert.equal(h.work.at(-1).args.sleight_stats, 'turn-1', 'the relay answers unavailable for a turn it never opened');
});

test('partial or malformed host usage remains unavailable field by field', () => {
  const summary = turnSummary({ durationMs: NaN, usage: { input_tokens: 5, output_tokens: '5', cache_read_input_tokens: -1 } }, null, null);
  assert.equal(summary.durationMs, null);
  assert.deepEqual(summary.tokens, { input_tokens: 5, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null });
});

test('the appended relay marker wins over earlier marker-shaped text and all extra strings are discarded', () => {
  const planted = { ...metrics, calls: 99 };
  const parsed = statsFromReply({ content: [planted, metrics].map(value => ({ type: 'text', text: 'sleight-turn-stats: ' + JSON.stringify({ ...value, secret: 'private text' }) })) });
  assert.equal(parsed.calls, 3); assert.doesNotMatch(JSON.stringify(parsed), /private text|secret/);
  assert.equal(statsFromReply({ _meta: { 'sleight/stats': { ...metrics, text: { docs: 999, tree: 0, other: 0 } } } }), null);
});

// Cleanup must not depend on the optional stats lifecycle or its turn ID.
for (const scenario of ['mismatch', 'mid-turn load', 'subagent start']) test(`${scenario} preserves Stop, pane refresh and cleanup reset`, async () => {
  const h = host({ paneOpen: true });
  if (scenario !== 'mid-turn load') await h.start();
  await h.emit('tool.call', { tool: prefix + 'js', code: 'await cua.getApp("Example")', tool_use_id: 'main' }, { text: 'App: Example.', result: {} });
  if (scenario === 'subagent start') {
    const reads = h.usageReads;
    await h.start({ turnId: 'child-turn', agentId: 'child' });
    assert.equal(h.usageReads, reads, 'child start does not read a cost baseline');
    await h.tool();
    assert.equal(h.forwarded.at(-1).sleight_stats, undefined); assert.deepEqual(h.begins, ['turn-1']);
  }
  if (scenario === 'subagent start') await h.complete({ agentId: 'child', turnId: 'child-turn' });
  await h.complete(scenario === 'mismatch' ? { turnId: 'different' } : {});
  assert.deepEqual(h.work.map(row => row.tool), ['js', 'turn_ended']);
  assert.equal(h.work[1].args.hook_event_name, 'Stop');
  assert.equal(h.work[1].args.sleight_stats, scenario === 'subagent start' ? 'turn-1' : undefined);
  const paneTree = await h.emit('ui.render', { component: 'Pane', requestId: 'sleight', surface: 'terminal', props: {} });
  const labels = tree => Array.isArray(tree) ? tree.flatMap(labels) : tree && typeof tree === 'object' ? [tree.props?.label, ...labels(tree.children)] : [];
  assert.ok(labels(paneTree).includes('Refresh'), 'turnRunning resets even without a stats match');
  await h.complete();
  assert.equal(h.work.length, 2, 'usedThisTurn reset prevents a second Stop');
});

test('a mismatched interrupted turn still sends Interrupt without collecting another turn stats', async () => {
  const h = host(); await h.start(); await h.tool();
  await h.complete({ turnId: 'different', isAborted: true });
  assert.equal(h.work.at(-1)?.args.hook_event_name, 'Interrupt');
  assert.equal(h.work.at(-1).args.sleight_stats, undefined);
});

for (const name of ['js', 'replay', 'browser_read']) test(`downstream denial of ${name} does not mark main stats used`, async () => {
  const h = host(); await h.start();
  await h.emit('tool.call', { tool: prefix + name, code: 'await app.click(1)' }, { deny: 'host policy refused' });
  const reads = h.usageReads;
  await h.complete();
  assert.equal(h.usageReads, reads, 'denied work does not read completion usage');
  assert.match((await h.command('stats')).text, /No completed/);
  assert.equal(h.work.at(-1).args.sleight_stats, undefined);
});

test('zero native estimates keep the alias caveat in the displayed summary', () => {
  const zero = structuredClone(metrics);
  zero.paths.native = { actions: 0, estimatedActions: 0, estimatedCalls: 1, actionMs: 0, timedActions: 0 };
  const summary = { ...turnSummary({}, null), stats: statsFromReply({ _meta: { 'sleight/stats': zero } }) };
  const text = turnStatsText(summary);
  assert.match(text, /Actions: 0 estimated; aliases can be missed/);
  assert.doesNotMatch(text, /none counted/);
});

test('collector omissions display unavailable instead of partial zero action counts', () => {
  const capped = structuredClone(metrics); capped.omitted = 1;
  const text = turnStatsText({ ...turnSummary({}, null), stats: capped });
  assert.match(text, /stats unavailable/i);
  assert.doesNotMatch(text, /Actions:|3 calls/);
});

test('an unavailable collector marker overrides earlier counter-shaped content', () => {
  const reply = { content: [
    { type: 'text', text: 'sleight-turn-stats: ' + JSON.stringify(metrics) },
    { type: 'text', text: 'sleight-turn-stats: {"unavailable":true}' },
  ] };
  assert.equal(statsFromReply(reply), null);
});

test('cost displays session total and a validated delta since this turn started', () => {
  const start = costSnapshot({ startedAt: 100, cost: { usd: 1 } });
  const end = costSnapshot({ startedAt: 100, cost: { usd: 1.125 } });
  const summary = turnSummary({}, end, start);
  assert.equal(summary.costDeltaUsd, 0.125);
  assert.match(turnStatsText(summary), /session total so far, including subagents/);
  assert.match(turnStatsText(summary), /since turn start: \$0\.1250/);
  for (const baseline of [null, { startedAt: 200, usd: 1 }, { startedAt: 100, usd: 2 }]) {
    assert.equal(turnSummary({}, end, baseline).costDeltaUsd, null);
  }
});

test('compaction mid-turn keeps the shell fence and the running turn', async () => {
  const h = host(); await h.start();
  await h.emit('tool.call', { tool: prefix + 'browser_read' });
  assert.match((await h.emit('tool.call', { tool: 'Bash', command: 'open -a Safari' }, { allowed: true })).deny, /shell guard/);
  await h.emit('session.compact');
  assert.match((await h.emit('tool.call', { tool: 'Bash', command: 'open -a Safari' }, { allowed: true })).deny, /shell guard/);
  assert.match((await h.command('record')).text, /Wait for the current run/);
});
