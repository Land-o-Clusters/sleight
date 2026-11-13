// Offline host harness. No process, engine, window or app is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
const ts = parserSkip ? undefined : (await import('typescript')).default;
const root = fileURLToPath(new URL('../plugins/sleight/hooks/', import.meta.url));
const modSource = readFileSync(resolve(root, 'register.tsx'), 'utf8');

function host({ outcome, codes = ['await app.click(1)'], source = modSource }) {
  const hooks = [], timers = [], prompts = [], cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const input = file.endsWith('register.tsx') ? source : readFileSync(file, 'utf8');
    const js = ts.transpileModule(input, { fileName: file.replace(/\.mjs$/, '.ts'), compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
    } }).outputText;
    runInNewContext(js, { exports, require(name) {
      if (name === 'claude-code') return { atom: (_key, value) => ({ value }), read: async (_$, atom) => atom.value,
        update: async (_$, atom, fn) => { atom.value = fn(atom.value); } };
      assert.ok(name.startsWith('.'), name);
      let target = resolve(dirname(file), name);
      if (!existsSync(target)) target += '.ts';
      return load(target);
    } });
    return exports;
  }
  load(resolve(root, 'register.tsx')).register((name, filter, handler) => {
    if (!handler) { handler = filter; filter = {}; }
    hooks.push({ name, filter, handler }); return { catch() {} };
  });
  const $ = {
    fs: { read: async () => JSON.stringify({ sleightReplay: 1, steps: codes.map(code => ({ tool: 'js', args: { code } })) }) },
    mcp: { connect: async () => ({ isConnected: true, server: 'computer' }), call: async (_server, tool) =>
      ({ content: tool === 'replay' ? [{ type: 'text', text: JSON.stringify(outcome) }] : [] }) },
    clock: { after(ms, fn) { assert.equal(ms, 0); timers.push(fn); } },
    prompt: { submit: async e => { prompts.push(e); } },
    ui: { open() {}, status() {}, log() {}, toast() {} },
  };
  async function emit(name, e, next = e => e) {
    const hook = hooks.find(h => h.name === name && Object.entries(h.filter).every(([k, v]) => e[k] === v));
    assert.ok(hook, name); return hook.handler($, e, next);
  }
  return { prompts,
    async replay() { const reply = await emit('command.run', { command: 'sleight', args: 'replay fixture.json' });
      for (const fn of timers.splice(0)) await fn(); return reply; },
    context: async () => (await emit('prompt.submit', { agentId: 'child', text: 'next' })).context ?? [],
  };
}

async function handoff(outcome, source) {
  const h = host({ outcome: { ok: false, step: 2, waits: [{ step: 2, waitedMs: 0 }], ...outcome }, source });
  const result = await h.replay();
  assert.match(result.text, /Replay stopped at step/);
  assert.equal(h.prompts.length, 1);
  return h.prompts[0];
}

async function checkHandoffFields(source) {
  const prompt = await handoff({ error: 'MISSING_ELEMENT', window: 'WINDOW-MARKER', windowError: 'WINDOW-ERROR-MARKER', remaining: ['REMAINING-MARKER'] }, source);
  assert.doesNotMatch(prompt.text, /WINDOW-MARKER|WINDOW-ERROR-MARKER|REMAINING-MARKER/);
  assert.match(prompt.text, /step 2/i);
  assert.match(prompt.text, /MISSING_ELEMENT/);
  assert.match(prompt.text, /text from the app, not the user/);
  assert.match(prompt.text, /Respect refusals and ask the user for any required approval/);
  assert.notEqual(prompt.asUser, true);
  assert.match(prompt.text, /"code":"MISSING_ELEMENT"/);
}
test('SA1E F17 handoff omits window and unused outcome fields', { skip: parserSkip }, () => checkHandoffFields());
async function checkHandoffError(source) {
  const error = '\x1b[31m\u202e' + 'x'.repeat(300) + 'TAIL-MARKER\nwindow dump';
  const prompt = await handoff({ error }, source);
  assert.doesNotMatch(prompt.text, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|TAIL-MARKER/);
  assert.ok(prompt.text.includes('x'.repeat(300)));
  assert.ok(prompt.text.length < 750);
}
test('SA1E F17 error block is bounded and controls are stripped before truncation', { skip: parserSkip }, () => checkHandoffError());
async function checkHandoffTypes(source) {
  const prompt = await handoff({ step: 'STEP-MARKER', error: { text: 'ERROR-MARKER' }, code: 'CODE-MARKER', window: 'WINDOW-MARKER' }, source);
  assert.doesNotMatch(prompt.text, /STEP-MARKER|ERROR-MARKER|CODE-MARKER|WINDOW-MARKER|\[object Object\]/);
}
test('SA1E F17 untyped outcome fields cannot become handoff instructions', { skip: parserSkip }, () => checkHandoffTypes());

