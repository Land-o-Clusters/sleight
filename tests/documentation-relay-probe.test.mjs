import { fixtureDocumentation } from './helpers/canonical-docs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as checks from '../bench/compat/documentation.mjs';
const docs = readFileSync(new URL('fixtures/native-api-docs.txt', import.meta.url), 'utf8');
const text = text => ({ type: 'text', text });

// The real relay and JSON streams, with only the engine process replaced.
function relayClient(t, options, mode, opens) {
  opens.push(options);
  const previous = process.env.SLEIGHT_ENGINE_DOCS;
  if (options.env.SLEIGHT_ENGINE_DOCS === undefined) delete process.env.SLEIGHT_ENGINE_DOCS;
  else process.env.SLEIGHT_ENGINE_DOCS = options.env.SLEIGHT_ENGINE_DOCS;
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-documentation-lease-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputLease = new InputLease({ directory, holder: 'offline documentation probe' });
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const relay = createRelay({ documentationTrust: fixtureDocumentation(docs), clientIn, clientOut, serverIn, serverOut,
    inputLease, changeReview: false,
    warmRepl: true, warmEngine: false, openShot: false });
  const pending = new Map(); let id = 1, initialized;
  const wire = msg => serverOut.write(JSON.stringify(msg) + '\n');
  const baseline = options.env.SLEIGHT_ENGINE_DOCS === 'full';
  serverIn.on('data', bytes => {
    for (const line of bytes.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') wire({ id: msg.id, result: {} });
      if (msg.method !== 'tools/call') continue;
      if (msg.params.arguments?.title === 'Prepare sleight REPL') {
        const value = !baseline && mode === 'policy' ? docs.replace('Unknown runtime policy', 'Changed runtime policy') : docs;
        wire({ id: msg.id, result: { content: [text(value), text('[sleight:guard-ready]\n')],
          ...(!baseline && mode === 'metadata' ? { _meta: { 'codex/nodeReplExecutionDurationMs': 3, 'codex/telemetry': {} } } : {}),
          ...(!baseline && mode === 'timing' ? { _meta: { 'codex/nodeReplExecutionDurationMs': 3 } } : {}) } });
      } else {
        assert.notEqual(mode, 'lease', 'the ordinary lease guard must refuse the property cell before engine dispatch');
        assert.ok(msg.params.arguments.code.endsWith('await cua.getState({emit:false});'));
        wire({ id: msg.id, result: { content: [text('private synthetic inventory must remain absent from the report')],
          ...(!baseline && mode === 'error' ? { isError: true } : {}) } });
      }
    }
  });
  clientOut.on('data', bytes => {
    for (const line of bytes.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.id === 0) initialized?.();
      else if (pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    }
  });
  let closed = false;
  const close = async () => {
    if (closed) return true;
    closed = true;
    relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy();
    if (previous === undefined) delete process.env.SLEIGHT_ENGINE_DOCS; else process.env.SLEIGHT_ENGINE_DOCS = previous;
    return true;
  };
  t.after(close);
  return new Promise(resolve => {
    initialized = () => {
      clientIn.write(JSON.stringify({ method: 'notifications/initialized' }) + '\n');
      resolve({
        call: (name, args) => new Promise(done => {
          const callId = id++; pending.set(callId, done);
          assert.equal(args.code, 'await cua.getState({emit:false});');
          if (mode === 'lease') args = { ...args, code: 'nodeRepl.write("sleight-documentation-native:" + typeof cua.getApp)' };
          clientIn.write(JSON.stringify({ id: callId, method: 'tools/call', params: { name, arguments: args,
            ...(!baseline && mode === 'context' ? { _meta: { 'codex/sandbox-state': { mode: 'changed' } } } : {}) } }) + '\n');
        }),
        close, cleanupReceipt: () => ({ started: false, childCollected: true, groupCollected: true }),
      });
    };
    clientIn.write(JSON.stringify({ id: 0, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'sleight-documentation-relay' } } }) + '\n');
  });
}

test('the relay probe inventory read measures actual serialized documentation under InputLease without acquiring an app', async t => {
  assert.equal(typeof checks.documentationRelayChecks, 'function');
  const opened = [];
  const report = await checks.documentationRelayChecks('fake-launcher', {
    SLEIGHT_TURBO: '1', SLEIGHT_HAND: '1', SLEIGHT_SURFACES: 'browser', CUA_REPL_ENABLED_SURFACES: 'browser',
  }, { open: options => relayClient(t, options, 'normal', opened) });
  assert.equal(report.status, 'pass');
  assert.equal(report.removedCharacters, 201);
  assert.equal(report.policyUnchanged, true);
  assert.equal(report.outsideFenceUnchanged, true);
  assert.equal(report.apiExact, true);
  assert.doesNotMatch(JSON.stringify(report), /private synthetic inventory/);
  assert.equal(report.cleanup.childCollected, true);
  assert.equal(report.cleanup.groupCollected, true);
  assert.equal(opened.length, 2);
  assert.equal(opened[0].env.SLEIGHT_ENGINE_DOCS, 'full');
  assert.equal(Object.hasOwn(opened[1].env, 'SLEIGHT_ENGINE_DOCS'), false);
  for (const options of opened) {
    assert.equal(options.env.SLEIGHT_TURBO, '0');
    assert.equal(options.env.SLEIGHT_HAND, '0');
    assert.equal(options.env.SLEIGHT_SURFACES, 'computer');
    assert.equal(options.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  }
});
for (const mode of ['metadata', 'context', 'policy', 'error']) test(`serialized relay qualification rejects ${mode} even if raw format is known`, async t => {
  assert.equal(typeof checks.documentationRelayChecks, 'function');
  const report = await checks.documentationRelayChecks('fake-launcher', {}, { open: options => relayClient(t, options, mode, []) });
  assert.equal(report.status, 'fail');
  if (['metadata', 'context'].includes(mode)) assert.equal(report.removedCharacters, 0);
});
test('serialized relay qualification accepts only the observed timing metadata singleton', async t => {
  const report = await checks.documentationRelayChecks('fake-launcher', {}, { open: options => relayClient(t, options, 'timing', []) });
  assert.equal(report.status, 'pass');
  assert.equal(report.removedCharacters, 201);
  assert.equal(report.policyUnchanged, true);
  assert.equal(report.outsideFenceUnchanged, true);
});
test('an uncollected first relay session prevents the second session from starting', async () => {
  assert.equal(typeof checks.documentationRelayChecks, 'function');
  let opened = 0;
  const report = await checks.documentationRelayChecks('fake', {}, { open: async () => {
    opened++;
    return { call: async () => ({ content: [text(docs)] }), close: async () => false,
      cleanupReceipt: () => ({ childCollected: true, groupCollected: false }) };
  } });
  assert.equal(opened, 1);
  assert.equal(report.status, 'fail');
  assert.equal(report.cleanup.childCollected, true);
  assert.equal(report.cleanup.groupCollected, false);
});
test('the fixed property probe reproduces the 262-byte missing-target refusal under the launcher lease guard', async t => {
  const report = await checks.documentationRelayChecks('fake-launcher', {}, { open: options => relayClient(t, options, 'lease', []) });
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.sessions.map(session => session.serializedBytes), [262, 262]);
  assert.deepEqual(report.sessions.map(session => session.documentationCharacters), [0, 0]);
  assert.deepEqual(report.sessions.map(session => session.errorKind), ['input-lease-target-missing', 'input-lease-target-missing']);
  assert.doesNotMatch(JSON.stringify(report), /bundle ID and full window header|Send exactly|cua\.getState/);
});
