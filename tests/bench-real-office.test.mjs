import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const office = await import('../bench/real-office.mjs').catch(() => ({}));
const tasks = await import('../bench/tasks-office.mjs').catch(() => ({}));
const ns = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const ctxFor = t => {
  const dir = mkdtempSync(join(tmpdir(), 'office-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, nonce: 'abc123', officePath: join(dir, 'fixture.zip') };
};
// These saved outcomes are hand-derived; ZIP is only a transport for the XML.
function save(ctx, parts) {
  rmSync(ctx.officePath, { force: true });
  const stage = mkdtempSync(join(ctx.dir, 'package-'));
  for (const [name, data] of Object.entries(parts)) {
    mkdirSync(dirname(join(stage, name)), { recursive: true });
    writeFileSync(join(stage, name), data);
  }
  execFileSync('/usr/bin/zip', ['-q', ctx.officePath, ...Object.keys(parts)], { cwd: stage });
}
const rels = entries => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${ns.r}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const base = (kind, main) => ({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
  '_rels/.rels': rels([['r1', 'officeDocument', main]]),
});
const wp = (text, props = '') => `<w:p>${props}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const word = () => ({
  ...base('word', 'word/document.xml'),
  'word/document.xml': `<w:document xmlns:w="${ns.w}"><w:body>${wp('Report abc123', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>')}${wp('The violet shipment is ready.')}${wp('Keep this line abc123.')}<w:tbl><w:tr><w:tc>${wp('Item')}</w:tc><w:tc>${wp('Count')}</w:tc></w:tr><w:tr><w:tc>${wp('Crates')}</w:tc><w:tc>${wp('7')}</w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`,
  'word/styles.xml': `<w:styles xmlns:w="${ns.w}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`,
  'word/_rels/document.xml.rels': rels([['style', 'styles', 'styles.xml']]),
});
const cell = (ref, val, type = '') => `<c r="${ref}"${type ? ` t="${type}"` : ''}>${type === 'inlineStr' ? `<is><t>${val}</t></is>` : `<v>${val}</v>`}</c>`;
const excel = () => ({
  ...base('excel', 'xl/workbook.xml'),
  'xl/workbook.xml': `<workbook xmlns="${ns.s}" xmlns:r="${ns.r}"><sheets><sheet name="Inventory" sheetId="1" r:id="r2"/><sheet name="Review abc123" sheetId="2" r:id="r1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': rels([['r2', 'worksheet', 'worksheets/other.xml'], ['r1', 'worksheet', '/xl/worksheets/review.xml'], ['strings', 'sharedStrings', 'sharedStrings.xml']]),
  'xl/sharedStrings.xml': `<sst xmlns="${ns.s}"><si><t>Item</t></si><si><r><t>Quan</t></r><r><t>tity</t></r></si><si><t>Apples</t></si><si><t>Bananas</t></si><si><t>Pears</t></si><si><t>Budget</t></si></sst>`,
  'xl/worksheets/other.xml': `<worksheet xmlns="${ns.s}"><sheetData><row r="1">${cell('A1', '0', 's')}${cell('B1', '1', 's')}${cell('D1', '5', 's')}</row><row r="2">${cell('A2', '2', 's')}${cell('B2', 8)}${cell('D2', 11)}</row><row r="3">${cell('A3', '3', 's')}${cell('B3', 5)}${cell('D3', 4)}</row><row r="4">${cell('A4', '4', 's')}${cell('B4', 3)}<c r="D4"><f>SUM(D2:D3)</f><v>15</v></c></row></sheetData></worksheet>`,
  'xl/worksheets/review.xml': `<worksheet xmlns="${ns.s}"><sheetData/></worksheet>`,
});
const slide = title => `<p:sld xmlns:p="${ns.p}" xmlns:a="${ns.a}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const powerpoint = () => ({
  ...base('powerpoint', 'ppt/presentation.xml'),
  'ppt/presentation.xml': `<p:presentation xmlns:p="${ns.p}" xmlns:r="${ns.r}"><p:sldIdLst><p:sldId id="257" r:id="r2"/><p:sldId id="256" r:id="r1"/><p:sldId id="258" r:id="r3"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': rels([['r1', 'slide', 'slides/start.xml'], ['r2', 'slide', 'slides/finish.xml'], ['r3', 'slide', 'slides/middle.xml']]),
  'ppt/slides/start.xml': slide('Start abc123'),
  'ppt/slides/finish.xml': slide('Finish abc123'),
  'ppt/slides/middle.xml': slide('Middle abc123'),
});

test('Word checker verifies saved heading, replacement and exact table without the answer', t => {
  assert.equal(typeof office.checkWord, 'function');
  const ctx = ctxFor(t), parts = word();
  save(ctx, parts);
  assert.equal(office.checkWord({ ...ctx, answer: 'wrong' }), true);
  for (const [from, to] of [['Heading1', 'Normal'], ['violet', 'amber'], ['Crates', 'Boxes'], ['Keep this line abc123.', 'changed'], ['<w:sectPr/>', `${wp('extra')}<w:sectPr/>`]]) {
    save(ctx, { ...parts, 'word/document.xml': parts['word/document.xml'].replace(from, to) });
    assert.notEqual(office.checkWord({ ...ctx, answer: 'done' }), true, from);
  }
});

test('Word checker resolves the referenced style and rejects a fake heading definition or extra table', t => {
  assert.equal(typeof office.checkWord, 'function');
  const ctx = ctxFor(t), parts = word();
  save(ctx, { ...parts, 'word/styles.xml': parts['word/styles.xml'].replace('heading 1', 'Normal') });
  assert.notEqual(office.checkWord(ctx), true);
  save(ctx, { ...parts, 'word/document.xml': parts['word/document.xml'].replace('<w:sectPr/>', '<w:tbl/><w:sectPr/>') });
  assert.notEqual(office.checkWord(ctx), true);
});

test('Excel checker resolves workbook relationships, shared rich strings, sorted rows and formula', t => {
  assert.equal(typeof office.checkExcel, 'function');
  const ctx = ctxFor(t), parts = excel();
  save(ctx, parts);
  assert.equal(office.checkExcel(ctx), true);
  for (const [from, to] of [['SUM(D2:D3)', 'SUM(D2:D2)'], ['<v>15</v>', '<v>11</v>'], ['<v>8</v>', '<v>3</v>'], ['r="A2" t="s"><v>2', 'r="A2" t="s"><v>4'], ['</sheetData>', '<row r="5"><c r="A5" t="inlineStr"><is><t>extra</t></is></c></row></sheetData>']]) {
    save(ctx, { ...parts, 'xl/worksheets/other.xml': parts['xl/worksheets/other.xml'].replace(from, to) });
    assert.notEqual(office.checkExcel(ctx), true, from);
  }
});

test('Excel checker rejects renamed, nonempty, hidden or unreferenced extra sheets', t => {
  assert.equal(typeof office.checkExcel, 'function');
  const ctx = ctxFor(t), parts = excel();
  for (const mutation of [
    { 'xl/workbook.xml': parts['xl/workbook.xml'].replace('Review abc123', 'Review stale') },
    { 'xl/workbook.xml': parts['xl/workbook.xml'].replace('name="Inventory"', 'name="Inventory" state="hidden"') },
    { 'xl/worksheets/review.xml': `<worksheet xmlns="${ns.s}"><sheetData><row>${cell('A1', 'extra', 'inlineStr')}</row></sheetData></worksheet>` },
    { 'xl/worksheets/extra.xml': `<worksheet xmlns="${ns.s}"><sheetData/></worksheet>` },
  ]) {
    save(ctx, { ...parts, ...mutation });
    assert.notEqual(office.checkExcel(ctx), true);
  }
});

test('PowerPoint checker follows relationship order and rejects wrong title, added content and duplicates', t => {
  assert.equal(typeof office.checkPowerPoint, 'function');
  const ctx = ctxFor(t), parts = powerpoint();
  save(ctx, parts);
  assert.equal(office.checkPowerPoint(ctx), true);
  for (const mutation of [
    { 'ppt/presentation.xml': parts['ppt/presentation.xml'].replace('r:id="r2"', 'r:id="r1"') },
    { 'ppt/slides/middle.xml': slide('Middle stale') },
    { 'ppt/slides/middle.xml': slide('Middle abc123').replace('</a:p>', '<a:r><a:t>extra</a:t></a:r></a:p>') },
    { 'ppt/slides/middle.xml': slide('Middle abc123').replace('type="title"', 'type="body"') },
    { 'ppt/slides/extra.xml': slide('Extra abc123') },
  ]) {
    save(ctx, { ...parts, ...mutation });
    assert.notEqual(office.checkPowerPoint(ctx), true);
  }
});

test('PowerPoint rejects non-text drawings and additional empty shapes on a Title Only slide', t => {
  const ctx = ctxFor(t), parts = powerpoint();
  const extras = [
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>',
    '<p:cxnSp><p:nvCxnSpPr/><p:spPr/></p:cxnSp>',
    '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/></p:grpSp>',
    '<p:contentPart/>',
  ];
  for (const extra of extras) {
    save(ctx, { ...parts, 'ppt/slides/middle.xml': parts['ppt/slides/middle.xml'].replace('</p:spTree>', extra + '</p:spTree>') });
    assert.notEqual(office.checkPowerPoint(ctx), true, extra);
  }
});

test('PowerPoint rejects a picture background or a picture fill on its title shape', t => {
  const ctx = ctxFor(t), parts = powerpoint();
  const fill = '<a:blipFill><a:blip r:embed="image"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>';
  const document = parts['ppt/slides/middle.xml'].replace(`xmlns:a="${ns.a}"`, `xmlns:a="${ns.a}" xmlns:r="${ns.r}"`);
  for (const changed of [
    document.replace('<p:spTree>', `<p:bg><p:bgPr>${fill}</p:bgPr></p:bg><p:spTree>`),
    document.replace('<p:spPr/>', `<p:spPr>${fill}</p:spPr>`),
  ]) {
    save(ctx, { ...parts, 'ppt/slides/middle.xml': changed,
      'ppt/slides/_rels/middle.xml.rels': rels([['image', 'image', '../media/picture.png']]),
      'ppt/media/picture.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'),
      '[Content_Types].xml': parts['[Content_Types].xml'].replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'),
    });
    assert.notEqual(office.checkPowerPoint(ctx), true);
  }
});

test('Office readers refuse external/traversing relationships, malformed XML and symlink file paths', t => {
  assert.equal(typeof office.checkExcel, 'function');
  const ctx = ctxFor(t), parts = excel();
  for (const mutation of [
    { 'xl/_rels/workbook.xml.rels': parts['xl/_rels/workbook.xml.rels'].replace('worksheets/other.xml', '../../outside.xml') },
    { 'xl/_rels/workbook.xml.rels': parts['xl/_rels/workbook.xml.rels'].replace('Target="worksheets/other.xml"', 'TargetMode="External" Target="https://example.test/other.xml"') },
    { 'xl/workbook.xml': parts['xl/workbook.xml'].replace('</sheets>', '</wrong>') },
    { 'xl/workbook.xml': '<!DOCTYPE workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + parts['xl/workbook.xml'] },
    { 'xl/sharedStrings.xml': parts['xl/sharedStrings.xml'].replace('<t>Item</t>', '<t>&unknown;</t>') },
  ]) {
    save(ctx, { ...parts, ...mutation });
    assert.notEqual(office.checkExcel(ctx), true);
  }
  save(ctx, parts);
  const link = join(ctx.dir, 'link.xlsx');
  symlinkSync(ctx.officePath, link);
  assert.notEqual(office.checkExcel({ ...ctx, officePath: link }), true);
  assert.notEqual(office.checkExcel({ ...ctx, officePath: '/etc/passwd' }), true);
});

test('Office prepares nonce-scoped documents that fail until edited and never overwrite', async t => {
  assert.ok(Array.isArray(tasks.officeTasks));
  for (const task of tasks.officeTasks) {
    const ctx = ctxFor(t);
    await task.prepare(ctx);
    const integrity = execFileSync('/usr/bin/unzip', ['-t', ctx.officePath], { encoding: 'utf8' });
    assert.match(integrity, /No errors detected/);
    const main = task.id === 'word-edit' ? 'word/document.xml' : task.id === 'excel-edit' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
    const document = execFileSync('/usr/bin/unzip', ['-p', ctx.officePath, main], { encoding: 'utf8' });
    assert.match(document, /document|workbook|presentation/);
    if (task.id === 'powerpoint-edit') {
      const theme = execFileSync('/usr/bin/unzip', ['-p', ctx.officePath, 'ppt/theme/theme1.xml'], { encoding: 'utf8' });
      assert.match(theme, /themeElements/);
      const props = execFileSync('/usr/bin/unzip', ['-p', ctx.officePath, 'ppt/presProps.xml'], { encoding: 'utf8' });
      assert.match(props, /presentationPr/);
    }
    assert.ok(ctx.officePath.startsWith(ctx.dir + '/'));
    assert.match(ctx.officePath, /abc123\.(docx|xlsx|pptx)$/);
    assert.notEqual(await task.check({ ...ctx, answer: 'finished' }), true);
    assert.match(task.prompt(ctx), /sign-in|activation/);
    assert.equal(task.stopOnAppDialog, true);
    await assert.rejects(async () => task.prepare(ctx), /exist|overwrite/i);
  }
});

test('OOXML namespace aliases, split runs and numeric entities preserve semantic text', t => {
  const ctx = ctxFor(t), parts = word();
  const document = parts['word/document.xml'].replace('abc123', 'abc&#49;23')
    .replace('The violet shipment is ready.', 'The violet</w:t></w:r><w:r><w:t> shipment is ready.')
    .replaceAll('w:', 'q:').replace('xmlns:w', 'xmlns:q');
  save(ctx, { ...parts, 'word/document.xml': document });
  assert.equal(office.checkWord(ctx), true);
});

test('Word rejects a correct table placed before the preserved text', t => {
  const ctx = ctxFor(t), parts = word(), document = parts['word/document.xml'];
  const table = document.match(/<w:tbl>[\s\S]*<\/w:tbl>/)[0];
  save(ctx, { ...parts, 'word/document.xml': document.replace(table, '').replace(wp('Keep this line abc123.'), table + wp('Keep this line abc123.')) });
  assert.notEqual(office.checkWord(ctx), true);
});

test('Excel rejects hidden columns and shared formula ranges that change additional cells', t => {
  const ctx = ctxFor(t), parts = excel();
  for (const document of [
    parts['xl/worksheets/other.xml'].replace('<sheetData>', '<cols><col min="1" max="2" hidden="1"/></cols><sheetData>'),
    parts['xl/worksheets/other.xml'].replace('<f>', '<f t="shared" ref="D2:D4" si="0">'),
  ]) {
    save(ctx, { ...parts, 'xl/worksheets/other.xml': document });
    assert.notEqual(office.checkExcel(ctx), true);
  }
});

test('ZIP reader rejects corrupt CRC, oversized entry, unsupported compression and path traversal without extraction', t => {
  const ctx = ctxFor(t), parts = excel();
  for (const mutate of [
    (archive, central) => archive.writeUInt32LE(0, central + 16),
    (archive, central) => archive.writeUInt32LE(3 * 1024 * 1024, central + 24),
    (archive, central) => archive.writeUInt16LE(99, central + 10),
    archive => {
      const name = Buffer.from('xl/workbook.xml');
      for (let at = archive.indexOf(name); at >= 0; at = archive.indexOf(name, at + name.length)) archive.write('../', at);
    },
  ]) {
    save(ctx, parts);
    const archive = readFileSync(ctx.officePath), central = archive.indexOf(Buffer.from('504b0102', 'hex'));
    mutate(archive, central); writeFileSync(ctx.officePath, archive);
    assert.notEqual(office.checkExcel(ctx), true);
  }
});

test('Word and PowerPoint reject extra saved story content outside their main edited bodies', t => {
  const ctx = ctxFor(t);
  save(ctx, { ...word(), 'word/header1.xml': `<w:hdr xmlns:w="${ns.w}">${wp('extra header')}</w:hdr>` });
  assert.notEqual(office.checkWord(ctx), true);
  save(ctx, { ...powerpoint(), 'ppt/notesSlides/notesSlide1.xml': `<p:notes xmlns:p="${ns.p}" xmlns:a="${ns.a}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>extra notes</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>` });
  assert.notEqual(office.checkPowerPoint(ctx), true);
});

for (const id of ['word-edit', 'excel-edit', 'powerpoint-edit']) {
  test(`${id} cleanup closes only retained leases and quits only the app it launched`, async t => {
    const task = tasks.officeTasks?.find(task => task.id === id);
    assert.ok(task);
    const ctx = ctxFor(t), seen = [];
    ctx.windowLeases = [
      { running: true, launched: false, close: async () => seen.push('existing-close'), quit: async () => seen.push('existing-quit') },
      { running: false, launched: true, close: async () => seen.push('owned-close'), dispose: async () => { seen.push('owned-dispose'); return true; }, quit: async () => seen.push('owned-quit') },
    ];
    await task.cleanup(ctx);
    assert.deepEqual(seen, ['owned-close', 'owned-dispose', 'owned-quit', 'existing-close']);
    ctx.windowLeases = [{ running: true, launched: false, close: async () => { throw new Error('retained window unavailable'); } }];
    await assert.rejects(task.cleanup(ctx), /retained window unavailable/);
    await task.cleanup({ ...ctx, windowLeases: [] });
  });
}
