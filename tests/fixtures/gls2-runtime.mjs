import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import {createOwnRuntime} from '../../plugins/sleight/lib/runtime-select.mjs';
import {createRelay} from '../../plugins/sleight/lib/relay.mjs';
import {prepareMacInputRegistrar} from '../../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { createMacDriverClient } from '../../plugins/sleight/lib/mac-driver/client.mjs';
import { DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../../plugins/sleight/lib/mac-driver/protocol.mjs';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
const window = { windowId: '101', processStart: '100.25', pid: 120, bundleId: 'com.apple.calculator',
  app: 'Calculator', title: 'Calculator', identityVerified: true, onScreen: true, minimized: false,
  bounds: { x: 0, y: 0, width: 320, height: 500 } };
const header = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator, ID: main';
const rows = value => [
  'container ID: keypad',
  ...(value === '735' ? ['\tscroll area ID: StandardResultView', '\t\ttext Description: Last Expression, Value: 15 × 49'] : []),
  `\tscroll area ID: StandardInputView;value:${value}`,
  `\t\ttext Description: Edit field, Value: ${value}`,
  '\tbutton Description: Delete, ID: Delete',
  `\tbutton Description: ${value === '0' ? 'All Clear' : 'Clear'}, ID: ${value === '0' ? 'AllClear' : 'Clear'}`,
  ...['Seven', 'One', 'Multiply', 'Four', 'Three', 'Equals'].map(id => '\tbutton Description: ' + id + ', ID: ' + id),
];
const tree = value => header + '\n' + rows(value).map((row, i) => {
  const indent = /^\t*/.exec(row)[0]; return '\t' + indent + (i + 1) + ' ' + row.slice(indent.length);
}).join('\n');
const binding = { windowId: window.windowId, processStart: window.processStart };
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

export async function fixture(t, { initial = tree('735'), afterClick, plainAction, wireClient, menu, partial, missingRead, changedIdentity, readSequence, menuBounds, twoWindows, realPolicy, compactReads, timeoutMs, delayAction, sentVerified } = {}) {
  let readId = 0, current = initial, id = 0, buffer = '';
  let live = structuredClone(window);
  const calls = [], pending = new Map();
  const driver = { async restart() {}, async close() {}, async ping() { return { build: 'a'.repeat(64) }; },
    async request(method, params) {
      const selected = twoWindows && (params?.selector === 'Other' || params?.windowId === '102') ? { ...live, windowId: '102' } : live;
      calls.push({ method, params: structuredClone(params) });
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
        processStart: window.processStart }, windows: [structuredClone(selected)] };
      if (method === 'verifyWindowIdentity') return { window: structuredClone(selected) };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'personState') return { token: 'fixture', personTookOver: false };
      if (method === 'getAXState') return { window: structuredClone(selected), text: readSequence?.[Math.min(readId, readSequence.length - 1)] ?? current, readId: ++readId, truncated: false };
      assert.equal(method, 'click');
      if (delayAction) await new Promise(resolve => setTimeout(resolve, delayAction));
      assert.equal(params.readId, readId, 'native input uses the current admission read');
      current = afterClick?.(current, params.args[0]) ?? current;
      if (menu) live = { ...live, ...changedIdentity, bounds: { ...live.bounds, width: 600, ...menuBounds } };
      return { window: structuredClone(live), readId, delivery: sentVerified ? 'sent-verified' : 'sent-unverified', retry: 'read-first',
        ...afterClick && !plainAction ? {text:current,readId:++readId,truncated:false} : {},
        ...menu ? { semantics: 'menu-accessibility', ...missingRead ? {} : { text: current, readId: ++readId, truncated: !!partial } } : {} };
    } };
  const transport = wireClient ? createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', build: 'a'.repeat(64), spawn({ nonce }) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, _, done) {
      const request = JSON.parse(bytes); done();
      Promise.resolve().then(async () => {
        const result = request.method === 'ping' ? { protocol: request.protocol, apiVersion: 2, build: 'a'.repeat(64),
          methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS, 'inputGateState', 'personState', 'rendererRestore'] } : await driver.request(request.method, request.params);
        child.stdout.write(JSON.stringify({ protocol: request.protocol, platform: 'darwin', nonce, id: request.id, ok: true, result }) + '\n');
      }).catch(error => child.emit('error', error));
    } });
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; }; return child;
  } }) }) : driver;
  const runtime = createOwnRuntime({ driver: transport, compactReads, inputRegistrar: await prepareMacInputRegistrar(transport, 'a'.repeat(64)),
    lease: { acquire: () => 'fixture', grant: () => ({ token: 'fixture' }), renew() {}, renewGrant() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1],
    ancestry: () => [{ pid: 500, path: '/fixture/Host' }], ownHostPid: () => false,
    permissions: { app() {}, page() {}, sitesLimited: () => false }, replOptions: { environment: () => ({}) },
  });
  const input = new PassThrough(), output = new PassThrough(), bridge = runtime.createTransport(output);
  const relay = createRelay({ clientIn: input, clientOut: bridge.clientOut, serverIn: runtime.serverIn, serverOut: runtime.serverOut,
    nativeMac: true, nativeSession: bridge.nativeSession, documentationTrust: runtime.documentationTrust,
    permissions: { app() {}, page() {}, sitesLimited: () => false }, ownHostPid: () => false,
    changeReview: false, warmRepl: false, warmEngine: false, simFocusNote: false, idleTurnEndMs: 0 });
  t.after(async () => { await relay.close(); bridge.close(); await runtime.close(); input.destroy(); output.destroy(); });
  if (!realPolicy) runtime.safety.setPolicy({ checkPause() {}, beforeAction: ({ args }) => ({ args }) });
  output.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result); pending.delete(message.id);
    }
  });
  const js = (code, timeout_ms = timeoutMs ?? 30000) => new Promise(resolve => {
    pending.set(++id, resolve);
    input.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code, timeout_ms } } }) + '\n');
  });
  return { js, calls, runtime, change: value => { current = value; }, move: () => { live.bounds.x++; } };
}
