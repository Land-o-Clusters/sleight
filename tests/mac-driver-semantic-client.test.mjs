import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { DRIVER_CORE_METHODS, DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { normalizeMacDriverError, formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';

function fixture(t, methods = ['setValue', 'selectText', 'performSecondaryAction', 'paste'], metadata = { matchCount: 2 }, resultMetadata = {}) {
  const requests = [];
  const client = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close')); return true; };
    child.stdin = new Writable({ write(bytes, _, done) {
      const request = JSON.parse(bytes); requests.push(request); done();
      const result = request.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2, build: 'a'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...methods] } :
        { delivery: request.params.args?.at(-1) === 'unverified' ? 'sent-unverified' : 'sent-verified', retry: 'read-first', clipboardRestored: true, ...resultMetadata };
      const response = { protocol: 'sleight.driver/1', platform: 'darwin', nonce: request.nonce, id: request.id, ok: true, result };
      if (request.params.args?.at(-1) === 'ambiguous') {
        delete response.result; response.ok = false;
        response.error = { code: 'AMBIGUOUS_ELEMENT', next: DRIVER_CODES.AMBIGUOUS_ELEMENT.next, unhealthy: false,
          message: 'AMBIGUOUS_ELEMENT', delivery: 'not-sent', retry: 'safe', ...metadata };
      }
      if (request.params.args?.at(-1) === 'busy') {
        delete response.result; response.ok = false;
        response.error = { code: 'AX_UNAVAILABLE', message: 'ignored provider text', next: 'retry-safe', unhealthy: false,
          delivery: 'not-sent', retry: 'safe', pasteRefusal: 'busy', ...metadata };
      }
      if (request.method === 'paste' && request.params.args[0] === 'controls') {
        delete response.result; response.ok = false;
        response.error = { code: 'ACTION_UNSUPPORTED', message: 'ignored provider text', next: DRIVER_CODES.ACTION_UNSUPPORTED.next,
          unhealthy: false, delivery: 'not-sent', retry: 'safe', clipboard: 'untouched', textInput: 'unsupported-controls', ...metadata };
      }
      queueMicrotask(() => child.stdout.write(JSON.stringify(response) + '\n'));
    } });
    return child;
  } }) });
  t.after(() => client.close()); return { client, requests };
}
const identity = { windowId: '7', processStart: 'start', readId: 1, personToken: 'person' };

for (const [method, args] of [
  ['setValue', [2, 'value']], ['setValue', [{ id: 'field' }, 4.5]], ['setValue', [{ label: 'Check' }, true]],
  ['selectText', [2, 'value', { prefix: 'before', suffix: 'after', selectionType: 'cursor_after' }]],
  ['performSecondaryAction', [2, 'Show menu']], ['paste', ['text']], ['paste', ['html', { format: 'html' }]],
]) test(`${method} keeps binding and arguments separate from transport options`, async t => {
  const { client, requests } = fixture(t);
  const result = await client[method](identity, args, { timeoutMs: 500, read: 'full', context: { call: 'semantic' } });
  assert.deepEqual(requests.at(-1).params, { ...identity, args, read: 'full' });
  assert.deepEqual(requests.at(-1).context, { call: 'semantic' }); assert.equal(result.clipboardRestored, true);
});

for (const [method, args] of [
  ['setValue', [true, 'v']], ['setValue', [2, null]], ['setValue', [2, {}]], ['setValue', [2, Infinity]],
  ['setValue', [[1, 2], 'v']], ['setValue', [{ id: 'x', label: 'x' }, 'v']],
  ['selectText', [2, '']], ['selectText', [2, 'x', { selectionType: 'all' }]], ['selectText', [2, 'x', { prefix: 1 }]],
  ['selectText', [2, 'x', { unknown: true }]], ['performSecondaryAction', [2, '']],
  ['paste', ['text', { format: 'other' }]], ['paste', ['text', { preserve: false }]], ['paste', [null]],
]) test(`${method} rejects malformed ${JSON.stringify(args)} before helper preparation`, async t => {
  const { client, requests } = fixture(t);
  await assert.rejects(client[method](identity, args), { code: 'INVALID_PARAMS' }); assert.equal(requests.length, 0);
});

