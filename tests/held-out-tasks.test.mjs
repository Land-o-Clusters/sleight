import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const heldOut = await import('../bench/tasks-held-out.mjs').catch(() => ({}));
const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const temp = t => { const dir = trackTemp(mkdtempSync(join(tmpdir(), 'held-out-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const task = id => heldOut.heldOutTasks?.(async () => ({})).find(item => item.id === id);

// Saved outcomes built by hand; Python's standard ZIP library is independent of the production fixture writer.
function save(path, parts, archive = execFileSync) {
  rmSync(path, { force: true });
  const stage = trackTemp(mkdtempSync(join(dirname(path), 'package-')));
  for (const [name, data] of Object.entries(parts)) { mkdirSync(dirname(join(stage, name)), { recursive: true }); writeFileSync(join(stage, name), data); }
  archive('/usr/bin/python3', ['-I', '-B', '-c',
    'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as output:\n for name in sys.argv[2:]: output.write(name, arcname=name)\n',
    path, ...Object.keys(parts)], { cwd: stage, timeout: 10000, killSignal: 'SIGKILL' });
}
const rels = entries => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${r}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const table = rows => `<w:tbl>${rows.map(row => `<w:tr>${row.map(cell => `<w:tc>${p(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
const heading = level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr></w:style>`;
const docx = body => ({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
  '_rels/.rels': rels([['r1', 'officeDocument', 'word/document.xml']]),
  'word/document.xml': `<w:document xmlns:w="${w}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  'word/styles.xml': `<w:styles xmlns:w="${w}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading(1)}${heading(2)}</w:styles>`,
  'word/_rels/document.xml.rels': rels([['s', 'styles', 'styles.xml']]),
});

test('held out: three tasks, none a claim task, each preparing a nonce-scoped fixture that fails until edited', async t => {
  assert.deepEqual(heldOut.HELD_OUT_TASKS, ['word-memo', 'word-brief', 'textedit-notes-table']);
  const claim = readFileSync(new URL('../bench/claim-tasks.txt', import.meta.url), 'utf8').trim().split(',');
  for (const id of heldOut.HELD_OUT_TASKS) {
    assert.equal(claim.includes(id), false, id);
    const item = task(id), ctx = { dir: temp(t), nonce: 'abc123' };
    assert.equal(item.heldOut, true);
    await item.prepare(ctx);
    const path = ctx.officePath ?? ctx.document;
    assert.ok(path.startsWith(ctx.dir + '/') && path.includes('abc123'), path);
    assert.notEqual(await item.check({ ...ctx, answer: 'done' }), true, id);
    assert.throws(() => item.prepare(ctx), /exist/i, 'never overwrites');
    assert.match(item.prompt(ctx), /sign-in|leave it open/);
    assert.doesNotMatch(item.prompt(ctx), /Report abc123|amber with violet\. Keep all other existing text unchanged\. At the end of the document insert one 2-row, 2-column table\. Its first row is Item \| Count, and its second row is Crates \| 7\. Do not add any other text\. Work only/,
      'not the claim task\'s prompt');
  }
});

test('held out: word-memo checks two heading levels, the replacement and a 3x2 table at the end', async t => {
  const item = task('word-memo'), ctx = { dir: temp(t), nonce: 'abc123' };
  await item.prepare(ctx);
  const good = [p('Memo abc123', 'Heading1'), p('Summary', 'Heading2'), p('The silver order shipped on time.'), p('Keep this line abc123.'),
    table([['Name', 'Role'], ['Ada', 'Lead'], ['Lin', 'Review']])];
  save(ctx.officePath, docx(good.join('')));
  assert.equal(item.check(ctx), true);
  for (const [why, body] of [
    ['Summary not Heading 2', good.with(1, p('Summary', 'Heading1'))],
    ['title not a heading', good.with(0, p('Memo abc123'))],
    ['copper kept', good.with(2, p('The copper order shipped on time.'))],
    ['table before the text', [good[4], ...good.slice(0, 4)]],
    ['wrong cell', good.with(4, table([['Name', 'Role'], ['Ada', 'Lead'], ['Lin', 'Reviewer']]))],
    ['2 rows', good.with(4, table([['Name', 'Role'], ['Ada', 'Lead']]))],
    ['extra text', [...good, p('extra')]],
  ]) {
    save(ctx.officePath, docx(body.join('')));
    assert.notEqual(item.check(ctx), true, why);
  }
});

test('held out: handwritten Word fixtures remain checkable without a zip executable', async t => {
  const item = task('word-memo'), ctx = { dir: temp(t), nonce: 'abc123' };
  await item.prepare(ctx);
  const body = [p('Memo abc123', 'Heading1'), p('Summary', 'Heading2'), p('The silver order shipped on time.'), p('Keep this line abc123.'),
    table([['Name', 'Role'], ['Ada', 'Lead'], ['Lin', 'Review']])];
  save(ctx.officePath, docx(body.join('')), (command, args, options) => {
    if (command === 'zip' || command.endsWith('/zip')) throw Object.assign(Error('zip unavailable'), { code: 'ENOENT' });
    assert.ok(options.timeout > 0 && options.timeout <= 10000, 'the fixture archiver must be bounded');
    assert.equal(options.killSignal, 'SIGKILL');
    return execFileSync(command, args, options);
  });
  assert.equal(item.check(ctx), true);
  assert.equal(readFileSync(ctx.officePath).readUInt16LE(8), 8, 'independent fixture transport still exercises DEFLATE');
});

test('held out: word-brief checks Heading 2, both replacements and a 2x3 table', async t => {
  const item = task('word-brief'), ctx = { dir: temp(t), nonce: 'abc123' };
  await item.prepare(ctx);
  const good = [p('Brief abc123', 'Heading2'), p('Pack the green crate first.'), p('Load the green crate last.'), p('Keep this line abc123.'),
    table([['Day', 'Item', 'Qty'], ['Mon', 'Rope', '2']])];
  save(ctx.officePath, docx(good.join('')));
  assert.equal(item.check(ctx), true);
  for (const body of [good.with(2, p('Load the blue crate last.')), good.with(0, p('Brief abc123', 'Heading1')),
    good.with(4, table([['Day', 'Item'], ['Mon', 'Rope']]))]) {
    save(ctx.officePath, docx(body.join('')));
    assert.notEqual(item.check(ctx), true);
  }
});

// The shape TextEdit writes for a 2x2 table (Format > Text > Table...), reduced: \itap1 rows, \intbl cells, \lastrow.
const row = (cells, last = false) => '\\itap1\\trowd \\taflags1 \\trgaph108\\trleft-108 \\trbrdrt\\brdrnil \\trbrdrl\\brdrnil \\trbrdrr\\brdrnil \n' +
  '\\clvertalc \\clshdrawnil \\clwWidth4180\\clftsWidth3 \\clbrdrt\\brdrs\\brdrw20\\brdrcf2 \\clpadl100 \\clpadr100 \\gaph\\cellx4320\n' +
  '\\clvertalc \\clshdrawnil \\clwWidth4180\\clftsWidth3 \\clbrdrt\\brdrs\\brdrw20\\brdrcf2 \\clpadl100 \\clpadr100 \\gaph\\cellx8640\n' +
  cells.map((cell, i) => `\\pard\\intbl\\itap1\\pardeftab720\\partightenfactor0\n\\cf0 ${cell}\\cell ${i === cells.length - 1 ? (last ? '\\lastrow' : '') + '\\row' : ''}\n`).join('');
const saved = (lines, rows, after = '') => '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2822\n\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n' +
  '{\\colortbl;\\red255\\green255\\blue255;\\red0\\green0\\blue0;}\n{\\*\\expandedcolortbl;;\\cssrgb\\c0\\c0\\c0;}\n' +
  '\\paperw11900\\paperh16840\\margl1440\\margr1440\\vieww11520\\viewh8400\\viewkind0\n\\pard\\tx720\\pardeftab720\\partightenfactor0\n\n' +
  `\\f0\\fs24 \\cf0 ${lines.join('\\\n')}\\\n\\\n` + rows.map((cells, i) => row(cells, i === rows.length - 1)).join('\n') +
  `\\pard\\tx720\\pardeftab720\\partightenfactor0\n\\cf0 ${after}\\\n}`;

test('held out: the rich text reader returns paragraphs and table rows in order', () => {
  const blocks = heldOut.rtfBlocks(saved(['Notes abc123', 'The violet lamp is on.', 'Keep this line abc123.'], [['Item', 'Count'], ['Crates', '7']]));
  assert.deepEqual(blocks, [{ paragraph: 'Notes abc123' }, { paragraph: 'The violet lamp is on.' }, { paragraph: 'Keep this line abc123.' },
    { row: ['Item', 'Count'] }, { row: ['Crates', '7'] }]);
  assert.deepEqual(heldOut.rtfBlocks("{\\rtf1\\ansi caf\\'e9 \\u8364?\\uc0\\u8364 x\\\n}"), [{ paragraph: 'café €€x' }], 'the space after a control word is its delimiter');
  for (const bad of ['plain text', '{\\rtf1 {\\pict abc}}', '{\\rtf1 \\itap2 x}', '{\\rtf1 x', '{\\rtf1 a\\cell b}']) assert.throws(() => heldOut.rtfBlocks(bad), bad);
});

test('held out: textedit-notes-table checks the replacement and a 2x2 table after the text', async t => {
  const item = task('textedit-notes-table'), ctx = { dir: temp(t), nonce: 'abc123' };
  await item.prepare(ctx);
  assert.match(item.check(ctx), /TEXT_MISMATCH/, 'the prepared file still says amber');
  const lines = ['Notes abc123', 'The violet lamp is on.', 'Keep this line abc123.'];
  writeFileSync(ctx.document, saved(lines, [['Item', 'Count'], ['Crates', '7']]));
  assert.equal(item.check(ctx), true);
  for (const [content, reason] of [[saved(lines, [['Item', 'Count'], ['Boxes', '7']]), /TABLE_MISMATCH/],
    [saved(lines, [['Item', 'Count'], ['Crates', '7']], 'extra'), /TEXT_MISMATCH|NOT_AT_END/],
    [saved(lines.with(1, 'The amber lamp is on.'), [['Item', 'Count'], ['Crates', '7']]), /TEXT_MISMATCH/],
    ['{\\rtf1 broken', /UNREADABLE/]]) {
    writeFileSync(ctx.document, content);
    assert.match(String(item.check(ctx)), reason);
  }
});

test('held out: the world suite runs them only by name, as rows outside the claim plan', async () => {
  const { getTasks } = await import('../bench/tasks.mjs');
  const { selectSuiteTasks } = await import('../bench/shop.mjs');
  const { suite, resolveTask, planSuite } = await import('../bench/world/suite.mjs');
  const world = getTasks('world');
  for (const id of heldOut.HELD_OUT_TASKS) {
    const item = world.find(t => t.id === id);
    assert.ok(item?.fixtureLifecycle && item.heldOut, id);
    assert.ok(item.allowedApps.length > 0, id);
    assert.doesNotMatch(item.prompt({ dir: '/tmp/x', nonce: 'n', officePath: '/tmp/x/a.docx', document: '/tmp/x/a.rtf' }), /computer use/i);
  }
  assert.equal(selectSuiteTasks(world).some(t => t.heldOut), false, 'a pass without --tasks leaves them out');
  assert.deepEqual(selectSuiteTasks(world, ['word-memo']).map(t => t.id), ['word-memo']);
  const ccTasks = JSON.parse(readFileSync(new URL('../bench/world/tasks/cc-held-out.json', import.meta.url)));
  // BT2 added mail-to-sheet, and LR1 added its three long-thread tasks.
  assert.deepEqual(suite.heldOut.map(row => row.task), ['mail-to-sheet', ...heldOut.HELD_OUT_TASKS, ...ccTasks.map(row => row.task),
    'dm-first-message', 'mail-first-invoice', 'endless-feed-honesty']);
  for (const row of suite.heldOut) {
    assert.equal(row.claim, false);
    assert.equal((await resolveTask(row.id)).id, row.task);
    assert.match(row.runner, /^bench\/run\.mjs --suite world --tasks /);
    assert.equal(world.find(task => task.id === row.task)?.heldOut, true, row.task);
    assert.deepEqual(selectSuiteTasks(world, [row.task]).map(task => task.id), [row.task]);
  }
  assert.equal(planSuite().some(row => suite.heldOut.some(held => held.task === row.task)), false);
});

test('held out: a dry run prepares and checks each fixture without driving an app', async t => {
  const { executeRealTask } = await import('../bench/real-run.mjs');
  for (const id of heldOut.HELD_OUT_TASKS) {
    const ctx = { dir: temp(t), nonce: 'dry123' };
    const result = await executeRealTask(task(id), ctx, { dryRun: true, drive: () => { throw new Error('drove an app'); } });
    assert.equal(result.dryRun, true, id);
    assert.notEqual(result.check, 'true', id);
    assert.match(result.prompt, /dry123/);
  }
});
