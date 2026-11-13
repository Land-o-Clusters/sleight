import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PassThrough } from 'node:stream';

// Each broken variant runs this same file in its own process. The desktop
// boundary below is an in-memory driver, including its registrar handshake.
const mutations = {
  receipt: ['mac-safety.mjs', 'result = { ...result, readId: entry.readId };', 'result = { ...result };'],
  handle: ['repl/cua.mjs', "else if (platform === 'darwin' && Number.isSafeInteger(result?.readId) && result.readId > 0) latestRead = result.readId;", ''],
  resultRead: ['repl/cua.mjs', 'readResult(result); latestRead = result.readId; pendingReads.delete(readKey);', 'readResult(result); pendingReads.delete(readKey);'],
  key: ['mac-driver/diff.mjs', "if (method === 'pressKey' && typeof params?.args?.[0] === 'string' && params.target === undefined) return;", ''],
  numbers: ['mac-driver/diff.mjs', "if (!entry || params?.readId !== entry.snapshot.readId) stale('', 'handle-readid');", "if (!entry) stale('', 'handle-readid');"],
  failure: ['runtime-select.mjs', "failureDelivery: facts.errors.at(-1)?.delivery === 'not-sent' && facts.errors.at(-1)?.charactersDelivered > 0 ? 'sent-partial' : facts.errors.at(-1)?.delivery,", ''],
  partial: ['runtime-select.mjs', "facts.errors.at(-1)?.delivery === 'not-sent' && facts.errors.at(-1)?.charactersDelivered > 0 ? 'sent-partial' : ", ''],
  relay: ['relay.mjs', "delivery: nativeMac ? nativeSession?.inputFailure?.(msg.id)?.delivery : undefined,", ''],
  wording: ['compact-reads.mjs', "failure?.delivery === 'not-sent' ? 'failed action sent no input' :", ''],
};
let hook;
if (process.env.GL6_MUTANT) {
  const names = process.env.GL6_MUTANT === 'original' ? ['receipt', 'key'] : [process.env.GL6_MUTANT];
  assert.ok(names.every(name => Object.hasOwn(mutations, name)), 'known broken variant');
  const selected = names.map(name => mutations[name]).map(([file, before, after]) => ({
    target: new URL('../plugins/sleight/lib/' + file, import.meta.url).href, before, after,
  }));
  hook = registerHooks({ load(url, context, next) {
    const result = next(url, context);
    const mutation = selected.find(row => row.target === url);
    if (!mutation) return result;
    const { before, after } = mutation;
    assert.ok(String(result.source).includes(before), 'mutation anchor');
    return { ...result, source: String(result.source).replace(before, after) };
  } });
}
const { createOwnRuntime } = await import('../plugins/sleight/lib/runtime-select.mjs');
const { createRelay } = await import('../plugins/sleight/lib/relay.mjs');
const { createCua } = await import('../plugins/sleight/lib/repl/cua.mjs');
const { createMacReadState } = await import('../plugins/sleight/lib/mac-driver/diff.mjs');
const { prepareMacInputRegistrar } = await import('../plugins/sleight/lib/mac-driver/input-registrar.mjs');
hook?.deregister();

const window = { windowId: '101', processStart: '100.25', pid: 120, bundleId: 'org.test.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
  bounds: { x: 0, y: 0, width: 800, height: 600 } };
const tree = 'Window: "Draft", App: Editor.\n0 standard window Draft\n' +
  Array.from({ length: 7 }, (_, i) => `\t${i + 1} button Item ${i + 1}`).join('\n');
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const binding = { windowId: window.windowId, processStart: window.processStart };

async function fixture(t, { postRead = false, failKey, failChars, change = false } = {}) {
  let readId = 0, current = tree, id = 0, buffer = '';
  const calls = [], pending = new Map();
  const driver = { async restart() {}, async close() {}, async ping() { return { build: 'a'.repeat(64) }; },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
        processStart: window.processStart }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'personState') return { token: 'fixture', personTookOver: false };
      if (method === 'getAXState') return { window, text: current, readId: ++readId, truncated: false };
      assert.ok(['typeText', 'pressKey', 'click'].includes(method), method);
      assert.equal(params.readId, readId, 'native action uses the latest admission read');
      if (method === 'pressKey' && failKey) throw Object.assign(Error('fixture key refusal'),
        { code: 'KEY_FOCUS_UNAVAILABLE', delivery: failKey, retry: failKey === 'not-sent' ? 'safe' : 'read-first', ...(failChars ? { charactersDelivered: failChars } : {}) });
      if (method === 'typeText' && change) current = current.replace('button Item 7', 'button Another item');
      return { window, delivery: 'sent-unverified', retry: 'read-first',
        ...postRead ? { text: current, readId: ++readId, truncated: false } : {} };
    } };
  const runtime = createOwnRuntime({ driver, inputRegistrar: await prepareMacInputRegistrar(driver, 'a'.repeat(64)),
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
  runtime.safety.setPolicy({ checkPause() {}, beforeAction: ({ args }) => ({ args }) });
  output.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result); pending.delete(message.id);
    }
  });
  const js = code => new Promise(resolve => {
    pending.set(++id, resolve);
    input.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  });
  const acquired = await js('let app = await cua.getApp("Editor");');
  assert.equal(acquired.isError, false, text(acquired));
  return { js, calls };
}