test('raw semantic requests use the same validation and cannot supply clipboard authority', async t => {
  const { client, requests } = fixture(t);
  await assert.rejects(client.request('paste', { ...identity, args: ['v'], clipboard: { preserve: false } }), { code: 'INVALID_PARAMS' });
  await assert.rejects(client.request('setValue', { ...identity, args: [2, {}] }), { code: 'INVALID_PARAMS' });
  assert.equal(requests.length, 0);
});

test('semantic calls remain unavailable until the helper explicitly advertises them', async t => {
  const { client, requests } = fixture(t, []);
  await assert.rejects(client.paste(identity, ['text']), { code: 'DRIVER_VERSION_MISMATCH' });
  assert.deepEqual(requests.map(r => r.method), ['ping']);
});

test('ambiguous selection keeps numeric count in the error and never retries', async t => {
  const { client, requests } = fixture(t);
  await assert.rejects(client.selectText(identity, [2, 'ambiguous']), e => {
    assert.equal(e.code, 'AMBIGUOUS_ELEMENT'); assert.equal(e.delivery, 'not-sent'); assert.equal(e.matchCount, 2);
    assert.equal(normalizeMacDriverError(e).matchCount, 2); assert.match(formatMacDriverError(e), /matches=2/);
    return true;
  });
  assert.equal(requests.filter(r => r.method === 'selectText').length, 1);
});

for (const matchCount of [-1, 1, 1.5, null, '2', true, 1_048_577]) test(`invalid match count ${JSON.stringify(matchCount)} retires before replay`, async t => {
  const { client, requests } = fixture(t, ['selectText'], { matchCount });
  await assert.rejects(client.selectText(identity, [2, 'ambiguous']), { code: 'DRIVER_PROTOCOL', unhealthy: true });
  assert.equal(requests.filter(r => r.method === 'selectText').length, 1);
  assert.equal(Object.hasOwn(normalizeMacDriverError({ code: 'AMBIGUOUS_ELEMENT', matchCount }), 'matchCount'), false);
});

