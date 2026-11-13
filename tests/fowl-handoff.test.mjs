import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
const temp = (prefix) => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const load = async (rel) => {
  const module = await import(new URL(rel, import.meta.url).href).catch((err) => {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    return undefined;
  });
  assert.ok(module, `${rel} is absent`);
  return module;
};

test('three hand-off tasks name a local page, a native step, a site log and a file check', async () => {
  const tasks = JSON.parse(readFileSync(join(root, 'bench/fowl/handoff.json'), 'utf8'));
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.name), ['invoice-preview', 'table-textedit', 'note-textedit']);
  for (const task of tasks) {
    assert.match(task.prompt, /\{browser\}/);
    assert.match(task.prompt, new RegExp(`http://127\\.0\\.0\\.1:5431/t/${task.name}/`));
    assert.ok(task.site?.log?.includes(`/t/${task.name}/api/log`));
    assert.ok(Array.isArray(task.site.expect) && task.site.expect.length > 0);
    assert.ok(task.native?.kind);
    assert.ok(task.budgetSeconds > 0);
  }
  assert.equal(tasks[0].native.kind, 'preview-pdf');
  assert.equal(tasks[0].native.file, 'invoice.pdf');
  assert.match(tasks[0].prompt, /\{out\}\/invoice\.pdf/);
  assert.match(tasks[0].prompt, /Preview/);
  assert.equal(tasks[1].native.kind, 'textedit-file');
  assert.equal(tasks[1].native.file, 'roster.txt');
  assert.match(tasks[1].prompt, /\{out\}\/roster\.txt/);
  assert.match(tasks[1].prompt, /TextEdit/);
  assert.equal(tasks[2].native.kind, 'note-file');
  assert.match(tasks[2].prompt, /TextEdit/);
  assert.match(tasks[0].prompt, /Preview.*invoice-total.txt/i);
});

test('the round wrapper preserves the selected Sleight prompt through its clean environment', () => {
  assert.match(readFileSync(join(root, 'bench/fowl/rounds.sh'), 'utf8'), /SLEIGHT_PROMPT="\$\{SLEIGHT_PROMPT:-\}"/);
});

test('invoice grader needs the saved PDF with the page total, not the answer text', async () => {
  const { gradeNative, INVOICE_TOTAL } = await load('../bench/fowl/grade.mjs');
  const dir = temp('sleight-handoff-inv-');
  const task = {
    name: 'invoice-preview',
    native: { kind: 'preview-pdf', file: 'invoice.pdf', total: INVOICE_TOTAL },
    site: { expect: ['^view /', '^download /invoice.pdf'] },
  };
  const site = { lines: ['view /', 'download /invoice.pdf'] };
  const answer = `RESULT: the total is $${INVOICE_TOTAL}`;
  let extracted = '';
  const extractPdf = () => extracted;
  const grade = (opts = {}) => gradeNative({ task, dir, site, answer, extractPdf, ...opts });
  assert.ok(grade().problems.length > 0, 'missing file fails');
  writeFileSync(join(dir, 'invoice.pdf'), '%PDF-1.4\n(Total: $0.00)\n');
  assert.match(grade().problems.join('\n'), /total/);
  writeFileSync(join(dir, 'invoice.pdf'), '%PDF-1.7\ncompressed without readable total');
  writeFileSync(join(dir, 'invoice-total.txt'), 'INV-4419 0.00\n');
  assert.ok(grade().problems.length > 0);
  writeFileSync(join(dir, 'invoice-total.txt'), `INV-4419 ${INVOICE_TOTAL}\n`);
  assert.ok(grade().problems.length > 0, 'a bogus PDF with the right marker fails');
  extracted = `Invoice INV-4419\nTotal: $${INVOICE_TOTAL}`;
  assert.deepEqual(grade().problems, []);
  extracted = `Invoice OTHER\nTotal: $${INVOICE_TOTAL}`;
  assert.ok(grade().problems.length > 0, 'the saved PDF must name this invoice');
  extracted = `Invoice INV-44190\nTotal: $${INVOICE_TOTAL}`;
  assert.ok(grade().problems.length > 0, 'an invoice id prefix fails');
  extracted = 'Invoice INV-4419\nTotal: $0.00';
  assert.ok(grade().problems.length > 0, 'the saved PDF must contain this total');
  assert.ok(grade({ extractPdf: () => { throw new Error('extract failed'); } }).problems.length > 0);
  extracted = `Invoice INV-4419\nTotal: $${INVOICE_TOTAL}`;
  assert.ok(grade({ site: { lines: ['view /'] } }).problems.length > 0, 'download log required');
  writeFileSync(join(dir, 'invoice.pdf'), 'not a PDF');
  assert.ok(grade().problems.length > 0, 'PDF signature required');
});

