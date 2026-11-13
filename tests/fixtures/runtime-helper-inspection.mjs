import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { createMacReadState } from '../../plugins/sleight/lib/mac-driver/diff.mjs';
import { createRelay } from '../../plugins/sleight/lib/relay.mjs';
import { helperInspection } from '../../plugins/sleight/lib/repl/helpers.mjs';
import { registrar } from './runtime-helper-registrar.mjs';
export { registrar } from './runtime-helper-registrar.mjs';

// Only the ID1 capability provider is replaced. All admission, policy,
// retained-number and guard code below is the production implementation.
const safetyURL = new URL('../../plugins/sleight/lib/mac-safety.mjs', import.meta.url);
const provider = new URL('./runtime-helper-registrar.mjs', import.meta.url).href;
const source = readFileSync(safetyURL, 'utf8').replace(/(['"])(\.\.?\/[^'"]+)\1/g,
  (_all, quote, path) => quote + (path.endsWith('/input-registrar.mjs') ? provider : new URL(path, safetyURL).href) + quote);
const scratch = mkdtempSync(join(tmpdir(), 'hl1b-safety-'));
const moduleFile = join(scratch, 'mac-safety.mjs');
writeFileSync(moduleFile, source);
const { createMacSafety } = await import(pathToFileURL(moduleFile));
const runtimeURL = new URL('../../plugins/sleight/lib/runtime-select.mjs', import.meta.url);
const runtimeSource = readFileSync(runtimeURL, 'utf8').replace(/(['"])(\.\.?\/[^'"]+)\1/g,
  (_all, quote, path) => quote + (path === './mac-safety.mjs' ? pathToFileURL(moduleFile).href :
    path.endsWith('/input-registrar.mjs') ? provider : new URL(path, runtimeURL).href) + quote);
const runtimeFile = join(scratch, 'runtime-select.mjs');
writeFileSync(runtimeFile, runtimeSource);
export const runFixtureRuntime = (await import(pathToFileURL(runtimeFile))).runOwnRuntime;
rmSync(scratch, { recursive: true });
export const initial = Object.freeze({ windowId: '101', pid: 120, processStart: '1700000000:123456',
  bundleId: 'com.example.Editor', app: 'TextEdit', title: 'Draft', identityVerified: true,
  onScreen: true, minimized: false, bounds: { x: 0, y: 0, width: 800, height: 600 } });
export const tree = (extra = '', window = initial) => `Window: "${window.title}", App: ${window.app}.\n0 standard window ${window.title}\n\t1 text field Name\n\t2 text field Email\n\t3 button Done${extra}\nThe focused UI element is 1 text field Name`;
export const resultText = result => result?.content?.filter(row => row.type === 'text').map(row => row.text).join('\n') ?? '';
// Load a changed product module for a negative control. Its dependencies still
// resolve to this checkout; the temporary module is removed after import.
export async function productModule(path, change) {
  // A compatibility entry point has no guards to mutate. Follow its shared implementation.
  const implementation = path === 'windows-driver/safety.mjs' ? 'driver-safety.mjs' : path;
  const url = new URL('../../plugins/sleight/lib/' + implementation, import.meta.url);
  const original = readFileSync(url, 'utf8'), changed = change(original);
  if (changed === original) throw Error('negative control did not change product source');
  const directory = mkdtempSync(join(tmpdir(), 'hl1d-product-'));
  const file = join(directory, 'product.mjs');
  try {
    writeFileSync(file, changed.replace(/(['"])(\.\.?\/[^'"]+)\1/g,
      (_all, quote, relative) => quote + (relative.endsWith('/input-registrar.mjs') ? provider : new URL(relative, url).href) + quote));
    return await import(pathToFileURL(file));
  } finally { rmSync(directory, { recursive: true }); }
}
export async function fixture(t, options = {}) {
  let window = { ...structuredClone(initial), ...options.window }, text = tree('', window), readId = 0, cell = 1, messageId = 0, runtimePolicy;
  const requests = [], snapshots = [], reads = createMacReadState(), cards = [];
  const driver = { async request(method, params) {
    requests.push({ method, params: structuredClone(params) });
    if (options.request) { const answer = await options.request(method, params, { window, text, readId }); if (answer !== undefined) return answer; }
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart }, windows: [structuredClone(window)] };
    if (method === 'verifyWindowIdentity') return { window: structuredClone(window) };
    if (method === 'personState') return { window: structuredClone(window), token: 'person-' + requests.length, personTookOver: false };
    return { window: structuredClone(window), text, readId: ++readId, delivery: 'sent-unverified' };
  } };
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  for (const stream of streams) stream.resume();
  const relay = (options.createRelay ?? createRelay)({ clientIn: streams[0], clientOut: streams[1], serverIn: streams[2], serverOut: streams[3],
    nativeMac: true, nativeSession: { setPolicy(value) { runtimePolicy = value; } },
    inputLease: undefined, idleTurnEndMs: 0, changeReview: false,
    paymentCard: { async ask(value) { cards.push(value); return options.paymentChoice ?? 'cancel'; } },
    ...options.relayOptions });
  const lease = { acquire: () => 'lease', renew() {}, release() {}, close() {} };
  const safety = (options.createSafety ?? createMacSafety)({ driver, lease, inputRegistrar: options.noRegistrar ? undefined : registrar(driver),
    approve: options.approve ?? (() => true), approvalScope: options.approvalScope,
    targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/host' }], policy: options.policy ?? (() => ({ allow: true })),
    permissions: { app() {}, page() {}, sitesLimited: () => false }, ownHostPid: options.ownHostPid,
    refreshApprovals: options.refreshApprovals });
  safety.setPolicy(runtimePolicy);
  t.after(async () => { await safety.close(); await relay.close(); streams.forEach(stream => stream.destroy()); });
  const observe = reply => { if (typeof reply?.text === 'string' && !snapshots.some(row => row.readId === reply.readId && row.window.windowId === reply.window.windowId)) { snapshots.push(reads.read(reply)); } };
  const context = () => ({ cell, isActive: () => true, observe,
    beforeRequest(method, params) { return reads.assertCurrent(method, params, cell); },
    fullTree: params => reads.fullTree(params) });
  const acquire = async () => {
    const reply = await safety.request('getApp', { selector: window.bundleId }, { cell, observe });
    observe(reply); reads.endCell([{ type: 'text', text: reply.text }], [snapshots.at(-1)]); return reply;
  };
  const first = await acquire();
  // Let the real relay observe the successful acquisition so its lease app and
  // compactor baseline are established through the ordinary response path.
  const deliverAcquisition = reply => new Promise(resolve => {
    streams[2].once('data', bytes => {
      const request = JSON.parse(bytes);
      streams[3].write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        content: [{ type: 'text', text: reply.text }], isError: false,
        _meta: { 'codex/toolSurface': { app: { appId: reply.window.bundleId }, window: reply.window } },
      } }) + '\n');
    });
    streams[1].once('data', () => resolve());
    streams[0].write(JSON.stringify({ jsonrpc: '2.0', id: 'fixture-acquire', method: 'tools/call',
      params: { name: 'js', arguments: { code: 'var app = await cua.getApp("TextEdit");' } } }) + '\n');
  });
  await deliverAcquisition(first);
  const params = (args = [3], changes = {}) => ({ windowId: window.windowId, processStart: window.processStart, readId, args, ...changes });
  return { driver, safety, relay, reads, runtimePolicy, streams, requests, cards, params, acquire, snapshots, deliverAcquisition,
    actions: () => requests.filter(row => ['click','setValue','pressKey','typeText','paste','performSecondaryAction','drag','scroll'].includes(row.method)),
    patch(patch) { window = { ...window, ...patch }; }, setText(value) { text = value; },
    nextCell() { safety.finishCell(cell); cell++; },
    async step(method = 'click', args = [3], changes = {}, helper = 'fillForm', custom = {}) {
      const p = params(args, changes), c = { ...context(), helper, messageId: ++messageId, ...custom };
      if (helper !== undefined) await safety.inspectHelperCall(helperInspection(helper, method, p), c);
      return safety.request(method, p, c);
    },
    inspect(proposal, custom = {}) { return safety.inspectHelperCall(proposal, { ...context(), ...custom }); },
    context,
  };
}
