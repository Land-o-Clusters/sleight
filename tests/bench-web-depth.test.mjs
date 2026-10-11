import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';
import { serveWebPage, checkWeb } from '../bench/real-server.mjs';
import { webTasks } from '../bench/tasks-web.mjs';
import { getTasks } from '../bench/tasks.mjs';

const nonce = 'abc123';
const expected = {
  validation: { rejected: true, errors: [], fields: { email: 'team@example.test', seats: '3', code: nonce }, submitted: true },
  controls: { project: 'Orchid', date: '2026-11-17', team: 'Research', submitted: true },
  modal: { project: 'Orchid', note: `Approved ${nonce}`, confirmed: true, modalOpen: false },
  hover: { row: 'Orchid', action: 'Archive', menuOpen: false },
  reorder: { order: ['Oak', 'Cedar', 'Maple', 'Orchid', 'Pine'] },
  iframe: { outside: '', frame: { project: 'Orchid', code: nonce, submitted: true } },
  shadow: { outside: '', inside: { project: 'Orchid', code: nonce, submitted: true } },
  tabs: { tab: 'first', answer: `Tide-${nonce}`, submitted: true },
  accordion: { expanded: ['Marine'], answer: `Coral-${nonce}`, submitted: true },
  delayed: { loaded: true, answer: `Ready-${nonce}`, submitted: true },
};
const misses = {
  validation: [{ rejected: false }, { errors: ['Email is invalid'] }, { fields: { ...expected.validation.fields, seats: '2' } }],
  controls: [{ project: 'Oak' }, { date: '2026-11-18' }, { team: 'Operations' }],
  modal: [{ project: 'Oak' }, { modalOpen: true }, { note: 'Approved stale' }],
  hover: [{ row: 'Oak' }, { action: 'Pin' }, { menuOpen: true }],
  reorder: [{ order: ['Oak', 'Cedar', 'Orchid', 'Maple', 'Pine'] }, { order: ['Oak', 'Cedar', 'Maple', 'Pine', 'Orchid'] }],
  iframe: [{ outside: nonce, frame: { ...expected.iframe.frame, code: '' } }, { frame: { ...expected.iframe.frame, project: 'Oak' } }],
  shadow: [{ outside: nonce, inside: { ...expected.shadow.inside, code: '' } }, { inside: { ...expected.shadow.inside, project: 'Oak' } }],
  tabs: [{ tab: 'second' }, { answer: '' }, { answer: 'Tide-stale' }],
  accordion: [{ expanded: ['Coastal'] }, { expanded: [] }, { answer: 'Coral-stale' }],
  delayed: [{ loaded: false }, { answer: 'Ready-stale' }],
};

async function fixture(t, kind) {
  const ctx = { nonce, sequence: 0 };
  await serveWebPage(ctx, kind);
  t.after(() => ctx.closeServer?.());
  return ctx;
}
const post = (ctx, state, path = 'state', extra = {}) => fetch(ctx.url + path, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nonce, kind: ctx.webKind, sequence: ++ctx.sequence, state, ...extra }),
});

