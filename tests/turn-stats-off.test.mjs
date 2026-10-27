// Observe the real classifier at its function entry, without production test hooks.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { PassThrough } from 'node:stream';

const classifier = mock.fn();
const probeKey = '__sleightStatsClassifierProbe';
globalThis[probeKey] = classifier;
const statsUrl = new URL('../plugins/sleight/lib/turn-stats.mjs', import.meta.url).href;
const hook = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== statsUrl) return loaded;
    const source = loaded.source.toString();
    const entry = 'export function textKinds(text) {';
    assert.ok(source.includes(entry), 'instrument the actual classifier entry');
    return { ...loaded, source: source.replace(entry, `${entry} globalThis.${probeKey}(text);`) };
  },
});
let createRelay;
try { ({ createRelay } = await import('../plugins/sleight/lib/relay.mjs')); }
finally { hook.deregister(); }

test('stats off, untagged and internal calls skip textKinds; an admitted call enters it', t => {
  t.after(() => { delete globalThis[probeKey]; });
  for (const [mod, tag, opened, expected] of [[false, { turn: 'off' }, true, 0], [true, undefined, false, 0],
    [true, 'private-skip', true, 0], [true, { internal: true }, true, 1], [true, undefined, true, 1]]) {
    classifier.mock.resetCalls();
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, modHost: () => mod });
    try {
      if (opened) clientIn.write(JSON.stringify({ id: 'begin', method: 'tools/call', params: { name: 'turn_ended',
        arguments: { sleight_stats_begin: 'turn' } } }) + '\n');
      if (tag === 'private-skip') clientIn.write(JSON.stringify({ id: 'skip', method: 'tools/call', params: { name: 'turn_ended',
        arguments: { sleight_stats_skip: 'toolu_child' } } }) + '\n');
      clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js',
        arguments: { code: 'nodeRepl.write(1)', ...(tag ? { sleight_stats: tag } : {}) },
        _meta: { 'claudecode/toolUseId': 'toolu_child' } } }) + '\n');
      serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: 'Window: Fixture\n1 button Example' }] } }) + '\n');
      assert.equal(classifier.mock.callCount(), expected, `mod=${mod}, tag=${JSON.stringify(tag)}`);
    } finally {
      relay.dispose();
      for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy();
    }
  }
});