test('table grader needs the saved TextEdit file to contain every roster row', async () => {
  const { gradeNative, ROSTER } = await load('../bench/fowl/grade.mjs');
  const dir = temp('sleight-handoff-tab-');
  const task = { name: 'table-textedit', native: { kind: 'textedit-file', file: 'roster.txt' }, site: { expect: ['^view /'] } };
  const site = { lines: ['view /'] };
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0);
  writeFileSync(join(dir, 'roster.txt'), 'not the table\n');
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0);
  writeFileSync(join(dir, 'roster.txt'), ROSTER.map((r, i) => `${r.name}\t${ROSTER[(i + 1) % 3].hours}`).join('\n'));
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0, 'swapped hours fail');
  writeFileSync(join(dir, 'roster.txt'), ROSTER.map((r) => `${r.name}\n${r.hours}`).join('\n'));
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0, 'split lines fail');
  writeFileSync(join(dir, 'roster.txt'), ROSTER.map((r) => `${r.name}\t${r.role}\t${r.hours}`).join('\n'));
  assert.deepEqual(gradeNative({ task, dir, site }).problems, []);
  writeFileSync(join(dir, 'roster.txt'), ROSTER.map((r) => `${r.name}\t${r.hours}9`).join('\n'));
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0, 'numeric prefixes fail');
  writeFileSync(join(dir, 'roster.txt'), ROSTER.map((r) => `${r.name} ${r.hours}`).join(' '));
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0, 'one line cannot contain the whole roster');
  writeFileSync(join(dir, 'roster.txt'), ROSTER.map((r) => `${r.name} 99 ${r.hours}`).join('\n'));
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0, 'the first number after each name is its hours');
  writeFileSync(join(dir, 'roster.txt'), ROSTER.map((r) => `${r.name} 12.5 8.0 20.0`).join('\n'));
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0, 'one name cannot claim every hours value');
});

test('PDF extraction reads the file through PDFKit with a bounded command and rejects absent text', async () => {
  const { extractPdfText } = await load('../bench/fowl/grade.mjs');
  let called;
  const text = extractPdfText('/tmp/invoice.pdf', (...args) => { called = args; return 'INV-4419 1,247.50'; });
  assert.equal(text, 'INV-4419 1,247.50');
  assert.equal(called[0], '/usr/bin/osascript');
  assert.deepEqual(called[1].slice(0, 2), ['-l', 'JavaScript']);
  assert.match(called[1][3], /PDFDocument/);
  assert.equal(called[1].at(-1), '/tmp/invoice.pdf');
  assert.equal(called[2].timeout, 10000);
  assert.throws(() => extractPdfText('/tmp/invoice.pdf', () => ''));
});

test('note grader needs the saved text and site log', async () => {
  const { gradeNative, NOTE } = await load('../bench/fowl/grade.mjs');
  const dir = temp('sleight-handoff-note-');
  const task = { native: { kind: 'note-file', file: 'note.txt' }, site: { expect: ['^view /'] } };
  const site = { lines: ['view /'] };
  assert.ok(gradeNative({ task, dir, site }).problems.length);
  writeFileSync(join(dir, 'note.txt'), 'wrong text');
  assert.ok(gradeNative({ task, dir, site }).problems.length);
  writeFileSync(join(dir, 'note.txt'), NOTE.title + '\n' + NOTE.body + '\n');
  assert.deepEqual(gradeNative({ task, dir, site }).problems, []);
  assert.ok(gradeNative({ task, dir, site: { lines: [] } }).problems.length);
});

