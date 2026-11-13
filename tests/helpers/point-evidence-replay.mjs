import assert from 'node:assert/strict';

// Hold a native reply after Chromium has produced it. The trace distinguishes
// a missing reply from a slow fixture launch or a page load event.
export function holdPointEvidence(t, page, matches) {
  const impl = page.mainFrame()._connection.toImpl(page.mainFrame());
  const client = impl._page.delegate._sessionForFrame(impl)._client;
  const send = client._sendMayFail, trace = [];
  let release, entered, collect;
  const objects = new Set(), collected = new Promise(resolve => { collect = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  client._sendMayFail = async function(method, params) {
    const result = await send.call(this, method, params);
    if (method === 'Runtime.releaseObject' && objects.has(params.objectId)) collect(params.objectId);
    if (matches(method, params, result)) {
      if (result?.object?.objectId) objects.add(result.object.objectId);
      trace.push({ method, backendNodeId: params.backendNodeId ?? result?.node?.backendNodeId,
        tag: result?.node?.localName, name: result?.nodes?.[0]?.name?.value });
      entered();
      await held;
    }
    return result;
  };
  t.after(() => { release(); client._sendMayFail = send; t.diagnostic(JSON.stringify({ heldEvidence: trace })); });
  return { ready, release, trace, objects, collected, send: (method, params) => send.call(client, method, params) };
}

export async function withReplayDeadline(work, ms = 5000) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('FL4 replay is waiting for the held native reply')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function assertNoPointInput(page) {
  assert.deepEqual(await page.evaluate(() => ({ pays, inputs })), { pays: 0, inputs: [] });
}

export function pointPhases(t) {
  const rows = [];
  t.after(() => t.diagnostic(JSON.stringify({ pointPhases: rows })));
  return async (stage, work) => {
    const row = { stage, status: 'pending' }, start = performance.now(); rows.push(row);
    try { const result = await work(); row.status = 'done'; return result; }
    catch (error) { row.status = 'failed'; throw error; }
    finally { row.ms = Math.round(performance.now() - start); }
  };
}

// Fail the real shield's settle acknowledgement, after its pointer arrival and
// before its guard or click callback. This sends no button-down or click.
export function refusePointSettle(backgroundClick, trace = []) {
  return (tab, locator, click, options) => backgroundClick(tab, new Proxy(locator, {
    get(target, property) {
      if (property === 'evaluate') return (fn, arg, ...rest) => {
        if (arg?.guard && arg?.settle) {
          trace.push('settle acknowledgement unavailable');
          throw Error('FL4 controlled missing settle acknowledgement');
        }
        return target.evaluate(fn, arg, ...rest);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }), (...args) => { trace.push('click callback'); return click(...args); }, options);
}

// A descheduled scan can cross its wall-clock budget on a small static page.
// Advance only this owned utility world's clock, with no elapsed-time wait.
export async function exhaustPointGeometry(page, work) {
  const impl = page.mainFrame()._connection.toImpl(page.mainFrame()), utility = await impl.utilityContext();
  await utility.evaluateExpression(`() => {
    const state = { descriptor: Object.getOwnPropertyDescriptor(Performance.prototype, 'now'), calls: 0 };
    globalThis.__fl4Clock = state;
    Object.defineProperty(Performance.prototype, 'now', { ...state.descriptor, value: () => ++state.calls * 51 });
  }`, { isFunction: true });
  try {
    const result = await work();
    const calls = await utility.evaluateExpression('() => globalThis.__fl4Clock.calls', { isFunction: true });
    return { result, calls };
  } finally {
    await utility.evaluateExpression(`() => {
      Object.defineProperty(Performance.prototype, 'now', globalThis.__fl4Clock.descriptor);
      delete globalThis.__fl4Clock;
    }`, { isFunction: true });
  }
}
