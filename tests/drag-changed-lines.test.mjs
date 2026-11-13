import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { callLocalTool, runScript } from '../plugins/sleight/lib/launch.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const appId = 'org.example.editor', app = 'Fixture Editor';
const tree = (value, title = 'note.txt') => [`Window: "${title}", App: ${app}.`,
  `0 standard window ${title}, URL: file:///tmp/${title}`,
  ...Array.from({ length: 25 }, (_, i) => `\t${i + 1} button Item ${i}`),
  `\t30 text entry area Value: ${value}`].join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const withEnv = async (t, name, value) => {
  const before = process.env[name];
  process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
};

test('launcher appends one read after changed text and keeps the drag result if the read fails', async () => {
  for (const changed of [true, false, null]) for (const fail of [false, true]) {
    let reads = 0;
    const result = await callLocalTool('drag', { app }, async () => true,
      async (_script, args) => args.op === 'capture' ? { ok: true } : { ok: true, path: 'accessibility', textChanged: changed },
      undefined, undefined, { afterDrag: async () => { reads++; if (fail) throw Error('read failed'); return [{ type: 'text', text: 'changed lines' }]; } });
    assert.equal(reads, changed === true ? 1 : 0);
    assert.equal(result.content.length, changed === true && !fail ? 2 : 1);
    assert.equal(result.isError, undefined);
  }
});

test('DP4 off preserves the launcher result byte for byte and runs no read', async t => {
  await withEnv(t, 'SLEIGHT_DP4', '0');
  const result = await callLocalTool('drag', { app }, async () => true,
    async (_script, args) => args.op === 'capture' ? { ok: true } : { ok: true, path: 'accessibility', textChanged: true },
    undefined, undefined, { afterDrag: () => assert.fail('off arm read') });
  assert.deepEqual(result, { content: [{ type: 'text', text: '{\n "path": "accessibility",\n "textChanged": true\n}' }] });
});

test('launcher owns both JXA switches and forwards their independent off values', async t => {
  for (const name of ['SLEIGHT_DP2', 'SLEIGHT_DP7']) await withEnv(t, name, '0');
  let request;
  await runScript('drag.js', { dp2: true, dp7: true }, (_cmd, argv, _options, done) => {
    request = JSON.parse(argv.at(-1)); done(null, '{"ok":true}', '');
    return { once() {}, removeListener() {} };
  });
  assert.equal(request.dp2, false); assert.equal(request.dp7, false);
});

async function fixture(t, { readError = false, otherWindow = false, changed = true, off = false, stop = false, cross = false, implicit = false, identityMismatch = false, browser = false, wrongApp = false, incomplete = false } = {}) {
  if (off) await withEnv(t, 'SLEIGHT_DP4', '0');
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const received = [], sent = [], leases = [], afterLease = [];
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  let relay;
  serverIn.on('data', bytes => {
    for (const msg of bytes.toString().trim().split('\n').map(JSON.parse)) {
      sent.push(msg);
      if (msg.method !== 'tools/call') continue;
      const dragRead = String(msg.id).startsWith('sleight-drag-read-');
      if (dragRead) {
        afterLease.push([...leases]);
        if (stop) { relay.close(); continue; }
      }
      const title = msg.params.arguments.code.includes('destination') ? 'destination.txt' : 'note.txt';
      serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        ...(dragRead && readError ? { isError: true } : {}),
        _meta: { 'codex/toolSurface': { app: { appId: dragRead && wrongApp ? 'org.other.app' : appId } } },
        content: [{ type: 'text', text: dragRead && incomplete ? 'Window: \"note.txt\", App: Fixture Editor.' : tree(dragRead ? 'beta alpha' : 'alpha beta', dragRead && otherWindow ? 'other.txt' : title) }],
      } }) + '\n');
    }
  });
  relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    ask: async () => 'accept', webBrowser: () => browser,
    windowIdentity: async target => ({ ...target, status: identityMismatch ? 'mismatch' : 'ok', matches: 1, epoch: 'fixture', window: 1,
      pid: 7, processStart: 1, windowNumber: target.windowNumber ?? (target.title === 'destination.txt' ? 12 : 11) }),
    inputLease: { acquire: () => { leases.push('lease'); return 'lease'; }, renew() {},
      release: () => { leases.pop(); }, close() {}, blockers: () => [] },
    localTools: { tools: [{ name: 'drag' }], target: async () => ({ appId, app, title: 'note.txt', url: 'file:///tmp/note.txt', windowNumber: 11 }),
      call: (name, args, approve, _run, resolved, prepared, options) => callLocalTool(name, args, approve,
        async (_script, request) => request.op === 'capture' ? { ok: true } : {
          ok: true, path: 'accessibility', textChanged: changed, windowId: 11, ...(cross ? { toWindowId: 12 } : {}),
        }, resolved, prepared, options) } });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const send = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  send(1, 'js', { code: implicit ? `let editor = await cua.getApp("${appId}")` : `let editor = await cua.getApp({ windowId: 11 })` });
  for (let i = 0; i < 20 && !received.some(m => m.id === 1); i++) await tick();
  assert.ok(received.some(m => m.id === 1), JSON.stringify({ received, sent }));
  if (cross) {
    send(2, 'js', { code: `let destination = await cua.getApp({ windowId: 12 })` });
    for (let i = 0; i < 20 && !received.some(m => m.id === 2); i++) await tick();
  }
  send(3, 'drag', { app: appId, windowId: 11, ...(cross ? { toWindowId: 12 } : {}), from: [20, 40], to: [80, 40] });
  for (let i = 0; i < 40 && !received.some(m => m.id === 3); i++) await tick();
  return { result: received.find(m => m.id === 3)?.result, reads: sent.filter(m => String(m.id).startsWith('sleight-drag-read-')), afterLease, received };
}

