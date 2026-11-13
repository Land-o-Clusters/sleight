import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fork } from 'node:child_process';
import { AsyncResource } from 'node:async_hooks';
import { evaluations } from './fixtures/repl-legacy-domain.mjs';
import { createWindowsSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { createReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';

const worker = new URL('../plugins/sleight/lib/repl/worker.mjs', import.meta.url);
const legacy = new URL('./fixtures/repl-legacy-domain.mjs', import.meta.url).href;
const text = result => result.content.map(item => item.text).join('\n');
let serial = 0;

async function evaluator(t, { platform, old = false, emulate = false, request } = {}) {
  const url = new URL(`?domain-test-${++serial}`, worker).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (emulate && context.parentURL === url && specifier === 'node:repl')
        return { shortCircuit: true, url: legacy };
      return next(specifier, context);
    },
    load(specifier, context, next) {
      const loaded = next(specifier, context);
      if (!old || specifier !== url) return loaded;
      // Restore the old worker's two-domain wiring, including its per-cell listener.
      let source = String(loaded.source);
      const shared = "  const evaluationDomain = createDomain();\n  evaluationDomain.on('error', error => currentCell()?.reject?.(error));\n";
      assert.ok(source.includes(shared));
      source = source.replace(shared, '').replace('...replOptions, domain: evaluationDomain', '...replOptions');
      assert.ok(source.includes('          cell.reject = reject;'));
      source = source.replace('          cell.reject = reject;', `          const evaluationDomain = createDomain();
          evaluationDomain.on('error', error => { if (active === cell) reject(error); });`);
      return { ...loaded, source };
    },
  });
  let createEvaluator;
  try { ({ createEvaluator } = await import(url)); }
  finally { hooks.deregister(); }
  const instance = createEvaluator({ platform, request: request ?? (async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    throw Object.assign(Error('FORBIDDEN_SETTINGS: settings windows are refused.'), { code: 'FORBIDDEN_SETTINGS' });
  }) });
  t.after(() => instance.close());
  return instance;
}

async function bounded(instance, code, limit = 750) {
  let timer;
  const begin = performance.now();
  try {
    return await Promise.race([
      instance.evaluate(code).then(result => ({ result, ms: performance.now() - begin })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true, ms: performance.now() - begin }), limit); }),
    ]);
  } finally { clearTimeout(timer); }
}

const errors = [
  ['refusal', 'var candidate = await cua.getApp("Settings");', /FORBIDDEN_SETTINGS: settings windows are refused\./],
  ['TypeError', 'null.x', /TypeError: Cannot read properties of null/],
  ['rejection', 'await Promise.reject(new Error("rejected cell"));', /Error: rejected cell/],
  ['throw', 'throw new Error("synchronous cell");', /Error: synchronous cell/],
  ['syntax', 'const = ;', /SyntaxError:/],
  ['timer throw', 'setTimeout(() => { throw new Error("timer cell"); }, 0); await new Promise(() => {});', /Error: timer cell/],
];

for (const platform of ['win32', 'darwin']) for (const emulate of [false, true])
  test(`${platform}: ${emulate ? 'pre-25.9 domain' : 'current REPL'} preserves every cell error and session`, { timeout: 10000 }, async t => {
    const instance = await evaluator(t, { platform, emulate });
    const state = emulate ? evaluations.at(-1) : undefined;
    assert.equal((await instance.evaluate('let kept = await Promise.resolve(40);')).isError, false);
    for (const [name, code, expected] of errors) {
      const outcome = await bounded(instance, code);
      assert.equal(outcome.timedOut, undefined, name);
      assert.equal(outcome.result.isError, true, name);
      assert.match(text(outcome.result), expected, name);
      assert.ok(outcome.ms < 750, `${name}: ${outcome.ms} ms`);
      assert.equal(text(await instance.evaluate('kept + 2')), '42', `${name}: persistent binding`);
      t.diagnostic(`${name}: ${outcome.ms.toFixed(2)} ms`);
    }
    if (state) {
      // Mac redeclaration preflight rejects malformed syntax before Node's
      // evaluator enters its legacy domain. Runtime errors still use it.
      assert.equal(state.errors.length, errors.length - (platform === 'darwin' ? 1 : 0));
      assert.equal(state.callbacks, 1 + errors.length, 'only successful cells called back');
    }
  });

for (const platform of ['win32', 'darwin']) for (const [name, code] of errors.slice(0, 4))
  test(`${platform}: broken old worker times out on legacy ${name}`, { timeout: 5000 }, async t => {
    const instance = await evaluator(t, { platform, emulate: true, old: true });
    const state = evaluations.at(-1);
    const outcome = await bounded(instance, code, 150);
    assert.equal(outcome.timedOut, true);
    assert.equal(state.errors.length, 1, 'the private REPL domain consumed the error');
    assert.equal(state.callbacks, 0, 'the old error path never called back');
    await assert.rejects(instance.evaluate('1 + 1'), /REPL_BUSY/);
    t.diagnostic(`old worker ${name}: still pending at ${outcome.ms.toFixed(2)} ms`);
  });

for (const platform of ['win32', 'darwin'])
  test(`${platform}: a stale domain error cannot reject the next cell`, { timeout: 5000 }, async t => {
    let stale;
    const instance = await evaluator(t, { platform, emulate: true, request: async () => {
      const domain = evaluations.at(-1).domain;
      stale = AsyncResource.bind(() => domain.emit('error', Error('previous cell error')));
      throw Error('initial refusal');
    } });
    assert.match(text(await instance.evaluate('await cua.getApp("Settings");')), /initial refusal/);
    const pending = instance.evaluate('await new Promise(resolve => setTimeout(() => resolve(42), 30));');
    stale();
    const result = await pending;
    assert.equal(result.isError, false, text(result));
    assert.equal(text(result), '42');
  });

test('Windows parent refusal survives real worker IPC without approval, content reads, input or retirement', { skip: windowsWorkerSkip, timeout: 10000 }, async t => {
  const windows = structuredClone(fakeWindows);
  windows[0].image = 'C:\\Apps\\WindowsTerminal.exe';
  windows[0].app = 'Windows Terminal';
  windows[0].title = 'Settings';
  const calls = [], workers = [];
  let restarts = 0;
  const driver = {
    async request(method) {
      calls.push(method);
      assert.equal(method, 'getState', 'only metadata inventory is needed to refuse');
      return { windows };
    },
    async restart() { restarts++; }, async close() {},
  };
  const safety = createWindowsSafety({ driver, allowForbidden: true,
    lease: { release() {}, close() {} }, approve: () => assert.fail('no approval for Settings') });
  const client = createReplClient({ platform: 'win32', driver, environment: () => ({ LANE_FIXTURE: '1' }),
    spawn: (...args) => { const child = fork(...args); workers.push(child); return child; },
    dispatch: (...args) => safety.request(...args) });
  t.after(async () => { await client.close(); await safety.close(); });
  await client.execute({ code: 'let kept = 42;' }); // Exclude process startup from the cell deadline.
  const begin = performance.now();
  const result = await client.execute({ code: 'await cua.getApp({windowId:"101"});', timeout_ms: 750 });
  assert.equal(result.isError, true);
  assert.match(text(result), /FORBIDDEN_SETTINGS/);
  assert.doesNotMatch(text(result), /REPL_TIMEOUT/);
  assert.ok(performance.now() - begin < 750);
  assert.equal(text(await client.execute({ code: 'kept' })), '42');
  assert.deepEqual(calls, ['getState']);
  assert.equal(workers.length, 1);
  assert.equal(restarts, 0);
});