test('cleanup deletes the native files under the task dir and leaves other names', async () => {
  const { cleanupNative } = await load('../bench/fowl/grade.mjs');
  const dir = temp('sleight-handoff-cln-');
  writeFileSync(join(dir, 'invoice.pdf'), 'pdf');
  writeFileSync(join(dir, 'roster.txt'), 'table');
  writeFileSync(join(dir, 'invoice-total.txt'), 'total');
  writeFileSync(join(dir, 'note.txt'), 'note');
  writeFileSync(join(dir, 'keep.md'), 'stay');
  cleanupNative(dir);
  assert.equal(readFileSync(join(dir, 'keep.md'), 'utf8'), 'stay');
  assert.throws(() => readFileSync(join(dir, 'invoice.pdf')));
  assert.throws(() => readFileSync(join(dir, 'roster.txt')));
  assert.throws(() => readFileSync(join(dir, 'invoice-total.txt')));
  assert.throws(() => readFileSync(join(dir, 'note.txt')));
});

test('local site handler serves a uniquely named PDF and the account-free note', async () => {
  const { createHandler, NOTE, ROSTER } = await load('../bench/fowl/site/server.mjs');
  const handle = createHandler({ downloadName: 'invoice-run.pdf' });
  const get = async (url) => {
    const result = {};
    const res = { writeHead(code, headers) { Object.assign(result, { code, headers }); return this; },
      end(body) { result.body = body; } };
    await handle({ url, method: 'GET' }, res);
    return result;
  };
  const pdf = await get('/t/invoice-preview/invoice.pdf');
  assert.equal(pdf.code, 200);
  assert.match(pdf.headers['content-disposition'], /invoice-run.pdf/);
  assert.match(pdf.body, /^%PDF/);
  const table = await get('/t/table-textedit/');
  for (const row of ROSTER) assert.ok(table.body.includes(row.name));
  const note = await get('/t/note-textedit/');
  assert.equal(note.code, 200);
  assert.ok(note.body.includes(NOTE.body));
  assert.equal((await get('/t/mailto-draft/')).code, 404);
  const log = JSON.parse((await get('/t/invoice-preview/api/log')).body);
  assert.ok(log.lines.includes('download /invoice.pdf'));
  assert.throws(() => createHandler({ downloadName: '../invoice.pdf' }));
});

test('origin-hook accepts the hand-off apps and 127.0.0.1, and declines other apps', async () => {
  const { answer } = await load('../bench/fowl/origin-hook.mjs');
  const hook = (message) => ({ mcp_server_name: 'plugin:sleight:computer', message });
  assert.equal(answer(hook('Allow Browser use to access http://127.0.0.1:5431?')), 'accept');
  for (const app of ['Preview', 'TextEdit', 'Google Chrome', 'Helium', 'Safari']) {
    assert.equal(answer(hook(`Allow Computer Use to use "${app}"?`)), 'accept', app);
  }
  assert.equal(answer(hook('Allow Computer Use to use "Mail"?')), 'decline');
  assert.equal(answer(hook('Allow Browser use to access https://example.com?')), 'decline');
  assert.equal(answer(hook('Allow download from http://127.0.0.1:5431/t/invoice-preview/?')), 'accept');
  assert.equal(answer(hook('Allow download from http://127.0.0.1:9999/t/invoice-preview/?')), 'decline');
  assert.equal(answer(hook('Allow download from https://example.com/invoice.pdf?')), 'decline');
  assert.equal(answer(hook('Allow download from http://u:p@127.0.0.1:5431/x?')), 'decline');
  assert.equal(answer(hook('Allow Browser use to use full Chrome Developer Tools access on http://127.0.0.1:5413')), 'decline');
});

test('fowl+sleight setup loads FowlBrowser for tabs and computer-only sleight for apps', async () => {
  const { fowlSleightSetup } = await load('../bench/fowl/surface.mjs');
  const setup = fowlSleightSetup({
    dir: '/tmp/fb-rounds/x/invoice-preview', mcpRoot: '/fowl', sleightRepo: root, label: '🧪 invoice-preview',
  });
  assert.equal(setup.mcpServers.fowlbrowser.command, join('/fowl', 'mcp/bin/fowlbrowser-mcp'));
  assert.equal(setup.mcpServers.fowlbrowser.env.FOWLBROWSER_LABEL, '🧪 invoice-preview');
  assert.equal(setup.mcpServers['plugin:sleight:computer'].command, join(root, 'plugins/sleight/bin/sleight-mcp'));
  assert.equal(setup.mcpServers['plugin:sleight:computer'].env.SLEIGHT_SURFACES, 'computer');
  assert.match(setup.allowed, /mcp__fowlbrowser/);
  assert.match(setup.allowed, /mcp__plugin_sleight_computer__js/);
  assert.ok(setup.allowed.split(',').includes('mcp__plugin_sleight_computer__app_handoff'));
  assert.ok(!setup.allowed.split(',').includes('mcp__plugin_sleight_computer'));
  assert.match(setup.promptPrefix, /FowlBrowser/);
  assert.match(setup.promptPrefix, /plugin_sleight_computer__js/);
  assert.equal(setup.pluginDir, join(root, 'plugins/sleight'));
});

