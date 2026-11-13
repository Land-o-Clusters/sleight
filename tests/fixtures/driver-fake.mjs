// Shared headless provider shape. Every window, tree, action and lease is synthetic.
import { prepareMacInputRegistrar } from '../../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { fakeWindows } from './windows-driver-fake.mjs';
import { createMacReadState } from '../../plugins/sleight/lib/mac-driver/diff.mjs';
import { resolveWindowsKey, refuseWindowsKey, WindowsClipboardWatch, windowsClipboardResult } from '../../plugins/sleight/lib/windows-driver/clipboard.mjs';
import { keyPlan } from '../../plugins/sleight/lib/mac-driver/keys.mjs';
import { guardWindowsAction } from '../../plugins/sleight/lib/windows-driver/guard.mjs';
import { clipboardClientReply } from './mac-driver-clipboard-client.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp, removeTemp } from '../../scripts/temp-leftovers.mjs';

export const sittingCase = ({ platform, id, status, elapsedMs = null, code = null, calls = [] }) =>
  ({ platform, id, status, elapsedMs, code, calls });

export async function driverFixture(platform, createSafety, { preview = false, allow = true,
  body = '1 button Done', beforeInput, afterInput } = {}) {
  const calls = [], actions = [], cards = [], leases = [], events = [];
  let readId = 0, paused = false, ended = false, changed = false, blocked;
  const window = platform === 'darwin' ? {
    windowId: '101', pid: 41, processStart: '100.25', bundleId: 'org.example.Fixture',
    app: 'Fixture', title: 'Fixture', identityVerified: true, onScreen: true, minimized: false,
    bounds: { x: 0, y: 0, width: 500, height: 500 },
  } : { ...structuredClone(fakeWindows[0]), app: 'Fixture', title: 'Fixture' };
  const text = 'Window: "Fixture", App: Fixture.\n0 standard window Fixture\n\t' + body;
  const driver = {
    ping: async () => ({ build: 'b'.repeat(64) }),
    async request(method, params) {
      if (method === 'inputGateState') return { enabled: true };
      calls.push(method); events.push(method);
      const observed = { ...structuredClone(window), ...changed ? { processStart: '200' } : {} };
      if (method === 'getState') return { windows: [observed], apps: [] };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app,
        pid: window.pid, processStart: window.processStart }, windows: [observed] };
      if (method === 'verifyWindowIdentity') return { window: observed };
      if (method === 'personState') return { window: observed, token: 'person-fixture', personTookOver: false };
      if (!['getAXState', 'getApp'].includes(method)) {
        if (blocked) throw Object.assign(Error(blocked), { code: blocked });
        if (beforeInput) await beforeInput(method, params);
        actions.push([method, structuredClone(params.args)]);
        if (afterInput) await afterInput(method, params);
      }
      return { window: observed, text, readId: ++readId, delivery: 'sent-unverified' };
    },
  };
  const lease = {
    acquire(target, scope) { leases.push(['acquire', scope]); return 'fixture-lease'; },
    renew() { leases.push(['renew']); },
    release() { leases.push(['release']); },
    close() { leases.push(['close']); },
  };
  const inputRegistrar = platform === 'darwin' && !preview ? await prepareMacInputRegistrar(driver, 'b'.repeat(64)) : undefined;
  const safety = createSafety({ platform, driver, lease, approve: async card => { cards.push(card); return allow; },
    allowForbidden: platform === 'darwin' ? () => false : false, inputRegistrar,
    policy: async () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 999, path: '/usr/bin/node' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false },
  });
  const policy = {
    beforeAction: async ({ args }) => { events.push('beforeAction'); return platform === 'darwin' ? { args } : args; },
    checkPause() { events.push('checkPause'); if (paused) throw Object.assign(Error('paused fixture'), { code: 'PAUSED' }); },
    endCell() { ended = true; },
  };
  safety.setPolicy(policy);
  return { platform, safety, driver, window, calls, actions, cards, leases, events, policy,
    pause(value) { paused = value; }, change() { changed = true; }, block(code) { blocked = code; },
    get ended() { return ended; },
    binding: () => ({ windowId: window.windowId, processStart: window.processStart }),
  };
}

