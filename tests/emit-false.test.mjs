import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { constants, createContext, runInContext } from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

async function engine(t, { combined = true } = {}) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-emit-false-')));
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const pending = new Map();
  let id = 0, shifted = false, content = [], lastCode = '';
  const actions = [];
  const tree = () => 'Window: "Fixture", App: Fixture Editor.\n0 standard window Fixture\n' +
    (shifted ? '1 button Different\n2 button Replacement' : '1 button Original\n2 button Different');
  const write = text => content.push({ type: 'text', text });
  const raw = {
    getAXState: async () => tree(),
    getAXStateAndScreenshot: async (options) => {
      if (options.emit !== false) write(tree());
      return { state: tree(), screenshot: 'fake image' };
    },
    getScreenshot: async () => 'fake image',
    click: async n => actions.push(n),
  };
  if (!combined) delete raw.getAXStateAndScreenshot;
  const context = createContext({
    cua: { getApp: async () => { write(tree()); return raw; }, listApps: async () => [] },
    nodeRepl: { write, emitImage: async () => content.push({ type: 'image', data: '', mimeType: 'image/png' }) },
  });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'emit-fixture',
    changeReview: false, inputLease: new InputLease({ directory: dir, holder: 'fixture' }) });
  clientOut.setEncoding('utf8').on('data', data => {
    for (const line of data.trim().split('\n')) {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg.result);
      pending.delete(msg.id);
    }
  });
  let queue = Promise.resolve();
  serverIn.setEncoding('utf8').on('data', data => {
    for (const line of data.trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.method !== 'tools/call') continue;
      queue = queue.then(async () => {
        content = [];
        lastCode = msg.params.arguments.code;
        let isError = false;
        // Preserve the fixture's top-level binding across calls, as the engine's REPL does.
        const code = msg.params.arguments.code.replace(/\bvar app\s*=/, 'globalThis.app =');
        try { await runInContext('(async () => { ' + code + ' })()', context,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (err) { isError = true; write(err.message); }
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content, isError,
          _meta: { 'codex/toolSurface': { app: { appId: 'example.fixture' } } } } }) + '\n');
      });
    }
  });
  t.after(() => {
    relay.dispose();
    for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = code => new Promise(resolve => {
    const callId = ++id;
    pending.set(callId, resolve);
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call',
      params: { name: 'js', arguments: { code } } }) + '\n');
  });
  const acquired = await call('var app = await cua.getApp("example.fixture")');
  assert.equal(acquired.isError, false, JSON.stringify(acquired.content));
  return { call, actions, shift: () => { shifted = true; }, code: () => lastCode };
}

for (const method of ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']) {
  test(method + ' respects emit false through variables and spreads', async t => {
    const h = await engine(t);
    const result = await h.call('const options = {emit:false}; await app.' + method + '({...options}); nodeRepl.write("kept");');
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: 'text', text: 'kept' }]);
  });
}

test('an omitted read does not suppress a later normal read or a read named in a comment', async t => {
  const h = await engine(t);
  for (const code of ['await app.getAXState({emit:false}); await app.getAXState();',
    '// getAXState({emit:false})\nawait app.getAXState();']) {
    const result = await h.call(code);
    assert.equal(result.isError, false);
    assert.match(result.content.map(c => c.text).join('\n'), /Window:|no change since/);
  }
});

test('an omitted read with no write cannot authorize a stale numeric click', async t => {
  const h = await engine(t);
  h.shift();
  const hidden = await h.call('await app.getAXState({emit:false})');
  assert.equal(hidden.isError, false);
  assert.equal(hidden.content.some(c => /Window:|Original|Different/.test(c.text ?? '')), false);
  const clicked = await h.call('await app.click(1)');
  assert.equal(clicked.isError, true, h.code().slice(-1800));
  assert.match(clicked.content.map(c => c.text).join('\n'), /stale|changed since|was .*Original.*now .*Different/);
  assert.deepEqual(h.actions, []);
});

test('a full tree explicitly written from an omitted read counts as visible', async t => {
  const h = await engine(t);
  h.shift();
  const result = await h.call('nodeRepl.write(await app.getAXState({emit:false}))');
  assert.match(result.content.map(c => c.text).join('\n'), /1 button Different/);
  assert.equal((await h.call('await app.click(1)')).isError, false);
  assert.deepEqual(h.actions, [1]);
});

test('screenshot fallback keeps its hidden header out of the result', async t => {
  const h = await engine(t, { combined: false });
  const result = await h.call('await app.getScreenshot({emit:false})');
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, []);
});
