import { fixtureDocumentation } from './helpers/canonical-docs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import * as launch from '../plugins/sleight/lib/launch.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const app = 'Example Editor', appId = 'org.example.editor';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-open-fast-')), path = join(dir, 'note.txt');
  writeFileSync(path, 'hello'); utimesSync(path, 10, 10); t.after(() => removeTemp(dir));
  return { app, path };
}

test('fast open skips LaunchServices only for an exact existing document after validation', async t => {
  const args = fixture(t);
  for (const fast of [false, true]) for (const present of [false, true]) {
    const events = [], openedFiles = new Map([[JSON.stringify([appId, args.path]), Date.now()]]);
    const result = await launch.openDocument(args, { fast, openedFiles, resolve: async () => appId,
      hasDocument: async (id, path) => { events.push(['check', id, path]); return present; },
      exec: async () => events.push(['open']) });
    assert.equal(result.isError, undefined);
    assert.equal(result._meta['sleight/openedApp'], appId);
    assert.equal(events.some(e => e[0] === 'check'), fast);
    assert.equal(events.some(e => e[0] === 'open'), !(fast && present));
    if (fast) assert.deepEqual(events[0], ['check', appId, args.path]);
  }
});

test('failed document observation falls back to background open; blocked targets never get observed', async t => {
  const args = fixture(t), events = [];
  const options = { fast: true, resolve: async () => appId,
    hasDocument: async () => { events.push('check'); throw Error('AX unavailable'); }, exec: async () => events.push('open') };
  assert.equal((await launch.openDocument(args, options)).isError, undefined);
  assert.deepEqual(events, ['check', 'open']);
  events.length = 0;
  assert.equal((await launch.openDocument({ ...args, path: args.path + '.sh' }, options)).isError, true);
  assert.deepEqual(events, []);
});

function harness(t, options) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const received = [];
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, ...options });
  t.after(() => relay.close());
  return { received, relay, send: (name = 'open_file', id = 1) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name,
    arguments: { app, path: '/tmp/note.txt' } } }) + '\n') };
}

test('fast open overlaps resolution and its one approval with target lookup; the open waits for the lookup', async t => {
  const target = deferred(), resolution = deferred(), approval = deferred(), events = [];
  const h = harness(t, { openFast: true, ask: async () => { events.push('approval'); return approval.promise; },
    inputLease: { acquire: () => { events.push('lease'); return 'lease'; }, renew: () => events.push('renew'), release() {}, close() {} },
    localTools: { tools: [{ name: 'open_file' }], target: () => { events.push('target'); return target.promise; },
      prepareOpen: (args, approve) => launch.prepareOpenFile(args, approve, { resolve: () => { events.push('resolve'); return resolution.promise; } }),
      call: async (_name, _args, approve, _run, _resolved, prepared) => {
        assert.equal(await approve(['open_file', app], 'Allow?'), true);
        assert.equal(await prepared.bundleId, appId);
        events.push('action'); return { content: [] };
      } } });
  h.send(); await tick();
  assert.deepEqual(new Set(events), new Set(['target', 'resolve', 'approval']));
  approval.resolve('accept'); resolution.resolve(appId); await tick();
  assert.ok(!events.includes('action'));
  target.resolve({ appId, app, title: null, url: null }); await tick();
  assert.ok(events.indexOf('lease') < events.indexOf('action'));
  assert.ok(events.indexOf('renew') < events.indexOf('action'));
  assert.equal(events.filter(e => e === 'approval').length, 1);
});

test('fast open denial, failed target and Stop during preparation cannot open a file', async t => {
  for (const mode of ['denied', 'target-failed', 'stopped']) {
    const target = deferred(); let actions = 0, prompts = 0;
    const h = harness(t, { openFast: true, ask: async () => { prompts++; return mode === 'denied' ? 'decline' : 'accept'; },
      localTools: { tools: [{ name: 'open_file' }], target: () => target.promise,
        prepareOpen: (args, approve) => launch.prepareOpenFile(args, approve, { resolve: async () => appId }),
        call: async (_name, _args, approve) => { if (await approve(['open_file', app], 'Allow?')) actions++; return { content: [] }; } } });
    h.send(); await tick();
    if (mode === 'stopped') await h.relay.close();
    target.resolve(mode === 'target-failed' ? Promise.reject(Error('target changed')) : { appId, app });
    await tick(); assert.equal(actions, 0, mode);
    // The approval runs alongside the lookup, so the user answers once whatever the lookup finds.
    assert.equal(prompts, 1, mode);
  }
});