// Production clipboard admission against synthetic trees, layouts and counters.
// Each platform consumes its production count rule, with synthetic counter values.
export async function clipboardDriverFixture(t, platform, createSafety, { body, countWatch, nativeKeyAdmission = false } = {}) {
  const order = [], state = createMacReadState();
  let count = 10, moveCount = false;
  const windowsWatch = new WindowsClipboardWatch(() => ({ value: count, error: 0 }));
  let windowsAdmission;
  const h = await driverFixture(platform, createSafety, { body,
    beforeInput(method, params) {
      order.push('native-admission');
      if (platform === 'darwin') {
        if (method === 'pressKey') keyPlan(params.args[0], new Map([['c', { keyCode: 8, modifiers: [] }]]));
        countWatch?.('admit', count);
      } else {
        if (method === 'pressKey') refuseWindowsKey(resolveWindowsKey(params.args[0], c => c.toUpperCase().charCodeAt(0)));
        windowsAdmission = windowsWatch.admit();
      }
    },
    async afterInput() {
      order.push('input');
      if (moveCount) { count++; order.push('count-moved'); }
      if (platform === 'win32') windowsClipboardResult({ clipboardChanged: windowsWatch.finish(windowsAdmission),
        delivery: 'sent-unverified', retry: 'read-first' });
      if (platform === 'darwin' && countWatch?.('finish', count)?.changed) {
        const reply = await clipboardClientReply({ ok: true, result: {
          clipboardChanged: true, delivery: 'sent-unverified', retry: 'read-first',
        } });
        throw Object.assign(Error(reply.error.code), reply.error);
      }
    },
  });
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  if (platform === 'darwin') {
    const snapshot = state.read(first); state.endCell([{ type: 'text', text: first.text }], [snapshot]);
  }
  h.safety.setPolicy({
    async beforeAction(action) {
      order.push('policy');
      if (platform === 'darwin') {
        const snapshot = state.read({ window: action.window, text: action.text, readId: action.readId });
        state.assertCurrent(action.method, { ...h.binding(), readId: snapshot.readId, args: action.args }, 1);
        return { args: action.args };
      }
      // Native-rule parity can isolate layout admission behind an allowing policy.
      // The production parent text refusal has its own zero-input witness.
      if (nativeKeyAdmission && action.method === 'pressKey') return action.args;
      return (await guardWindowsAction(action)).args;
    },
    checkPause() { order.push('pause'); }, endCell() {},
  });
  t.after(() => h.safety.close());
  return { ...h, order, moveCount() { moveCount = true; },
    async request(method, args) {
      const read = await h.safety.request('getAXState', h.binding());
      return h.safety.request(method, { ...h.binding(), readId: read.readId, args }, { cell: 1 });
    } };
}

// Only DriverClipboardWatch is compiled. Its OS counter is shadowed with a trap.
// The executable consumes stdin and prints JSON, with no app or window entry point.
export function clipboardCounterFixture(t) {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-rt17c-counter-')));
  t.after(() => removeTemp(directory));
  const source = readFileSync(new URL('../../plugins/sleight/lib/mac-driver/native/DriverClipboardWatch.swift', import.meta.url), 'utf8');
  const entry = `
enum NSPasteboard {
  struct Board { var changeCount: Int { fatalError("system counter forbidden") } }
  static var general: Board { Board() }
}
struct DriverFault: Error {
  let code: String
  var disposition = [String: Any]()
  init(_ code: String) { self.code = code }
}
var count = 10
let watch = DriverClipboardWatch(count: { count }, now: { 1 }, personInputSince: { _ in false })
var admission: DriverClipboardWatch.Admission?
while let line = readLine() {
  let command = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
  count = command["count"] as! Int
  var result = [String: Any]()
  do {
    if command["op"] as! String == "admit" { admission = nil; try watch.admit(&admission) }
    else { result["changed"] = try watch.finish(admission) }
  } catch let error as DriverFault { result = error.disposition; result["code"] = error.code }
  catch { fatalError("unexpected fixture error") }
  print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
}
`;
  const file = join(directory, 'counter.swift'), binary = join(directory, 'counter');
  writeFileSync(file, source + entry);
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'modules'), file, '-o', binary],
    { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  if (compiled.status !== 0) throw Error(compiled.stderr);
  const history = [];
  return (op, count) => {
    history.push({ op, count });
    const run = spawnSync(binary, [], { input: history.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    if (run.status !== 0) throw Error(run.stderr);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
    if (result.code) throw Object.assign(Error(result.code), result);
    return result;
  };
}