// A small DOM adapter executes the shipped handlers. It does not render a
// layout, dispatch real pointer input or start an engine/browser process.
async function controls(ctx, path = '', parentMessage = () => {}) {
  const html = await (await fetch(ctx.url + path)).text(), pending = [], listeners = {}, timers = [];
  class Element {
    value = ''; textContent = ''; hidden = false; open = false; children = []; listeners = {}; contentWindow = {};
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    focus() { this.onfocus?.(); this.onfocusin?.(); }
    querySelector(tag) { return this.children.find(child => child.tag === tag); }
    attachShadow(options) { assert.equal(options.mode, 'open'); return this.root = scope(); }
  }
  function scope() {
    return { nodes: new Map(), getElementById(id) { return this.nodes.get(id); },
      set innerHTML(markup) {
        for (const match of markup.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)) {
          const [, tag, attrs, id, text] = match, element = new Element();
          Object.assign(element, { tag, textContent: text.trim(), value: attrs.match(/value="([^"]*)"/)?.[1] ?? '', hidden: /\bhidden\b/.test(attrs) });
          if (tag === 'select' || tag === 'details') {
            const tail = markup.slice(match.index).split(`</${tag}>`)[0];
            if (tag === 'select') element.value = tail.match(/<option[^>]*>([^<]*)/)?.[1] ?? '';
            else element.children = [Object.assign(new Element(), { tag: 'summary', textContent: tail.match(/<summary>([^<]*)/)?.[1] })];
          }
          this.nodes.set(id, element);
        }
      } };
  }
  const document = scope(); document.innerHTML = html.split('<script>')[0];
  document.createElement = tag => Object.assign(new Element(), { tag });
  let closed = 0;
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, location: { origin: new URL(ctx.url).origin }, window: { close() { closed++; } },
    parent: { postMessage: parentMessage }, addEventListener: (name, callback) => { listeners[name] = callback; },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    fetch: (url, options) => { const request = fetch(new URL(url, ctx.url), options); pending.push(request); return request; },
  });
  return { html, node: id => document.getElementById(id), timers, listeners, closed: () => closed,
    flush: () => Promise.all(pending.splice(0)) };
}

async function exercise(t, kind) {
  const ctx = await fixture(t, kind), page = await controls(ctx), node = page.node, event = { preventDefault() {}, dataTransfer: { setData() {} } };
  const fill = (id, value) => { node(id).value = value; node(id).oninput?.(); };
  if (kind === 'validation') {
    node('form').onsubmit(event);
    assert.equal(node('errors').children.length, 3);
    fill('email', 'team@example.test'); fill('seats', '3'); fill('code', nonce); node('form').onsubmit(event);
  } else if (kind === 'controls') {
    node('project').focus(); assert.equal(node('options').hidden, false); node('orchid').onclick();
    fill('date', '2026-11-17'); fill('team', 'Research'); node('form').onsubmit(event);
  } else if (kind === 'modal') {
    node('orchid').onclick(); assert.equal(node('modal').open, true);
    fill('note', `Approved ${nonce}`); node('form').onsubmit(event);
  } else if (kind === 'hover') {
    assert.equal(node('menu-Orchid').hidden, true);
    node('actions-Orchid').onmouseenter(); assert.equal(node('menu-Orchid').hidden, false); node('archive-Orchid').onclick();
  } else if (kind === 'reorder') {
    const move = onto => {
      const children = node('items').children;
      children.find(item => item.textContent === 'Orchid').ondragstart(event);
      children.find(item => item.textContent === onto).ondrop(event);
    };
    move('Cedar'); await page.flush(); assert.notEqual(checkWeb(ctx), true, 'real drop one slot off fails'); move('Maple');
  } else if (kind === 'iframe') {
    const frame = await controls(ctx, 'frame', (data, origin) => page.listeners.message({ data, origin, source: node('frame').contentWindow }));
    frame.node('project').value = 'Orchid'; frame.node('project').onchange();
    frame.node('code').value = nonce; frame.node('code').oninput(); frame.node('form').onsubmit(event);
    await frame.flush();
  } else if (kind === 'shadow') {
    const root = node('host').root;
    root.getElementById('project').value = 'Orchid'; root.getElementById('project').onchange();
    root.getElementById('code').value = nonce; root.getElementById('code').oninput(); root.getElementById('form').onsubmit(event);
  } else if (kind === 'tabs') {
    const second = await controls(ctx, 'second'); await second.flush();
    const value = second.html.match(/<strong>([^<]+)<\/strong>/)[1];
    second.node('close').onclick(); assert.equal(second.closed(), 1);
    fill('answer', value); node('form').onsubmit(event);
  } else if (kind === 'accordion') {
    node('marine').open = true; node('marine').listeners.toggle(); fill('answer', `Coral-${nonce}`); node('form').onsubmit(event);
  } else if (kind === 'delayed') {
    assert.equal(page.timers.length, 1); assert.ok(page.timers[0].delay >= 1000 && page.timers[0].delay <= 3000);
    fill('answer', `Ready-${nonce}`); node('form').onsubmit(event);
    await page.flush(); assert.notEqual(checkWeb(ctx), true, 'answer before loading cannot pass'); page.timers[0].callback();
  }
  await page.flush();
  assert.equal(checkWeb(ctx), true, `${kind} shipped handlers must emit the accepted state`);
  await ctx.closeServer();
}