test('only a typed pre-input paste contention selects DRIVER_BUSY regardless of provider wording', async t => {
  async function contentionReply(native, { method = 'paste' } = {}) {
    const { client, requests } = fixture(t, [method], native.error);
    const args = method === 'setValue' ? [2, 'busy'] : ['busy'];
    try { return { ok: true, result: await client.request(method, { ...identity, args }) }; }
    catch (error) { return { ok: false, error: { ...error, ...normalizeMacDriverError(error, { action: true }) } }; }
    finally {
      assert.equal(requests.filter(row => row.method === method).length, 1);
      await client.close();
    }
  }
  const error = { code: 'AX_UNAVAILABLE', message: 'diagnostic', unhealthy: false, next: 'retry-safe',
    delivery: 'not-sent', retry: 'safe', pasteRefusal: 'busy' };
  for (const message of ['DRIVER_BUSY', 'untrusted provider text', '', 'DRIVER_BUSY\ninjected']) {
    const reply = await contentionReply({ ok: false, error: { ...error, message } }, { method: 'paste' });
    assert.equal(reply.error.code, 'DRIVER_BUSY');
    assert.equal(reply.error.message, 'The driver request queue is full.');
    assert.equal(reply.error.delivery, 'not-sent'); assert.equal(reply.error.retry, 'safe');
    assert.equal(reply.error.next, 'retry-safe'); assert.equal(reply.error.unhealthy, false);
  }
  const forged = await contentionReply({ ok: false, error: { ...error, pasteRefusal: undefined,
    message: 'DRIVER_BUSY' } }, { method: 'paste' });
  assert.equal(forged.error.code, 'AX_UNAVAILABLE');
  assert.equal(forged.error.message, 'The app did not provide a usable accessibility response.');
  assert.equal(forged.error.retry, 'safe'); assert.equal(forged.error.next, 'retry-safe');
  for (const patch of [
    { pasteRefusal: null }, { pasteRefusal: false }, { pasteRefusal: true }, { pasteRefusal: 1 },
    { pasteRefusal: ['busy'] }, { pasteRefusal: {} }, { pasteRefusal: '' },
    { pasteRefusal: 'unknown' }, { pasteRefusal: 'busy\ninjected' },
    { code: 'ACTION_UNSUPPORTED', next: 'none' }, { code: 'INVALID_PARAMS' },
    { delivery: 'unknown', retry: 'read-first' }, { delivery: 'sent-unverified', retry: 'read-first' },
    { delivery: 'sent-verified', retry: 'read-first' }, { retry: 'read-first' },
    { delivery: undefined }, { retry: undefined }, { delivery: undefined, retry: undefined },
    { unhealthy: true }, { unhealthy: undefined }, { unhealthy: 0 }, { message: undefined },
  ]) {
    const reply = await contentionReply({ ok: false, error: { ...error, ...patch } }, { method: 'paste' });
    assert.equal(reply.error.code, 'DRIVER_PROTOCOL', JSON.stringify(patch));
    assert.equal(reply.error.unhealthy, true); assert.equal(reply.error.retry, 'read-first');
    assert.equal(Object.hasOwn(reply.error, 'pasteRefusal'), false);
  }
  for (const method of ['click', 'setValue', 'getState']) {
    const reply = await contentionReply({ ok: false, error }, { method });
    assert.equal(reply.error.code, 'DRIVER_PROTOCOL', method);
    assert.equal(Object.hasOwn(reply.error, 'pasteRefusal'), false);
  }
  const changed = await contentionReply({ ok: false, error: { ...error, clipboardChanged: true } });
  assert.equal(changed.error.code, 'CLIPBOARD_CHANGED');
  assert.equal(changed.error.retry, 'read-first'); assert.equal(changed.error.next, 'stop-tell-user');
  assert.equal(Object.hasOwn(changed.error, 'pasteRefusal'), false);
});

test('clipboard reservation contention is a busy refusal with safe retry and no replay', async t => {
  const { client, requests } = fixture(t, ['paste'], {});
  await assert.rejects(client.paste(identity, ['busy']), error => {
    assert.equal(error.code, 'DRIVER_BUSY'); assert.equal(error.delivery, 'not-sent'); assert.equal(error.retry, 'safe');
    assert.equal(error.message, 'DRIVER_BUSY');
    assert.equal(normalizeMacDriverError(error).next, 'retry-safe');
    assert.equal(formatMacDriverError(error), 'sleight: DRIVER_BUSY: The driver request queue is full. delivery=not-sent; retry=safe; next=retry-safe: Correct the request if needed, then retry only the operation that was not sent.');
    return true;
  });
  assert.equal(requests.filter(row => row.method === 'paste').length, 1);
});

test('a delivered semantic action carries the existing unconfirmed note when its target vanishes', async t => {
  const { client } = fixture(t);
  const result = await client.setValue(identity, [2, 'unverified']);
  assert.equal(result.delivery, 'sent-unverified');
  assert.equal(result.note, 'Input was attempted, but its effect could not be confirmed.');
});

test('an unavailable full observation keeps delivered input and attaches the existing note without replay', async t => {
  const { client, requests } = fixture(t, ['click'], {}, { delivery: 'sent-unverified', observation: 'unavailable', observationError: 'WINDOW_NOT_FOUND' });
  const result = await client.click(identity, [2], { read: 'full' });
  assert.equal(result.delivery, 'sent-unverified'); assert.equal(result.observation, 'unavailable');
  assert.equal(result.note, 'Input was attempted, but its effect could not be confirmed.');
  assert.equal(requests.filter(row => row.method === 'click').length, 1);
});

