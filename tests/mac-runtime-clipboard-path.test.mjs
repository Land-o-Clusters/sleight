import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { createCua } from '../plugins/sleight/lib/repl/cua.mjs';
import { keyPlan, parseKeyChord } from '../plugins/sleight/lib/mac-driver/keys.mjs';
import { createMacClipboardPreserver } from '../plugins/sleight/lib/mac-driver/preserve.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { clipboardClientReply } from './fixtures/mac-driver-clipboard-client.mjs';

const us = new Map(Object.entries({ c: 8, x: 7, v: 9, s: 1 }).flatMap(([key, keyCode]) => [
  [key, { keyCode, modifiers: [] }], [key.toUpperCase(), { keyCode, modifiers: ['shift'] }],
]));

function fixture(platform = 'darwin') {
  const calls = [], events = [];
  const window = { windowId: '7', processStart: 'start', pid: 42, bundleId: 'test.fake', identityVerified: true };
  const cua = createCua({ platform, write() {}, emitImage() {}, async request(method, params) {
    calls.push({ method, params });
    if (method === 'getApp') return { window, readId: 1, text: 'Fixture' };
    if (method === 'pressKey') events.push(...keyPlan(params.args[0], us));
    return { window, delivery: 'unknown', retry: 'read-first', clipboard: 'untouched' };
  } });
  return { cua, calls, events };
}

test('runtime app handles refuse Command Copy, Cut and Paste before any input event', async () => {
  const { cua, calls, events } = fixture();
  const app = await cua.getApp('Fixture');
  assert.equal(cua.isHandle(app), true);
  for (const modifier of ['super', 'cmd', 'command', 'meta', 'Super_L', 'Super_R', 'Meta_L', 'Meta_R']) {
    for (const key of ['c', 'x', 'v']) {
      await assert.rejects(app.pressKey(`${modifier}+${key}`), error =>
        error.code === 'ACTION_UNSUPPORTED' && error.delivery === 'not-sent' && error.clipboard === 'untouched');
    }
  }
  assert.deepEqual(events, []);
  await app.pressKey('super+s');
  assert.equal(calls.at(-1).method, 'pressKey');
});

