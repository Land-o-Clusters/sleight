import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
let hook;
const variant = process.env.GLC3_ERROR_MUTANT;
if (variant) hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  const file = variant === 'transport' ? 'driver-client.mjs' : variant === 'helper' ? 'repl/client.mjs' : 'mac-driver/errors.mjs';
  if (url !== new URL('../plugins/sleight/lib/' + file, import.meta.url).href) return loaded;
  const before = variant === 'transport' ? "'menuRefusal', 'pointerRefusal'" : variant === 'helper'
    ? "if (platform === 'darwin' && error.parentSafety === true && error.code === 'ACTION_UNSUPPORTED' &&" : 'const menuRefusal = code ===';
  assert.ok(String(loaded.source).includes(before));
  return { ...loaded, source: String(loaded.source).replace(before, variant === 'transport' ? "'pointerRefusal'" : variant === 'helper'
    ? before.replace('if (', 'if (false && ') : 'const menuRefusal = false && code ===') };
} });
const { formatMacDriverError, MAC_DRIVER_MENU_DETAILS } = await import('../plugins/sleight/lib/mac-driver/errors.mjs');
const { createMacDriverClient, DRIVER_PROTOCOL } = await import('../plugins/sleight/lib/mac-driver/client.mjs');
const { DRIVER_CODES, DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } = await import('../plugins/sleight/lib/mac-driver/protocol.mjs');
const { checkSessionMenu } = await import('../plugins/sleight/lib/session-menu.mjs');
const { createMacReplClient } = await import('../plugins/sleight/lib/repl/client.mjs');
const { formFixture } = await import('./fixtures/runtime-helpers.mjs');
process.on('exit', () => hook?.deregister());
function client(t, fault) {
  const c = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, _, done) {
      const r = JSON.parse(bytes.toString()); done();
      const reply = r.method === 'ping' ? { ok: true, result: { protocol: DRIVER_PROTOCOL, apiVersion: 2,
        build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } } :
        { ok: false, error: { code: 'ACTION_UNSUPPORTED', next: DRIVER_CODES.ACTION_UNSUPPORTED.next,
          unhealthy: false, message: 'PROVIDER_SECRET', delivery: 'not-sent', retry: 'safe', ...fault } };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: DRIVER_PROTOCOL, platform: 'darwin',
        nonce: r.nonce, id: r.id, ...reply }) + '\n'));
    } });
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; }; return child;
  } }) }); t.after(() => c.close()); return c;
}
for (const [reason, sentence] of [['menu-compound', "Menu title: click the item's number; the menu need not be open."],
  ['not-requested', 'Not requested.'], ['person-popup', MAC_DRIVER_MENU_DETAILS['person-popup']]]) {
  test(`fixed menu detail ${reason} survives real client transport`, async t => {
    const c = client(t, { menuRefusal: reason });
    await assert.rejects(c.request('click', { args: [0], readId: 1, windowId: '1', processStart: 'fake' }), error => {
      assert.equal(error.menuRefusal, reason);
      const line = formatMacDriverError(error, { action: true });
      assert.ok(line.includes(sentence), line); assert.ok(!line.includes('PROVIDER_SECRET'));
      assert.match(line, /delivery=not-sent;/);
      if (reason === 'menu-compound') assert.match(line, /retry=safe;/);
      else assert.doesNotMatch(line, /retry=safe;/);
      return true;
    });
  });
}
test('fixed focus step survives native client transport and parent formatting', async t => {
  const c = client(t, { code: 'KEY_FOCUS_UNAVAILABLE', next: DRIVER_CODES.KEY_FOCUS_UNAVAILABLE.next,
    message: 'KEY_FOCUS_UNAVAILABLE step=frontmost' });
  await assert.rejects(c.request('pressKey', { args: ['super+2'], readId: 1, windowId: '1', processStart: 'fake' }), error => {
    assert.match(formatMacDriverError(error), /step=frontmost;/); return true;
  });
});
test('provider text and unproved reason ids cannot select menu details', async t => {
  for (const fields of [{ message: "Menu title: click the item's number; the menu need not be open." }, { message: 'Not requested.' },
    { menuRefusal: 'private label' }, { menuRefusal: 'menu-compound', delivery: 'sent-unverified', retry: 'read-first' },
    { menuRefusal: 'not-requested', code: 'STALE_ELEMENT' }]) {
    const line = formatMacDriverError({ code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe', ...fields });
    assert.ok(!line.includes("Menu title: click the item's number; the menu need not be open.") && !line.includes('Not requested.'), line);
  }
  const c = client(t, { menuRefusal: 'private label' });
  await assert.rejects(c.request('click', { args: [0], readId: 1, windowId: '1', processStart: 'fake' }), { code: 'DRIVER_PROTOCOL' });
});
test('JS-thrown refusals use the same fixed reason ids and formatter vocabulary', () => {
  for (const [target, sentence, reason] of [[2, "Menu title: click the item's number; the menu need not be open.", 'menu-compound'], [4, 'Not requested.', 'not-requested']]) {
    assert.throws(() => checkSessionMenu({ method: 'click', args: [target], window: { app: 'Fixture' },
      text: '0 standard window\n1 menu bar\n\t2 Fixture\n\t\t3 menu (collapsed)\n\t\t\t4 menu item Quit Fixture' }), error => {
      assert.equal(error.menuRefusal, reason);
      assert.ok(error.message.includes(sentence)); assert.ok(formatMacDriverError(error).includes(sentence)); return true;
    });
  }
});
for (const [target, sentence] of [[2, "Menu title: click the item's number; the menu need not be open."], [4, 'Not requested.']])
  test('JS helper inspection delivers fixed menu refusal: ' + sentence, { skip: replWorkerSkip }, async t => {
    const sent = [];
    const driver = { async request(method) {
      sent.push(method);
      return { window: { app: 'Fixture', title: 'Draft', windowId: '101', pid: 120,
        processStart: '1700000000:123456', bundleId: 'com.example.Editor', identityVerified: true,
        bounds: { x: 0, y: 0, width: 1000, height: 1000 } }, readId: 1,
        text: 'Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 text field Name' };
    }, async restart() {}, async close() {} };
    const repl = createMacReplClient({ driver, admit: () => true, environment: () => ({}),
      inspectHelperCall() { checkSessionMenu({ method: 'click', args: [target], window: { app: 'Fixture' },
        text: '0 standard window\n1 menu bar\n\t2 Fixture\n\t\t3 menu (collapsed)\n\t\t\t4 menu item Quit Fixture' }); } });
    t.after(() => repl.close());
    const initial = await repl.execute({ code: `var app = await cua.getApp('Fixture', {emit:false}); var h = (${formFixture.toString()})({Name:{}}, app); void 0;` });
    assert.equal(initial.isError, false, JSON.stringify(initial));
    const result = await repl.execute({ code: 'await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"}]);' });
    const text = result.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
    assert.equal(result.isError, true); assert.ok(text.includes(sentence), text);
    assert.ok(!sent.some(method => ['click', 'setValue', 'pressKey'].includes(method)));
  });
