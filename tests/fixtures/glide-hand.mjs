import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { createHandClient, shareConsent } from '../../plugins/sleight/lib/hand/client.mjs';
import { createGlideGeometryWire as ordinaryWire } from '../../plugins/sleight/lib/mac-driver/geometry.mjs';
import { createRuntimeHand as ordinaryHand } from '../../plugins/sleight/lib/hand/runtime-hand.mjs';
export const settle = () => new Promise(resolve => setImmediate(resolve));
export const call = 'c'.repeat(32), bounds = [0, 0, 900, 600];
export const base = () => ({ type: 'observation', read: 1, pid: 42, window: '7', processStart: 'start', bounds,
  reused: false, acquired: [10, 11], before: 0, after: 0, initial: 'a'.repeat(64), rendered: 'a'.repeat(64), final: 'a'.repeat(64),
  notifications: true, settled: true, complete: true, continuous: true, transform: true, drag: false, references: [] });
export const row = () => ({ action: 2, joined: true, semantic: true, clipping: true, departed: false, rects: [[10.2, 20.2, 29.3, 39.3]] });
export async function harness(t, { createRuntimeHand = ordinaryHand, createWire = ordinaryWire, native = false } = {}) {
  const child = new EventEmitter(); child.pid = 12345; child.lines = [];
  child.stdin = new EventEmitter(); child.stdin.writableLength = 0;
  child.stdin.write = line => { child.lines.push(...line.trim().split('\n').map(JSON.parse)); return true; };
  child.stdin.end = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  child.stdout = new EventEmitter(); child.stdio = [child.stdin, child.stdout, null, new PassThrough(), new PassThrough()];
  const client = createHandClient({ setting: () => ({ enabled: true, style: 'ring' }), watch: () => {}, permissions: null, usage: null,
    built: () => true, prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close()); await shareConsent(); await settle();
  const windowBounds = native ? [200, 500, 900, 350] : bounds;
  const hand = createRuntimeHand({ client, producer: true }), stream = new PassThrough();
  const frames = () => child.lines.filter(f => f.hand === 'stage-producer');
  const certificates = () => frames().filter(f => f.op === 'certificate');
  const ack = () => {
    const f = frames().at(-1);
    child.stdout.emit('data', JSON.stringify({ hand: 'stage-producer-ack', nonce: f.nonce, session: f.session, turn: f.turn,
      seq: f.seq, op: f.op, accepted: true }) + '\n');
  };
  const wire = createWire({ nonce: 'f'.repeat(64), stream, publish: hand.geometry });
  const turn = wire.begin(1); ack();
  const send = (id, patch = {}) => stream.write(JSON.stringify({ ...base(), ...patch, request: id, turn,
    protocol: 'sleight.glide-geometry/1', nonce: 'f'.repeat(64) }) + '\n');
  send(1, { bounds: windowBounds }); assert.equal(certificates().length, 1, 'complete baseline certifies'); ack(); wire.finish(1);
  const act = () => {
    wire.begin(2, { call, index: 0 });
    hand({ type: 'action', phase: 'act', call, index: 0, kind: 'click', point: native ? [650, 700] : [25, 40], rect: native ? [640, 680, 20, 20] : [10, 20, 30, 40], window: { id: 7, pid: 42, rect: windowBounds } });
    ack(); wire.finish(2);
  };
  return { hand, wire, send, act, certificates, ack, frames, client, child, stream, turn };
}