test('an approval answered after Stop opens nothing', async t => {
  const answer = deferred(); let prompts = 0, calls = 0;
  const h = harness(t, { openFast: true, ask: async () => { prompts++; return answer.promise; },
    localTools: { tools: [{ name: 'open_file' }], target: async () => ({ appId, app }),
      prepareOpen: (args, approve) => launch.prepareOpenFile(args, approve, { resolve: async () => appId }),
      call: async (_name, _args, approve) => { if (await approve(['open_file', app], 'Allow?')) calls++; return { content: [] }; } } });
  h.send(); await tick();
  assert.equal(prompts, 1);
  await h.relay.close();
  answer.resolve('accept'); await tick(); await tick();
  assert.equal(calls, 0);
});

test('local open reuses preparation, preserves its approval wording and refuses before observation on denial', async t => {
  const args = fixture(t);
  for (const allowed of [false, true]) {
    let resolutions = 0, prompts = 0, checks = 0, opens = 0;
    const prepared = launch.prepareOpenFile(args, async (parts, message) => {
      prompts++; assert.deepEqual(parts, ['open_file', app]);
      assert.equal(message, `Allow Claude to open files in ${app}? They open in the background.`);
      return allowed;
    }, { resolve: async () => { resolutions++; return appId; } });
    const result = await launch.callLocalTool('open_file', args, () => prepared.approval, undefined, undefined, {
      ...prepared, hasDocument: async () => { checks++; return true; }, exec: async () => { opens++; },
    });
    assert.equal(result.isError, allowed ? undefined : true);
    // The probe confirms the document's window, so no background open runs.
    assert.equal(resolutions, 1); assert.equal(prompts, 1); assert.equal(checks, allowed ? 1 : 0); assert.equal(opens, 0);
  }
});

test('Stop after native observation prevents background open and a false successful reuse', async t => {
  const args = fixture(t);
  for (const matches of [false, true]) {
    let stopped = false, opens = 0;
    await assert.rejects(launch.openDocument(args, { fast: true, resolve: async () => appId,
      current: () => { if (stopped) throw Error('stopped'); },
      hasDocument: async () => { stopped = true; return matches; }, exec: async () => { opens++; } }), /stopped/);
    assert.equal(opens, 0);
  }
});

test('flag-off and other local tools do not start speculative preparation', async t => {
  for (const [openFast, name] of [[false, 'open_file'], [true, 'drag']]) {
    const target = deferred(); let prepared = 0;
    const h = harness(t, { openFast, localTools: { tools: [{ name }], target: () => target.promise,
      prepareOpen: () => { prepared++; }, call: async () => ({ content: [] }) } });
    h.send(name); await tick(); assert.equal(prepared, 0);
    target.resolve({ appId, app }); await tick();
  }
});

test('a confirmed window skips the open unless the file changed during the call or since this session opened it', async t => {
  const args = fixture(t);
  for (const mode of ['unknown', 'fresh', 'newer', 'changed-during-probe', 'not-open']) {
    const openedFiles = new Map(), events = [];
    utimesSync(args.path, 10, 10);
    if (['fresh', 'newer'].includes(mode)) openedFiles.set(JSON.stringify([appId, args.path]), 20000);
    if (mode === 'newer') utimesSync(args.path, 30, 30);
    await launch.openDocument(args, { fast: true, openedFiles, resolve: async () => appId,
      hasDocument: async () => {
        if (mode === 'changed-during-probe') utimesSync(args.path, 30, 30);
        return mode !== 'not-open';
      }, exec: async () => events.push('open') });
    assert.deepEqual(events, ['unknown', 'fresh'].includes(mode) ? [] : ['open'], mode);
  }
});

test('a file changed after this session opened it opens again', async t => {
  const args = fixture(t), openedFiles = new Map(), events = [];
  let open = false;
  const options = { fast: true, openedFiles, resolve: async () => appId,
    hasDocument: async () => open, exec: async () => { events.push('open'); open = true; } };
  await launch.openDocument(args, options);
  await launch.openDocument(args, options);
  assert.deepEqual(events, ['open']);
  const later = (Date.now() + 60000) / 1000;
  utimesSync(args.path, later, later);
  await launch.openDocument(args, options);
  assert.deepEqual(events, ['open', 'open']);
});

