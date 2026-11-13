import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createContext, runInContext, constants } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { lastHeader, splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

// Run only this file to print the stop reasons. This never starts an engine or native helper.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/sf7/rel3.json', import.meta.url), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const body = result => result.content.map(c => c.text ?? '').join('\n');
const addressFocus = { sheets: 0, role: 'AXComboBox', subrole: null, inWindow: true, inPage: false };

async function fakeEngine(t, browser, { disturb, opened, missingIdentity = false } = {}) {
  const data = recorded[browser], appId = browser === 'firefox' ? 'org.mozilla.firefox' : 'com.apple.Safari';
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const requests = [], replies = [], traces = [], operations = [];
  let state = data.states.gate, writes = [], cursor = 0, next = 0, changed = false;
  const raw = {
    getAXState: async () => { operations.push(['read', lastHeader(state)?.title]); return state; },
    pressKey: async key => {
      operations.push(['pressKey', key]); changed = true;
      if (/^(super|cmd)\+t$/i.test(key)) state = opened ?? data.states.newTab;
      if (key === 'Return') state = browser === 'firefox' ? data.states.shop : data.states.inbox;
    },
    typeText: async value => { operations.push(['typeText', value]); },
    setValue: async (number, value) => { operations.push(['setValue', number, value]); },
    click: async number => {
      operations.push(['click', number]); changed = true;
      // Only final Safari trees were retained. Intermediate click/setValue headers are an explicit fixture assumption.
      if (browser === 'safari' && state === data.states.inbox && number === 19) state = data.states.urgent;
      else if (browser === 'safari' && state === data.states.urgent && number === 8) state = data.states.inbox;
    },
  };
  const context = createContext({ app: raw, setTimeout, cua: {
    getApp: async () => raw,
    getState: async () => ({ apps: [{ id: appId, displayName: browser === 'firefox' ? 'Firefox' : 'Safari' }], browsers: [] }),
    listApps: async () => [{ id: appId, windows: [{ title: lastHeader(state)?.title }] }],
  }, nodeRepl: { write: value => writes.push(String(value)) } });
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sf7-'))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut,
    inputLease: new InputLease({ directory, holder: 'SF7 replay' }), changeReview: false, ck3: false,
    runningProbe: () => ({ status: 'responding' }),
    windowIdentity: async expected => {
      const current = lastHeader(state);
      // The retained retry says confirmed:false. Model an unavailable lookup of the stale header; the actual
      // helper response is absent from the trace. All successful observations derive their header from the fake app.
      if (changed && missingIdentity || expected.title !== current?.title || expected.url !== current?.url) return;
      return { ...expected, ...current, status: 'ok', matches: 1, headerMatches: 1,
        epoch: 'sf7-helper', window: 1, windowNumber: 22, pid: 123, processStart: 1,
        hidIdleSeconds: 1000, windowSubrole: 'AXStandardWindow', focus: addressFocus,
        ...(changed ? disturb : {}) };
    },
    trace: (direction, msg) => { if (direction.includes('continuation') || direction === 'native-window-admission') traces.push({ direction, ...msg }); },
  });
  t.after(() => { relay.dispose(); for (const s of streams) s.destroy(); });
  serverIn.on('data', bytes => requests.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  return { operations, traces, requests,
    setState(value) { state = value; changed = true; },
    async call(code) {
      const id = ++next;
      clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
      for (let i = 0; i < 1000; i++) {
        await tick();
        while (cursor < requests.length) {
          const request = requests[cursor++];
          assert.equal(request.method, 'tools/call');
          assert.equal(request.params.name, 'js');
          writes = [];
          let error;
          try {
            await runInContext(`(async () => { ${request.params.arguments.code} })()`, context,
              { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
          } catch (e) { error = e; }
          // The real engine emits acquisition state without an explicit write. Split acquisition replies precede input.
          if (/cua\.getApp\(/.test(request.params.arguments.code) && !error) writes.push(state);
          const content = [...(error ? [{ type: 'text', text: String(error.message) }] : []),
            { type: 'text', text: writes.join('') }];
          serverOut.write(JSON.stringify({ id: request.id, result: { content, isError: !!error,
            _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId, kind: 'appId' } } } } }) + '\n');
        }
        const reply = replies.find(row => row.id === id);
        if (reply) return reply.result;
      }
      throw Error('SF7 fake engine did not receive a result');
    },
  };
}

