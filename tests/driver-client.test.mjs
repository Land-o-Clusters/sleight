import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { registerHooks } from 'node:module';
import { DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';

if (process.env.GLS2D_DRIVER_MUTANT) {
  const hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== new URL('../plugins/sleight/lib/driver-client.mjs', import.meta.url).href) return loaded;
    const [before, after] = process.env.GLS2D_DRIVER_MUTANT === 'allowlist'
      ? ["['reuseIfUnchanged', 'menuRequests']", "['reuseIfUnchanged']"]
      : ["if (Object.hasOwn(params, 'menuRequests') &&", 'if (false &&'];
    assert.ok(String(loaded.source).includes(before));
    return { ...loaded, source: String(loaded.source).replace(before, after) };
  } });
  process.on('exit', () => hook.deregister());
}

async function fixture(t, platform, fields = {}, failure, binarySha256) {
  const module = await import('../plugins/sleight/lib/driver-client.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
  assert.equal(typeof module.createDriverClient, 'function', 'both drivers need the shared client');
  const requests = [], children = [];
  const client = module.createDriverClient({ driverPlatform: platform, platform, prepare: async () => ({ status: 'ready',
    build: 'b'.repeat(64), binarySha256, spawn({ nonce }) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, encoding, done) {
        const r = JSON.parse(bytes); requests.push(r); done();
        const result = r.method === 'ping' ? { protocol: r.protocol, apiVersion: r.platform === 'darwin' ? 2 : 1, build: 'b'.repeat(64),
          methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS, 'echo'] } : { ...r.params, ...fields };
        queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: r.protocol,
          ...platform === 'darwin' ? { platform } : {}, nonce, id: r.id,
          ...failure && r.method !== 'ping' ? { ok: false, error: failure } : { ok: true, result } }) + '\n'));
      } });
      child.kill = () => { queueMicrotask(() => child.emit('close')); return true; };
      children.push(child); return child;
    } }) });
  t.after(() => client.close());
  return { client, requests, children };
}
test('GLINT3 serving identity uses the verified handshake and this generations prepared binary', async t => {
  const h = await fixture(t, 'darwin', {}, undefined, 'c'.repeat(64));
  assert.equal(h.client.runtimeReceipt(), undefined, 'inspection must not start a helper');
  assert.equal(h.children.length, 0);
  await h.client.getState();
  const receipt = h.client.runtimeReceipt();
  assert.equal(receipt.driverSourceBuild, 'b'.repeat(64));
  assert.equal(receipt.driverBuild, 'c'.repeat(64));
  assert.equal(receipt.ping.build, 'b'.repeat(64));
  receipt.ping.build = 'd'.repeat(64);
  assert.equal(h.client.runtimeReceipt().ping.build, 'b'.repeat(64), 'callers cannot rewrite serving identity');
  await h.client.restart();
  assert.equal(h.client.runtimeReceipt(), undefined, 'retired helpers cannot attest the next cell');
  await h.client.getState(); assert.equal(h.children.length, 2);
  assert.equal(h.client.runtimeReceipt().driverBuild, 'c'.repeat(64));
});
test('GLINT3 missing or malformed binary identity stays unverified', async t => {
  for (const hash of [undefined, null, '', 'private path', 'A'.repeat(64), 'g'.repeat(64), 'é'.repeat(64), '0'.repeat(63) + '\n', '0'.repeat(64) + '\n']) {
    const h = await fixture(t, 'darwin', {}, undefined, hash);
    await h.client.getState();
    assert.equal(h.client.runtimeReceipt(), undefined);
  }
});
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: shared client preserves the wire and one lazy child`, async t => {
    const h = await fixture(t, platform);
    assert.equal(h.children.length, 0);
    assert.deepEqual(await h.client.request('echo', { selector: 'fixture' }), { selector: 'fixture' });
    await h.client.getState();
    assert.equal(h.children.length, 1);
    assert.deepEqual(h.requests.map(r => r.id), platform === 'darwin' ? [1, 2, 3] : [1, 2]);
    assert.ok(h.requests.every(r => r.protocol === (platform === 'darwin' ? 'sleight.driver/1' : 'sleight.windows-driver/1')));
    assert.ok(h.requests.every(r => platform === 'darwin' ? r.platform === platform : !Object.hasOwn(r, 'platform')));
  });
}
for (const method of ['getAXState', 'getAXStateAndScreenshot']) {
  for (const menuRequests of [undefined, [], ['Recent Items', 'Font']])
    test(`darwin: ${method} forwards parent menu requests ${JSON.stringify(menuRequests)}`, async t => {
      const h = await fixture(t, 'darwin');
      const params = { windowId: '7', processStart: '1.2', ...(menuRequests === undefined ? {} : { menuRequests }) };
      await h.client.request(method, params);
      assert.deepEqual(h.requests.at(-1).params, params);
    });
  test(`darwin: ${method} rejects malformed parent menu requests before spawning`, async t => {
    const h = await fixture(t, 'darwin');
    for (const menuRequests of [null, 'Font', {}, [1], Array(1), Array(129).fill('Font'), ['é'.repeat(513)]])
      await assert.rejects(h.client.request(method, { menuRequests }), { code: 'INVALID_PARAMS' });
    assert.equal(h.children.length, 0);
  });
}
test('darwin: menu requests remain read-only parameters', async t => {
  const h = await fixture(t, 'darwin');
  for (const method of ['getScreenshot', 'click', 'echo'])
    await assert.rejects(h.client.request(method, { menuRequests: [] }), { code: 'INVALID_PARAMS' });
  assert.equal(h.children.length, 0);
});

test('GLS3 real client carries only vocabulary parameter fields on refusals', async t => {
  const h = await fixture(t, 'darwin', {}, { code: 'INVALID_PARAMS', next: 'none', unhealthy: false,
    message: 'PRIVATE VALUE', field: 'menuRequests' });
  await assert.rejects(h.client.request('getAXState', {}), { code: 'INVALID_PARAMS', field: 'menuRequests' });
  for (const field of ['PRIVATE VALUE', 'menuRequests\nPRIVATE', 4, null]) {
    const invalid = await fixture(t, 'darwin', {}, { code: 'INVALID_PARAMS', next: 'none', unhealthy: false,
      message: 'PRIVATE VALUE', field });
    await assert.rejects(invalid.client.request('getAXState', {}), { code: 'DRIVER_PROTOCOL', unhealthy: true });
  }
  await assert.rejects(h.client.request('getAXState', { menuRequests: ['PRIVATE'.repeat(200)] }), { code: 'INVALID_PARAMS', field: 'menuRequests' });
});

test('GLS3 empty and private unknown parameter names refuse before spawning', async t => {
  const h = await fixture(t, 'darwin');
  for (const field of ['', 'PRIVATE KEY'])
    await assert.rejects(h.client.request('getAXState', { [field]: 'PRIVATE VALUE' }), { code: 'INVALID_PARAMS', field: 'params' });
  assert.equal(h.children.length, 0);
});
test('UC2B client preserves bounded wait receipts and rejects malformed durations', async t => {
  const h = await fixture(t, 'darwin', { waitedForPersonMs: 3020 });
  assert.equal((await h.client.request('echo', {})).waitedForPersonMs, 3020);
  for (const value of [-1, 1.5, 30001, 'private']) {
    const invalid = await fixture(t, 'darwin', { waitedForPersonMs: value });
    await assert.rejects(invalid.client.request('echo', {}), { code: 'DRIVER_PROTOCOL' });
  }
  const refused = await fixture(t, 'darwin', {}, { code: 'PERSON_TOOK_OVER', message: 'person', unhealthy: false,
    next: 'stop-tell-user', delivery: 'not-sent', retry: 'safe', waitedForPersonMs: 8000, reason: 'person-pointer' });
  await assert.rejects(refused.client.request('echo', {}), error =>
    error.code === 'PERSON_TOOK_OVER' && error.waitedForPersonMs === 8000 && error.reason === 'person-pointer');
});

test('UC2B2 client validates effective wait caps on success and refusal', async t => {
  const h = await fixture(t, 'darwin', { waitedForPersonMs: 1200, personWaitCapMs: 4849 });
  assert.equal((await h.client.request('echo', {})).personWaitCapMs, 4849);
  for (const personWaitCapMs of [-1, 8001, 1.5, 'private']) {
    const invalid = await fixture(t, 'darwin', { personWaitCapMs });
    await assert.rejects(invalid.client.request('echo', {}), { code: 'DRIVER_PROTOCOL' });
  }
  const refused = await fixture(t, 'darwin', {}, { code: 'PERSON_TOOK_OVER', message: 'person', unhealthy: false,
    next: 'stop-tell-user', delivery: 'not-sent', retry: 'safe', personWaitCapMs: 4849, waitedForPersonMs: 4849 });
  await assert.rejects(refused.client.request('echo', {}), error => error.personWaitCapMs === 4849 && !error.unhealthy);
});

test('UC2B wait and UC2F text receipts survive both error envelopes together', async t => {
  const receipt = { waitedForPersonMs: 1200, personWaitCapMs: 4849, charactersDelivered: 32,
    charactersPosted: 64, focusChanged: true, focusRestored: false, compositionBypassed: true,
    textBeliefFallback: false, personTookOver: true };
  const refused = await fixture(t, 'darwin', {}, { ...receipt, code: 'PERSON_TOOK_OVER', message: 'person',
    unhealthy: false, next: 'stop-tell-user', delivery: 'sent-unverified', retry: 'read-first', reason: 'person-pointer' });
  const clipboard = await fixture(t, 'darwin', { ...receipt, clipboardChanged: true,
    delivery: 'sent-unverified', retry: 'read-first' });
  for (const [h, code] of [[refused, 'PERSON_TOOK_OVER'], [clipboard, 'CLIPBOARD_CHANGED']]) {
    await assert.rejects(h.client.request('echo', {}), error => {
      assert.equal(error.code, code);
      for (const [key, value] of Object.entries(receipt)) assert.equal(error[key], value, key);
      if (code === 'PERSON_TOOK_OVER') assert.equal(error.reason, 'person-pointer');
      return true;
    });
  }
});
