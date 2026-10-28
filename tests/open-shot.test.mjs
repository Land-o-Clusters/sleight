import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createContext, runInContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const tree = 'Window: "note.txt", App: Example Editor.\n0 standard window note.txt\n\t1 text area Value: draft';
const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function open(t, { flag = '0', autoFlag, window = tree, openedFile, failShot = false, failOpen = false, failRead = false, changeReview = false, warmRepl = false, ...relayOptions } = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const sent = [], received = [], events = [], approvals = [], leases = [];
  const previous = process.env.SLEIGHT_OPEN_SHOT, previousAuto = process.env.SLEIGHT_OPEN_AUTO_SHOT;
  if (flag == null) delete process.env.SLEIGHT_OPEN_SHOT;
  else process.env.SLEIGHT_OPEN_SHOT = flag;
  if (autoFlag === undefined) delete process.env.SLEIGHT_OPEN_AUTO_SHOT;
  else process.env.SLEIGHT_OPEN_AUTO_SHOT = autoFlag;
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview, warmRepl, ...relayOptions,
    ask: async message => { approvals.push(message); return 'accept'; },
    inputLease: { acquire: target => { leases.push(target); return 'lease'; }, renew() {}, release() {}, close() {} },
    localTools: { tools: [{ name: 'open_file' }], target: async () => ({ appId: 'org.example.editor', app: 'Example Editor' }),
      call: async (_name, _args, approve) => {
        if (!await approve(['open_file', 'Example Editor'], 'Allow opening?')) throw Error('declined');
        return failOpen ? { isError: true, content: [{ type: 'text', text: 'Open refused.' }] }
          : { content: [{ type: 'text', text: 'Opened note.txt.' }], _meta: { 'sleight/openedApp': 'org.example.editor',
            ...(openedFile ? { 'sleight/openedFile': openedFile } : {}) } };
      } } });
  if (previous === undefined) delete process.env.SLEIGHT_OPEN_SHOT;
  else process.env.SLEIGHT_OPEN_SHOT = previous;
  if (previousAuto === undefined) delete process.env.SLEIGHT_OPEN_AUTO_SHOT;
  else process.env.SLEIGHT_OPEN_AUTO_SHOT = previousAuto;
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let content = [];
  const write = text => content.push({ type: 'text', text });
  const shot = async options => {
    events.push('screenshot');
    if (failShot) throw Error('Screenshot unavailable');
    if (options?.emit !== false) content.push(image);
    return 'fake pixels';
  };
  const raw = { getScreenshot: shot, getAXState: async () => window,
    getAXStateAndScreenshot: async options => {
      events.push('screenshot');
      if (failShot) throw Error('Screenshot unavailable');
      if (options?.emit !== false) { write(window); content.push(image); }
      return { state: window, screenshot: 'fake pixels' };
    } };
  const context = createContext({ cua: { listApps: async () => [], getApp: async () => {
    events.push('acquire');
    if (failRead) throw Error('Window read refused');
    write(window); return raw;
  } }, nodeRepl: { write, emitImage: async () => content.push(image) } });
  let queue = Promise.resolve();
  serverIn.on('data', data => {
    for (const msg of data.toString().trim().split('\n').map(JSON.parse)) {
      sent.push(msg);
      if (msg.method !== 'tools/call') continue;
      queue = queue.then(async () => {
        content = [];
        let isError = false;
        // The engine's REPL keeps top-level bindings between calls; the relay's handle is a `var`.
        const code = msg.params.arguments.code.replace(/\bvar (__sleightOpenedApp\d+) =/, 'globalThis.$1 =');
        try { await runInContext(`(async () => { ${code} })()`, context); }
        catch (error) { isError = true; write(error.message); }
        serverOut.write(JSON.stringify({ id: msg.id, result: { content, isError,
          _meta: { 'codex/toolSurface': { app: { appId: 'org.example.editor' } } } } }) + '\n');
      });
    }
  });
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'open_file',
    arguments: { app: 'Example Editor', path: '/tmp/note.txt' } } }) + '\n');
  for (let i = 0; i < 30 && !received.some(msg => msg.id === 1); i++) { await tick(); await queue; }
  const result = received.find(msg => msg.id === 1)?.result;
  assert.ok(result, JSON.stringify(received));
  return { result, sent, events, approvals, leases, received };
}

