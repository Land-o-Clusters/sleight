import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { createHandClient, shareConsent } from '../../plugins/sleight/lib/hand/client.mjs';
import { createCursorEvents } from '../../plugins/sleight/lib/hand/events.mjs';
import { createRuntimeHand } from '../../plugins/sleight/lib/hand/runtime-hand.mjs';
import { createBrowserHand } from '../../plugins/sleight/lib/hand/browser-hand.mjs';
import { createRelay } from '../../plugins/sleight/lib/relay.mjs';
import { setHandPid } from '../../plugins/sleight/lib/hand/pid.mjs';

const flush = async () => { for (let n = 0; n < 15; n++) await new Promise(resolve => setImmediate(resolve)); };
export async function recordDefaultTurn(route) {
  const child = new EventEmitter(); child.pid = 4242;
  const lines = [], replies = [], work = [], setting = () => ({ enabled: true, style: 'ring', stream: false });
  child.stdin = Object.assign(new EventEmitter(), { writableLength: 0, write(line) { lines.push(JSON.parse(line)); return true; }, end() {} });
  child.stdout = new EventEmitter(); child.stdio = [child.stdin, child.stdout, null, new PassThrough(), new PassThrough()]; child.kill = () => {};
  const client = createHandClient({ setting, built: () => true, watch: () => undefined, permissions: null, usage: null,
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  const cursor = createCursorEvents({ setting, sink: { write() {}, close() {} } }); cursor.connectHost(client);
  const hand = createRuntimeHand({ client, events: cursor });
  const bounds = { X: 100, Y: 50, Width: 1200, Height: 900 }, page = {};
  const turbo = createBrowserHand({ client, setting, events: cursor, env: {}, defer: fn => work.push(fn),
    readMetrics: async () => ({ screenX: 100, screenY: 50, outerWidth: 1200, outerHeight: 900, innerWidth: 1200, innerHeight: 800,
      dpr: 2, visible: true, focusOnBody: false, vv: { offsetLeft: 0, offsetTop: 0, scale: 1 } }),
    locate: async () => ({ ok: true, window: { pid: 77, windowId: 5, bounds }, windows: [{ pid: 77, id: 5, bounds, layer: 0 }],
      displays: [{ X: 0, Y: 0, Width: 1800, Height: 1200 }] }) });
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  let action;
  serverIn.on('data', bytes => {
    for (const request of bytes.toString().trim().split('\n').map(JSON.parse)) {
      if (request.id === undefined) continue;
      action = Promise.resolve().then(async () => {
        if (request.params?.name === 'js') {
          if (route === 'Glide') {
            const record = { type: 'action', call: 'c'.repeat(32), index: 0, kind: 'click', point: [650, 700], rect: [630, 680, 40, 40],
              window: { pid: 42, id: 7, rect: [200, 500, 900, 350] } };
            hand({ ...record, phase: 'act' }); hand({ ...record, phase: 'done' });
          } else {
            const token = turbo.step({ op: 'click', page, locator: { boundingBox: async () => ({ x: 200, y: 100, width: 100, height: 40 }) }, ref: 'e1' });
            while (work.length) await work.shift()();
            turbo.finish(token);
          }
        }
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [] } }) + '\n');
      });
    }
  });
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, cursor, changeReview: false, idleTurnEndMs: 0, modHost: () => false });
  const request = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  try {
    await shareConsent(); await flush();
    request(1, 'js', { code: '1 + 1' }); await flush(); await action; await flush();
    assert.ok(replies.some(row => row.id === 1 && !row.result?.isError), 'fixture call must complete through the relay');
    request(2, 'turn_ended', { hook_event_name: 'Stop' }); await flush(); await action; await flush();
    assert.ok(replies.some(row => row.id === 2 && !row.result?.isError), 'fixture turn must end through the relay');
    return lines.filter(row => row.hand !== 'menu').map(({ nonce, ...row }) => row);
  } finally { await relay.dispose(); turbo.close(); client.close(); cursor.close(); setHandPid(0); }
}