test('CB1Q wrapper refuses clipboard text even when the planner wrongly admits Command+C', async () => {
  const events = [], requests = [];
  const wrapper = createMacClipboardPreserver({ dispatchPressKey(_target, chord) {
    requests.push(chord);
    // Broken planner: every chord would produce input if the wrapper let it through.
    events.push({ type: 'keyDown', chord });
  } });
  const app = wrapper.wrap({ pressKey() { assert.fail('raw key path'); } });
  for (const chord of ['cmd+c', 'cmd+x', 'cmd+v', 'cmd+ctrl+c', 'cmd+shift+x', 'ctrl+v']) {
    await assert.rejects(app.pressKey(chord), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
  }
  assert.deepEqual(requests, []); assert.deepEqual(events, []);
  for (const chord of ['ctrl+c', 'ctrl+x', 'ctrl+shift+c', 'ctrl+shift+x', 'cmd+s']) await app.pressKey(chord);
  assert.deepEqual(requests, ['ctrl+c', 'ctrl+x', 'ctrl+shift+c', 'ctrl+shift+x', 'cmd+s']);
  assert.equal(events.length, 5);
});

test('runtime explicit paste reaches the bound native dispatcher once and preserves unknown delivery', async () => {
  const { cua, calls } = fixture();
  const app = await cua.getApp('Fixture');
  const result = await app.paste('A😀\nB', { format: 'text' });
  assert.deepEqual(calls.map(call => call.method), ['getApp', 'paste']);
  assert.deepEqual(calls[1].params, { windowId: '7', processStart: 'start', readId: 1, args: ['A😀\nB', { format: 'text' }] });
  assert.equal(result.delivery, 'unknown'); assert.equal(result.retry, 'read-first');
  assert.equal(result.clipboard, 'untouched');
});

test('createCua refuses browser-only chord spellings by text or native grammar without input', async () => {
  const { clipboardChords } = await import('./fixtures/clipboard-chords.mjs');
  const { cua, events } = fixture();
  const app = await cua.getApp('Fixture');
  for (const chord of clipboardChords) {
    try { parseKeyChord(chord); continue; } catch {}
    await assert.rejects(app.pressKey(chord), { code: /^(?:ACTION_UNSUPPORTED|INVALID_PARAMS)$/ }, chord);
  }
  assert.deepEqual(events, []);
});

test('CB1Q text refusal precedes native validation of browser clipboard aliases', async () => {
  const { cua, calls, events } = fixture();
  const app = await cua.getApp('Fixture');
  for (const chord of ['Meta+KeyC', 'ControlOrMeta+C', 'Ctrl+KeyV'])
    await assert.rejects(app.pressKey(chord), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent' });
  assert.deepEqual(calls.map(call => call.method), ['getApp']);
  await assert.rejects(app.pressKey('Ctrl+KeyC'), { code: 'INVALID_PARAMS' });
  assert.deepEqual(calls.map(call => call.method), ['getApp', 'pressKey']); assert.deepEqual(events, []);
});

test('CB1Q runtime reports a caught stop and only turn_ended reopens input', { skip: replWorkerSkip }, async t => {
  const window = { windowId: '7', processStart: 'start', pid: 42, bundleId: 'test.fake',
    app: 'Fixture', title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
    bounds: { x: 0, y: 0, width: 500, height: 500 } };
  const tree = 'Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 button Done';
  const inputs = [], waiting = new Map();
  let readId = 0, id = 0, buffer = '';
  const driver = { async restart() {}, async close() {},
    async ping() { return { build: 'b'.repeat(64) }; },
    async request(method, params) {
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
        processStart: window.processStart }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'personState') return { window, token: 'fixture', personTookOver: false };
      if (method === 'getAXState') return { window, text: tree, readId: ++readId, truncated: false };
      inputs.push([method, params.args]);
      if (inputs.length === 1) {
        const parsed = await clipboardClientReply({ ok: true, result: {
          clipboardChanged: true, delivery: 'sent-unverified', retry: 'read-first',
        } }, { method });
        assert.equal(parsed.ok, false);
        throw Object.assign(Error(parsed.error.message), parsed.error);
      }
      return { window, text: tree, readId: ++readId, delivery: 'sent-unverified', retry: 'read-first' };
    } };
  const runtime = createOwnRuntime({ driver, inputRegistrar: await prepareMacInputRegistrar(driver, 'b'.repeat(64)),
    lease: { acquire: () => 'fixture', grant: () => ({ token: 'fixture-token' }), renewGrant() {}, renew() {}, release() {}, close() {} }, approve: () => true,
    policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false },
    replOptions: { environment: () => ({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }) },
  });
  runtime.safety.setPolicy({ beforeAction: async ({ args }) => ({ args }), checkPause() {}, endCell() {}, reset() {} });
  t.after(() => runtime.close());
  runtime.serverOut.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      runtime.safety.guardResult(message);
      const result = runtime.safety.displayResult(message.id, message.result);
      runtime.safety.recordDelivery(result);
      waiting.get(message.id)(result); waiting.delete(message.id);
    }
  });
  const call = (name, code, args = {}) => new Promise(resolve => {
    waiting.set(++id, resolve);
    runtime.serverIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name, arguments: code === undefined ? args : { code } } }) + '\n');
  });
  const acquired = await call('js', 'var app = await cua.getApp("Fixture");');
  assert.equal(acquired.isError, false, JSON.stringify(acquired));
  const caught = await call('js', `
    try { await app.pressKey('ctrl+c'); } catch {}
    try { await app.click(1); } catch {}
    try { await app.pressKey('s'); } catch {}
    try { await app.paste('fixture'); } catch {}
    await app.getAXState();
  `);
  assert.equal(caught.isError, true, 'the model cannot hide the stop by catching it');
  const text = caught.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.equal((text.match(/^sleight: action \d+ \w+: CLIPBOARD_CHANGED:/gm) ?? []).length, 4, text);
  assert.match(text, /next=stop-tell-user/); assert.match(text, /retry=read-first/);
  assert.deepEqual(inputs, [['pressKey', ['ctrl+c']]]);
  await call('js_reset');
  assert.equal((await call('js', 'var app = await cua.getApp("Fixture"); await app.click(1);')).isError, true);
  assert.equal(inputs.length, 1);
  for (const value of [undefined, false, 'true', 1]) {
    await call('turn_ended', undefined, value === undefined ? {} : { sleight_clipboard_turn_end: value });
    const retry = await call('js', 'var app = await cua.getApp("Fixture"); await app.pressKey("s");');
    assert.equal(retry.isError, true, 'only an explicit parent true clears the stop');
    assert.equal(inputs.length, 1);
  }
  await call('turn_ended', undefined, { sleight_clipboard_turn_end: true });
  assert.equal((await call('js', 'var app = await cua.getApp("Fixture"); await app.pressKey("s");')).isError, false);
  assert.deepEqual(inputs, [['pressKey', ['ctrl+c']], ['pressKey', ['s']]]);
});