for (const flag of ['0']) test(`open screenshot stays off for flag=${flag}`, async t => {
  const h = await open(t, { flag });
  assert.deepEqual(h.events, ['acquire']);
  assert.equal(h.result.isError, false);
  assert.equal(h.result.content.some(c => c.type === 'image'), false);
  assert.ok(h.result.content.some(c => c.text === tree));
  assert.equal(h.sent.filter(msg => msg.method === 'tools/call').length, 1);
});

test('open_file records its combined delivered image once and never the private screenshot reply', async t => {
  const recorded = [], cursor = { status() {}, close() {}, screenshot: content => recorded.push(...content.filter(c => c.type === 'image')) };
  const h = await open(t, { flag: '1', cursor });
  assert.deepEqual(recorded, h.result.content.filter(c => c.type === 'image')); assert.equal(recorded.length, 1);
});

test('open_file records no pixels when its engine read is withheld as an own-host window', async t => {
  const recorded = [], cursor = { status() {}, close() {}, screenshot: content => recorded.push(content) };
  const h = await open(t, { flag: '1', cursor, window: 'Window: "Allow payment", App: consent-host.\n0 standard window Allow payment' });
  assert.equal(h.result.isError, true); assert.deepEqual(recorded, []);
  assert.equal(h.result.content.some(c => c.type === 'image'), false);
});

for (const flag of [null, '1', 'true']) for (const changeReview of [false, true]) test(`flag=${flag} returns one screenshot after the tree in one engine call; changeReview=${changeReview}`, async t => {
  const h = await open(t, { flag, changeReview });
  assert.deepEqual(h.events, ['acquire', 'screenshot']);
  assert.equal(h.result.isError, false);
  assert.deepEqual(h.result.content.filter(c => c.type === 'image'), [image]);
  assert.ok(h.result.content.findIndex(c => c.text === tree) < h.result.content.findIndex(c => c.type === 'image'));
  assert.match(h.result.content.map(c => c.text ?? '').join('\n'), /Window handle: `__sleightOpenedApp\d+`/);
  assert.equal(h.sent.filter(msg => msg.method === 'tools/call').length, 1);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.leases.length, 1, 'only the existing local open reserves an app');
  assert.equal(h.received.filter(msg => msg.id === 1).length, 1);
});

test('a screenshot failure keeps the successful open, tree and handle', async t => {
  const h = await open(t, { flag: '1', failShot: true });
  assert.deepEqual(h.events, ['acquire', 'screenshot']);
  assert.equal(h.result.isError, false);
  assert.ok(h.result.content.some(c => c.text === tree));
  assert.equal(h.result.content.some(c => c.type === 'image'), false);
  assert.match(h.result.content.map(c => c.text ?? '').join('\n'), /Opened note.txt.*\n.*Window:.*\n/s);
  assert.match(h.result.content.map(c => c.text ?? '').join('\n'), /Window handle:/);
});

test('failed open and failed acquisition do not request a screenshot', async t => {
  for (const failure of [{ failOpen: true }, { failRead: true }]) {
    const h = await open(t, { flag: '1', ...failure });
    assert.equal(h.result.isError, true);
    assert.equal(h.events.includes('screenshot'), false);
  }
});

// A workbook's tree as Excel shows it: a content area with sheet buttons and no cell values (excel-edit, 2026-10-17).
const sheet = ['Window: "Book", App: Example Editor.', '0 standard window Book, URL: file:///tmp/book.xlsx',
  '\t1 layout area Content Area, Description: Workbook area, Used range: A1 to B4', '\t\t2 button Insert sheet, ID: addBlankSheetButton',
  '\t3 combo box (settable) Description: name box, Value: A1, ID: NameBox'].join('\n');
const textlessNote = /the document area exposes no text values/;
const all = h => h.result.content.map(c => c.text ?? '').join('\n');