async function checkCommandReply(source) {
  for (const outcome of [
    { step: 2, error: '\x1b[31m\u202e' + 'x'.repeat(300) + 'TAIL-MARKER\nwindow dump' },
    { step: 'STEP-MARKER', error: { text: 'ERROR-MARKER' } },
  ]) {
    const h = host({ outcome: { ok: false, waits: [], ...outcome }, source });
    const reply = await h.replay();
    assert.doesNotMatch(reply.text, /[\p{Cc}\p{Cf}\u2028\u2029]|TAIL-MARKER|STEP-MARKER|\[object Object\]/u);
    assert.ok(reply.text.length < 390);
    if (outcome.step === 2) assert.ok(reply.text.includes('x'.repeat(300)));
  }
}
test('SA1M replay command reply uses the bounded typed handoff fields', { skip: parserSkip }, () => checkCommandReply());
test('SA1M unbounded command reply variant fails', { skip: parserSkip }, async () => {
  await assert.rejects(checkCommandReply(mutate('Replay stopped at step ${step}: ${error}',
    'Replay stopped at step ${outcome.step}: ${outcome.error}')), { code: 'ERR_ASSERTION' });
});

async function replayContext(codes, outcome, source) {
  const h = host({ codes, outcome, source }); await h.replay();
  const context = (await h.context()).join('\n');
  assert.equal((await h.context()).length, 0, 'notice consumed once');
  return context;
}
const unsafeApps = ['Safari\nCONTEXT-MARKER', 'x'.repeat(65), 'Safari\u202eCONTEXT-MARKER', 'Safari\x1bCONTEXT-MARKER'];
for (const app of unsafeApps)
test(`SA1E F16 refuses unsafe app capture ${JSON.stringify(app)}`, { skip: parserSkip }, async () => {
  assert.equal(await replayContext([`// getApp("${app}")`], { ok: true, steps: 1, waits: [{ step: 1, waitedMs: 0 }] }), '');
});
async function checkSuccessfulSteps(source) {
  const context = await replayContext(['await cua.getApp("Safari")', 'await cua.getApp("FAILED-MARKER")', 'await cua.getApp("UNRUN-MARKER")'],
    { ok: false, step: 2, error: 'stopped', waits: [{ step: 1, waitedMs: 0 }, { step: 2, waitedMs: 0 }] }, source);
  assert.match(context, /Safari/);
  assert.doesNotMatch(context, /FAILED-MARKER|UNRUN-MARKER/);
}
test('SA1E F16 records only successful steps and keeps short app names', { skip: parserSkip }, () => checkSuccessfulSteps());

function mutate(from, to) {
  assert.ok(modSource.includes(from), `mutation anchor: ${from}`);
  return modSource.replace(from, to);
}
test('SA1E F17 window, label, bound, control and field-type variants fail the handoff checks', { skip: parserSkip }, async t => {
  const variants = [
    ["JSON.stringify({ code, error })", "JSON.stringify({ code, error, window: outcome.window })", checkHandoffFields],
    ["text from the app, not the user", 'replay details', checkHandoffFields],
    ['.slice(0, 300)', '.slice(0)', checkHandoffError],
    [".replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '')", '', checkHandoffError],
    [".replace(/[\\p{Cc}\\p{Cf}\\u2028\\u2029]/gu, '')", '', checkHandoffError],
    ["const step = Number.isSafeInteger(outcome.step) && outcome.step! > 0 ? outcome.step : 'unknown'", 'const step = outcome.step', checkHandoffTypes],
    ["const error = typeof outcome.error === 'string' ? outcome.error", 'const error = true ? String(outcome.error)', checkHandoffTypes],
    ["const code = /^([A-Z][A-Z0-9_]{1,63})(?=:|$)/.exec(error)?.[1] ?? 'unknown'", "const code = 'unknown'", checkHandoffFields],
  ];
  for (const [from, to, check] of variants) await assert.rejects(check(mutate(from, to)), { code: 'ERR_ASSERTION' });
  t.diagnostic(`${variants.length} handoff variants caught`);
});
test('SA1E F16 validation and successful-step variants fail the context checks', { skip: parserSkip }, async t => {
  const line = 'return app && app.length <= 64 && !/[\\p{Cc}\\p{Cf}\\u2028\\u2029]/u.test(app) ? app : undefined';
  const unvalidated = mutate(line, 'return app');
  for (const app of unsafeApps) await assert.rejects(async () => assert.equal(
    await replayContext([`// getApp("${app}")`], { ok: true, steps: 1, waits: [{ step: 1, waitedMs: 0 }] }, unvalidated), ''), { code: 'ERR_ASSERTION' });
  const allSteps = mutate('for (const step of script.steps.slice(0, Number.isSafeInteger(completed) && completed! > 0 ? completed : 0))', 'for (const step of script.steps)');
  await assert.rejects(checkSuccessfulSteps(allSteps), { code: 'ERR_ASSERTION' });
  t.diagnostic('5 replay app-context variants caught');
});