test('DP4 relay reads once under the drag lease and appends the existing compactor diff', async t => {
  const h = await fixture(t);
  assert.equal(h.reads.length, 1, JSON.stringify(h));
  assert.match(h.reads[0].params.arguments.code, /^await editor\.getAXState\(\{ disableDiffing: true \}\)$/);
  assert.ok(h.afterLease[0].length > 0);
  const text = h.result.content.map(c => c.text).join('\n');
  assert.match(text, /lines changed since the last full tree/);
  assert.match(text, /\+ .*text entry area Value: beta alpha/);
  assert.doesNotMatch(text, /Item 20/);
});

for (const options of [{ readError: true }, { otherWindow: true }, { changed: false }, { off: true }, { wrongApp: true }, { incomplete: true }, { browser: true }, { implicit: true, identityMismatch: true }]) {
  test(`DP4 preserves the result without changed lines: ${JSON.stringify(options)}`, async t => {
    const h = await fixture(t, options);
    assert.equal(h.reads.length, options.changed === false || options.off || options.browser || options.identityMismatch ? 0 : 1);
    assert.equal(h.result.content.length, 1); assert.equal(h.result.isError, undefined);
  });
}

test('DP4 cross-window move reads the destination once', async t => {
  const h = await fixture(t, { cross: true });
  assert.equal(h.reads.length, 1, JSON.stringify(h));
  assert.match(h.reads[0].params.arguments.code, /^await destination\.getAXState/);
  assert.match(h.result.content.map(c => c.text).join('\n'), /beta alpha/);
});

test('DP4 Stop during the read publishes no changed lines', async t => {
  const h = await fixture(t, { stop: true });
  assert.equal(h.reads.length, 1);
  assert.ok(!h.result?.content.some(c => /lines changed|beta alpha/.test(c.text)));
});

test('DP4 implicit acquisition proves the returned native window number before one read', async t => {
  const h = await fixture(t, { implicit: true });
  assert.equal(h.reads.length, 1, JSON.stringify(h));
  assert.match(h.result.content.map(c => c.text).join('\n'), /lines changed since the last full tree/);
});

// Exercise the relay callback with states that ordinary acquisition currently deduplicates.
async function callbackFixture(options = {}) {
  const { duplicate = false, baseline = true, mismatch = false } = options;
  const number = Object.hasOwn(options, 'number') ? options.number : 11;
  const source = readFileSync(new URL('../plugins/sleight/lib/relay.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('  async function dragChangedLines('), source.indexOf('\n  async function callLocal('));
  const target = { appId, app, title: 'note.txt', url: 'file:///tmp/note.txt', nativeCandidates: 1 };
  const requests = [], proofs = [], internalRequests = new Map();
  const context = { process, setTimeout, clearTimeout, inputLease: {}, leaseCalls: new Map([[1, { key: 'lease' }]]),
    dragWindows: new Map(duplicate ? [[1, { ...target, windowNumber: 11 }], [2, { ...target, title: 'old.txt', windowNumber: 11 }]] : []),
    leaseWindow: target, webBrowser: () => false,
    windowIdentity: async window => { proofs.push(window); return { status: mismatch ? 'mismatch' : 'ok' }; },
    verifyWindowIdentity: (_target, observed) => { if (observed.status !== 'ok') throw Error('identity mismatch'); },
    handleBundles: new Map([['editor', target]]), handleSelectors: new Map(), unconfirmedHandles: new Set(),
    sameWindow: (a, b) => a.app === b.app && a.title === b.title,
    internalRequests, lateHelperReplies: new Set(), nextInternalId: 1, engineMeta: () => ({}),
    toServer: request => { requests.push(request); internalRequests.get(request.id)({ result: { content: [{ type: 'text', text: tree('beta alpha') }] } }); },
    windowFromText: () => target, hasFullTree: () => true, GUARD_MARK: '[guard]',
    compactor: { seenLines: () => baseline ? { 30: 'text entry area Value: alpha beta' } : undefined,
      process: () => [{ type: 'text', text: baseline ? 'changed lines' : tree('beta alpha') }] },
  };
  const run = runInNewContext(code + '\ndragChangedLines', context);
  let result, error;
  try { result = await run({ id: 1, params: { arguments: { app: appId } } }, { textChanged: true, windowId: number }, () => {}); }
  catch (caught) { error = caught; }
  return { result, error, requests, proofs };
}

test('DP4 refuses missing and unsafe result window numbers before reading', async () => {
  for (const number of [undefined, null, '11', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const h = await callbackFixture({ number });
    assert.equal(h.requests.length, 0, String(number));
    assert.equal(h.proofs.length, 0, String(number));
    assert.equal(h.result.length, 0);
  }
});

test('DP4 proves identity for duplicate window numbers and suppresses a mismatch', async () => {
  for (const mismatch of [false, true]) {
    const h = await callbackFixture({ duplicate: true, mismatch });
    assert.equal(h.proofs.length, 1);
    assert.equal(h.requests.length, mismatch ? 0 : 1);
    if (mismatch) assert.match(h.error.message, /identity mismatch/);
    else assert.equal(h.result[0].text, 'changed lines');
  }
});

test('DP4 appends no whole tree when the target has no compactor baseline', async () => {
  const h = await callbackFixture({ baseline: false });
  assert.equal(h.requests.length, 0);
  assert.equal(h.result.length, 0);
});