test('DP3 names the acquired handle API in both prompt forms and preserves the off result', async t => {
  const api = "It has the engine's app API: click, pressKey, typeText, paste, setValue, selectText, scroll, performSecondaryAction, getAXState, getScreenshot, getAXStateAndScreenshot.";
  for (const prompt of [undefined, 'lean']) {
    const expected = prompt === 'lean' ? api.replace("It has the engine's app API: ", 'App API: ').replaceAll(', ', ',') : api;
    const off = await open(t, { prompt, handleApi: false });
    const on = await open(t, { prompt });
    assert.doesNotMatch(all(off), /engine's app API/);
    assert.ok(all(on).includes('\n' + expected));
    const normalize = text => text.replace(/__sleightOpenedApp\d+/g, '__sleightOpenedAppN');
    assert.equal(normalize(all(on).replace('\n' + expected, '')), normalize(all(off)));
    const failed = await open(t, { prompt, failRead: true });
    assert.doesNotMatch(all(failed), /engine's app API/);
  }
});

test('a textless document gets its screenshot in the open result, with no note to take one', async t => {
  const h = await open(t, { window: sheet, openedFile: { path: '/tmp/book.xlsx', size: 9000 } });
  assert.deepEqual(h.events, ['acquire', 'screenshot']);
  assert.equal(h.result.isError, false);
  assert.deepEqual(h.result.content.filter(c => c.type === 'image'), [image]);
  assert.ok(h.result.content.findIndex(c => c.text === sheet) < h.result.content.findIndex(c => c.type === 'image'));
  assert.doesNotMatch(all(h), textlessNote);
  assert.match(all(h), /screenshot added, the tree has no document text\. Window handle: `(__sleightOpenedApp\d+)`, already acquired, but `app` isn't set: start the next call with `let app = \1;`\./);
  const calls = h.sent.filter(msg => msg.method === 'tools/call');
  assert.equal(calls.length, 2);
  assert.match(calls[1].params.arguments.code, /^await __sleightOpenedApp\d+\.getScreenshot\(\)$/);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.leases.length, 1, 'the screenshot reserves nothing more');
});

test('SLEIGHT_OPEN_AUTO_SHOT=0 keeps the baseline: the note and no screenshot', async t => {
  const h = await open(t, { autoFlag: '0', window: sheet, openedFile: { path: '/tmp/book.xlsx', size: 9000 } });
  assert.deepEqual(h.events, ['acquire']);
  assert.equal(h.result.content.some(c => c.type === 'image'), false);
  assert.match(all(h), textlessNote);
  assert.doesNotMatch(all(h), /screenshot added/);
});

test('a screenshot failure on a textless document keeps the note, tree and handle', async t => {
  const h = await open(t, { window: sheet, openedFile: { path: '/tmp/book.xlsx', size: 9000 }, failShot: true });
  assert.deepEqual(h.events, ['acquire', 'screenshot']);
  assert.equal(h.result.isError, false);
  assert.equal(h.result.content.some(c => c.type === 'image'), false);
  assert.ok(h.result.content.some(c => c.text === sheet));
  assert.match(all(h), textlessNote);
  assert.match(all(h), /Window handle: `__sleightOpenedApp\d+`, already acquired/);
});

test('no screenshot for a document with text, a blank new file, or a window showing another file', async t => {
  const blank = ['Window: "Untitled", App: Example Editor.', '0 standard window Untitled, URL: file:///tmp/new.txt',
    '\t1 text area (settable)'].join('\n');
  for (const [window, openedFile] of [[tree, undefined], [blank, { path: '/tmp/new.txt', size: 0 }],
    [sheet, { path: '/tmp/other.xlsx', size: 9000 }]]) {
    const h = await open(t, { window, openedFile });
    assert.deepEqual(h.events, ['acquire'], window);
    assert.equal(h.result.content.some(c => c.type === 'image'), false);
  }
  // The same empty text area holds text when the file on disk has some.
  const h = await open(t, { window: blank, openedFile: { path: '/tmp/new.txt', size: 40 } });
  assert.deepEqual(h.events, ['acquire', 'screenshot']);
});
