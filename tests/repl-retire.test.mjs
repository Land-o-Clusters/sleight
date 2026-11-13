import { replWorkerSkip, windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { registerHooks } from 'node:module';
import { createMacReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { createWindowsReplClient } from '../plugins/sleight/lib/windows-repl/client.mjs';

const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const window = { windowId: '101', pid: 120, processStart: '134059077770000001', bundleId: 'com.example.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true, image: 'C:\\Apps\\Editor.exe', integrity: 'medium' };
const tree = 'Window: "Draft", App: Editor.\n0 standard window Draft';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('darwin refuses an unexpected preflight error before worker startup and serves the next cell', { skip: replWorkerSkip,timeout:10000}, async t => {
  // Replace only the preflight dependency of a fresh client module. The worker,
  // parent IPC and evaluator remain real, with no new production injection API.
  const clientURL=new URL('../plugins/sleight/lib/repl/client.mjs?throwing-preflight',import.meta.url).href;
  const apiURL=new URL('../plugins/sleight/lib/runtime-api.mjs',import.meta.url).href;
  const hook=registerHooks({resolve(specifier,context,next) {
    if (context.parentURL===clientURL && specifier==='../runtime-api.mjs') return {
      shortCircuit:true, url:'data:text/javascript,'+encodeURIComponent(`
        import { normalizeRuntimeCell as real } from ${JSON.stringify(apiURL)};
        export function normalizeRuntimeCell(code, handles) {
          if (code.includes('preflightFailure')) throw Error('arbitrary fixture preflight failure');
          return real(code, handles);
        }`),
    };
    return next(specifier,context);
  }});
  let create;
  try { ({createMacReplClient:create}=await import(clientURL)); }
  finally { hook.deregister(); }
  const requests=[],workers=[];
  const client=create({platform:'darwin',admit:async()=>true,
    spawn:(...args)=>{const child=fork(...args);workers.push(child);return child;},
    driver:{async request(method) {requests.push(method);return {window,text:tree,readId:1};},async restart(){},async close(){}}});
  t.after(()=>client.close());
  const refused=await client.execute({code:'await cua.getApp("Editor"); await app.click(0); // preflightFailure'});
  assert.equal(refused.isError,true);
  assert.equal(text(refused),'Runtime preflight failed');
  assert.equal(workers.length,0);
  assert.deepEqual(requests,[]);
  const next=await client.execute({code:'let app=await cua.getApp("Editor");'});
  assert.equal(next.isError,false,text(next));
  assert.equal(workers.length,1);
  assert.deepEqual(requests,['getApp']);
});

for (const [platform, create] of [['darwin', createMacReplClient], ['win32', createWindowsReplClient]]) {
  function fixture(t, options = {}) {
    const workers = [], requests = [];
    const repl = create({ platform, admit: async () => true, environment: () => ({ LANE_FIXTURE: '1' }),
      spawn: (...args) => { const child = fork(...args); workers.push(child); return child; },
      ...options, driver: {
        async request(method, params) {
          requests.push({ method, params });
          return { window, text: tree, readId: 1 };
        },
        async restart() {}, async close() {}, ...options.driver,
      } });
    t.after(() => repl.close());
    return { repl, workers, requests, js: code => repl.execute({ code }) };
  }

  for (const failing of ['restart', 'onReset']) {
    test(`${platform} recovers after one rejected ${failing}, then executes and resets again`, { skip: platform === 'darwin' ? replWorkerSkip : windowsWorkerSkip, timeout: 10000 }, async t => {
      let restarts = 0, resets = 0;
      const { repl, js, workers, requests } = fixture(t, {
        driver: { async restart() { if (++restarts === 1 && failing === 'restart') throw Error('fixture restart failed'); } },
        async onReset() { if (++resets === 1 && failing === 'onReset') throw Error('fixture onReset failed'); },
      });
      assert.equal((await js('let app = await cua.getApp("Editor"); const before = 1;')).isError, false);
      await assert.rejects(() => repl.reset(), new RegExp(`fixture ${failing} failed`));
      assert.notEqual(workers[0].exitCode ?? workers[0].signalCode, null);
      const recovered = await js('typeof before; let app = await cua.getApp("Editor");');
      assert.equal(recovered.isError, false, text(recovered));
      assert.equal(requests.length, 2, 'a new cell reaches the fake driver after cleanup failure');
      assert.equal((await repl.reset()).isError, undefined);
      assert.equal(restarts, 2);
      assert.equal(resets, failing === 'restart' ? 1 : 2);
      const fresh = await js('typeof app');
      assert.equal(fresh.isError, false, text(fresh));
      assert.match(text(fresh), /undefined/);
      assert.equal(workers.length, 3);
    });
  }

  test(`${platform} serializes retirement and waits for parent reset before replacement`, { skip: platform === 'darwin' ? replWorkerSkip : windowsWorkerSkip, timeout: 10000 }, async t => {
    const entered = deferred(), release = deferred(), parentEntered = deferred(), parentRelease = deferred();
    const events = [];
    let restarts = 0, resets = 0;
    t.after(() => { release.resolve(); parentRelease.resolve(); });
    const { repl, js, workers } = fixture(t, {
      driver: { async restart() {
        events.push(`restart${++restarts}`);
        if (restarts === 1) { entered.resolve(); await release.promise; }
      } },
      async onReset() {
        events.push(`reset${++resets}`);
        if (resets === 1) { parentEntered.resolve(); await parentRelease.promise; }
      },
    });
    await js('const before = 1;');
    assert.match(text(await repl.execute({ code: 'await new Promise(() => {});', timeout_ms: 50 })), /REPL_TIMEOUT/);
    await entered.promise;
    const next = js('typeof before');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workers.length, 1);
    const reset = repl.reset();
    assert.deepEqual(events, ['restart1']);
    release.resolve();
    await parentEntered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['restart1', 'reset1']);
    assert.equal(workers.length, 1);
    parentRelease.resolve();
    assert.match(text(await next), /REPL_RESET/);
    await reset;
    assert.deepEqual(events, ['restart1', 'reset1', 'restart2', 'reset2']);
    const fresh = await js('typeof before');
    assert.equal(fresh.isError, false, text(fresh));
    assert.match(text(fresh), /undefined/);
    assert.equal(workers.length, 2);
  });

  test(`${platform} acquisition rejects malformed read ids before creating an action handle`, { skip: platform === 'darwin' ? replWorkerSkip : windowsWorkerSkip, timeout: 10000 }, async t => {
    let readId;
    const requests = [];
    const { js } = fixture(t, { driver: { async request(method) {
      requests.push(method);
      return { window, text: tree, readId };
    } } });
    for (const invalid of [undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      readId = invalid;
      const result = await js('var candidate = await cua.getApp("Editor"); await candidate.click(0);');
      assert.equal(result.isError, true, String(invalid));
      assert.match(text(result), /DRIVER_PROTOCOL/);
    }
    assert.deepEqual(requests, Array(6).fill('getApp'));
    readId = 1;
    const valid = await js('let app = await cua.getApp("Editor"); await app.click(0); void 0;');
    assert.equal(valid.isError, false, text(valid));
    assert.deepEqual(requests.slice(-2), ['getApp', 'click']);
  });

  test(`${platform} driver error fields survive IPC without replaying input`, { skip: platform === 'darwin' ? replWorkerSkip : windowsWorkerSkip, timeout: 10000 }, async t => {
    let actions = 0;
    const { js } = fixture(t, { driver: { async request(method) {
      if (method === 'getApp') return { window, text: tree, readId: 1 };
      actions++;
      throw Object.assign(Error('fixture action failed'), { code: 'DEADLINE_EXCEEDED',
        delivery: 'unknown', retry: 'read-first', unhealthy: true, personTookOver: true });
    } } });
    await js('let app = await cua.getApp("Editor");');
    const result = await js('await app.click(0).catch(error => nodeRepl.write([error.code,error.delivery,error.retry,error.unhealthy,error.personTookOver]));');
    assert.equal(result.isError, platform === 'darwin', text(result));
    assert.equal(result.content.at(-1).text, '["DEADLINE_EXCEEDED","unknown","read-first",true,true]');
    if (platform === 'darwin') assert.match(result.content[0].text,/1 click\(0\) unknown/);
    assert.equal(actions, 1);
  });
}
