import test from 'node:test';
import assert from 'node:assert/strict';
import { driverFixture, sittingCase, clipboardDriverFixture, clipboardCounterFixture } from './fixtures/driver-fake.mjs';
import { createDriverSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { MAC_DRIVER_SENTENCES, formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';

for (const platform of ['darwin', 'win32']) test(`CB1Q ${platform} parent clipboard latch refuses all twelve input methods while reads and new turns remain available`, async t => {
  let changed = false;
  const h = await shared(t, platform, { afterInput() {
    if (changed) return;
    changed = true;
    throw Object.assign(Error(MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED), { code: 'CLIPBOARD_CHANGED',
      clipboardChanged: true, delivery: 'sent-unverified', retry: 'read-first', next: 'stop-tell-user' });
  } });
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  const input = (method, args = [1]) => h.safety.request(method, { ...h.binding(), readId: first.readId, args });
  const initial = input('pressKey', ['ctrl+c']);
  const queued = input('click');
  await assert.rejects(initial, { code: 'CLIPBOARD_CHANGED', delivery: 'sent-unverified' });
  const stopped = { code: 'CLIPBOARD_CHANGED', message: MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED,
    delivery: 'not-sent', retry: 'read-first', next: 'stop-tell-user' };
  if (platform === 'win32') stopped.message = formatMacDriverError(stopped, { action: true });
  await assert.rejects(queued, stopped);
  const before = h.calls.length;
  for (const method of DRIVER_ACTION_METHODS) await assert.rejects(input(method), stopped, method);
  assert.equal(h.calls.length, before, 'latched input never reaches the driver');
  assert.equal(h.actions.length, 1);
  await h.safety.finishCell(1);
  await h.safety.request('getAXState', h.binding());
  await h.safety.reset();
  await h.safety.request('getApp', { selector: 'Fixture' });
  await assert.rejects(input('click'), stopped, 'worker reset keeps the turn latch');
  await h.safety.endTurn();
  const next = await h.safety.request('getApp', { selector: 'Fixture' });
  await h.safety.request('pressKey', { ...h.binding(), readId: next.readId, args: ['Home'] });
  assert.deepEqual(h.actions, [['pressKey', ['ctrl+c']], ['pressKey', ['Home']]]);
});

for (const platform of ['darwin', 'win32']) test(`CB1Q ${platform} latched input keeps the clipboard refusal even when the read queue is full`, async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const safety = createDriverSafety({ platform }, {
    queue: { queued: 0, serial: Promise.resolve() }, epoch: () => 0,
    fail(code) { throw Object.assign(Error(code), { code }); },
    dispatch(method) {
      if (method === 'getState') return held;
      throw Object.assign(Error(MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED), { code: 'CLIPBOARD_CHANGED', clipboardChanged: true });
    },
  });
  await assert.rejects(safety.request('pressKey', {}), { code: 'CLIPBOARD_CHANGED' });
  const reads = Array.from({ length: 8 }, () => safety.request('getState', {}));
  try { await assert.rejects(safety.request('click', {}), { code: 'CLIPBOARD_CHANGED', retry: 'read-first', next: 'stop-tell-user' }); }
  finally { release(); await Promise.all(reads); }
});

for (const platform of ['darwin', 'win32']) for (const evidence of [undefined, false, 'true', 1, true])
  test(`CB1S ${platform} only typed count-move evidence latches input: ${typeof evidence} ${String(evidence)}`, async () => {
    let sent = 0;
    const safety = createDriverSafety({ platform }, {
      queue: { queued: 0, serial: Promise.resolve() }, epoch: () => 0,
      fail(code) { throw Object.assign(Error(code), { code }); },
      dispatch() {
        if (++sent === 1) throw Object.assign(Error(MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED), {
          code: 'CLIPBOARD_CHANGED', delivery: 'not-sent', retry: evidence === true ? 'read-first' : 'safe',
          ...evidence === undefined ? {} : { clipboardChanged: evidence },
        });
        return 'input';
      },
    });
    await assert.rejects(safety.request('pressKey', {}), { code: 'CLIPBOARD_CHANGED', delivery: 'not-sent' });
    if (evidence === true) {
      await assert.rejects(safety.request('click', {}), { code: 'CLIPBOARD_CHANGED', retry: 'read-first' });
      assert.equal(sent, 1);
    } else {
      assert.equal(await safety.request('click', {}), 'input');
      assert.equal(sent, 2);
    }
  });

async function shared(t, platform, options) {
  const module = await import('../plugins/sleight/lib/driver-safety.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
  assert.equal(typeof module.createDriverSafety, 'function', 'both platforms need the shared dispatcher');
  const h = await driverFixture(platform, module.createDriverSafety, options);
  t.after(() => h.safety.close()); return h;
}

test('the same action sequence has matching refusal codes, order and empty denied sinks', async t => {
  const sequences = [];
  for (const platform of ['darwin', 'win32']) {
    const h = await shared(t, platform), rows = [];
    const attempt = async (id, method, params) => {
      const count = h.actions.length;
      let code;
      try { await h.safety.request(method, params, { cell: 1 }); }
      catch (error) { code = error.code; }
      rows.push(sittingCase({ platform, id, status: code ? 'refused' : 'pass', code }));
      if (code) assert.equal(h.actions.length, count, `${platform}/${id} delivered no input`);
    };
    await attempt('unacquired', 'getAXState', h.binding());
    const first = await h.safety.request('getApp', { selector: 'Fixture' }, { cell: 1 });
    const params = { ...h.binding(), readId: first.readId, args: ['Home'] };
    await attempt('first', 'pressKey', params);
    // Windows retains a stale-read check; use the acknowledged result id for the next step.
    const fresh = await h.safety.request('getAXState', h.binding(), { cell: 1 });
    h.safety.recordReadDelivery?.(fresh);
    params.readId = fresh.readId;
    h.pause(true); await attempt('pause', 'pressKey', params); h.pause(false);
    const latest = await h.safety.request('getAXState', h.binding(), { cell: 1 });
    params.readId = latest.readId;
    h.change(); await attempt('identity', 'pressKey', params);
    await h.safety.finishCell(1); assert.equal(h.ended, true);
    await h.safety.endTurn();
    await attempt('ended', 'getAXState', h.binding());
    assert.deepEqual(h.actions, [['pressKey', ['Home']]]);
    sequences.push(rows.map(({ id, code }) => [id, code]));
  }
  assert.deepEqual(sequences[0], sequences[1]);
  assert.deepEqual(sequences[0], [['unacquired', 'APP_NOT_ACQUIRED'], ['first', null], ['pause', 'PAUSED'],
    ['identity', 'IDENTITY_CHANGED'], ['ended', 'APP_NOT_ACQUIRED']]);
});

for (const label of ['Copy', 'Cut']) test(`clipboard ${label}: production rules refuse on both platforms`, async t => {
  const rows = [];
  for (const platform of ['darwin', 'win32']) {
    const h = await clipboardDriverFixture(t, platform, createDriverSafety, { body: '1 button ' + label });
    let code = null;
    try { await h.request('click', [1]); } catch (error) { code = error.code; }
    rows.push({ platform, code, order: h.order, inputs: h.actions.length });
  }
  assert.deepEqual(rows, [
    { platform: 'darwin', code: 'ACTION_UNSUPPORTED', order: ['policy'], inputs: 0 },
    { platform: 'win32', code: 'ACTION_UNSUPPORTED', order: ['policy'], inputs: 0 },
  ]);
});

test('clipboard Control+C: Mac admits Control+C, Windows refuses', async t => {
  const rows = [];
  for (const platform of ['darwin', 'win32']) {
    const h = await clipboardDriverFixture(t, platform, createDriverSafety, { nativeKeyAdmission: true });
    let code = null;
    try { await h.request('pressKey', ['Control+c']); } catch (error) { code = error.code; }
    rows.push({ platform, code, order: h.order, inputs: h.actions.length });
  }
  assert.deepEqual(rows, [
    { platform: 'darwin', code: null, order: ['policy', 'pause', 'native-admission', 'input'], inputs: 1 },
    { platform: 'win32', code: 'ACTION_UNSUPPORTED', order: ['policy', 'pause', 'native-admission'], inputs: 0 },
  ]);
});

test('clipboard change-count movement stops both platforms before the next input',
  { skip: process.platform !== 'darwin' }, async t => {
  const rows = [];
  for (const platform of ['darwin', 'win32']) {
    const h = await clipboardDriverFixture(t, platform, createDriverSafety,
      { countWatch: platform === 'darwin' ? clipboardCounterFixture(t) : undefined });
    h.moveCount();
    let code = null, next = null, retry = null;
    try {
      await h.request('click', [1]);
      await h.request('click', [1]);
    } catch (error) { ({ code, next, retry } = error); }
    rows.push({ platform, code, next, retry, order: h.order, inputs: h.actions.length });
  }
  assert.deepEqual(rows, [
    { platform: 'darwin', code: 'CLIPBOARD_CHANGED', next: 'stop-tell-user', retry: 'read-first',
      order: ['policy', 'pause', 'native-admission', 'input', 'count-moved'], inputs: 1 },
    { platform: 'win32', code: 'CLIPBOARD_CHANGED', next: 'stop-tell-user', retry: 'read-first',
      order: ['policy', 'pause', 'native-admission', 'input', 'count-moved'], inputs: 1 },
  ]);
});

test('Mac production preview still refuses input before any driver access', async t => {
  const h = await shared(t, 'darwin', { preview: true });
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  const count = h.calls.length;
  await assert.rejects(h.safety.request('pressKey', { ...h.binding(), readId: first.readId, args: ['Home'] }),
    { code: 'METHOD_NOT_FOUND' });
  assert.equal(h.calls.length, count); assert.equal(h.actions.length, 0);
});

for (const platform of ['darwin', 'win32']) test(`${platform}: checkPause is required, including after policy waits`, async t => {
  const h = await shared(t, platform);
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  const params = { ...h.binding(), readId: first.readId, args: ['Home'] };
  h.safety.setPolicy({ beforeAction: h.policy.beforeAction });
  const count = h.calls.length;
  await assert.rejects(h.safety.request('pressKey', params), { code: platform === 'darwin' ? 'MAC_SAFETY_UNAVAILABLE' : 'WINDOWS_SAFETY_UNAVAILABLE' });
  assert.equal(h.calls.length, count);
  h.safety.setPolicy({ ...h.policy, beforeAction: async action => { h.pause(true); return h.policy.beforeAction(action); } });
  await assert.rejects(h.safety.request('pressKey', params), { code: 'PAUSED' });
  assert.equal(h.actions.length, 0);
});

const commonActions = [
  ['click', [1]], ['doubleClick', [1]], ['rightClick', [1]], ['setValue', [1, 'fixture']],
  ['typeText', ['fixture']], ['pressKey', ['Home']], ['paste', ['fixture']],
  ['selectText', [1, 'fixture']], ['performSecondaryAction', [1, 'Invoke']], ['drag', [[10, 10], [20, 20]]],
];
test('ten common actions retain fresh-read, policy, pause, input and observation order', async t => {
  const sinks = [];
  for (const platform of ['darwin', 'win32']) {
    const h = await shared(t, platform);
    await h.safety.request('getApp', { selector: 'Fixture' });
    for (const [method, args] of commonActions) {
      const read = await h.safety.request('getAXState', h.binding());
      h.safety.recordReadDelivery?.(read);
      h.events.length = 0;
      await h.safety.request(method, { ...h.binding(), readId: read.readId, args }, { cell: 1 });
      assert.deepEqual(h.events.filter(event => ['getAXState', 'beforeAction', 'checkPause', method].includes(event)),
        ['getAXState', 'beforeAction', 'checkPause', method], platform + '/' + method);
    }
    sinks.push(h.actions);
  }
  assert.deepEqual(sinks[0], commonActions); assert.deepEqual(sinks[1], commonActions);
});

for (const platform of ['darwin', 'win32']) test(`${platform}: no microtask gap from final Pause to driver input`, async t => {
  const h = await shared(t, platform);
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  h.policy.checkPause = () => { queueMicrotask(() => h.events.push('next-microtask')); h.events.push('pause'); };
  h.events.length = 0;
  await h.safety.request('pressKey', { ...h.binding(), readId: first.readId, args: ['Home'] });
  assert.ok(h.events.indexOf('pause') < h.events.indexOf('pressKey'));
  assert.ok(h.events.indexOf('pressKey') < h.events.indexOf('next-microtask'));
});

test('decline caching keeps each platform policy and never reads content', async t => {
  for (const platform of ['darwin', 'win32']) {
    const h = await shared(t, platform, { allow: false });
    for (let i = 0; i < 2; i++) await assert.rejects(h.safety.request('getApp', { selector: 'Fixture' }), { code: 'APP_DECLINED' });
    assert.equal(h.cards.length, platform === 'darwin' ? 1 : 2);
    assert.equal(h.calls.includes('getAXState'), false); assert.equal(h.leases.length, 0);
  }
});