test('a hung document probe falls back at one second total and ignores its late match', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const args = fixture(t), probe = deferred(), events = [];
  const pending = launch.openDocument(args, { fast: true, resolve: async () => appId,
    openedFiles: new Map([[JSON.stringify([appId, args.path]), Date.now()]]),
    hasDocument: () => probe.promise, exec: async () => events.push('open') });
  await tick(); t.mock.timers.tick(999); await tick();
  assert.deepEqual(events, []);
  t.mock.timers.tick(1); await tick();
  assert.deepEqual(events, ['open']);
  assert.equal((await pending).isError, undefined);
  probe.resolve(true); await tick();
  assert.deepEqual(events, ['open']);
});

test('document probe child gets a one-second timeout instead of the generic helper deadline', async () => {
  let options;
  await launch.runScript('open-file-window.js', {}, { run: (_cmd, _args, opts, reply) => {
    options = opts; reply(null, '{"ok":true,"matches":false}', '');
  } });
  assert.equal(options.timeout, 1000);
});

function observe({ ids = [appId], documents = [], mains, hidden = false, minimized = false, visible = true, visibilityError = false, axError = false } = {}) {
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const $ = key => key;
  Object.assign($, { NSWorkspace: { sharedWorkspace: { runningApplications: list(ids.map(bundleIdentifier => ({ bundleIdentifier, processIdentifier: 123 }))) } },
    NSURL: { fileURLWithPath: path => ({ absoluteString: new URL('file://' + path.replaceAll(' ', '%20')).href }) },
    AXUIElementCreateApplication: pid => ({ pid }), AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, key, out) => {
      if (axError) return -1;
      if (key === 'AXWindows') out[0] = list(documents.map((document, i) => ({ document, main: mains ? mains[i] : true })));
      else if (key === 'AXMain') { if (element.main === 'error') return -1; out[0] = element.main; }
      else if (key === 'AXHidden') out[0] = hidden;
      else if (key === 'AXMinimized') out[0] = minimized;
      else if (key === 'AXVisible') out[0] = visible;
      else out[0] = element.document;
      if (visibilityError && ['AXHidden', 'AXMinimized', 'AXVisible'].includes(key)) return -1;
      return 0;
    } });
  const source = readFileSync(new URL('../plugins/sleight/lib/open-file-window.js', import.meta.url), 'utf8');
  return JSON.parse(runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, Ref: () => [],
    ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value }, request: { appId, path: '/tmp/a b.txt' } }));
}

test('read-only window probe matches only the exact AXDocument URL in one matching process', () => {
  assert.equal(observe({ documents: ['file:///tmp/a%20b.txt'] }).matches, true);
  for (const options of [
    { documents: ['file:///tmp/a%20b.txt.bak'] }, { documents: ['/tmp/a b.txt'] },
    { documents: ['https://example.com/a%20b.txt'] }, { documents: [null] }, { documents: [] },
    { ids: [] }, { ids: [appId, appId], documents: ['file:///tmp/a%20b.txt'] },
    { ids: ['org.example.other'], documents: ['file:///tmp/a%20b.txt'] }, { axError: true },
  ]) assert.equal(observe(options).matches, false);
});

test('document probe cannot reuse hidden, minimized or unknown-visibility windows', () => {
  for (const state of [{ hidden: true }, { minimized: true }, { visible: false }, { visibilityError: true }]) {
    assert.equal(observe({ documents: ['file:///tmp/a%20b.txt'], ...state }).matches, false, JSON.stringify(state));
  }
});

test('document probe skips the open only when the matching window is the main one', () => {
  const path = 'file:///tmp/a%20b.txt', other = 'file:///tmp/other.txt';
  assert.equal(observe({ documents: [other, path], mains: [false, true] }).matches, true);
  // TextEdit showing A and B with B in front: the read after open_file would return B.
  for (const mains of [[false, true], [false, false], ['error', true]]) {
    assert.equal(observe({ documents: [path, other], mains }).matches, false, JSON.stringify(mains));
  }
});

function failingFirstLookup(t, options) {
  let lookups = 0, opened = 0;
  const first = deferred();
  const h = harness(t, { openFast: true, ...options,
    localTools: { tools: [{ name: 'open_file' }],
      target: () => lookups++ === 0 ? first.promise : { appId, app },
      prepareOpen: (args, approve) => launch.prepareOpenFile(args, approve, { resolve: async () => appId }),
      call: async (_name, _args, approve) => { if (await approve(['open_file', app], 'Allow?')) opened++; return { content: [] }; } } });
  return { ...h, opened: () => opened, fail: () => first.resolve(Promise.reject(Error('Input lease: target changed'))) };
}

