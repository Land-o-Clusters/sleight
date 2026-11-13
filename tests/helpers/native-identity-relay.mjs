// Offline relay transport and OS-call fakes. No native helper process is started.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../../plugins/sleight/lib/input-lease.mjs';
import { registerTemp } from '../../scripts/temp-leftovers.mjs';
import { inspect } from './window-identity-fixture.mjs';

export const settle = () => new Promise(resolve => setImmediate(resolve));
export const appId = 'com.apple.TextEdit';
export function identityRelay(t, { relayFactory = createRelay, sources, health = true, tree = true, ...options } = {}) {
  const directory = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ad3y-')));
  const state = { number: 11, pid: 123, processStart: 1, status: 'ok', numbers: undefined, unavailable: false };
  const requests = [], observations = [], events = [], forwarded = [], received = [];
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  for (const [stream, output] of [[serverIn, forwarded], [clientOut, received]]) {
    stream.setEncoding('utf8').on('data', data => data.split('\n').filter(Boolean).forEach(line => output.push(JSON.parse(line))));
  }
  const inputLease = new InputLease({ directory, holder: 'ad3y' });
  const relay = relayFactory({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false,
    runningProbe: () => ({ status: 'responding' }),
    ...(health ? { spaceProbe: () => ({ status: 'responding', pid: state.pid, processStart: state.processStart,
      windows: 1, allWindows: 1, windowNumbers: [state.number], ...state.health }) } : {}),
    trace: (direction, msg) => { if (direction.startsWith('native-window-')) events.push({ direction, ...msg }); },
    windowIdentity: request => {
      requests.push(structuredClone(request));
      const observed = inspect(request, state.numbers ?? [null], state.focused ?? 0, true, [], (_app, windows, _list, runtime) => {
        windows.forEach(window => { window.missing = ['AXWindowNumber', 'AXDocument']; });
        runtime.cgNumber = state.numbers ? undefined : state.number;
        runtime.running.processIdentifier = state.pid;
        runtime.running.launchDate.timeIntervalSince1970 = state.processStart;
        runtime.cgUnavailable = state.status === 'unknown' || state.unavailable;
        if (state.numbers) runtime.cgWindows = windows.map((window, i) => ({ kCGWindowOwnerPID: state.pid,
          kCGWindowLayer: 0, kCGWindowNumber: state.numbers[i], kCGWindowName: window.AXTitle,
          kCGWindowBounds: { X: window.AXPosition.x, Y: window.AXPosition.y, Width: window.AXSize.width, Height: window.AXSize.height } }));
      }, sources);
      observations.push(observed);
      state.afterInspect?.(request, observed);
      return observed;
    }, ...options });
  t.after(() => relay.close());
  const call = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args } }) + '\n');
  const send = (id, code) => call(id, 'js', { code });
  const reply = (id, text = 'Window: "Untitled", App: TextEdit.' + (tree ? '\n0 standard window Untitled\n1 button Next' : '')) =>
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }],
      _meta: { 'codex/toolSurface': { app: { appId } } } } }) + '\n');
  const read = async (id, code = 'await app.getAXState()', text) => {
    send(id, code); await settle();
    assert.equal(forwarded.at(-1).id, id);
    reply(id, text); await settle();
    assert.equal(received.at(-1).id, id);
  };
  return { state, requests, observations, events, forwarded, received, relay, call, send, reply, read };
}
