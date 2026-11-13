import { MOD_META } from './fixtures/mod-attribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

// Wire-level relay fixture. Production receiver behavior is exercised separately
// through the Windows launcher in windows-safety-relay.
function fixture(t, factory = createRelay, host = 'claude-code') {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], pending = new Map();
  let id = 0, failNextEnd = false;
  const write = (stream, message) => stream.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  clientOut.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line), resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  serverIn.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line); sent.push(message);
      if (message.id === undefined) continue;
      const isEnd = message.params?.name === 'turn_ended';
      const failed = isEnd && failNextEnd;
      if (isEnd) failNextEnd = false;
      write(serverOut, { id: message.id, result: message.method === 'initialize' ? { capabilities: { tools: {} } }
        : { content: failed ? [{ type: 'text', text: 'fixture cleanup failed' }] : [], isError: failed } });
    }
  });
  const relay = factory({ clientIn, clientOut, serverIn, serverOut, nativeWindows: true, nativeMac: false,
    changeReview: false, inputLease: false, idleTurnEndMs: 0, warmRepl: false, warmEngine: false });
  t.after(async () => { await relay.close(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const request = (method, params) => new Promise(resolve => {
    pending.set(++id, resolve); write(clientIn, { id, method, params });
  });
  const tool = async (name, args = {}) => (await request('tools/call', { name, arguments: args, ...(name === 'turn_ended' ? { _meta: MOD_META } : {}) })).result;
  const ready = request('initialize', { clientInfo: { name: host, version: '1' }, capabilities: {} });
  return { ready, sent, relay, tool, failNextEnd() { failNextEnd = true; },
    bootstrap: async () => JSON.parse((await tool('turn_ended', { sleight_turbo: { event: 'bootstrap' } })).content[0].text).sleightTurbo };
}
const ends = h => h.sent.filter(message => message.params?.name === 'turn_ended').map(message => message.params.arguments);

async function boundEnds(t, factory = createRelay) {
  const h = fixture(t, factory); await h.ready;
  const envelope = await h.bootstrap();
  for (const event of ['Stop', 'Interrupt']) {
    for (const args of [{}, { hook_event_name: event, sleight_clipboard_turn_end: true },
      { hook_event_name: event, sleight_turbo: { ...envelope, nonce: '0'.repeat(64), event: 'end' } }]) {
      await h.tool('turn_ended', args);
      assert.equal(ends(h).at(-1).sleight_clipboard_turn_end, false);
      assert.equal('sleight_turbo' in ends(h).at(-1), false);
    }
    await h.tool('turn_ended', { hook_event_name: event, sleight_turbo: { ...envelope, event: 'end' } });
    assert.equal(ends(h).at(-1).sleight_clipboard_turn_end, true);
  }
}
test('WCB1C win32 relay gives only mod-bound Stop/Interrupt a true clipboard turn-end flag', boundEnds);

async function owedEnds(t, factory = createRelay) {
  const h = fixture(t, factory); await h.ready;
  const envelope = await h.bootstrap();
  await h.tool('js', { code: '1 + 1' });
  h.failNextEnd();
  const failed = await h.tool('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } });
  assert.equal(failed.isError, true);
  assert.equal(ends(h).at(-1).sleight_clipboard_turn_end, true);
  const count = ends(h).length;
  await h.tool('js', { code: '2 + 2' });
  await h.relay.endOpenTurn(); await tick();
  assert.ok(ends(h).length > count);
  assert.ok(ends(h).slice(count).every(args => args.sleight_clipboard_turn_end === false), 'owed and unbound ends cannot clear a newer stop');
}
test('WCB1C win32 relay forces owed cleanup replay false', owedEnds);

for (const host of ['claude-code', 'cursor']) test(`WCB1C ${host} without bootstrap gets a true win32 idle flag`, async t => {
  const h = fixture(t, createRelay, host); await h.ready;
  await h.tool('js', { code: '1 + 1' });
  await h.relay.endOpenTurn();
  assert.equal(ends(h).at(-1).sleight_clipboard_turn_end, true);
});

for (const [name, before, after, witness] of [
  ['C5 native turn-end builder', '...(nativeRuntime ? { sleight_clipboard_turn_end:', '...(nativeMac ? { sleight_clipboard_turn_end:', boundEnds],
  ['C6 owed replay builder', '.map(args => nativeRuntime ? { ...args, sleight_clipboard_turn_end: false } : args)',
    '.map(args => nativeMac ? { ...args, sleight_clipboard_turn_end: false } : args)', owedEnds],
]) test(`${name}: production passes and Mac-only variant fails on win32`, async t => {
  await witness(t);
  const url = new URL('../plugins/sleight/lib/relay.mjs', import.meta.url), original = readFileSync(url, 'utf8');
  let changed = original.replace(before, after); assert.notEqual(changed, original);
  changed = changed.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_, q, path) => `from ${q}${new URL(path, url).href}${q}`);
  const broken = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
  await assert.rejects(witness(t, broken.createRelay), { code: 'ERR_ASSERTION' });
  t.diagnostic('1 production wire witness passed; 1 broken-variant wire witness failed');
});