test('SF7 Firefox B-r1: native identity refuses the stale retry before the recorded guard stop', async t => {
  const data = recorded.firefox, h = await fakeEngine(t, 'firefox');
  const results = [];
  for (const call of data.calls.slice(0, 6)) results.push(await h.call(call.code));
  assert.equal(splitMenuActions(data.calls[2].code), undefined, 'the pre-action read/filter/write is outside the supported split shape');
  assert.deepEqual(results.map(r => !!r.isError), [false, false, true, true, true, true]);
  const refusals = h.traces.filter(r => r.direction === 'tab-continuation-refused');
  assert.deepEqual(refusals.map(r => r.reason), ['not-admitted']);
  assert.deepEqual(data.recordedRefusals.map(r => r.reason), ['not-admitted', 'not-admitted']);
  assert.deepEqual(h.traces.filter(r => r.direction === 'native-window-admission').map(r => r.confirmed),
    [true, true, false]);
  assert.match(body(results[2]), /ran 1 action/);
  for (const result of results.slice(3)) assert.match(body(result), /native window identity is unavailable/);
  assert.deepEqual(h.operations.filter(([op]) => op !== 'read'), [['pressKey', 'super+t']],
    'the retry and mixed acquisition/read cell send no input after native admission refuses');
  t.diagnostic(JSON.stringify({ case: 'Firefox inject-order B-r1', recordedStops: data.recordedRefusals,
    replayStops: refusals.map(r => r.reason), firstStopCause: 'unsupported read/filter/write prefix, no continuation admission',
    retryCause: 'the retained native pin refuses the unavailable identity before the engine guard; mixed acquisition/read stays refused',
    replayedCalls: results.length, recordedCalls: data.calls.length, skippedCalls: data.calls.length - results.length }));
});

test('SF7 Firefox B-r1 retry: stale header with inconclusive native admission stops before input and reacquisition recovers', async t => {
  const data = recorded.firefox, h = await fakeEngine(t, 'firefox', { missingIdentity: true });
  await h.call('let app = await cua.getApp("org.mozilla.firefox");');
  // Isolate the header mismatch recorded on the retry. The trace does not retain enough native data to derive it
  // from the preceding call, so this is a seeded state, not a claim to reconstruct that missing observation.
  h.setState(data.states.newTab);
  const stopped = await h.call(data.calls[3].code);
  assert.equal(stopped.isError, true);
  assert.match(body(stopped), /native window identity is unavailable/);
  assert.deepEqual(h.operations.filter(([op]) => op !== 'read'), []);
  assert.deepEqual(h.traces.filter(r => r.direction === 'tab-continuation-refused'), []);
  assert.equal((await h.call(data.calls[4].code)).isError, true, 'a mixed cell cannot clear a refused native pin');
  assert.notEqual((await h.call('await cua.getApp("org.mozilla.firefox");')).isError, true,
    'the refusal advises a standalone acquisition before further input');
  const recovered = await h.call(data.calls[5].code);
  assert.notEqual(recovered.isError, true, body(recovered));
  assert.equal(h.operations.filter(([op]) => op === 'typeText').length, 1);
  t.diagnostic(JSON.stringify({ case: 'Firefox inject-order B-r1 retry, seeded stale header', eventLine: 31,
    reason: 'native identity unavailable', sentActions: 0, seededNativeObservation: 'unavailable' }));
});

test('SF7 Safari B-r2: six calls have no admission stop; mixed result retains action origin and current tree', async t => {
  const data = recorded.safari, h = await fakeEngine(t, 'safari');
  const results = [];
  for (const call of data.calls) results.push(await h.call(call.code));
  assert.equal(results.length, 6);
  assert.deepEqual(results.map(r => !!r.isError), [false, false, false, false, false, false]);
  assert.deepEqual(h.traces.filter(r => r.direction === 'tab-continuation-refused'), []);
  const mixed = body(results[2]);
  assert.match(mixed, /Window: "sleight benchmark — Inbox · Demo Mail"/);
  assert.equal(lastHeader(mixed).title, 'sleight benchmark — URGENT: invoice copy needed today · Demo Mail');
  assert.match(mixed, /this call acted on "sleight benchmark — Inbox · Demo Mail"/);
  assert.match(mixed, /The window it shows now is "sleight benchmark — URGENT: invoice copy needed today · Demo Mail"/);
  // A fresh acquisition may supply the first guard read. There must still be reads in every action call.
  assert.ok(h.operations.filter(([op]) => op === 'read').length >= 5);
  t.diagnostic(JSON.stringify({ case: 'Safari inject-mail B-r2', replayedCalls: results.length,
    recordedStops: data.recordedRefusals.length, replayStops: 0, currentTree: lastHeader(mixed).title,
    priorActionReceiptRetained: true, intermediateNativeState: 'not retained, simulated' }));
});

