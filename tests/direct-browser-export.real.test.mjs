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
  const source = exportTableFixture(17), f = await fixture(t, source.html), ref = await refFor(f.page, 'table', 'Prices');
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
  assert.deepEqual(list.rows, [['ok'], ['ok'], ['last\nline']]); assert.equal(list.complete, true);
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
  assert.deepEqual(data.rows, [['child cell']]); assert.equal(data.complete, true);
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
  const f = await fixture(t, exportTableFixture(9).html), ref = await refFor(f.page, 'table', 'Prices'), output = join(f.root, 'prices.json');
  const entry = { page: f.page, state: {} }, dispatcher = createToolDispatcher({
    pages: { enqueue: async (_tab, run) => run(entry) }, snapshot, runSteps: () => assert.fail('input'), fillFields: () => assert.fail('input'),
    ctx: ctx(`Export the Prices table to "${output}"`) });
  const request = { name: 'browser_read', arguments: { tab: 't1', export: ref, format: 'json', path: output } };
  const result = await dispatcher.call(request);
  assert.equal(result.isError, false, result.text); assert.match(result.text, /Rows: 200\.\nComplete: yes \(rendered collection\)\./);
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
test('scroll extent follows wrappers to the first overflow ancestor and does not use an unrelated outer scroller', options, async t => {
  const f = await fixture(t, '<div style="height:30px;overflow:auto"><div><ul aria-label="Wrapped">' +
    Array.from({ length: 12 }, () => '<li>row</li>').join('') + '</ul></div></div>' +
    '<div style="height:20px;overflow:auto"><div style="height:100px"><div style="overflow:auto"><ul aria-label="Contained"><li>one</li></ul></div></div></div>');
  const wrapped = await readDataExport(f.page, await refFor(f.page, 'list', 'Wrapped'));
  assert.equal(wrapped.complete, false); assert.match(wrapped.reasons.join(), /scrolling.*no declared total/);
  const contained = await readDataExport(f.page, await refFor(f.page, 'list', 'Contained'));
  assert.equal(contained.complete, true, JSON.stringify(contained.reasons));
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
  assert.deepEqual(data.rows, [['plain product'], ['plain note'], ['[redacted]'], ['[redacted]'], ['[redacted]']]);
  assert.equal(data.complete, false); assert.match(data.reasons.join(), /masked content redacted/);
  assert.doesNotMatch(JSON.stringify(data), /masked-plaintext|protected-card-text|form-control-secret/);
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
  assert.equal(data.complete, true, JSON.stringify(data.reasons));
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