for (const postRead of [false, true]) test(`typeText then Command+s in one cell, post-action tree=${postRead}`, { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { postRead });
  const result = await f.js('await app.typeText("Sleight GL1 input smoke\\n"); await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(f.calls.filter(row => ['typeText', 'pressKey'].includes(row.method)).map(row => row.method), ['typeText', 'pressKey']);
});

test('a tree-free native receipt carries its parent read id through the worker handle', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t);
  const result = await f.js('const typed = await app.typeText("fixture"); nodeRepl.write("receipt-read=" + typed.readId); await app.typeText("more"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /receipt-read=2/);
  assert.equal(f.calls.filter(row => row.method === 'typeText').length, 2);
});

for (const postRead of [false, true]) test(`receipt read becomes current for the next handle action, tree=${postRead}`, async () => {
  let id = 1;
  const calls = [];
  const cua = createCua({ platform: 'darwin', write() {}, emitImage() {}, async request(method, params) {
    calls.push({ method, params });
    if (method === 'getApp') return { window, text: tree, readId: id };
    assert.equal(params.readId, id, 'handle advances to its result read');
    return { window, readId: ++id, ...postRead ? { text: tree } : {}, delivery: 'sent-unverified' };
  } });
  const app = await cua.getApp('Editor');
  await app.typeText('fixture'); await app.pressKey('Command+s'); await app.click(7);
  assert.deepEqual(calls.map(row => row.params.readId), [undefined, 1, 2, 3]);
});

test('untargeted keys tolerate an earlier session read while element numbers stay stale', () => {
  const reads = createMacReadState(), first = reads.read({ window, text: tree, readId: 1 });
  reads.endCell([{ type: 'text', text: tree }], [first]);
  reads.read({ window, text: tree, readId: 2 });
  assert.doesNotThrow(() => reads.assertCurrent('pressKey', { ...binding, readId: 1, args: ['Command+s'] }, 'cell'));
  assert.throws(() => reads.assertCurrent('click', { ...binding, readId: 1, args: [7] }, 'cell'),
    { code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' });
});

test('a click using an old handle read is refused before the driver', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { postRead: true });
  assert.equal((await f.js('let newer = await cua.getApp("Editor"); await newer.typeText("fixture"); void 0;')).isError, false);
  const refused = await f.js('await app.click(7);');
  assert.equal(refused.isError, true, text(refused)); assert.match(text(refused), /STALE_READ/);
  assert.equal(f.calls.filter(row => row.method === 'click').length, 0);
});

test('an untargeted key on an older handle binds the fresh parent admission read', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { postRead: true });
  assert.equal((await f.js('let newer = await cua.getApp("Editor"); await newer.typeText("fixture"); void 0;')).isError, false);
  const result = await f.js('await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 1);
});

test('click(7) from before the action result cannot click a changed numbered row', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { postRead: true, change: true });
  const result = await f.js('await app.typeText("fixture"); await app.click(7);');
  assert.equal(result.isError, true, text(result)); assert.match(text(result), /STALE_READ/);
  assert.equal(f.calls.filter(row => row.method === 'typeText').length, 1);
  assert.equal(f.calls.filter(row => row.method === 'click').length, 0);
  assert.doesNotMatch(text(result), /partial input possible/);
});

for (const delivery of ['not-sent', 'sent-unverified', 'unknown']) test(`failure wording follows failed key delivery=${delivery}`, { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { postRead: true, failKey: delivery });
  const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s");');
  assert.equal(result.isError, true, text(result));
  if (delivery === 'not-sent') {
    assert.match(text(result), /failed action sent no input/);
    assert.doesNotMatch(text(result), /partial input possible/);
  } else assert.match(text(result), /partial input possible/);
  assert.equal(f.calls.filter(row => row.method === 'typeText').length, 1);
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 1);
});

test('a not-sent failure that delivered characters never reads as sent no input (GLS2E)', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { postRead: true, failKey: 'not-sent', failChars: 2 });
  const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s");');
  assert.equal(result.isError, true, text(result));
  assert.doesNotMatch(text(result), /failed action sent no input/);
  assert.match(text(result), /partial input possible/);
});

test('a refused first key reports that the cell sent no input', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { failKey: 'not-sent' });
  const result = await f.js('await app.pressKey("Command+s");');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /call failed \(no input was sent\)/);
  assert.doesNotMatch(text(result), /partial input possible/);
});

test('every broken variant has an exact source anchor', () => {
  for (const [file, anchor] of Object.values(mutations))
    assert.ok(readFileSync(new URL('../plugins/sleight/lib/' + file, import.meta.url), 'utf8').includes(anchor), file);
});
