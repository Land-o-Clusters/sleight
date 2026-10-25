import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createPdfReader } from '../plugins/sleight/lib/direct-browser/pdf.mjs';
import { textPdf } from '../bench/pdf-fixture.mjs';

// Run the actual serialized isolated-world function, replacing only the CDP
// transport and fetch boundary. Streams, cancellation and byte decoding are real.
function fixture({ locationUrl, response, fetching, mutate, content, contextId = 42, creating } = {}) {
  const url = 'https://invoice.test/current.pdf#page=3';
  const frame = { id: 'main', loaderId: 'loaded', url, mimeType: 'application/pdf' };
  const bytes = textPdf(['Fallback invoice']), calls = [], requests = [];
  let extractions = 0;
  const reader = createPdfReader({ extract: async path => {
    extractions++;
    assert.deepEqual(await readFile(path), bytes);
    return { pageCount: 1, pages: [{ page: 1, offset: 0, text: 'Fallback invoice' }], next: null };
  } });
  const page = { url: () => frame.url, isClosed: () => false };
  const entry = { page, cdp: { async send(method, params) {
    calls.push(method);
    if (method === 'Page.getResourceTree') return { frameTree: { frame: { ...frame } } };
    if (method === 'Page.enable') return {};
    if (method === 'Page.getResourceContent') {
      if (content) return content;
      throw Error('No resource with given URL found');
    }
    if (method === 'Page.createIsolatedWorld') {
      assert.equal(params.frameId, 'main');
      assert.equal(params.grantUniveralAccess, false);
      await creating?.();
      return { executionContextId: contextId };
    }
    assert.equal(method, 'Runtime.callFunctionOn');
    assert.equal(params.executionContextId, 42);
    assert.equal(params.userGesture, false);
    assert.equal(params.awaitPromise, true);
    const fn = runInNewContext('(' + params.functionDeclaration + ')', {
      URL, AbortController, setTimeout, clearTimeout, btoa,
      location: new URL(locationUrl ?? url),
      fetch: async (target, options) => {
        requests.push({ target, options });
        assert.equal(target, 'https://invoice.test/current.pdf');
        assert.equal(options.mode, 'same-origin');
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.redirect, 'error');
        assert.equal(options.cache, 'no-store');
        if (fetching) return fetching(target, options);
        const result = response?.() ?? new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
        Object.defineProperty(result, 'url', { value: target });
        return result;
      },
    });
    const value = await fn(...params.arguments.map(arg => arg.value));
    mutate?.(frame);
    return { result: { value } };
  } } };
  return { reader, entry, bytes, calls, requests, extractions: () => extractions };
}

test('a PDF cache miss reads exact tab bytes in an unprivileged same-origin world', async t => {
  const f = fixture(); t.after(() => f.reader.dispose());
  assert.match((await f.reader.tab(f.entry)).text, /Page 1\/1: "Fallback invoice"/);
  assert.equal(f.extractions(), 1); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.signal.aborted, true, 'network task ends before extraction');
});

test('a cached PDF never creates a world or makes a network request', async t => {
  const f = fixture({ content: { content: textPdf(['Fallback invoice']).toString('base64'), base64Encoded: true } });
  t.after(() => f.reader.dispose());
  assert.match((await f.reader.tab(f.entry)).text, /Fallback invoice/);
  assert.equal(f.requests.length, 0); assert.equal(f.calls.includes('Page.createIsolatedWorld'), false);
});

for (const [name, options] of [
  ['a different origin', { locationUrl: 'https://other.test/current.pdf' }],
  ['a different document on the same origin', { locationUrl: 'https://invoice.test/other.pdf' }],
  ['a fetch failure', { fetching: async () => { throw Error('redirect or unavailable response'); } }],
  ['an HTML response', { response: () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) }],
  ['an HTTP failure', { response: () => new Response('denied', { status: 403, headers: { 'content-type': 'application/pdf' } }) }],
  ['non-PDF bytes', { response: () => new Response('plain text', { headers: { 'content-type': 'application/pdf' } }) }],
  ['a missing isolated context', { contextId: null }],
]) test(`PDF fallback refuses ${name} before extraction`, async t => {
  const f = fixture(options); t.after(() => f.reader.dispose());
  await assert.rejects(f.reader.tab(f.entry), /unavailable|readable file/);
  assert.equal(f.extractions(), 0);
  if (options.locationUrl) assert.equal(f.requests.length, 0, 'identity mismatch sends no request');
  if (options.contextId === null) assert.equal(f.calls.includes('Runtime.callFunctionOn'), false, 'a missing context must not evaluate in the default world');
});

test('PDF fallback checks both declared and streamed byte limits and cancels overflow', async t => {
  let cancelled = false;
  const declared = fixture({ response: () => new Response('', { headers: { 'content-type': 'application/pdf', 'content-length': '33554433' } }) });
  const streamed = fixture({ response: () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/pdf' } }) });
  t.after(async () => { await declared.reader.dispose(); await streamed.reader.dispose(); });
  for (const f of [declared, streamed]) {
    await assert.rejects(f.reader.tab(f.entry), /32 MiB/);
    assert.equal(f.extractions(), 0);
  }
  assert.equal(cancelled, true);
});

test('PDF fallback suppresses text after a loader change during the refetch', async t => {
  const f = fixture({ mutate: frame => { frame.loaderId = 'replacement'; } });
  t.after(() => f.reader.dispose());
  await assert.rejects(f.reader.tab(f.entry), /tab changed/);
});

test('turn end drains an in-flight PDF refetch and refuses its text before extraction', async () => {
  let entered, complete;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ fetching: async target => {
    entered();
    await new Promise(resolve => { complete = resolve; });
    const response = new Response(f.bytes, { headers: { 'content-type': 'application/pdf' } });
    Object.defineProperty(response, 'url', { value: target });
    return response;
  } });
  const reading = f.reader.tab(f.entry);
  await started;
  let drained = false;
  const ending = f.reader.dispose().then(result => { drained = true; return result; });
  await Promise.resolve(); assert.equal(drained, false);
  complete();
  await assert.rejects(reading, /turn ended/);
  assert.deepEqual(await ending, { retained: 0 });
  assert.equal(f.extractions(), 0);
});

test('turn end during isolated-world creation prevents a later network request', async () => {
  let entered, complete;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ creating: async () => {
    entered(); await new Promise(resolve => { complete = resolve; });
  } });
  const reading = f.reader.tab(f.entry);
  await started;
  const ending = f.reader.dispose(); complete();
  await assert.rejects(reading, /turn ended|unavailable/);
  assert.deepEqual(await ending, { retained: 0 });
  assert.equal(f.requests.length, 0, 'ended turns must not start a refetch');
  assert.equal(f.extractions(), 0);
});
