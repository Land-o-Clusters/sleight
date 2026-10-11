import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unxml = text => text.replace(/<\/(?:[\w]+:)?(?:p|row|tr)>/g, '\n').replace(/<[^>]+>/g, '')
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Stored ZIP entries need no dependency or external fixture writer.
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const file = Buffer.from(name), data = Buffer.from(value), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
    locals.push(local, file, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(file.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, file); offset += local.length + file.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const rels = body => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const namespaces = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function ooxml(format, text) {
  const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[format];
  const mime = { docx: 'wordprocessingml.document', xlsx: 'spreadsheetml.sheet', pptx: 'presentationml.presentation' }[format];
  const entries = { '_rels/.rels': rels(rel('rId1', 'officeDocument', main)) };
  const overrides = [[main, `application/vnd.openxmlformats-officedocument.${mime}.main+xml`]];
  if (format === 'docx') entries[main] = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${xml(text)}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
  if (format === 'xlsx') {
    entries[main] = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${namespaces}><sheets><sheet name="Fixture" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    entries['xl/_rels/workbook.xml.rels'] = rels(rel('rId1', 'worksheet', 'worksheets/sheet1.xml'));
    entries['xl/worksheets/sheet1.xml'] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${xml(text)}</t></is></c></row></sheetData></worksheet>`;
    overrides.push(['xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']);
  }
  if (format === 'pptx') {
    entries[main] = `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ${namespaces}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
    entries['ppt/_rels/presentation.xml.rels'] = rels(rel('rId1', 'slide', 'slides/slide1.xml'));
    entries['ppt/slides/slide1.xml'] = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ${namespaces}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Fixture"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>${xml(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    overrides.push(['ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']);
    const pns = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ${namespaces}`;
    const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
    entries[main] = entries[main].replace('<p:sldIdLst>', '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/></p:sldMasterIdLst><p:sldIdLst>');
    entries['ppt/_rels/presentation.xml.rels'] = rels(rel('rId1', 'slide', 'slides/slide1.xml') + rel('rId2', 'slideMaster', 'slideMasters/slideMaster1.xml'));
    entries['ppt/slides/_rels/slide1.xml.rels'] = rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'));
    entries['ppt/slideLayouts/slideLayout1.xml'] = `<p:sldLayout ${pns} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
    entries['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'));
    entries['ppt/slideMasters/slideMaster1.xml'] = `<p:sldMaster ${pns}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
    entries['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml') + rel('rId2', 'theme', '../theme/theme1.xml'));
    const colors = { dk1: '000000', lt1: 'FFFFFF', dk2: '1F497D', lt2: 'EEECE1', accent1: '4F81BD', accent2: 'C0504D', accent3: '9BBB59', accent4: '8064A2', accent5: '4BACC6', accent6: 'F79646', hlink: '0000FF', folHlink: '800080' };
    const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>', font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
    entries['ppt/theme/theme1.xml'] = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture"><a:themeElements><a:clrScheme name="Fixture">${Object.entries(colors).map(([key, value]) => `<a:${key}><a:srgbClr val="${value}"/></a:${key}>`).join('')}</a:clrScheme><a:fontScheme name="Fixture"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="Fixture"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map(width => `<a:ln w="${width}">${fill}<a:prstDash val="solid"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
    for (const [path, type] of [['ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout'], ['ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster'], ['ppt/theme/theme1.xml', 'theme']]) {
      overrides.push([path, `application/vnd.openxmlformats-officedocument.${type}+xml`]);
    }
  }
  entries['[Content_Types].xml'] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([path, type]) => `<Override PartName="/${path}" ContentType="${type}"/>`).join('')}</Types>`;
  return zip(entries);
}
function pdf(text) {
  const stream = `BT /F1 18 Tf 40 740 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, n) => { offsets.push(Buffer.byteLength(out)); out += `${n + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
export function writeDocument(path, format, marker, status = 'PENDING') {
  if (!/^[A-Za-z0-9-]+$/.test(marker) || !/^(PENDING|DONE)$/.test(status)) throw new Error('invalid fixture text');
  const text = `${marker} ${status}`;
  const body = ['docx', 'xlsx', 'pptx'].includes(format) ? ooxml(format, text) :
    format === 'pdf' ? pdf(text) : format === 'rtf' ? `{\\rtf1\\ansi ${text}}` :
      format === 'html' ? `<!doctype html><meta charset="utf-8"><p>${xml(text)}</p>` :
        ['txt', 'md'].includes(format) ? text + '\n' : undefined;
  if (body === undefined) throw new Error('unknown document format');
  writeFileSync(path, body, { mode: 0o600 });
}
export function readDocument(path, format) {
  if (['docx', 'xlsx', 'pptx'].includes(format)) {
    const patterns = { docx: ['word/document.xml'], xlsx: ['xl/worksheets/*.xml', 'xl/sharedStrings.xml'], pptx: ['ppt/slides/slide*.xml'] };
    const names = execFileSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 1 << 20 }).trim().split('\n');
    const allowed = name => patterns[format].some(p => new RegExp('^' + p.replaceAll('.', '\\.').replaceAll('*', '.*') + '$').test(name));
    return names.filter(allowed).map(name => unxml(execFileSync('/usr/bin/unzip', ['-p', path, name], { encoding: 'utf8', maxBuffer: 4 << 20 }))).join('\n');
  }
  const text = readFileSync(path, 'utf8');
  return format === 'html' ? unxml(text) : text;
}
export const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function checkDocument(ctx, answer = '') {
  const text = readDocument(ctx.path, ctx.format);
  if (!text.includes(ctx.marker)) return 'FILE_MARKER_MISSING';
  if (ctx.mode === 'edit') return /\bDONE\b/.test(text) && !/\bPENDING\b/.test(text) || 'FILE_EDIT_NOT_SAVED';
  let value; try { value = JSON.parse(answer).marker; } catch {}
  return value === ctx.marker && fileHash(ctx.path) === ctx.beforeHash || 'FILE_READ_NOT_CONFIRMED';
}