test('createCua preserves synchronous inspect.custom on a Mac handle', async () => {
  const { inspect } = await import('node:util');
  const { cua, calls } = fixture();
  const app = await cua.getApp('Fixture');
  assert.equal(app[inspect.custom](), '[Mac app handle]');
  assert.equal(inspect(app), '[Mac app handle]');
  assert.deepEqual(calls.map(call => call.method), ['getApp']);
});

for (const grammar of ['native', 'browser']) test(`createCua applies the Mac policy to clipboard entries accepted by the ${grammar} grammar`, async t => {
  const { clipboardChords } = await import('./fixtures/clipboard-chords.mjs');
  const { parseKeyChord } = await import('../plugins/sleight/lib/mac-driver/keys.mjs');
  const { keyClass } = await import('../plugins/sleight/lib/direct-browser/rules.mjs');
  const accepted = clipboardChords.filter(chord => {
    if (grammar === 'browser') return keyClass(chord).kind === 'safe';
    try { parseKeyChord(chord); return true; } catch { return false; }
  });
  assert.ok(accepted.length > 100);
  const { cua, events } = fixture();
  const app = await cua.getApp('Fixture');
  let allowed = 0, refused = 0;
  for (const chord of accepted) {
    let parsed;
    try { parsed = parseKeyChord(chord); }
    catch {
      await assert.rejects(app.pressKey(chord), { code: /^(?:ACTION_UNSUPPORTED|INVALID_PARAMS)$/ }, chord);
      refused++; continue;
    }
    const before = events.length;
    if (/^[cx]$/i.test(parsed.key) && parsed.modifiers.includes('control') &&
        !parsed.modifiers.includes('meta') && !parsed.modifiers.includes('alt')) {
      await app.pressKey(chord); assert.ok(events.length > before, chord); allowed++;
    } else {
      await assert.rejects(app.pressKey(chord), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', clipboard: 'untouched' }, chord);
      assert.equal(events.length, before, chord); refused++;
    }
  }
  t.diagnostic(`${grammar}GrammarClipboardChords=${accepted.length} allowed=${allowed} refused=${refused} unionChords=${clipboardChords.length}`);
});

// Independent UI examples, not generated from the production classifier table.
const clipboardLabels = {
  en: ['Copy', 'Cut', 'Copy Link', 'Copy Image', 'Copy to Clipboard', 'Copy File Path', 'Copy Email Address', 'Copy as Markdown', 'Cut Selection'],
  es: ['Copiar', 'Cortar', 'Copiar enlace', 'Copiar imagen'],
  fr: ['Copier', 'Couper', 'Copier le lien', 'Copier l’image'],
  de: ['Kopieren', 'Ausschneiden', 'Link kopieren', 'Bild kopieren'],
  pt: ['Copiar', 'Cortar', 'Recortar', 'Copiar link', 'Copiar imagem'],
  it: ['Copia', 'Copiare', 'Taglia', 'Tagliare', 'Copia link', 'Copia immagine'],
  ja: ['コピー', '切り取り', '切取', 'リンクをコピー', '画像をコピー'],
  zh: ['复制', '複製', '拷贝', '拷貝', '剪切', '剪下', '复制链接', '複製影像'],
  ko: ['복사', '잘라내기', '링크 복사', '이미지 복사'],
};
const clipboardVariants = ['Ｃｏｐｙ', 'cOpY', 'C\u200bo\u200dp\u2060y', 'Cοpy', 'Сopy', 'CОРY', 'Сυt', 'CΟPΥ', 'CОΡΥ', 'СΟΡΥ',
  'Copy_Link', 'Copy\u00a0Image', 'Copy–Link', 'Co\u0301py', 'Copy…', 'Copy (⌘C)', 'コピー\u200b', '复制\u2060链接'];
function menuFixture(body) {
  let readId = 1, tree = `Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 ${body}`;
  const window = { windowId: '7', processStart: 'start', pid: 42, bundleId: 'test.fake',
    app: 'Editor', title: 'Draft', identityVerified: true };
  const state = createMacReadState(), calls = [];
  const cua = createCua({ platform: 'darwin', write() {}, emitImage() {}, async request(method, params) {
    if (method === 'getApp' || method === 'getAXState') {
      const reply = { window, text: tree, readId: readId++, truncated: false };
      const snapshot = state.read(reply); state.endCell([{ type: 'text', text: tree }], [snapshot]);
      return reply;
    }
    state.assertCurrent(method, params, 'fixture-cell');
    calls.push({ method, params });
    return { window, delivery: 'sent-unverified', retry: 'read-first' };
  } });
  return { cua, calls, setBody(body) { tree = `Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 ${body}`; } };
}
for (const [language, labels] of Object.entries({ ...clipboardLabels, variants: clipboardVariants }))
  test(`real Mac action path refuses clipboard writes: ${language}`, async t => {
    let refused = 0;
    for (const label of labels) for (const role of ['button', 'menu item'])
      for (const selector of [1, { label }, { id: 'copy-action' }]) {
        const f = menuFixture(`${role} ${label}, ID: copy-action`), app = await f.cua.getApp('Editor');
        for (const method of ['click', 'doubleClick', 'performSecondaryAction']) {
          await assert.rejects(app[method](selector, ...method === 'performSecondaryAction' ? ['Activate'] : []), error =>
            error.code === 'ACTION_UNSUPPORTED' && error.delivery === 'not-sent' && error.retry === 'safe' &&
            error.clipboard === 'untouched' && /would overwrite the clipboard/i.test(error.message), `${method}: ${label}`);
          refused++;
        }
        assert.deepEqual(f.calls, []);
      }
    t.diagnostic(`refused=${refused} driverActions=0`);
  });

test('menu Paste reads the clipboard and neutral labels retain their action path', async t => {
  const labels = ['Paste', 'Pegar', 'Coller', 'Einfügen', 'Colar', 'Incolla', '貼り付け', '粘贴', '貼上', '붙여넣기',
    'Paste and Match Style', 'Copyright', 'Copying', 'Shortcut', 'Cutlery', 'Copycat'];
  let allowed = 0;
  for (const label of labels) for (const role of ['button', 'menu item']) {
    const f = menuFixture(`${role} ${label}`), app = await f.cua.getApp('Editor');
    for (const method of ['click', 'performSecondaryAction']) {
      await app[method](1, ...method === 'performSecondaryAction' ? ['Activate'] : []); allowed++;
    }
    assert.deepEqual(f.calls.map(call => call.method), ['click', 'performSecondaryAction']);
  }
  t.diagnostic(`allowed=${allowed}`);
});

test('clipboard guard uses current labels, descriptions and values but ignores unrelated metadata', async () => {
  for (const body of ['button, Description: Copy Link', 'button, Value: Cut', 'button (focused) Copy']) {
    const f = menuFixture(body), app = await f.cua.getApp('Editor');
    await assert.rejects(app.click(1), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent' });
    assert.equal(f.calls.length, 0);
  }
  const f = menuFixture('button Help, ID: Copy, Help: Cut, Secondary Actions: Copy');
  const app = await f.cua.getApp('Editor'); await app.click(1);
  f.setBody('button Copy'); await app.getAXState();
  await assert.rejects(app.click(1), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent' });
  assert.equal(f.calls.length, 1);
});

test('clipboard refusal has a conditional wording pin', async () => {
  const { MAC_CLIPBOARD_WRITE_REFUSAL } = await import('../plugins/sleight/lib/mac-driver/diff.mjs');
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/prompt-default.json', import.meta.url)));
  assert.equal(createHash('sha256').update(MAC_CLIPBOARD_WRITE_REFUSAL).digest('hex'), baseline.clipboardWriteNotice);
});