test('SF7 supported same-call Firefox new tab admits its remainder and returns the reached page', async t => {
  const h = await fakeEngine(t, 'firefox');
  await h.call('let app = await cua.getApp("org.mozilla.firefox");');
  const result = await h.call('await app.pressKey("super+t"); await app.typeText("https://example.test"); await app.pressKey("Return");');
  assert.notEqual(result.isError, true, body(result));
  assert.equal(h.operations.filter(([op]) => op === 'typeText').length, 1);
  assert.equal(h.traces.filter(r => r.direction === 'menu-continuation' && r.kind === 'tab').length, 1);
  assert.equal(lastHeader(body(result)).title, 'Ember mug · Tidewell Demo Shop');
  assert.match(body(result), /all 3 actions ran/);
  const opNames = h.operations.map(([op]) => op), key = opNames.indexOf('pressKey'), typed = opNames.indexOf('typeText');
  assert.ok(opNames.slice(key + 1, typed).includes('read'), 'a pre-action read remains before typing into the new tab');
  assert.ok(opNames.slice(typed + 1, opNames.lastIndexOf('pressKey')).includes('read'), 'Return also keeps its pre-action read');
});

test('SF7 supported same-call Safari new tab passes with a hidden prior strip', async t => {
  // Synthetic transition control: the retained Safari tree has the two-tab chrome, but no Start Page sample exists.
  const opened = recorded.safari.states.inbox.replaceAll('Inbox · Demo Mail', 'Start Page')
    .replace(/^The focused UI element is .*$/m, 'The focused UI element is 32 text field (settable) Description: smart search field');
  const h = await fakeEngine(t, 'safari', { opened });
  await h.call('let app = await cua.getApp("Safari");');
  const result = await h.call('await app.pressKey("super+t"); await app.typeText("https://example.test"); await app.pressKey("Return");');
  assert.notEqual(result.isError, true, body(result));
  assert.equal(h.operations.filter(([op]) => op === 'typeText').length, 1);
  assert.equal(h.traces.filter(r => r.direction === 'menu-continuation' && r.kind === 'tab').length, 1);
  assert.equal(lastHeader(body(result)).title, 'sleight benchmark — Inbox · Demo Mail');
  assert.match(body(result), /all 3 actions ran/);
});

for (const [name, disturb, opened, reason] of [
  ['user input', { hidIdleSeconds: 0 }, undefined, 'hid-input'],
  ['focus outside window', { focus: { ...addressFocus, inWindow: false } }, undefined, 'focus-outside-window'],
  ['same-title replacement window', { windowNumber: 23 }, undefined, 'identity: Input lease: step=window-number the selected window number changed.'],
  ['another focused window', { status: 'mismatch' }, undefined, 'identity: Input lease: step=native-identity the native window changed.'],
  ['ambiguous same-title windows', { matches: 2 }, undefined, 'identity: Input lease: step=window-inventory window identity is ambiguous.'],
  ['page retitle without added tab', undefined, recorded.firefox.states.gate.replaceAll('Sleight Gate', 'Retitled Gate'), 'no-new-tab'],
]) test(`SF7 supported shape still stops on ${name}`, async t => {
  const h = await fakeEngine(t, 'firefox', { disturb, opened });
  await h.call('let app = await cua.getApp("org.mozilla.firefox");');
  const result = await h.call('await app.pressKey("super+t"); await app.typeText("https://example.test"); await app.pressKey("Return");');
  assert.equal(result.isError, true);
  assert.equal(h.operations.filter(([op]) => op === 'typeText').length, 0);
  const reasons = h.traces.filter(r => r.direction === 'tab-continuation-refused').map(r => r.reason);
  assert.equal(reasons.length, 1);
  assert.ok(reasons[0].startsWith(reason), reasons[0]);
  t.diagnostic(JSON.stringify({ control: name, reason: reasons[0], typed: 0 }));
});