test('an oversized setValue readback retains its cap metadata and the existing unconfirmed note', async t => {
  const { client } = fixture(t, ['setValue'], {}, { delivery: 'sent-unverified', valueVerified: false, valueReadback: 'over-limit', valueReadbackLimit: 1_048_576 });
  const result = await client.setValue(identity, [2, 'value']);
  assert.equal(result.valueReadback, 'over-limit'); assert.equal(result.valueReadbackLimit, 1_048_576);
  assert.equal(result.valueVerified, false); assert.equal(result.note, 'Input was attempted, but its effect could not be confirmed.');
});

test('strict unverified delivery preserves its note and untouched clipboard evidence', async t => {
  const { client, requests } = fixture(t, ['paste'], {}, { delivery: 'sent-unverified', clipboard: 'untouched' });
  const result = await client.paste(identity, ['v']);
  assert.equal(result.clipboard, 'untouched'); assert.equal(result.retry, 'read-first');
  assert.equal(result.note, 'Input was attempted, but its effect could not be confirmed.');
  assert.equal(requests.filter(row => row.method === 'paste').length, 1);
});

test('typed control refusal crosses the client once and selects a fixed recovery reason', async t => {
  const { client, requests } = fixture(t, ['paste'], {});
  await assert.rejects(client.paste(identity, ['controls']), error => {
    assert.equal(error.code, 'ACTION_UNSUPPORTED'); assert.equal(error.textInput, 'unsupported-controls');
    assert.equal(error.delivery, 'not-sent'); assert.equal(error.clipboard, 'untouched');
    assert.match(formatMacDriverError(error), /Line breaks and tabs require/);
    assert.doesNotMatch(formatMacDriverError(error), /ignored provider text/);
    return true;
  });
  assert.equal(requests.filter(row => row.method === 'paste').length, 1);
});

for (const metadata of [{ textInput: 'unknown' }, { delivery: 'unknown', retry: 'read-first' }]) {
  test(`invalid control refusal metadata retires the helper: ${JSON.stringify(metadata)}`, async t => {
    const { client } = fixture(t, ['paste'], metadata);
    await assert.rejects(client.paste(identity, ['controls']), { code: 'DRIVER_PROTOCOL', unhealthy: true });
  });
}

test('semantic UTF-8 over-limit text refuses before helper preparation', async t => {
  const { client, requests } = fixture(t);
  for (const [method, args] of [['paste', ['é'.repeat(524289)]], ['selectText', [2, 'é'.repeat(524289)]]])
    await assert.rejects(client[method](identity, args), { code: 'INVALID_PARAMS' });
  assert.equal(requests.length, 0);
});

test('UC2F partial text errors preserve verified counts, focus and IME disposition', async t => {
  const metadata = { charactersDelivered: 5, charactersPosted: 10, focusChanged: true, focusRestored: false,
    compositionBypassed: true, textBeliefFallback: false };
  const { client } = fixture(t, undefined, metadata);
  await assert.rejects(client.selectText(identity, [2, 'ambiguous']), error => {
    for (const [key, value] of Object.entries(metadata)) assert.equal(error[key], value, key);
    for (const [key, value] of Object.entries(metadata)) assert.equal(normalizeMacDriverError(error)[key], value, key);
    for (const [key, value] of Object.entries(metadata)) assert.ok(formatMacDriverError(error).includes(`${key}=${value};`), key);
    return true;
  });
});
for (const metadata of [{ charactersPosted: -1 }, { charactersPosted: 1.5 }, { compositionBypassed: 'yes' },
  { textBeliefFallback: 1 }, { focusChanged: 'yes' }, { focusRestored: 0 }]) {
  test(`UC2F malformed text disposition refuses ${JSON.stringify(metadata)}`, async t => {
    const { client } = fixture(t, undefined, metadata);
    await assert.rejects(client.selectText(identity, [2, 'ambiguous']), { code: 'DRIVER_PROTOCOL' });
  });
}
