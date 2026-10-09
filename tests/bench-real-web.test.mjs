import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext, Script } from 'node:vm';
import * as server from '../bench/real-server.mjs';
import { acquireFixture } from '../bench/real-run.mjs';
import { closeFixtures } from '../bench/real-fixture.mjs';

const kinds = ['grid', 'editor', 'dense', 'spa', 'nested', 'infinite'];
const rows = [
  { project: 'Cedar', budget: 90 }, { project: 'Orchid', budget: 125 },
  { project: 'Harbor', budget: 140 }, { project: 'Maple', budget: 180 },
  { project: 'Willow', budget: 220 }, { project: 'Juniper', budget: 260 },
  { project: 'Birch', budget: 310 }, { project: 'Elm', budget: 350 },
  { project: 'Aspen', budget: 390 }, { project: 'Pine', budget: 430 },
  { project: 'Spruce', budget: 470 }, { project: 'Oak', budget: 510 },
];
const good = {
  grid: { rows, sorted: 'budget-ascending' },
  editor: { document: [
    { tag: 'h1', children: [{ text: 'Weekly planning', bold: false }] },
    { tag: 'h2', children: [{ text: 'Release checklist', bold: false }] },
    { tag: 'p', children: [{ text: 'We ', bold: false }, { text: 'ship carefully', bold: true }, { text: ' every Friday.', bold: false }] },
    { tag: 'ul', children: [
      { tag: 'li', children: [{ text: 'Review draft', bold: false }] },
      { tag: 'li', children: [{ text: 'Publish release', bold: false }] },
      { tag: 'li', children: [{ text: 'Archive notes abc123', bold: false }] },
    ] },
  ] },
  dense: { selected: 'link-173', title: 'Tidal observatory field notes' },
  spa: { route: '/complete', visits: ['/', '/requests', '/requests/new', '/complete'], fields: { category: 'Research', project: 'Orchid', code: 'abc123' } },
  nested: { accordion: true, tree: ['Science', 'Marine', 'Station'], details: true, selected: 'Coral report abc123' },
  infinite: { loaded: 100, opened: 'Record 87', note: 'Reviewed abc123', confirmed: true, modalOpen: false },
};
const post = (ctx, state, extra = {}) => fetch(ctx.url + 'state', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nonce: ctx.nonce, kind: ctx.webKind, sequence: ++ctx.sequence, state, ...extra }),
});
async function fixture(t, kind) {
  assert.equal(typeof server.serveWebPage, 'function', 'web page server must exist');
  const ctx = { nonce: 'abc123', sequence: 0 };
  await server.serveWebPage(ctx, kind);
  t.after(() => ctx.closeServer?.());
  return ctx;
}