for (const kind of Object.keys(expected)) test(`${kind}: exact server state passes and near misses fail without a browser`, async t => {
  const ctx = await fixture(t, kind);
  assert.notEqual(checkWeb({ ...ctx, answer: 'Done' }), true);
  const html = await (await fetch(ctx.url)).text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  new Script(scripts[0][1]);
  assert.doesNotMatch(html, /type="file"|\bdownload\b|(?:src|href)="https?:\/\//);
  if (kind === 'tabs') {
    assert.notEqual(checkWeb({ ...ctx, page: { snapshot: expected.tabs } }), true, 'missing second-tab records fail closed');
    await fetch(ctx.url + 'second');
    await post(ctx, { tab: 'second', value: `Tide-${nonce}`, answer: '', submitted: false }, 'second/state');
  }
  if (kind === 'iframe') {
    assert.notEqual(checkWeb({ ...ctx, page: { snapshot: expected.iframe } }), true, 'missing frame records fail closed');
    await fetch(ctx.url + 'frame');
    await post(ctx, expected.iframe.frame, 'frame/state');
  }
  assert.equal((await post(ctx, expected[kind])).status, 204);
  assert.equal(checkWeb(ctx), true);
  for (const miss of misses[kind]) {
    await post(ctx, { ...expected[kind], ...miss });
    assert.notEqual(checkWeb(ctx), true, JSON.stringify(miss));
  }
  await post(ctx, { ...expected[kind], extra: true });
  assert.notEqual(checkWeb(ctx), true);
  await post(ctx, expected[kind]);
  assert.equal(checkWeb(ctx), true);
  assert.equal((await post(ctx, {}, 'state', { nonce: 'other' })).status, 400);
  if (kind === 'tabs') {
    await post(ctx, { tab: 'second', value: `Tide-${nonce}`, answer: `Tide-${nonce}`, submitted: true }, 'second/state');
    assert.notEqual(checkWeb(ctx), true, 'entering the value in the second tab invalidates the run');
    await post(ctx, expected.tabs, 'second/state');
    assert.notEqual(checkWeb(ctx), true, 'a first-tab claim on the second endpoint cannot pass');
  }
  if (kind === 'iframe') {
    await post(ctx, { ...expected.iframe.frame, code: 'stale' }, 'frame/state');
    assert.notEqual(checkWeb(ctx), true, 'outer page cannot claim a correct frame');
  }
  await ctx.closeServer();
  await assert.rejects(fetch(ctx.url));
  await exercise(t, kind);
});

test('browser table supplies unique native and Chromium extension tasks with matching task sentences', async t => {
  assert.equal(webTasks.length, 126);
  const all = getTasks('real');
  assert.equal(new Set(all.map(task => task.id)).size, all.length);
  for (const browser of ['safari', 'helium', 'chrome', 'firefox', 'arc']) {
    for (const kind of Object.keys(expected)) {
      const native = webTasks.find(task => task.id === `${browser}-${kind}`);
      assert.equal(native?.surface, 'native');
      assert.equal(native.webKind, kind);
      assert.ok(native.bundle);
      const extension = webTasks.find(task => task.id === `${browser}-${kind}-extension`);
      if (['safari', 'firefox'].includes(browser)) { assert.equal(extension, undefined); continue; }
      assert.equal(extension?.surface, 'extension');
      const ctx = await fixture(t, kind);
      const nativePrompt = native.prompt(ctx), extensionPrompt = extension.prompt(ctx);
      assert.equal(nativePrompt.slice(nativePrompt.indexOf('. ') + 2), extensionPrompt.slice(extensionPrompt.indexOf('. ') + 2));
      assert.match(extensionPrompt.split('. ')[0], /cua\.createBrowserTab/);
      await ctx.closeServer();
    }
  }
});