test('a failed lookup declines its pending approval: later asks go ahead and a late yes grants nothing', async t => {
  const answers = [];
  const h = failingFirstLookup(t, { ask: () => { const answer = deferred(); answers.push(answer); return answer.promise; } });
  h.send('open_file', 1); await tick();
  assert.equal(answers.length, 1);
  h.fail(); await tick(); await tick();
  assert.equal(h.received.find(m => m.id === 1)?.result.isError, true);
  h.send('open_file', 2); await tick(); await tick();
  assert.equal(answers.length, 2, 'the second approval must not wait behind the failed call');
  answers[0].resolve('accept'); answers[1].resolve('decline'); await tick(); await tick();
  h.send('open_file', 3); await tick(); await tick();
  assert.equal(answers.length, 3, 'a yes to the failed call is not a session grant');
  answers[2].resolve('accept'); await tick(); await tick();
  assert.equal(h.opened(), 1);
});

test('a failed lookup cancels its elicitation', async t => {
  const h = failingFirstLookup(t, {});
  h.send('open_file', 1); await tick();
  const request = h.received.find(m => m.method === 'elicitation/create');
  assert.ok(request);
  h.fail(); await tick(); await tick();
  assert.deepEqual(h.received.find(m => m.method === 'notifications/cancelled')?.params.requestId, request.id);
  assert.equal(h.received.find(m => m.id === 1)?.result.isError, true);
  assert.equal(h.opened(), 0);
});

test('a running app skips the document probe and the open; a changed file or another app still follows the old order', async t => {
  const args = fixture(t), running = { appId, app };
  const run = async (options, target = running) => {
    const events = [];
    const result = await launch.openDocument(args, { fast: true, target, resolve: async () => appId,
      hasDocument: async () => { events.push('check'); return true; }, exec: async () => events.push('open'), ...options });
    return { events, result };
  };
  const warm = await run({});
  assert.deepEqual(warm.events, []);
  assert.equal(warm.result._meta['sleight/openedFile'].lazy, true);
  // A file changed since this session opened it opens now, with no probe.
  const stale = await run({ openedFiles: new Map([[JSON.stringify([appId, args.path]), 5000]]) });
  assert.deepEqual(stale.events, ['open']);
  assert.equal(stale.result._meta['sleight/openedFile'].lazy, undefined);
  // An app that isn't running (no target) or a target for another app keeps the probe.
  for (const target of [null, { appId: 'org.example.other' }]) {
    const cold = await run({}, target);
    assert.deepEqual(cold.events, ['check']);
    assert.equal(cold.result._meta['sleight/openedFile'].lazy, undefined);
  }
  const absent = await run({ hasDocument: async () => false }, null);
  assert.deepEqual(absent.events, ['open']);
});

test('reopenDocument runs the background open and records it for the mtime check', async t => {
  const args = fixture(t), openedFiles = new Map(), calls = [];
  await launch.reopenDocument(appId, args.path, { openedFiles, exec: async (file, argv) => calls.push([file, argv]) });
  assert.deepEqual(calls, [['/usr/bin/open', ['-g', '-b', appId, args.path]]]);
  assert.ok(openedFiles.get(JSON.stringify([appId, args.path])) > 0);
});

async function lazyOpen(t, windows, { reopenFails = false, documentationTrust } = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const received = [], reads = [], events = [], file = '/tmp/note.txt';
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', bytes => {
    for (const msg of bytes.toString().trim().split('\n').map(JSON.parse)) {
      if (msg.method !== 'tools/call' || msg.params.name !== 'js') continue;
      reads.push(msg.id); events.push('read');
      const value = windows[Math.min(reads.length, windows.length) - 1];
      const result = typeof value === 'string' ? { content: [{ type: 'text', text: value }] } : value;
      serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
  });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, openFast: true, documentationTrust,
    ask: async () => 'accept',
    inputLease: { acquire: () => 'lease', renew() {}, release() {}, close() {} },
    localTools: { tools: [{ name: 'open_file' }], target: async () => ({ appId, app }),
      reopen: async (id, path) => { events.push(['reopen', id, path]); if (reopenFails) throw Error('open failed'); },
      call: async (_name, _args, approve) => {
        await approve(['open_file', app], 'Allow?');
        return { content: [{ type: 'text', text: 'Opened.' }],
          _meta: { 'sleight/openedApp': appId, 'sleight/openedFile': { path: file, real: file, size: 5, lazy: true } } };
      } } });
  t.after(() => relay.close());
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'open_file', arguments: { app, path: file } } }) + '\n');
  for (let i = 0; i < 40 && !received.some(m => m.id === 1); i++) await tick();
  return { events, reply: received.find(m => m.id === 1)?.result, reads,
    async js(id) {
      clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(4)' } } }) + '\n');
      for (let i = 0; i < 40 && !received.some(m => m.id === id); i++) await tick();
      return received.find(m => m.id === id)?.result;
    } };
}
const shows = name => `Window: "${name}", App: ${app}.\n0 standard window ${name}, URL: file:///tmp/${name}\n\t1 text area Value: x`;