for (const kind of kinds) {
  test(`${kind} checker uses posted state and rejects incomplete, changed and stale outcomes`, async t => {
    const ctx = await fixture(t, kind);
    assert.notEqual(server.checkWeb({ ...ctx, answer: 'Done' }), true);
    if (kind === 'dense') await fetch(ctx.url + 'article/link-173');
    assert.equal((await post(ctx, good[kind])).status, 204);
    assert.equal(server.checkWeb(ctx), true);
    const negatives = {
      grid: [{ rows: rows.slice(1) }, { rows: rows.map(row => row.project === 'Oak' ? { ...row, budget: 511 } : row) }, { rows: [...rows].reverse() }, { sorted: '' }],
      editor: [{ document: good.editor.document.slice(1) }, { document: [...good.editor.document].reverse() },
        { document: [...good.editor.document, { tag: 'p', children: [{ text: 'extra', bold: false }] }] }],
      dense: [{ selected: 'link-172' }, { title: 'Other article' }],
      spa: [{ route: '/requests/new' }, { visits: ['/', '/complete'] }, { fields: { category: 'Research', project: 'Orchid', code: 'stale' } }, { fields: { category: 'Research', project: 'Orchid', code: 'abc123', extra: 'unexpected' } }],
      nested: [{ accordion: false }, { tree: ['Science', 'Station'] }, { details: false }, { selected: 'Coral report stale' }],
      infinite: [{ loaded: 80 }, { opened: 'Record 86' }, { note: 'Reviewed stale' }, { confirmed: false }, { modalOpen: true }],
    };
    for (const change of negatives[kind]) {
      await post(ctx, { ...good[kind], ...change });
      assert.notEqual(server.checkWeb(ctx), true, JSON.stringify(change));
    }
    await post(ctx, { ...good[kind], unexpected: true });
    assert.notEqual(server.checkWeb(ctx), true, 'extra fields cannot hide unintended edits');
    await post(ctx, good[kind]);
    await post(ctx, {}, { sequence: 1 });
    assert.equal(server.checkWeb(ctx), true, 'late snapshots cannot overwrite the latest page state');
    await post(ctx, {});
    assert.notEqual(server.checkWeb(ctx), true, 'later incomplete state invalidates an earlier pass');
  });

  test(`${kind} page has executable script, stays local, rejects foreign state and closes its listener`, async t => {
    const ctx = await fixture(t, kind);
    const response = await fetch(ctx.url), html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length);
    for (const match of scripts) new Script(match[1]);
    assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
    if (kind === 'dense') assert.ok([...html.matchAll(/<a /g)].length >= 200);
    assert.equal((await post(ctx, good[kind], { nonce: 'stale' })).status, 400);
    assert.equal((await post(ctx, good[kind], { kind: 'other' })).status, 400);
    assert.equal((await fetch(ctx.url + 'state', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.test' }, body: '{}' })).status, 403);
    assert.equal((await fetch(ctx.url.replace('abc123', 'other'))).status, 404);
    assert.equal((await fetch(ctx.url + 'state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
    assert.equal((await fetch(ctx.url + 'state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(40000) })).status, 413);
    assert.notEqual(server.checkWeb(ctx), true);
    await ctx.closeServer();
    await assert.rejects(fetch(ctx.url));
    await ctx.closeServer();
  });
}

test('dense checker requires a request for the named article, beyond a claimed page snapshot', async t => {
  const ctx = await fixture(t, 'dense');
  await post(ctx, good.dense);
  assert.notEqual(server.checkWeb(ctx), true);
  await fetch(ctx.url + 'article/link-172');
  assert.notEqual(server.checkWeb(ctx), true);
  await fetch(ctx.url + 'article/link-173');
  assert.equal(server.checkWeb(ctx), true);
});

test('all twelve tasks close their server even when owned-window cleanup fails', async () => {
  const module = await import('../bench/tasks-web.mjs').catch(() => ({}));
  assert.ok(Array.isArray(module.webTasks), 'web task collection must exist');
  assert.equal(module.webTasks.length, 12);
  const source = readFileSync(new URL('../bench/tasks-web.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const tasks = runInNewContext(`${source}\nwebTasks`, {
    serveWebPage: server.serveWebPage, checkWeb: server.checkWeb,
    closeFixtures: async ctx => { await ctx.windowLeases[0].close(); },
  });
  for (const task of tasks) {
    const ctx = { nonce: 'abc123', windowLeases: [{ close: async () => { throw new Error('owned window unresolved'); } }] };
    await task.prepare(ctx);
    assert.match(task.prompt(ctx), /computer use/);
    assert.match(task.prompt(ctx), /Do not .*other/);
    assert.doesNotMatch(task.prompt(ctx), /mcp__|getApp/);
    await assert.rejects(task.cleanup(ctx), /owned window unresolved/);
    assert.equal(ctx.closeServer, undefined);
    await assert.rejects(fetch(ctx.url));
  }
});

// This small DOM adapter runs each page's actual event handlers without
// launching an app. It exercises emitted state; browser layout needs a live run.
class EditorNode {
  listeners = {}; style = {}; childNodes = [];
  constructor(tag, ...children) {
    this.nodeType = tag === '#text' ? 3 : 1;
    this.tagName = tag.toUpperCase();
    if (this.nodeType === 3) this.data = children[0];
    else this.append(...children);
  }
  append(...children) { this.childNodes.push(...children.map(child => typeof child === 'string' ? new EditorNode('#text', child) : child)); }
  replaceChildren(...children) { this.childNodes = []; this.append(...children); }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(child => child.textContent).join(''); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(tag) { return this.descendants().find(child => child.tagName.toLowerCase() === tag); }
  querySelectorAll(selector) {
    if (selector === 'p b,p strong') return this.descendants().filter(child => child.tagName === 'P')
      .flatMap(p => p.descendants().filter(child => ['B', 'STRONG'].includes(child.tagName)));
    return this.descendants().filter(child => child.tagName.toLowerCase() === selector);
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
const editorNode = (tag, ...children) => new EditorNode(tag, ...children);
function editorDocument() {
  const parts = {
    h1: editorNode('h1', 'Weekly planning'), h2: editorNode('h2', 'Release checklist'),
    p: editorNode('p', 'We ship carefully every Friday.'),
    list: editorNode('ul', editorNode('li', 'Review draft'), editorNode('li', 'Publish release')),
  };
  return Object.assign(editorNode('article', parts.h1, parts.h2, parts.p, parts.list), { parts });
}
async function pageScript(ctx, path = '') {
  const html = await (await fetch(ctx.url + path)).text(), nodes = new Map(), posts = [];
  let intersection;
  class Element {
    children = []; listeners = {}; hidden = false; open = false; value = ''; textContent = '';
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    focus() { this.focused = true; }
    querySelector(tag) { return this.children.find(node => node.tag === tag) ?? this.children.map(node => node.querySelector(tag)).find(Boolean); }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    set innerHTML(value) { for (const id of value.matchAll(/id="([^"]+)"/g)) nodes.set(id[1], new Element()); }
  }
  for (const id of html.split('<script>')[0].matchAll(/id="([^"]+)"/g)) nodes.set(id[1], new Element());
  const document = { getElementById: id => nodes.get(id), createElement: tag => Object.assign(new Element(), { tag }) };
  if (ctx.webKind === 'nested') {
    nodes.get('collection').hidden = true;
    nodes.get('coral').textContent = 'Coral report abc123';
    nodes.get('weather').textContent = 'Weather report';
  }
  if (ctx.webKind === 'dense' && path) nodes.get('article-title').textContent = 'Tidal observatory field notes';
  if (ctx.webKind === 'editor') {
    const editor = editorDocument(); nodes.set('editor', editor);
    document.execCommand = () => editor.parts.p.replaceChildren('We ', editorNode('b', 'ship carefully'), ' every Friday.');
  }
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, fetch: async (url, options) => { posts.push(JSON.parse(options.body)); return {}; },
    history: { pushState() {} }, location: { hash: '' }, addEventListener() {},
    MutationObserver: class { observe() {} },
    IntersectionObserver: class { constructor(callback) { intersection = callback; } observe() {} },
  });
  return { nodes, posts, load: () => intersection([{ isIntersecting: true }]), latest: () => posts.at(-1).state };
}

for (const kind of kinds) {
  test(`${kind} page controls emit the state the independent checker accepts`, async t => {
    const ctx = await fixture(t, kind), page = await pageScript(ctx, kind === 'dense' ? 'article/link-173' : '');
    const node = id => page.nodes.get(id), event = { preventDefault() {} };
    if (kind === 'grid') {
      node('find').value = 'Orchid'; node('find-row').onclick();
      const orchid = node('rows').children.find(row => row.children[0].textContent === 'Orchid').querySelector('input');
      assert.equal(orchid.focused, true);
      orchid.value = '125'; orchid.oninput(); node('sort').onclick();
    } else if (kind === 'editor') {
      node('bold').onmousedown(event); node('bold').onclick();
      node('editor').parts.list.append(editorNode('li', 'Archive notes abc123')); node('editor').listeners.input();
    } else if (kind === 'spa') {
      node('requests').onclick(); node('new').onclick(); node('category').value = 'Research'; node('category').onchange();
      assert.equal(node('code'), undefined, 'Code must appear only after Continue');
      node('project').value = 'Orchid'; node('project').oninput(); node('continue').onclick();
      node('code').value = 'abc123'; node('code').oninput(); node('form').onsubmit(event);
    } else if (kind === 'nested') {
      node('accordion').onclick();
      for (const id of ['science', 'marine', 'station', 'reports']) {
        node(id).open = true; node(id).listeners.toggle();
        if (id !== 'reports') assert.equal(node(id)['aria-expanded'], 'true', 'tree expansion must be exposed to accessibility');
      }
      node('coral').onclick();
    } else if (kind === 'infinite') {
      assert.equal(page.latest().loaded, 20);
      for (let i = 0; i < 4; i++) page.load();
      node('records').children[86].children[0].onclick();
      assert.equal(page.latest().modalOpen, true);
      node('note').value = 'Reviewed abc123'; node('note').oninput(); node('review').onsubmit(event);
    }
    assert.deepEqual(page.latest(), good[kind]);
    await post(ctx, page.latest());
    assert.equal(server.checkWeb(ctx), true);
  });
}

const editorMutations = {
  'extra paragraph': editor => editor.append(editorNode('p', 'Unexpected paragraph')),
  'extra heading': editor => editor.append(editorNode('h2', 'Unexpected heading')),
  'extra text outside a block': editor => editor.append('Unexpected text'),
  'bold outside the paragraph': editor => editor.parts.h1.replaceChildren(editorNode('b', 'Weekly planning')),
  'bold in a list item': editor => editor.parts.list.children[0].replaceChildren(editorNode('strong', 'Review draft')),
  'ordered list replacing bullets': editor => { editor.parts.list.tagName = 'OL'; },
  'paragraph moved after the list': editor => editor.replaceChildren(editor.parts.h1, editor.parts.h2, editor.parts.list, editor.parts.p),
  'changed paragraph whitespace': editor => editor.parts.p.childNodes[0].data = ' We ',
  'bold canceled inside the phrase': editor => {
    const span = editorNode('span', 'ship carefully'); span.style.fontWeight = 'normal';
    editor.parts.p.replaceChildren('We ', editorNode('b', span), ' every Friday.');
  },
};
for (const [name, mutate] of Object.entries(editorMutations)) {
  test(`editor actual script rejects ${name}`, async t => {
    const ctx = await fixture(t, 'editor'), page = await pageScript(ctx), editor = page.nodes.get('editor');
    page.nodes.get('bold').onclick(); editor.parts.list.append(editorNode('li', 'Archive notes abc123')); editor.listeners.input();
    await post(ctx, page.latest()); assert.equal(server.checkWeb(ctx), true);
    mutate(editor); editor.listeners.input(); await post(ctx, page.latest());
    assert.notEqual(server.checkWeb(ctx), true);
  });
}

for (const [name, phrase] of [
  ['strong tag', () => editorNode('strong', 'ship carefully')],
  ['bold span', () => Object.assign(editorNode('span', 'ship carefully'), { style: { fontWeight: '700' } })],
  ['split bold runs', () => editorNode('span', editorNode('b', 'ship '), editorNode('strong', 'carefully'))],
]) {
  test(`editor actual script accepts ordinary inline ${name}`, async t => {
    const ctx = await fixture(t, 'editor'), page = await pageScript(ctx), editor = page.nodes.get('editor');
    editor.parts.h1.replaceChildren(editorNode('span', 'Weekly planning'));
    editor.parts.p.replaceChildren(editorNode('span', 'We '), phrase(), editorNode('span', ' every Friday.'));
    editor.parts.list.append(editorNode('li', editorNode('span', 'Archive notes abc123'))); editor.listeners.input();
    await post(ctx, page.latest()); assert.equal(server.checkWeb(ctx), true);
  });
}

test('web server refuses unsafe nonce, unknown page kinds and a second server on one context', async t => {
  await assert.rejects(server.serveWebPage({ nonce: '<script>' }, 'grid'), /invalid/);
  await assert.rejects(server.serveWebPage({ nonce: 'abc123' }, 'other'), /invalid/);
  const ctx = await fixture(t, 'grid'), url = ctx.url;
  await assert.rejects(server.serveWebPage(ctx, 'editor'), /already exists/);
  assert.equal(ctx.url, url);
  assert.equal((await fetch(url)).status, 200);
});

test('all web tasks retain server cleanup when browser acquisition fails without mutation', async () => {
  const source = readFileSync(new URL('../bench/tasks-web.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const tasks = runInNewContext(`${source}\nwebTasks`, {
    serveWebPage: server.serveWebPage, checkWeb: server.checkWeb, acquireFixture, closeFixtures,
    openFixture: async (ctx, request) => {
      assert.equal(request.target, ctx.url);
      assert.equal(request.mode, 'window');
      assert.equal(request.token, ctx.nonce);
      throw Object.assign(new Error('browser refused before opening'), { noMutation: true });
    },
  });
  for (const task of tasks) {
    const ctx = { nonce: 'abc123' };
    try {
      await assert.rejects(task.setup(ctx), /browser refused/);
      assert.equal(ctx.pendingAcquisitions.size, 0);
      await task.cleanup(ctx);
      assert.equal(ctx.closeServer, undefined);
      await assert.rejects(fetch(ctx.url));
    } finally { await ctx.closeServer?.(); }
  }
});
