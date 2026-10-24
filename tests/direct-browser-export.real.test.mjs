import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { readDataExport, exportPageData, readExportCollection } from '../plugins/sleight/lib/direct-browser/export-data.mjs';
import { writeDataExport, exportSummary, EXPORT_LIMITS } from '../plugins/sleight/lib/direct-browser/export-file.mjs';
import { trustedLocatorRead } from '../plugins/sleight/lib/direct-browser/trusted-dom.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { exportTableFixture, gradeTableExport } from '../bench/export-table.mjs';

const pin = JSON.parse(fs.readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'set SLEIGHT_LIVE_DOM_TEST=1 for headless loopback fixtures'
  : !fs.existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;
const options = { skip, timeout: 30000 };
const ctx = text => ({ userMessage: () => ({ source: 'user', text }) });

async function fixture(t, html) {
  const sockets = new Set(), requests = [];
  const server = createServer((request, response) => { requests.push([request.method, request.url]); response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sleight-export-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { page, browser, root, requests };
}
async function refFor(page, role, name) {
  const value = await snapshot(page, { maxChars: 40000 });
  assert.equal(acknowledgeSnapshot(page, value.number), true);
  const line = value.text.split('\n').find(line => line.includes('- ' + role + ' "' + name + '"'));
  assert.ok(line, value.text.slice(0, 500));
  return /\[ref=([^\]]+)\]/.exec(line)[1];
}
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quote && text[i + 1] === '"') { field += '"'; i++; } else quote = !quote; }
    else if (c === ',' && !quote) { row.push(field); field = ''; }
    else if (c === '\r' && text[i + 1] === '\n' && !quote) { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += c;
  }
  assert.equal(quote, false); return rows;
}
test('200 rows beyond the snapshot cap export exactly as CSV and JSON, with only a receipt returned', options, async t => {
  const source = exportTableFixture(17), f = await fixture(t, source.html.replace('<table ', '<table aria-rowcount="201" ')), ref = await refFor(f.page, 'table', 'Prices');
  const capped = await snapshot(f.page, { maxChars: 40000 }); acknowledgeSnapshot(f.page, capped.number);
  assert.match(capped.text, /Cut:/); assert.doesNotMatch(capped.text, /item-17-200/);
  const data = await readDataExport(f.page, ref);
  assert.equal(data.complete, true, JSON.stringify(data.reasons)); assert.equal(data.rows.length, 200);
  assert.deepEqual(data.rows, source.rows); assert.deepEqual(data.columns, source.columns);
  const json = writeDataExport(data, { format: 'json' }, ctx('Export table'), { userHome: f.root });
  assert.deepEqual(gradeTableExport(fs.readFileSync(json.path, 'utf8'), source, exportSummary(json)), { pass: true, code: 'EXPORT_EXACT' });
  const csv = writeDataExport(data, {}, ctx('Export table'), { userHome: f.root });
  assert.deepEqual(parseCSV(fs.readFileSync(csv.path, 'utf8')), [source.columns, ...source.rows]);
  assert.doesNotMatch(exportSummary(json), /item-17|桃/);
  assert.deepEqual(await f.page.evaluate(() => window.effects), []);
  assert.deepEqual(f.requests, [['GET', '/']]);
});
test('HTML and ARIA lists preserve duplicates and page order, excluding hidden text and nested collections', options, async t => {
  const f = await fixture(t, '<ul aria-label="Items"><li>ok</li><li>ok</li><li>last<br>line<span hidden>hidden</span></li></ul>' +
    '<div role="list" aria-label="ARIA"><div role="listitem">first</div><div role="listitem">second<ul><li>nested</li></ul></div></div>');
  const list = await readDataExport(f.page, await refFor(f.page, 'list', 'Items'));
  assert.deepEqual(list.rows, [['ok'], ['ok'], ['last\nline']]); assert.equal(list.complete, false);
  assert.match(list.reasons.join(), /no declared total/);
  const aria = await readDataExport(f.page, await refFor(f.page, 'list', 'ARIA'));
  assert.deepEqual(aria.rows, [['first'], ['second']]); assert.equal(aria.complete, false); assert.match(aria.reasons.join(), /nested/);
});
test('declared virtual grid and list totals produce exact missing counts, and indices block false completeness', options, async t => {
  const grid = '<div role="grid" aria-label="Virtual" aria-rowcount="201"><div role="row"><span role="columnheader">Price</span></div>' +
    Array.from({ length: 12 }, (_, i) => `<div role="row" aria-rowindex="${i + 82}"><span role="gridcell">${i}</span></div>`).join('') + '</div>';
  const f = await fixture(t, grid + '<ul aria-label="Virtual list"><li aria-setsize="100" aria-posinset="50">middle</li><li aria-setsize="100" aria-posinset="52">gap</li></ul>');
  const table = await readDataExport(f.page, await refFor(f.page, 'grid', 'Virtual'));
  assert.equal(table.rows.length, 12); assert.equal(table.complete, false);
  assert.ok(table.reasons.includes('188 rows not rendered (virtualized or paginated collection)'));
  assert.match(table.reasons.join(), /index gaps/);
  const list = await readDataExport(f.page, await refFor(f.page, 'list', 'Virtual list'));
  assert.equal(list.complete, false); assert.ok(list.reasons.includes('98 rows not rendered (virtualized or paginated collection)'));
});
test('unknown scrolling totals, spanning cells, busy lists and missing rows stay incomplete', options, async t => {
  const f = await fixture(t, '<ul aria-label="Scroll" style="height:30px;overflow:auto">' + Array.from({ length: 15 }, () => '<li>row</li>').join('') +
    '</ul><table aria-label="Spans"><tr><td colspan="2">merged</td></tr></table><ul aria-label="Busy" aria-busy="true" aria-setsize="-1"><li>loading</li></ul>');
  for (const [role, name, reason] of [['list', 'Scroll', /no declared total/], ['table', 'Spans', /spanning/], ['list', 'Busy', /busy/]]) {
    const data = await readDataExport(f.page, await refFor(f.page, role, name));
    assert.equal(data.complete, false); assert.match(data.reasons.join(), reason);
  }
});
test('indexed rows without a total and unopened loaders remain partial without pressing a control', options, async t => {
  const f = await fixture(t, '<ul aria-label="Index"><li data-index="40">row 41</li><li data-index="41">row 42</li></ul>' +
    '<div role="log" aria-label="Loading"><div>one message</div><button onclick="effects.push(\'click\')">Load more</button><div role="progressbar"></div></div><script>window.effects=[]</script>');
  const indexed = await readDataExport(f.page, await refFor(f.page, 'list', 'Index'));
  assert.equal(indexed.complete, false); assert.match(indexed.reasons.join(), /no declared total/);
  const loading = await readDataExport(f.page, await refFor(f.page, 'log', 'Loading'));
  assert.equal(loading.complete, false); assert.match(loading.reasons.join(), /loading indicator/); assert.match(loading.reasons.join(), /unopened/);
  assert.deepEqual(loading.rows, [['one message']]);
  assert.deepEqual(await f.page.evaluate(() => window.effects), []);
});
test('exports mask protected form content and echoed secrets using the snapshot redaction policy', options, async t => {
  const f = await fixture(t, '<input type="password" value="long-password-123"><input aria-label="One time code" value="123456">' +
    '<table aria-label="Secrets"><tr><td>long-password-123</td><td>123456</td><td>4111 1111 1111 1111</td></tr>' +
    '<tr><td><textarea>private-editor</textarea></td><td contenteditable>editable-secret</td><td>safe</td></tr></table>');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Secrets'));
  const raw = JSON.stringify(data);
  assert.doesNotMatch(raw, /long-password-123|123456|4111|private-editor|editable-secret/);
  assert.deepEqual(data.rows, [['[redacted]', '[redacted]', '[redacted]'], ['[redacted]', '[redacted]', 'safe']]);
  assert.equal(data.complete, false); assert.ok(data.reasons.includes('protected content redacted'));
});
test('open shadow and slotted table text is read; closed roots and image content stay incomplete', options, async t => {
  const f = await fixture(t, '<table aria-label="Shadow"><tr><td><x-open>slotted text</x-open></td><td><span id="closed"></span></td><td><canvas></canvas></td></tr></table>' +
    '<script>document.querySelector("x-open").attachShadow({mode:"open"}).innerHTML="<span>open text: </span><slot></slot>";' +
    'document.querySelector("#closed").attachShadow({mode:"closed"}).innerHTML="<span>unreadable</span>";</script>');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Shadow'));
  assert.deepEqual(data.rows, [['open text: slotted text', '', '']]);
  assert.equal(data.complete, false); assert.match(data.reasons.join(), /closed shadow/); assert.match(data.reasons.join(), /non-text/);
});
test('bounded extraction labels text, column and row caps instead of claiming a full table', options, async t => {
  const f = await fixture(t, exportTableFixture(6).html);
  for (const [limits, reason] of [[{ rows: 3 }, /row budget/], [{ columns: 2 }, /column budget/], [{ characters: 40 }, /text budget/]]) {
    const data = await trustedLocatorRead(f.page.locator('table'), readExportCollection, { ...EXPORT_LIMITS, ...limits });
    assert.equal(data.complete, false); assert.match(data.reasons.join(), reason);
    assert.ok(data.rows.length <= (limits.rows ?? EXPORT_LIMITS.rows));
    assert.ok(data.rows.every(row => row.length <= (limits.columns ?? EXPORT_LIMITS.columns)));
    if (limits.rows) assert.equal(data.rows.length, limits.rows);
    if (limits.columns) assert.equal(data.rows.length, 200);
  }
});
test('an observed iframe table exports in its own utility world, with no main-frame DOM fallback', options, async t => {
  const f = await fixture(t, '<iframe srcdoc="&lt;table aria-label=Child&gt;&lt;tr&gt;&lt;td&gt;child cell&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;"></iframe>');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Child'));
  assert.deepEqual(data.rows, [['child cell']]); assert.equal(data.complete, false);
});
test('MAIN-world getters and page functions cannot run during a structured export', options, async t => {
  const f = await fixture(t, '<table aria-label="Hostile"><tr><td>honest text</td></tr></table><script>window.effects=[];' +
    'for(const key of ["innerText","textContent","children","childNodes","scrollHeight","clientHeight"])Object.defineProperty(HTMLElement.prototype,key,{get(){effects.push(key);throw Error("page getter")},configurable:true});' +
    'window.getComputedStyle=()=>{effects.push("style");throw Error("page style")};</script>');
  const ref = await refFor(f.page, 'table', 'Hostile');
  await f.page.evaluate(() => { window.effects.length = 0; });
  const data = await readDataExport(f.page, ref);
  assert.deepEqual(data.rows, [['honest text']]); assert.deepEqual(await f.page.evaluate(() => window.effects), []);
});
test('delivered refs are required, navigation retires refs, and export never refreshes or acts on a stale ref', options, async t => {
  const f = await fixture(t, exportTableFixture(2).html);
  const read = await snapshot(f.page); const ref = /table "Prices" \[ref=([^\]]+)\]/.exec(read.text)[1];
  await assert.rejects(readDataExport(f.page, ref), /not delivered/);
  acknowledgeSnapshot(f.page, read.number);
  await f.page.goto(f.page.url() + '?new-document');
  await assert.rejects(readDataExport(f.page, ref), /stale/);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
test('dispatcher end-to-end exports a user-named file and refuses pending dialogs without input', options, async t => {
  const f = await fixture(t, exportTableFixture(9).html.replace('<table ', '<table aria-rowcount="201" ')), ref = await refFor(f.page, 'table', 'Prices'), output = join(f.root, 'prices.json');
  const entry = { page: f.page, state: {} }, dispatcher = createToolDispatcher({
    pages: { enqueue: async (_tab, run) => run(entry) }, snapshot, runSteps: () => assert.fail('input'), fillFields: () => assert.fail('input'),
    ctx: ctx(`Export the Prices table to "${output}"`) });
  const request = { name: 'browser_read', arguments: { tab: 't1', export: ref, format: 'json', path: output } };
  const result = await dispatcher.call(request);
  assert.equal(result.isError, false, result.text); assert.match(result.text, /Rows: 200\.\nComplete: yes \(declared total matches rows read\)\./);
  assert.deepEqual(gradeTableExport(fs.readFileSync(output, 'utf8'), exportTableFixture(9), result.text), { pass: true, code: 'EXPORT_EXACT' });
  entry.state.dialog = {};
  await assert.rejects(exportPageData(entry, { export: ref }, ctx('Export table')), /dialog pending/);
  assert.deepEqual(await f.page.evaluate(() => window.effects), []);
});
test('the benchmark grader rejects missing, reordered, altered or falsely complete exports', () => {
  const source = exportTableFixture(5), actual = { columns: source.columns, rows: source.rows, rowCount: 200, complete: true, reasons: [] };
  assert.equal(gradeTableExport(JSON.stringify(actual), source, 'Rows: 200. Complete: yes.').pass, true);
  for (const changed of [{ ...actual, rows: source.rows.slice(1) }, { ...actual, rows: [...source.rows].reverse() }, { ...actual, complete: false },
    { ...actual, rowCount: 199 }, { ...actual, reasons: ['partial'] }]) assert.equal(gradeTableExport(JSON.stringify(changed), source, '200 complete: yes').pass, false);
});

test('pagination beside a collection and within its nearest scroller blocks completeness without input', options, async t => {
  const f = await fixture(t, '<section><ul aria-label="Sibling"><li>first</li></ul><button>Next</button></section>' +
    '<section><table aria-label="Nav"><tr><td>first</td></tr></table><div role="navigation" aria-label="Pages"><a href="#2">2</a></div></section>' +
    '<section><ul aria-label="Count"><li>first</li></ul><span>Page 1 of 3</span></section>' +
    '<section style="height:100px;overflow:auto"><div><ul aria-label="Ancestor"><li>first</li></ul></div><footer><a rel="next" href="#more">→</a></footer></section>' +
    '<script>window.effects=[];document.addEventListener("click",()=>effects.push("click"))</script>');
  for (const [role, name] of [['list', 'Sibling'], ['table', 'Nav'], ['list', 'Count'], ['list', 'Ancestor']]) {
    const data = await readDataExport(f.page, await refFor(f.page, role, name));
    assert.equal(data.complete, false, name); assert.match(data.reasons.join(), /pagination/);
  }
  assert.deepEqual(await f.page.evaluate(() => window.effects), []);
  assert.deepEqual(f.requests, [['GET', '/']]);
});
test('scroll extent gives reasons while collections without totals remain unknown', options, async t => {
  const f = await fixture(t, '<div style="height:30px;overflow:auto"><div><ul aria-label="Wrapped">' +
    Array.from({ length: 12 }, () => '<li>row</li>').join('') + '</ul></div></div>' +
    '<div style="height:20px;overflow:auto"><div style="height:100px"><div style="overflow:auto"><ul aria-label="Contained"><li>one</li></ul></div></div></div>');
  const wrapped = await readDataExport(f.page, await refFor(f.page, 'list', 'Wrapped'));
  assert.equal(wrapped.complete, false); assert.match(wrapped.reasons.join(), /scrolling/); assert.match(wrapped.reasons.join(), /no declared total/);
  const contained = await readDataExport(f.page, await refFor(f.page, 'list', 'Contained'));
  assert.equal(contained.complete, false); assert.match(contained.reasons.join(), /no declared total/);
});
test('zero geometry, off-canvas, opacity, clipping and zero font text are omitted with a reason', options, async t => {
  const styles = ['display:inline-block;width:0;height:0;overflow:hidden', 'position:absolute;left:-10000px',
    'opacity:0', 'position:absolute;clip:rect(0,0,0,0)', 'clip-path:inset(50%)', 'font-size:0'];
  const f = await fixture(t, '<ul aria-label="Visual"><li>visible' + styles.map((style, i) => `<span style="${style}">hidden-${i}</span>`).join('') +
    '</li></ul><ul aria-label="Below" style="margin-top:2000px"><li>below viewport</li></ul>');
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Visual'));
  assert.deepEqual(data.rows, [['visible']]); assert.equal(data.complete, false);
  assert.match(data.reasons.join(), /visually hidden text omitted/);
  const below = await readDataExport(f.page, await refFor(f.page, 'list', 'Below'));
  assert.deepEqual(below.rows, [['below viewport']], 'ordinary content below the viewport remains exportable');
});
test('CSS text masks redact content while product-card and secret-named row labels stay readable', options, async t => {
  const f = await fixture(t, '<ul aria-label="Products"><li id="product-card-3">plain product</li><li id="secret-notes">plain note</li>' +
    '<li><span style="-webkit-text-security:disc">masked-plaintext-987</span></li>' +
    '<li><span autocomplete="cc-number">protected-card-text</span></li><li><span role="textbox" aria-label="password">form-control-secret</span></li></ul>');
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Products'));
  assert.deepEqual(data.rows, [['plain product'], ['plain note'], ['[redacted]'], ['protected-card-text'], ['[redacted]']]);
  assert.equal(data.complete, false); assert.match(data.reasons.join(), /masked content redacted/);
  assert.doesNotMatch(JSON.stringify(data), /masked-plaintext|form-control-secret/);
});
test('ragged table rows retain their widths and return a completeness reason', options, async t => {
  const f = await fixture(t, '<table aria-label="Ragged"><tr><th>A</th><th>B</th></tr><tr><td>one</td></tr><tr><td>two</td><td>three</td></tr></table>');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Ragged'));
  assert.deepEqual(data.rows, [['one'], ['two', 'three']]); assert.equal(data.complete, false);
  assert.match(data.reasons.join(), /ragged/);
});
test('pagination also sits beside an overflow collection and can split its page count across tags', options, async t => {
  const f = await fixture(t, '<section><ul aria-label="Own scroller" style="overflow:auto"><li>one</li></ul><button>Next</button></section>' +
    '<section><ul aria-label="Split count"><li>one</li></ul><span>Page <b>1</b> of <b>4</b></span></section>');
  for (const name of ['Own scroller', 'Split count']) {
    const data = await readDataExport(f.page, await refFor(f.page, 'list', name));
    assert.equal(data.complete, false, name); assert.match(data.reasons.join(), /pagination/);
  }
});
test('ordinary rows above the current viewport stay in the export without moving the scroll position', options, async t => {
  const f = await fixture(t, '<ul aria-label="Scrolled">' + Array.from({ length: 100 }, (_, i) => `<li>row ${i}</li>`).join('') +
    '</ul><script>window.scrollTo(0,1000)</script>');
  const before = await f.page.evaluate(() => scrollY);
  assert.ok(before > 500);
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Scrolled'));
  assert.deepEqual(data.rows, Array.from({ length: 100 }, (_, i) => [`row ${i}`]));
  assert.equal(data.complete, false); assert.match(data.reasons.join(), /no declared total/);
  assert.equal(await f.page.evaluate(() => scrollY), before);
});
test('the dispatcher shares one export budget between tabs for the current turn', options, async t => {
  const f = await fixture(t, '<ul aria-label="Budget"><li>one</li></ul>'), ref = await refFor(f.page, 'list', 'Budget');
  const output = join(f.root, 'exports'); fs.mkdirSync(output);
  const entry = { page: f.page, state: {} }, dispatcher = createToolDispatcher({
    pages: { enqueue: async (_tab, run) => run(entry) }, snapshot, runSteps: () => assert.fail('input'), fillFields: () => assert.fail('input'),
    ctx: ctx(`Export table to "${output}"`) });
  for (let i = 0; i < EXPORT_LIMITS.turnFiles; i++) {
    const result = await dispatcher.call({ name: 'browser_read', arguments: { tab: i % 2 ? 't1' : 't2', export: ref, path: output } });
    assert.equal(result.isError, false, result.text);
  }
  const capped = await dispatcher.call({ name: 'browser_read', arguments: { tab: 't2', export: ref, path: output } });
  assert.equal(capped.isError, true); assert.match(capped.text, /turn.*count/);
  assert.equal(fs.readdirSync(output).length, EXPORT_LIMITS.turnFiles);
});

// G3C: each fixture asserts rows and the public receipt, without following or pressing a pager.
const oneRow = '<table aria-label="Data"><tr><td>only row</td></tr></table>';
for (const [name, pager] of [
  ['ul pager', '<ul><li><button>Next</button></li></ul>'],
  ['ol pager', '<ol><li><a href="#2">Next</a></li></ol>'],
  ['ARIA list pager', '<div role="list"><div role="listitem"><button>Next</button></div></div>'],
  ...['Next »', 'Next ›', 'Next →', 'Next >', 'Previous →', 'Older posts »', 'Newer posts ›', 'More →', 'Load more >']
    .map(label => [label, `<button>${label}</button>`]),
  ['next aria label', '<button aria-label="Go to next page">→</button>'],
  ['rel next', '<a rel="next" href="#2">→</a>'],
  ['number run', '<div><a href="#1">1</a> <a href="#2">2</a> <a href="#3">3</a> …</div>'],
  ['split number run', '<ul><li><a href="#1">1</a></li><li><a href="#2">2</a></li><li><a href="#3">3</a></li><li>…</li></ul>'],
  ['page count', '<span>Page <b>1</b> of <b>4</b></span>'],
]) test('G3C possible pagination: ' + name, options, async t => {
  const f = await fixture(t, `<section>${oneRow}${pager}</section><script>window.effects=[];document.addEventListener('click',()=>effects.push('click'))</script>`);
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.deepEqual(data.rows, [['only row']]); assert.equal(data.complete, false, JSON.stringify(data.reasons));
  const receipt = writeDataExport(data, { format: 'json' }, ctx('Export table'), { userHome: f.root });
  assert.match(exportSummary(receipt), /Complete: unknown \(rendered rows only\)/);
  assert.match(data.reasons.join(), /pagination/);
  assert.deepEqual(await f.page.evaluate(() => window.effects), []); assert.deepEqual(f.requests, [['GET', '/']]);
});
test('G3C body-level pager is inspected beyond the collection wrapper', options, async t => {
  const f = await fixture(t, `<main><section>${oneRow}</section></main><nav><button>Next</button></nav>`);
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.equal(data.complete, false); assert.match(data.reasons.join(), /pagination/);
});
test('G3C window scroll beyond the collection is possible infinite scroll', options, async t => {
  const f = await fixture(t, `<main>${oneRow}</main><div style="height:3000px"></div>`);
  const before = await f.page.evaluate(() => scrollY);
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.deepEqual(data.rows, [['only row']]); assert.equal(data.complete, false);
  assert.match(data.reasons.join(), /possible infinite scroll/);
  assert.equal(await f.page.evaluate(() => scrollY), before);
});
for (const [name, html, want] of [
  ['colgroup and col', '<table aria-label="Data"><colgroup><col></colgroup><tr><td>cell</td></tr></table>', [['cell']]],
  ['wbr and empty inline', '<ul aria-label="Data"><li>first<wbr><span></span><span> </span>last</li></ul>', [['first last']]],
  ['partial clip-path', '<ul aria-label="Data"><li><span style="display:inline-block;clip-path:circle(40%)">avatar label</span></li></ul>', [['avatar label']]],
  ['partial clip rect', '<ul aria-label="Data"><li><span style="position:absolute;width:100px;height:20px;clip:rect(0px,50px,20px,0px)">clipped label</span></li></ul>', [['clipped label']]],
]) test('G3C readable geometry: ' + name, options, async t => {
  const f = await fixture(t, html), role = html.includes('<table') ? 'table' : 'list';
  const data = await readDataExport(f.page, await refFor(f.page, role, 'Data'));
  assert.deepEqual(data.rows, want); assert.doesNotMatch(data.reasons.join(), /visually hidden|no readable/);
});
for (const [name, style] of [
  ['zero circle', 'clip-path:circle(0px)'], ['zero ellipse', 'clip-path:ellipse(0px 30px)'],
  ['zero polygon', 'clip-path:polygon(0 0, 50% 50%, 100% 100%)'],
]) test('G3C zero-area clipping omits text: ' + name, options, async t => {
  const f = await fixture(t, `<ul aria-label="Data"><li>safe<span style="display:inline-block;${style}">clipped secret</span></li></ul>`);
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Data'));
  assert.deepEqual(data.rows, [['safe']]); assert.match(data.reasons.join(), /visually hidden/);
});
test('G3C sensitive names on buttons and ordinary elements preserve labels while form values stay redacted', options, async t => {
  const f = await fixture(t, '<ul aria-label="Data"><li><button id="card" aria-label="Add card to cart">Add card to cart</button></li>' +
    '<li><span autocomplete="cc-number">ordinary label</span></li><li><output id="secret">ordinary output</output></li>' +
    '<li><input name="password" value="input-secret"></li><li><textarea name="secret">textarea-secret</textarea></li>' +
    '<li><select name="card"><option>select-secret</option></select></li><li><span contenteditable>editor-secret</span></li>' +
    '<li><span role="textbox" aria-label="password">textbox-secret</span></li></ul>');
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Data'));
  assert.deepEqual(data.rows, [['Add card to cart'], ['ordinary label'], ['ordinary output'], ...Array.from({ length: 5 }, () => ['[redacted]'])]);
  assert.doesNotMatch(JSON.stringify(data), /input-secret|textarea-secret|select-secret|editor-secret|textbox-secret/);
});
test('G3C default CSV page export has no BOM and explicit BOM adds only the UTF-8 signature', options, async t => {
  const f = await fixture(t, '<ul aria-label="Data"><li>桃</li><li>=1+1</li></ul>');
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Data'));
  const plain = writeDataExport(data, {}, ctx('Export table'), { userHome: f.root });
  const marked = writeDataExport(data, { bom: true }, ctx('Export table'), { userHome: f.root });
  assert.equal(fs.readFileSync(plain.path, 'utf8'), '"桃"\r\n"\'=1+1"\r\n');
  assert.equal(fs.readFileSync(marked.path, 'utf8'), '\uFEFF"桃"\r\n"\'=1+1"\r\n');
  assert.equal(marked.bytes, plain.bytes + 3); assert.equal(plain.bom, false); assert.equal(marked.bom, true);
});

test('G3C numeric collection rows are data, not evidence of pagination', options, async t => {
  const f = await fixture(t, '<ul aria-label="Numbers"><li>1</li><li>2</li><li>3</li></ul>');
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Numbers'));
  assert.deepEqual(data.rows, [['1'], ['2'], ['3']]); assert.equal(data.complete, false);
  assert.doesNotMatch(data.reasons.join(), /pagination/);
});

test('G3D matching declared total governs completeness while pagination remains a reason', options, async t => {
  const f = await fixture(t, '<main><table aria-label="Data" aria-rowcount="1"><tr><td>only row</td></tr></table><ul><li><button>Next →</button></li></ul></main>');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.deepEqual(data.rows, [['only row']]); assert.equal(data.complete, true);
  assert.match(data.reasons.join(), /pagination/);
});

// G3D: declared totals govern completeness; discovery signals only explain what was observed.
for (const [name, html, count, complete, reason] of [
  ['plain collection', oneRow, undefined, false, /no declared total/],
  ['overflow wrapper and pager', `<section><div style="overflow:auto">${oneRow}</div><button>Next</button></section>`, undefined, false, /pagination/],
  ['Bootstrap table-responsive', `<style>.table-responsive{overflow-x:auto}</style><section><div class="table-responsive">${oneRow}</div><ul><li><a href="#2">Next »</a></li></ul></section>`, undefined, false, /pagination/],
  ['two-page pager', `<section>${oneRow}<ul><li><a href="#1">1</a></li><li><a href="#2">2</a></li></ul></section>`, undefined, false, /pagination page numbers/],
  ['glyph pager', `<section>${oneRow}<div><button>‹</button><button>›</button></div></section>`, undefined, false, /pagination/],
  ['range declaration', `<section>${oneRow}<div>Showing 1 to 10 of 243 entries</div></section>`, 243, false, /242 rows not rendered/],
  ['matching results declaration', `<section>${oneRow}<p>1 results</p></section>`, undefined, false, /nearby count/],
  ['matching ARIA total', oneRow.replace('<table ', '<table aria-rowcount="1" '), 1, true, null],
  ['table footer count', oneRow.replace('</table>', '<tfoot><tr><td>Total: 1 rows</td></tr></tfoot></table>'), 1, true, null],
  ['page count is not a row count', `<section>${oneRow}<p>Page 1 of 2</p></section>`, undefined, false, /pagination page count/],
  ['unrelated header navigation', `<header><nav><a href="#next">Next.js docs</a></nav><span>1 results</span></header><main><section>${oneRow}</section></main>`, undefined, false, /no declared total/],
  ['More actions is not a pager', `<section>${oneRow}<button>More actions</button></section>`, undefined, false, /no declared total/],
]) test('G3D completeness: ' + name, options, async t => {
  const f = await fixture(t, html), data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.deepEqual(data.rows, [['only row']]);
  assert.equal(data.declaredTotal, count); assert.equal(data.complete, complete);
  if (reason) assert.match(data.reasons.join(), reason);
  if (/unrelated|More actions/.test(name)) assert.doesNotMatch(data.reasons.join(), /pagination|expansion/);
  const receipt = writeDataExport(data, { format: 'json' }, ctx('Export table'), { userHome: f.root });
  assert.match(exportSummary(receipt), complete ? /Complete: yes/ : count > 1 ? /Complete: no \(243 declared, 1 read\)/ : /Complete: unknown \(rendered rows only\)/);
  const saved = JSON.parse(fs.readFileSync(receipt.path, 'utf8'));
  assert.equal(saved.complete, complete); assert.equal(saved.declaredTotal, count);
  assert.deepEqual(f.requests, [['GET', '/']]);
});
test('G3D feed sentinel gives a reason without inventing a total', options, async t => {
  const f = await fixture(t, '<div role="feed" aria-label="Feed">' + Array.from({ length: 100 }, (_, i) => `<article role="article">item ${i}</article>`).join('') +
    '<div class="infinite-scroll-sentinel" style="height:0"></div></div>');
  const data = await readDataExport(f.page, await refFor(f.page, 'feed', 'Feed'));
  assert.equal(data.rows.length, 100); assert.equal(data.complete, false);
  assert.match(data.reasons.join(), /sentinel/); assert.match(data.reasons.join(), /no declared total/);
});
for (const role of ['combobox', 'searchbox', 'spinbutton']) test('G3D redacts sensitive ' + role, options, async t => {
  const f = await fixture(t, `<ul aria-label="Sensitive"><li><span role="${role}" aria-label="Card number">4111111111111111</span></li></ul>`);
  const raw = await trustedLocatorRead(f.page.locator('ul'), readExportCollection, EXPORT_LIMITS);
  assert.deepEqual(raw.rows, [['[redacted]']], 'the collection reader itself must redact, before snapshot scrubbing');
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Sensitive'));
  assert.deepEqual(data.rows, [['[redacted]']]); assert.doesNotMatch(JSON.stringify(data), /411111/);
});
test('G3D positioned text beyond the document scroll extent is omitted', options, async t => {
  const f = await fixture(t, '<ul aria-label="Off canvas" style="position:relative;overflow:hidden"><li>safe<span style="position:absolute;left:9999px">off-canvas-secret</span></li></ul>');
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Off canvas'));
  assert.deepEqual(data.rows, [['safe']]); assert.match(data.reasons.join(), /visually hidden/);
});
test('G3F positioned rows and ancestors below the fold remain exportable', options, async t => {
  const f = await fixture(t, '<ul aria-label="Positioned" style="min-height:20px"><li style="position:absolute;top:2000px">below fold</li></ul>' +
    '<section style="position:absolute;top:2100px"><ul aria-label="Ancestor"><li>below fold</li></ul></section>');
  const data = await readDataExport(f.page, await refFor(f.page, 'list', 'Positioned'));
  assert.deepEqual(data.rows, [['below fold']]); assert.equal(data.complete, false); assert.doesNotMatch(data.reasons.join(), /visually hidden/);
  const ancestor = await readDataExport(f.page, await refFor(f.page, 'list', 'Ancestor'));
  assert.deepEqual(ancestor.rows, [['below fold']]); assert.doesNotMatch(ancestor.reasons.join(), /visually hidden/);
});
test('G3D another collection cannot lend its count through its data rows', options, async t => {
  const f = await fixture(t, `<section>${oneRow}<ul aria-label="Other"><li><span>1 results</span></li></ul></section>`);
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.equal(data.declaredTotal, undefined); assert.equal(data.complete, false);
});
for (const [label, extra, declaredTotal, complete] of [
  ['Total: 1', '', undefined, false],
  ['Total rows: 1', '', undefined, false],
  ['1 results', ' hidden', undefined, false],
  ['2 results', '', 2, false],
]) test('G3D count declarations: ' + label + extra, options, async t => {
  const f = await fixture(t, `<section>${oneRow}<p${extra}>${label}</p></section>`);
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.equal(data.declaredTotal, declaredTotal); assert.equal(data.complete, complete);
});
test('G3D Showing 1 to 10 of 243 reports the declared and read counts', options, async t => {
  const f = await fixture(t, '<section><table aria-label="Range">' + Array.from({ length: 10 }, (_, i) => `<tr><td>row ${i + 1}</td></tr>`).join('') +
    '</table><div>Showing <b>1</b> to <b>10</b> of <b>243</b> entries</div></section>');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Range'));
  assert.equal(data.rows.length, 10); assert.equal(data.declaredTotal, 243); assert.equal(data.complete, false);
  const receipt = writeDataExport(data, {}, ctx('Export table'), { userHome: f.root });
  assert.match(exportSummary(receipt), /Complete: no \(243 declared, 10 read\)/);
});
test('G3D matching list item totals and conflicting declarations remain explicit', options, async t => {
  const f = await fixture(t, '<section><ul aria-label="Equal" aria-setsize="2"><li>first</li><li>second</li></ul></section>' +
    `<section>${oneRow.replace('<table ', '<table aria-rowcount="1" ')}<span aria-controls="data">2 results</span></section>`.replace('<table ', '<table id="data" '));
  const equal = await readDataExport(f.page, await refFor(f.page, 'list', 'Equal'));
  assert.equal(equal.complete, true); assert.equal(equal.declaredTotal, 2);
  const conflict = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.equal(conflict.complete, false); assert.match(conflict.reasons.join(), /conflicting totals/);
});
test('G3D a count explicitly controlling another collection cannot be borrowed', options, async t => {
  const f = await fixture(t, `<section>${oneRow.replace('<table ', '<table id="selected" ')}<p aria-controls="other">1 results</p></section>`);
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.equal(data.declaredTotal, undefined); assert.equal(data.complete, false);
});

// G3E: only collection-owned declarations can prove yes. Nearby counts can prove missing rows.
for (const [name, html, count, status, reason] of [
  ['matching sibling', `<section>${oneRow}<p>1 results</p></section>`, undefined, 'unknown', /nearby count/],
  ['smaller sibling', `<section>${oneRow}<p>0 results</p></section>`, undefined, 'unknown', /nearby count/],
  ['larger sibling', `<section>${oneRow}<p>243 results</p></section>`, 243, 'no', /242 rows not rendered/],
  ['cart badge', `<section>${oneRow}<aside><span>1 items</span></aside></section>`, undefined, 'unknown', /nearby count/],
  ['ancestor matching', `<main><section>${oneRow}</section><p>1 results</p></main>`, undefined, 'unknown', /nearby count/],
  ['ancestor larger', `<main><section>${oneRow}</section><p>243 results</p></main>`, 243, 'no', /242 rows not rendered/],
  ['ancestor text larger', `<section>243 results${oneRow}</section>`, 243, 'no', /242 rows not rendered/],
  ['caption', oneRow.replace('<tr>', '<caption>1 results</caption><tr>'), 1, 'yes', null],
  ['labelledby', oneRow.replace('<table ', '<table aria-labelledby="count" ') + '<p id="count">1 results</p>', 1, 'yes', null],
  ['describedby remote', oneRow.replace('<table ', '<table aria-describedby="count" ') + '<div>gap</div><div>gap</div><div>gap</div><p id="count">1 results</p>', 1, 'yes', null],
  ['controls', oneRow.replace('<table ', '<table id="data" ') + '<p aria-controls="data">1 results</p>', 1, 'yes', null],
  ['for id', oneRow.replace('<table ', '<table id="data" ') + '<label for="data">1 results</label>', 1, 'yes', null],
  ['another collection beside label', `<section>${oneRow}<p>243 results</p><table><tr><td>other</td></tr></table></section>`, undefined, 'unknown', /no declared total/],
  ['another collection in wrapper', `<section>${oneRow}<div><p>243 results</p><ul><li>other</li></ul></div></section>`, undefined, 'unknown', /no declared total/],
  ['explicit other for id', oneRow.replace('<table ', '<table id="data" ') + '<label for="other">243 results</label>', undefined, 'unknown', /no declared total/],
  ['nested other control label', oneRow + '<div aria-controls="other"><span>243 results</span></div>', undefined, 'unknown', /no declared total/],
  ['strong count and matching observation', oneRow.replace('<table ', '<table aria-rowcount="1" ') + '<p>1 results</p>', 1, 'yes', /nearby count/],
  ['strong count and smaller observation', oneRow.replace('<table ', '<table aria-rowcount="1" ') + '<p>0 results</p>', 1, 'yes', /nearby count/],
  ['strong count and larger observation', oneRow.replace('<table ', '<table aria-rowcount="1" ') + '<p>243 results</p>', 243, 'no', /242 rows not rendered/],
]) test('G3E count binding: ' + name, options, async t => {
  const f = await fixture(t, html);
  // Read the actual utility-world reader so accessible-name changes do not select a different collection.
  const data = await trustedLocatorRead(f.page.locator('table').first(), readExportCollection, EXPORT_LIMITS);
  assert.deepEqual(data.rows, [['only row']]); assert.equal(data.declaredTotal, count);
  assert.equal(data.complete, status === 'yes');
  if (reason) assert.match(data.reasons.join(), reason);
  const receipt = writeDataExport(data, { format: 'json' }, ctx('Export table'), { userHome: f.root });
  assert.match(exportSummary(receipt), new RegExp('Complete: ' + status));
  assert.equal(JSON.parse(fs.readFileSync(receipt.path)).complete, status === 'yes');
});

for (const label of ['1,2,3 results', '10,5 rows', 'Showing 1,2,3 to 10 of 243 entries', 'Showing 1 to 10,5 of 243 entries'])
  test('G3E rejects malformed count groups: ' + label, options, async t => {
    const f = await fixture(t, oneRow.replace('<tr>', `<caption>${label}</caption><tr>`) + `<p>${label}</p>`);
    const data = await trustedLocatorRead(f.page.locator('table'), readExportCollection, EXPORT_LIMITS);
    assert.equal(data.declaredTotal, undefined); assert.equal(data.complete, false);
  });
for (const [label, count] of [['1,243 results', 1243], ['Total rows: 1,000,000', 1000000], ['Showing 1 to 10 of 1,243 entries', 1243]])
  test('G3E accepts grouped count: ' + label, options, async t => {
    const f = await fixture(t, oneRow.replace('<tr>', `<caption>${label}</caption><tr>`));
    const data = await trustedLocatorRead(f.page.locator('table'), readExportCollection, EXPORT_LIMITS);
    assert.equal(data.declaredTotal, count); assert.equal(data.complete, false);
  });
for (const side of ['before', 'after']) test('G3E observes controls and totals two siblings ' + side, options, async t => {
  const extra = '<div><p>243 results</p><button>Next</button></div>', spacer = '<div>separator</div>';
  const f = await fixture(t, `<section>${side === 'before' ? extra + spacer + oneRow : oneRow + spacer + extra}</section>`);
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.equal(data.declaredTotal, 243); assert.equal(data.complete, false); assert.match(data.reasons.join(), /pagination/);
});
for (const [name, style] of [
  ['relative positive', 'position:relative;left:9999px'], ['relative negative', 'position:relative;left:-9999px'],
  ['transform positive', 'display:inline-block;transform:translateX(9999px)'],
  ['transform negative', 'display:inline-block;transform:translateX(-9999px)'],
  ['indent positive', 'display:inline-block;text-indent:9999px'], ['indent negative', 'display:inline-block;text-indent:-9999px'],
  ['transparent', 'color:transparent'], ['zero alpha', 'color:rgba(20,30,40,0)'],
]) test('G3E omits hidden text: ' + name, options, async t => {
  const f = await fixture(t, `<ul aria-label="Data" style="overflow:hidden"><li>safe<span style="${style}">hidden-value</span></li></ul>`);
  const data = await trustedLocatorRead(f.page.locator('ul'), readExportCollection, EXPORT_LIMITS);
  assert.deepEqual(data.rows, [['safe']]); assert.match(data.reasons.join(), /visually hidden/);
});
for (const role of ['textbox', 'combobox']) for (const [name, attr, label] of [
  ['placeholder password', 'placeholder="Password"', ''],
  ['data placeholder card', 'data-placeholder="Card number"', ''],
  ['describedby cvv', 'aria-describedby="hint"', '<p id="hint">CVV</p>'],
  ['describedby verification code', 'aria-describedby="hint"', '<p id="hint">Verification code</p>'],
  ['name security code', 'name="security_code"', ''],
]) test(`G3E redacts ${role} named by ${name}`, options, async t => {
  const f = await fixture(t, `<ul aria-label="Data"><li><span role="${role}" ${attr}>protected-value</span></li></ul>${label}`);
  const data = await trustedLocatorRead(f.page.locator('ul'), readExportCollection, EXPORT_LIMITS);
  assert.deepEqual(data.rows, [['[redacted]']]); assert.equal(data.redacted, true);
});
for (const [name, html, columns, rows, count, complete] of [
  ['thead td header', '<table aria-rowcount="2"><thead><tr><td>Name</td></tr></thead><tbody><tr><td>one</td></tr></tbody></table>', ['Name'], [['one']], 1, true],
  ['count on header row', '<table><tr aria-rowcount="2"><th>Name</th></tr><tr><td>one</td></tr></table>', ['Name'], [['one']], 1, true],
  ['hidden header', '<table aria-rowcount="2"><thead hidden><tr><th>Name</th></tr></thead><tr><td>one</td></tr></table>', [], [['one']], 1, false],
  ['hidden header row', '<table aria-rowcount="2"><tr hidden><th>Name</th></tr><tr><td>one</td></tr></table>', [], [['one']], 1, false],
  ['no header', '<table aria-rowcount="1"><tr><td>one</td></tr></table>', [], [['one']], 1, true],
]) test('G3E ARIA counts include header: ' + name, options, async t => {
  const f = await fixture(t, html), data = await trustedLocatorRead(f.page.locator('table'), readExportCollection, EXPORT_LIMITS);
  assert.deepEqual(data.columns, columns); assert.deepEqual(data.rows, rows);
  assert.equal(data.declaredTotal, count); assert.equal(data.complete, complete);
});

test('G3E ten rendered rows and an unrelated matching badge never prove the whole export', options, async t => {
  const f = await fixture(t, '<section><table aria-label="Data">' + Array.from({ length: 10 }, (_, i) => `<tr><td>row ${i}</td></tr>`).join('') +
    '</table><p>10 results</p></section>');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.equal(data.rows.length, 10); assert.equal(data.complete, false); assert.equal(data.declaredTotal, undefined);
  const receipt = writeDataExport(data, {}, ctx('Export table'), { userHome: f.root });
  assert.match(exportSummary(receipt), /Complete: unknown/);
});
test('G3E transparent containers preserve opaque children and ordinary indented text stays readable', options, async t => {
  const f = await fixture(t, '<ul><li><span style="color:transparent">hidden<span style="color:black">opaque</span></span></li>' +
    '<li><div style="text-indent:20px">indented</div></li></ul>');
  const data = await trustedLocatorRead(f.page.locator('ul'), readExportCollection, EXPORT_LIMITS);
  assert.deepEqual(data.rows, [['opaque'], ['indented']]);
});

for (const [name, style] of [
  ['relative', 'position:relative'], ['transform', 'transform:translateZ(0)'],
  ['absolute', 'position:absolute;left:0'],
]) for (const scrolled of [false, true]) test(`G3F all 60 ${name} rows export ${scrolled ? 'after scrolling' : 'below the fold'}`, options, async t => {
  const rows = Array.from({ length: 60 }, (_, i) => [`row ${i + 1}`]);
  const f = await fixture(t, `<!doctype html><style>table{position:relative;width:600px;height:${name === 'absolute' ? 3400 : 2400}px}tr{height:40px}</style>` +
    '<table aria-label="Data" aria-rowcount="60">' + rows.map(([value], i) =>
      `<tr style="${style};${name === 'absolute' ? `top:${1000 + i * 40}px` : ''}"><td>${value}</td></tr>`).join('') + '</table>');
  if (scrolled) await f.page.evaluate(() => window.scrollTo(0, 1200));
  const before = await f.page.evaluate(() => ({ x: scrollX, y: scrollY, height: innerHeight,
    first: document.querySelector('tr').getBoundingClientRect().top, last: document.querySelector('tr:last-child').getBoundingClientRect().top }));
  assert.ok(before.last > before.height, 'fixture has rows below the viewport');
  if (scrolled) { assert.ok(before.y > 0); assert.ok(before.first < 0, 'fixture also has rows above the viewport'); }
  else if (name === 'absolute') assert.ok(before.first > before.height, 'all absolute rows begin below the viewport');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.deepEqual(data.rows, rows); assert.equal(data.complete, true); assert.doesNotMatch(data.reasons.join(), /visually hidden/);
  for (const format of ['csv', 'json']) {
    const receipt = writeDataExport(data, { format }, ctx('Export table'), { userHome: f.root });
    const content = fs.readFileSync(receipt.path, 'utf8');
    assert.deepEqual(format === 'csv' ? parseCSV(content) : JSON.parse(content).rows, rows);
    assert.match(exportSummary(receipt), /Rows: 60\.\nComplete: yes/);
  }
  assert.deepEqual(await f.page.evaluate(() => ({ x: scrollX, y: scrollY })), { x: before.x, y: before.y });
  assert.deepEqual(f.requests, [['GET', '/']]);
});

for (const [name, style] of [
  ['relative', 'position:relative;left:2000px'], ['transform', 'transform:translateX(2000px)'],
  ['absolute', 'position:absolute;left:2000px'],
]) for (const scrolled of [false, true]) test(`G3F ${name} text inside the horizontal scroll extent exports ${scrolled ? 'after scrolling' : 'beyond the viewport'}`, options, async t => {
  const f = await fixture(t, `<!doctype html><style>body{width:4000px;min-height:100px}</style><table aria-label="Data" aria-rowcount="1" style="${style}">` +
    '<tr><td style="text-indent:20px">readable</td></tr></table>');
  if (scrolled) await f.page.evaluate(() => window.scrollTo(2500, 0));
  const before = await f.page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth,
    left: document.querySelector('table').getBoundingClientRect().left, right: document.querySelector('table').getBoundingClientRect().right }));
  assert.ok(scrolled ? before.x > 0 && before.right < 0 : before.left > before.width, 'fixture is outside the current viewport');
  const data = await readDataExport(f.page, await refFor(f.page, 'table', 'Data'));
  assert.deepEqual(data.rows, [['readable']]); assert.equal(data.complete, true); assert.doesNotMatch(data.reasons.join(), /visually hidden/);
  assert.deepEqual(await f.page.evaluate(() => ({ x: scrollX, y: scrollY })), { x: before.x, y: before.y });
});

