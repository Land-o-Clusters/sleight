import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createV3Bridge, serveV3Worker, createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { textPdf } from '../bench/pdf-fixture.mjs';

test('a trusted PDF build extends only its exact call; the next call retains the ordinary deadline', async () => {
  for (const request of [
    { name: 'browser_read', arguments: { tab: 't1' } },
    { name: 'browser_open', arguments: { url: 'https://example.test/invoice' } },
    { name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e1' }] } },
    { name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'e1', value: 'fixture' }] } },
  ]) {
  const child = new EventEmitter(), endpoint = new EventEmitter(); let calls = 0;
  child.connected = endpoint.connected = true;
  child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
  endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const worker = serveV3Worker({ channel: endpoint, browser: 'bfixture', begin: async () => ({
    async call(_request, control) {
      if (++calls === 1) control.pdfBuilding();
      await new Promise(resolve => setTimeout(resolve, 150));
      return { text: 'PDF text', isError: false };
    }, delivered: () => false, end: async () => ({ revoked: true, cleanup: [] }),
  }) });
  const bridge = await createV3Bridge({ timeoutMs: 60 }, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker: () => { queueMicrotask(() => worker.ready()); return child; } });
  try {
    await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn', text: 'Read the PDF' });
    assert.equal((await bridge.call(request)).text, 'PDF text');
    assert.notEqual((await bridge.call(request)).text, 'PDF text');
  } finally { await bridge.detach(); await worker.drain(); }
  }
});

test('the runtime signals a real compiler stage once, and cached extraction does not extend later reads', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sleight-pdf-worker-')), path = join(root, 'invoice.pdf');
  await writeFile(path, textPdf(['Total'])); let builds = 0, signals = 0;
  const binding = createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'message', text: `Read PDF "${path}"` }, () => true);
  const runtime = await createV3TurnRuntime({ binding, browser: 'bfixture', pages: { endTurn: async () => ({ cleanedUp: true }) }, snapshot() {},
    dependencies: { pdfInventory: { accepted: true }, preparePdfHelper: async ({ onProgress }) => {
      builds++; onProgress({ stage: 'sources' }); onProgress({ stage: 'compile' }); onProgress({ stage: 'compile' });
      return { status: 'ready', receipt: {} };
    }, extractPdf: async () => ({ pageCount: 1, pages: [{ page: 1, offset: 0, text: 'Total' }], next: null }) } });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await runtime.call({ name: 'browser_read', arguments: { file: path } }, { pdfBuilding: () => signals++ })).isError, false);
    assert.equal(builds, 1); assert.equal(signals, 1);
  } finally { await runtime.end(); await rm(root, { recursive: true, force: true }); }
});