test('lazy open: a window already showing the file is not opened again', async t => {
  const { events, reply } = await lazyOpen(t, [shows('note.txt')]);
  assert.deepEqual(events, ['read']);
  assert.match(reply.content[0].text, /Opened/);
  assert.ok(!reply.content.some(c => /can't confirm/.test(c.text)));
});

test('lazy open: a running app showing another document opens the file and reads again', async t => {
  const { events, reply, reads } = await lazyOpen(t, [shows('other.txt'), shows('note.txt')]);
  assert.deepEqual(events, ['read', ['reopen', appId, '/tmp/note.txt'], 'read']);
  assert.equal(new Set(reads).size, 2);
  assert.ok(!reply.content.some(c => /can't confirm/.test(c.text)));
  assert.ok(reply.content.some(c => /note\.txt/.test(c.text)));
});

test('lazy open: a window with no document URL also opens the file, and only one retry runs', async t => {
  const bare = `Window: "Untitled", App: ${app}.\n0 standard window Untitled`;
  const { events } = await lazyOpen(t, [bare, shows('other.txt')]);
  assert.deepEqual(events, ['read', ['reopen', appId, '/tmp/note.txt'], 'read']);
});

test('lazy open: a failed reopen answers with the first read and its notice', async t => {
  const { events, reply } = await lazyOpen(t, [shows('other.txt')], { reopenFails: true });
  assert.deepEqual(events, ['read', ['reopen', appId, '/tmp/note.txt']]);
  assert.ok(reply.content.some(c => /can't confirm/.test(c.text)));
});

for (const combined of [false, true]) for (const repeated of [false, true]) {
  test(`lazy re-acquire keeps every engine docs block for the first js result once, combined=${combined}, repeated=${repeated}`, async t => {
    const docs = ['## Computer Use', '# Other Browser APIs', '# Computer Use Confirmations Policy', '# Browser Safety', '# API Reference']
      .map(header => ({ type: 'text', text: header + '\nReference for ' + header + '\n' }));
    const first = combined ? [...docs.slice(0, -1), { ...docs.at(-1), text: docs.at(-1).text + shows('other.txt') }]
      : [...docs, { type: 'text', text: shows('other.txt') }];
    const h = await lazyOpen(t, [{ content: first },
      { content: [...(repeated ? docs : []), { type: 'text', text: shows('note.txt') }] },
      { content: [{ type: 'text', text: '4' }] }], { documentationTrust: fixtureDocumentation(docs.map(c => c.text)) });
    assert.equal(h.reads.length, 2);
    assert.ok(h.reply.content.some(c => /Window handle:/.test(c.text ?? '')));
    assert.ok(h.reply.content.some(c => c.text?.includes(shows('note.txt'))));
    assert.ok(!h.reply.content.some(c => /Reference for/.test(c.text ?? '')));
    const next = await h.js(2);
    for (const doc of docs) assert.equal(next.content.filter(c => c.text === doc.text).length, 1, doc.text);
    assert.deepEqual(next.content.slice(0, docs.length), docs);
    assert.ok(!next.content.some(c => c.text?.includes('other.txt')));
    assert.ok(!(await h.js(3)).content.some(c => /Reference for/.test(c.text ?? '')));
  });
}

test('a discarded window tree cannot turn its document headings into deferred engine docs', async t => {
  const h = await lazyOpen(t, [shows('other.txt') + '\n# API Reference\nDocument text, not engine docs.', shows('note.txt'), '4']);
  assert.equal(h.reads.length, 2);
  assert.ok(!(await h.js(2)).content.some(c => /Document text, not engine docs/.test(c.text ?? '')));
});