for (const label of ['1-10 of 10', 'Showing 1-10 of 10', '1–10 of 10', 'Showing 1 to 10 of 10'])
  test('G3F accepts compact range: ' + label, options, async t => {
    const rows = Array.from({ length: 10 }, (_, i) => [`row ${i + 1}`]);
    const f = await fixture(t, `<table><caption>${label}</caption>` + rows.map(([value]) => `<tr><td>${value}</td></tr>`).join('') + '</table>');
    const data = await trustedLocatorRead(f.page.locator('table'), readExportCollection, EXPORT_LIMITS);
    assert.deepEqual(data.rows, rows); assert.equal(data.declaredTotal, 10); assert.equal(data.complete, true);
  });
for (const label of ['1,2,3-10 of 10', '1-10,5 of 10']) test('G3F rejects malformed compact range: ' + label, options, async t => {
  const f = await fixture(t, oneRow.replace('<tr>', `<caption>${label}</caption><tr>`));
  const data = await trustedLocatorRead(f.page.locator('table'), readExportCollection, EXPORT_LIMITS);
  assert.equal(data.declaredTotal, undefined); assert.equal(data.complete, false);
});

for (const role of ['textbox', 'combobox']) for (const [label, redacted] of [
  ['Postal code', false], ['ZIP code', false], ['Product code', false], ['Code', false],
  ['Security code', true], ['Verification code', true], ['One time code', true],
]) test(`G3F ${role} placeholder ${label} is ${redacted ? 'redacted' : 'readable'}`, options, async t => {
  const f = await fixture(t, `<ul><li><span role="${role}" placeholder="${label}">field-value</span></li></ul>`);
  const data = await trustedLocatorRead(f.page.locator('ul'), readExportCollection, EXPORT_LIMITS);
  assert.deepEqual(data.rows, [[redacted ? '[redacted]' : 'field-value']]); assert.equal(data.redacted, redacted);
});

for (const [name, style] of [
  ['absolute right', 'position:absolute;left:9999px'], ['absolute below', 'position:absolute;top:9999px'],
  ['relative right', 'position:relative;left:9999px'], ['transform below', 'transform:translateY(9999px);display:inline-block'],
  ['far negative left', 'position:relative;left:-11000px;width:20000px;display:inline-block'],
  ['far negative top', 'position:relative;top:-11000px;height:20000px;display:inline-block'],
]) test('G3F off-canvas text stays hidden: ' + name, options, async t => {
  const f = await fixture(t, `<div style="position:relative;overflow:hidden;height:100px"><ul><li>safe<span style="${style}">hidden-value</span></li></ul></div>`);
  const data = await trustedLocatorRead(f.page.locator('ul'), readExportCollection, EXPORT_LIMITS);
  assert.deepEqual(data.rows, [['safe']]); assert.match(data.reasons.join(), /visually hidden/);
});