test('the surface patch applies on the pinned FowlBrowser commit and adds fowl+sleight', async (t) => {
  const cache = join(process.env.HOME, 'Library/Caches/sleight-bench/fowlbrowser');
  if (!existsSync(join(cache, '.git'))) return t.skip('pinned FowlBrowser cache is absent');
  const dir = temp('sleight-handoff-patch-');
  t.after(async () => (await import('node:fs')).rmSync(dir, { recursive: true, force: true }));
  const orig = spawnSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(orig.status, 0, orig.stderr);
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'tools/rounds.mjs'), orig.stdout);
  for (const args of [['init', '-q'], ['add', 'tools/rounds.mjs']]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const apply = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr + apply.stdout);
  const diff = spawnSync('/usr/bin/git', ['diff'], { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(diff.stdout, readFileSync(join(root, 'bench/fowl/sleight-surface.patch'), 'utf8'));
  const patched = readFileSync(join(dir, 'tools/rounds.mjs'), 'utf8');
  assert.match(patched, /fowl\+sleight/);
  assert.match(patched, /browser-use/);
  assert.match(patched, /replaceAll\('\{out\}'/);
  assert.match(patched, /gradeNative/);
  assert.match(patched, /bench\/fowl\/surface\.mjs/);
  assert.doesNotMatch(patched, /async function agentSetup/);
  assert.match(patched, /gradeFixture/);
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { agentSetup } from './tools/rounds.mjs'; for (const surface of ['fowlbrowser', 'sleight', 'fowl+sleight']) { const s = agentSetup({ task: { name: 'test', browser: 'chrome', prompt: 'save {out}', result: 'done' }, surface, dir: '/tmp/test', mcpRoot: '/fowl', settings: '/tmp/settings', model: 'opus', effort: 'medium' }); if (s instanceof Promise || !s.mcpConfig || !s.prompt.includes('/tmp/test')) throw Error(surface); } const bu = agentSetup({ task: { name: 'test', browser: 'chrome', prompt: 'save {out} in {browser} at {repo}', result: 'done', budgetSeconds: 90 }, surface: 'browser-use', dir: '/tmp/test', mcpRoot: '/fowl', settings: '/tmp/settings', model: 'haiku', effort: 'high' }); if (bu.command !== 'uv' || bu.mcpConfig || !bu.args.includes('--budget-seconds') || !bu.args.includes('--frozen') || !bu.prompt.includes('/tmp/test') || !bu.prompt.includes('Chrome')) throw Error('browser-use');"],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, SLEIGHT_REPO: root } });
  assert.equal(probe.status, 0, probe.stderr);
  const { fixtureGradeDescriptor } = await import('../bench/world/fowl-fixture-grade.mjs');
  const { closeSync } = await import('node:fs');
  const gradeFd = fixtureGradeDescriptor({ kind: 'local-mdn', expected: { code: 729 } });
  let fixtureProbe;
  try { fixtureProbe = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { gradeOutcome } from './tools/rounds.mjs'; const task = { worldFixture: 'local-mdn', grade: 'fixture' }; const site = { kind: 'local-mdn', views: [''] }; const run = { exitCode: 0, result: { result: 'RESULT: {\"code\":729}' } }; const grade = () => gradeOutcome({ task, run, grade: site }); if (!grade().ok) throw Error('correct fixture failed'); site.views = []; if (grade().ok) throw Error('unread fixture passed'); site.views = ['']; run.result.result = 'RESULT: {\"code\":730}'; if (grade().ok) throw Error('wrong fixture passed');"],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, SLEIGHT_REPO: root }, stdio: ['ignore', 'pipe', 'pipe', gradeFd] });
  } finally { closeSync(gradeFd); }
  assert.equal(fixtureProbe.status, 0, fixtureProbe.stderr);
});
