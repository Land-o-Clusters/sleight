import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  types: 'http://schemas.openxmlformats.org/package/2006/content-types',
};
const need = (condition, message) => { if (!condition) throw new Error(message); };
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const attr = (node, name, uri = '') => node.attrs[`${uri}|${name}`];
const is = (node, uri, name) => node.uri === uri && node.name === name;
const children = (node, uri, name) => node.children.filter(n => is(n, uri, name));
const all = (node, uri, name) => node.children.flatMap(n => [...(is(n, uri, name) ? [n] : []), ...all(n, uri, name)]);
const text = node => node.content.map(item => typeof item === 'string' ? item : text(item)).join('');
const one = (node, uri, name) => {
  const found = children(node, uri, name);
  need(found.length === 1, `expected one ${name}`);
  return found[0];
};
const texts = (node, uri) => all(node, uri, 't').map(text).join('');
const same = (actual, expected, message) => need(JSON.stringify(actual) === JSON.stringify(expected), message);

function decode(value) {
  need(!/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value), 'unsupported XML entity');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) => {
    if (!entity.startsWith('#')) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    need(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)), 'invalid XML character');
    return String.fromCodePoint(code);
  });
}

// A bounded namespace-aware reader for the transitional OOXML we create. No
// DTDs, external entities, XInclude, extraction or subprocess execution.
function xml(source) {
  need(!source.includes('\ufffd') && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source), 'invalid XML encoding');
  source = source.replace(/^\ufeff/, '');
  const root = { children: [], content: [], namespaces: { xml: 'http://www.w3.org/XML/1998/namespace' } };
  const stack = [root];
  let cursor = 0, count = 0;
  const qname = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
  const expanded = (name, namespaces, attribute = false) => {
    need(qname.test(name), 'invalid XML name');
    const fields = name.split(':'), prefix = fields.length === 2 ? fields[0] : '';
    need(!prefix || namespaces[prefix], 'unknown XML namespace');
    return [attribute && !prefix ? '' : namespaces[prefix] ?? '', fields.at(-1)];
  };
  while (cursor < source.length) {
    const parent = stack.at(-1);
    if (source[cursor] !== '<') {
      const end = source.indexOf('<', cursor), next = end < 0 ? source.length : end;
      const value = decode(source.slice(cursor, next));
      need(stack.length > 1 || !value.trim(), 'text outside XML root');
      parent.content.push(value); cursor = next; continue;
    }
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      need(end >= 0 && !source.slice(cursor + 4, end).includes('--'), 'invalid XML comment');
      cursor = end + 3; continue;
    }
    if (source.startsWith('<?xml ', cursor)) {
      need(stack.length === 1 && root.children.length === 0 && !source.slice(0, cursor).trim(), 'misplaced XML declaration');
      const end = source.indexOf('?>', cursor);
      need(end >= 0, 'unterminated XML declaration'); cursor = end + 2; continue;
    }
    need(!source.startsWith('<!', cursor) && !source.startsWith('<?', cursor), 'unsupported XML declaration');
    const end = source.indexOf('>', cursor);
    need(end >= 0, 'unterminated XML element');
    let tag = source.slice(cursor + 1, end); cursor = end + 1;
    if (tag.startsWith('/')) {
      need(stack.length > 1 && tag.slice(1).trim() === parent.qname, 'mismatched XML element');
      stack.pop(); continue;
    }
    const empty = tag.endsWith('/');
    if (empty) tag = tag.slice(0, -1);
    const match = /^([^\s]+)([\s\S]*)$/.exec(tag);
    need(match, 'invalid XML element');
    const rawAttrs = {}, namespaces = { ...parent.namespaces };
    let rest = match[2];
    while (rest.trim()) {
      const entry = /^\s+([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/.exec(rest);
      need(entry && !(entry[1] in rawAttrs) && !entry[2].includes('<'), 'invalid or duplicate XML attribute');
      rawAttrs[entry[1]] = decode(entry[2].slice(1, -1)); rest = rest.slice(entry[0].length);
    }
    for (const [key, value] of Object.entries(rawAttrs)) {
      if (key === 'xmlns') namespaces[''] = value;
      else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    }
    const [uri, name] = expanded(match[1], namespaces);
    const node = { qname: match[1], uri, name, namespaces, attrs: {}, children: [], content: [] };
    for (const [key, value] of Object.entries(rawAttrs)) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const [attrURI, local] = expanded(key, namespaces, true), identifier = `${attrURI}|${local}`;
      need(!(identifier in node.attrs), 'duplicate expanded XML attribute'); node.attrs[identifier] = value;
    }
    need(++count <= 100000 && stack.length <= 100, 'XML complexity exceeds limit');
    parent.children.push(node); parent.content.push(node);
    if (!empty) stack.push(node);
  }
  need(stack.length === 1 && root.children.length === 1, 'incomplete XML document');
  return root.children[0];
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function safePart(name) {
  need(name.length <= 240 && /^[A-Za-z0-9_./\[\]-]+$/.test(name) && !name.startsWith('/') &&
    !name.split('/').some(part => part === '..' || part === '.' || part === ''), 'unsafe package part path');
  return name;
}

function readPackage(ctx, main) {
  need(typeof ctx.officePath === 'string' && dirname(resolve(ctx.officePath)) === resolve(ctx.dir), 'Office file outside fixture directory');
  const stat = lstatSync(ctx.officePath);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024, 'unsafe or oversized Office file');
  const fd = openSync(ctx.officePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let archive;
  try {
    const opened = fstatSync(fd);
    need(opened.ino === stat.ino && opened.dev === stat.dev && opened.size === stat.size, 'Office file identity changed');
    archive = readFileSync(fd);
  } finally { closeSync(fd); }
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) { end = offset; break; }
  }
  need(end >= 0 && archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0, 'unsupported ZIP structure');
  const count = archive.readUInt16LE(end + 10), start = archive.readUInt32LE(end + 16);
  need(count > 0 && count <= 256 && count === archive.readUInt16LE(end + 8) && start + archive.readUInt32LE(end + 12) === end, 'ZIP directory exceeds limit');
  const parts = new Map(), ranges = [];
  let offset = start, total = 0;
  for (let index = 0; index < count; index++) {
    need(offset + 46 <= end && archive.readUInt32LE(offset) === 0x02014b50, 'invalid ZIP directory');
    const flags = archive.readUInt16LE(offset + 8), method = archive.readUInt16LE(offset + 10);
    const packed = archive.readUInt32LE(offset + 20), size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28), extra = archive.readUInt16LE(offset + 30), comment = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42), mode = archive.readUInt32LE(offset + 38) >>> 16;
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const entry = `ZIP entry ${JSON.stringify(name.slice(0, 240))}${name.length > 240 ? ' (name truncated)' : ''}: flags=0x${flags.toString(16).padStart(4, '0')} method=${method} compressed=${packed} uncompressed=${size}`;
    try {
      need(offset + 46 + nameLength + extra + comment <= end, 'truncated ZIP directory');
      offset += 46 + nameLength + extra + comment;
      const directory = name.endsWith('/');
      safePart(directory ? name.slice(0, -1) : name);
      need(!parts.has(name) && !(mode && (mode & 0xf000) === 0xa000), 'duplicate or symlink package part');
      const allowedFlags = 0x0808 | (method === 8 ? 0x0006 : 0);
      need((flags & ~allowedFlags) === 0 && [0, 8].includes(method) && size <= 2 * 1024 * 1024 && (total += size) <= 8 * 1024 * 1024, 'unsupported or oversized ZIP entry');
      need(local + 30 <= start && archive.readUInt32LE(local) === 0x04034b50, 'invalid ZIP local entry');
      const localNameLength = archive.readUInt16LE(local + 26), dataStart = local + 30 + localNameLength + archive.readUInt16LE(local + 28);
      need(dataStart + packed <= start && archive.readUInt16LE(local + 6) === flags && archive.readUInt16LE(local + 8) === method &&
        archive.subarray(local + 30, local + 30 + localNameLength).toString('utf8') === name, 'inconsistent ZIP entry');
      need(!ranges.some(([from, to]) => local < to && dataStart + packed > from), 'overlapping ZIP entries');
      ranges.push([local, dataStart + packed]);
      const data = method === 0 ? archive.subarray(dataStart, dataStart + packed) : inflateRawSync(archive.subarray(dataStart, dataStart + packed), { maxOutputLength: 2 * 1024 * 1024 });
      need(data.length === size && crc32(data) === archive.readUInt32LE(offset - (46 + nameLength + extra + comment) + 16), 'corrupt ZIP entry');
      if (!directory) parts.set(name, data);
    } catch (error) { throw new Error(`${error.message}; ${entry}`); }
  }
  need(offset === end, 'invalid ZIP directory length');
  const read = name => { need(parts.has(name), `missing package part: ${name}`); return xml(parts.get(name).toString('utf8')); };
  const relationships = (source, required = true) => {
    const path = source ? `${posix.dirname(source)}/_rels/${posix.basename(source)}.rels` : '_rels/.rels';
    if (!required && !parts.has(path)) return new Map();
    const root = read(path);
    need(is(root, NS.rel, 'Relationships'), 'invalid relationships root');
    const result = new Map();
    for (const relation of root.children) {
      need(is(relation, NS.rel, 'Relationship'), 'unknown relationship entry');
      const id = attr(relation, 'Id'), target = attr(relation, 'Target'), type = attr(relation, 'Type');
      need(id && !result.has(id) && attr(relation, 'TargetMode') !== 'External' && target && !/[\\%?#:]/.test(target), 'unsafe relationship');
      const resolved = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(source ? posix.dirname(source) : '', target));
      safePart(resolved); need(parts.has(resolved), 'relationship target is missing');
      result.set(id, { path: resolved, type });
    }
    return result;
  };
  need(is(read('[Content_Types].xml'), NS.types, 'Types'), 'invalid content types');
  const roots = [...relationships('').values()].filter(r => r.type === `${NS.r}/officeDocument`);
  need(roots.length === 1 && roots[0].path === main, 'wrong Office document type');
  // Validate every relationship, including optional notes/media relationships.
  for (const name of parts.keys()) if (name !== '_rels/.rels' && name.endsWith('.rels')) {
    const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(name);
    need(match, 'unexpected relationship path'); relationships(`${match[1]}/${match[2]}`);
  }
  return { parts, read, relationships };
}

const checked = operation => ctx => {
  try { operation(ctx); return true; }
  catch (error) { return `saved Office file: ${error.message}`; }
};

export const checkWord = checked(ctx => {
  const pkg = readPackage(ctx, 'word/document.xml'), document = pkg.read('word/document.xml');
  for (const name of pkg.parts.keys()) if (/^word\/(?:header[^/]*|footer[^/]*|comments[^/]*|footnotes|endnotes|glossary\/document)\.xml$/.test(name)) {
    need(texts(pkg.read(name), NS.w).trim() === '', 'unexpected Word story content');
  }
  need(is(document, NS.w, 'document'), 'invalid Word document');
  const body = one(document, NS.w, 'body');
  need(body.children.every(n => n.uri === NS.w && ['p', 'tbl', 'sectPr'].includes(n.name)), 'unexpected Word body content');
  for (const name of ['del', 'ins', 'drawing', 'object', 'altChunk', 'instrText', 'fldSimple', 'tab', 'br', 'vanish']) need(!all(document, NS.w, name).length, 'unsupported Word content');
  const paragraphs = children(body, NS.w, 'p').filter(p => texts(p, NS.w) !== '');
  same(paragraphs.map(p => texts(p, NS.w)), [`Report ${ctx.nonce}`, 'The violet shipment is ready.', `Keep this line ${ctx.nonce}.`], 'unexpected Word paragraphs');
  const styleId = attr(one(one(paragraphs[0], NS.w, 'pPr'), NS.w, 'pStyle'), 'val', NS.w);
  const stylesRel = [...pkg.relationships('word/document.xml').values()].filter(r => r.type === `${NS.r}/styles`);
  need(stylesRel.length === 1, 'missing Word style relationship');
  const styles = pkg.read(stylesRel[0].path), found = children(styles, NS.w, 'style').filter(s => attr(s, 'styleId', NS.w) === styleId);
  need(found.length === 1 && attr(found[0], 'type', NS.w) === 'paragraph' &&
    /^heading\s*1$/i.test(attr(one(found[0], NS.w, 'name'), 'val', NS.w) ?? '') &&
    attr(one(one(found[0], NS.w, 'pPr'), NS.w, 'outlineLvl'), 'val', NS.w) === '0', 'report title is not Heading 1');
  const tables = all(document, NS.w, 'tbl'); need(tables.length === 1, 'unexpected Word tables');
  const blocks = body.children.filter(n => !is(n, NS.w, 'sectPr') && !(is(n, NS.w, 'p') && texts(n, NS.w) === ''));
  need(blocks.at(-1) === tables[0], 'table is not at the end of the document');
  const rows = children(tables[0], NS.w, 'tr');
  need(rows.length === 2 && rows.every(row => children(row, NS.w, 'tc').length === 2), 'table is not 2 by 2');
  same(rows.map(row => children(row, NS.w, 'tc').map(cell => texts(cell, NS.w))), [['Item', 'Count'], ['Crates', '7']], 'unexpected table cells');
});

function sheetCells(root, strings) {
  need(is(root, NS.s, 'worksheet'), 'invalid worksheet');
  for (const name of ['mergeCell', 'drawing', 'hyperlink', 'tablePart', 'oleObject']) need(!all(root, NS.s, name).length, 'unsupported worksheet content');
  need(all(root, NS.s, 'col').every(col => !['1', 'true'].includes(attr(col, 'hidden'))), 'hidden worksheet column');
  const data = one(root, NS.s, 'sheetData'), result = {};
  need(data.children.every(node => is(node, NS.s, 'row')), 'unexpected worksheet data');
  for (const row of children(data, NS.s, 'row')) {
    need(!['1', 'true'].includes(attr(row, 'hidden')), 'hidden worksheet row');
    need(row.children.every(node => is(node, NS.s, 'c')), 'unexpected worksheet row content');
    for (const cell of children(row, NS.s, 'c')) {
      const ref = attr(cell, 'r'); need(/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(ref ?? '') && !(ref in result), 'invalid or duplicate cell');
      const values = children(cell, NS.s, 'v'), formulas = children(cell, NS.s, 'f'), inline = children(cell, NS.s, 'is');
      need(values.length <= 1 && formulas.length <= 1 && inline.length <= 1, 'ambiguous cell content');
      need(formulas.every(f => (!attr(f, 't') || attr(f, 't') === 'normal') && !attr(f, 'ref')), 'unsupported formula range');
      if (!values.length && !formulas.length && !inline.length) continue;
      const type = attr(cell, 't');
      let value;
      if (type === 's') {
        const index = values.length ? text(values[0]) : '';
        need(/^\d+$/.test(index) && Number(index) < strings.length && !inline.length, 'invalid shared string index'); value = strings[Number(index)];
      } else if (type === 'inlineStr') {
        need(inline.length === 1 && !values.length && !formulas.length, 'invalid inline string'); value = texts(inline[0], NS.s);
      } else {
        need(!type || type === 'n', 'unexpected cell type');
        need(values.length === 1 && text(values[0]).trim() !== '' && Number.isFinite(Number(text(values[0]))), 'invalid numeric value'); value = Number(text(values[0]));
      }
      if (value === '' && !formulas.length) continue;
      result[ref] = { value, ...(formulas.length ? { formula: text(formulas[0]).replace(/^=/, '').replace(/\s+/g, '').toUpperCase() } : {}) };
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export const checkExcel = checked(ctx => {
  const pkg = readPackage(ctx, 'xl/workbook.xml'), workbook = pkg.read('xl/workbook.xml');
  need(is(workbook, NS.s, 'workbook'), 'invalid workbook');
  const sheets = children(one(workbook, NS.s, 'sheets'), NS.s, 'sheet'), relations = pkg.relationships('xl/workbook.xml');
  same(sheets.map(s => attr(s, 'name')), ['Inventory', `Review ${ctx.nonce}`], 'unexpected worksheet names or order');
  need(sheets.every(s => !attr(s, 'state') || attr(s, 'state') === 'visible'), 'hidden worksheet');
  const paths = sheets.map(s => {
    const relation = relations.get(attr(s, 'id', NS.r)); need(relation?.type === `${NS.r}/worksheet`, 'missing worksheet relationship'); return relation.path;
  });
  need(new Set(paths).size === 2, 'duplicate worksheet reference');
  same([...pkg.parts.keys()].filter(name => /^xl\/worksheets\/[^/]+\.xml$/.test(name)).sort(), [...paths].sort(), 'extra worksheet parts');
  const shared = [...relations.values()].filter(r => r.type === `${NS.r}/sharedStrings`);
  need(shared.length <= 1, 'duplicate shared strings');
  const strings = shared.length ? children(pkg.read(shared[0].path), NS.s, 'si').map(si => texts(si, NS.s)) : [];
  const expected = { A1: { value: 'Item' }, A2: { value: 'Apples' }, A3: { value: 'Bananas' }, A4: { value: 'Pears' },
    B1: { value: 'Quantity' }, B2: { value: 8 }, B3: { value: 5 }, B4: { value: 3 },
    D1: { value: 'Budget' }, D2: { value: 11 }, D3: { value: 4 }, D4: { value: 15, formula: 'SUM(D2:D3)' } };
  same(sheetCells(pkg.read(paths[0]), strings), expected, 'unexpected cells, sort or formula');
  same(sheetCells(pkg.read(paths[1]), strings), {}, 'Review sheet is not empty');
});

export const checkPowerPoint = checked(ctx => {
  const pkg = readPackage(ctx, 'ppt/presentation.xml'), presentation = pkg.read('ppt/presentation.xml');
  for (const name of pkg.parts.keys()) if (/^ppt\/(?:notesSlides|comments)\/[^/]+\.xml$/.test(name)) {
    const story = pkg.read(name);
    need(all(story, NS.a, 'r').every(run => texts(run, NS.a).trim() === '') && !all(story, NS.p, 'cm').length, 'unexpected presentation notes or comments');
  }
  need(is(presentation, NS.p, 'presentation'), 'invalid presentation');
  const ids = children(one(presentation, NS.p, 'sldIdLst'), NS.p, 'sldId'), relations = pkg.relationships('ppt/presentation.xml');
  need(ids.length === 3 && new Set(ids.map(id => attr(id, 'id'))).size === 3, 'unexpected slide count or IDs');
  const paths = ids.map(id => {
    const relation = relations.get(attr(id, 'id', NS.r)); need(relation?.type === `${NS.r}/slide`, 'missing slide relationship'); return relation.path;
  });
  need(new Set(paths).size === 3, 'duplicate slide reference');
  same([...pkg.parts.keys()].filter(name => /^ppt\/slides\/[^/]+\.xml$/.test(name)).sort(), [...paths].sort(), 'extra slide parts');
  const titles = paths.map(path => {
    const slide = pkg.read(path); need(is(slide, NS.p, 'sld') && !['0', 'false'].includes(attr(slide, 'show')), 'invalid or hidden slide');
    const shapes = all(slide, NS.p, 'sp'), titleShapes = shapes.filter(shape => all(shape, NS.p, 'ph').some(ph => ['title', 'ctrTitle'].includes(attr(ph, 'type'))));
    need(titleShapes.length === 1 && shapes.length === 1, 'slide needs only one title placeholder');
    const tree = one(one(slide, NS.p, 'cSld'), NS.p, 'spTree');
    need(tree.children.every(node => ['nvGrpSpPr', 'grpSpPr', 'sp'].some(name => is(node, NS.p, name))), 'unexpected slide drawing');
    need(!all(slide, NS.p, 'bg').length && !all(slide, NS.a, 'blip').length, 'unexpected slide background or picture fill');
    const title = texts(titleShapes[0], NS.a);
    need(texts(slide, NS.a) === title && !all(slide, NS.p, 'pic').length && !all(slide, NS.p, 'graphicFrame').length, 'unexpected slide content');
    return title;
  });
  same(titles, [`Finish ${ctx.nonce}`, `Start ${ctx.nonce}`, `Middle ${ctx.nonce}`], 'unexpected slide titles or order');
});

function zip(parts) {
  const local = [], directory = []; let offset = 0;
  for (const [name, source] of Object.entries(parts)) {
    safePart(name); const data = Buffer.from(source), filename = Buffer.from(name), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12); // DOS date: 1980-01-01.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    directory.push(entry, filename); offset += header.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const rels = entries => declaration + `<Relationships xmlns="${NS.rel}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS.r}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const packageBase = (main, overrides) => ({
  '_rels/.rels': rels([['rId1', 'officeDocument', main]]),
  '[Content_Types].xml': declaration + `<Types xmlns="${NS.types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join('')}</Types>`,
});
const paragraph = value => `<w:p><w:r><w:t>${escape(value)}</w:t></w:r></w:p>`;
function wordParts(nonce) {
  return {
    ...packageBase('word/document.xml', [['word/document.xml', 'wordprocessingml.document.main'], ['word/styles.xml', 'wordprocessingml.styles']]),
    'word/document.xml': declaration + `<w:document xmlns:w="${NS.w}"><w:body>${paragraph(`Report ${nonce}`)}${paragraph('The amber shipment is ready.')}${paragraph(`Keep this line ${nonce}.`)}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/_rels/document.xml.rels': rels([['rId1', 'styles', 'styles.xml']]),
    'word/styles.xml': declaration + `<w:styles xmlns:w="${NS.w}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`,
  };
}
const inlineCell = (ref, value) => typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`;
function excelParts() {
  const rows = [['Item', 'Quantity'], ['Pears', 3], ['Apples', 8], ['Bananas', 5]];
  return {
    ...packageBase('xl/workbook.xml', [['xl/workbook.xml', 'spreadsheetml.sheet.main'], ['xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet']]),
    'xl/workbook.xml': declaration + `<workbook xmlns="${NS.s}" xmlns:r="${NS.r}"><bookViews><workbookView/></bookViews><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml']]),
    'xl/worksheets/sheet1.xml': declaration + `<worksheet xmlns="${NS.s}"><dimension ref="A1:B4"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="20" customWidth="1"/></cols><sheetData>${rows.map((row, index) => `<row r="${index + 1}">${row.map((value, col) => inlineCell(`${col ? 'B' : 'A'}${index + 1}`, value)).join('')}</row>`).join('')}</sheetData></worksheet>`,
  };
}
const groupShape = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const titleShape = title => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"/><a:t>${escape(title)}</a:t></a:r></a:p></p:txBody></p:sp>`;
function theme() {
  const colors = { dk1: '000000', lt1: 'FFFFFF', dk2: '1F497D', lt2: 'EEECE1', accent1: '4F81BD', accent2: 'C0504D', accent3: '9BBB59', accent4: '8064A2', accent5: '4BACC6', accent6: 'F79646', hlink: '0000FF', folHlink: '800080' };
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const fonts = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
  return declaration + `<a:theme xmlns:a="${NS.a}" name="Fixture"><a:themeElements><a:clrScheme name="Fixture">${Object.entries(colors).map(([key, value]) => `<a:${key}><a:srgbClr val="${value}"/></a:${key}>`).join('')}</a:clrScheme><a:fontScheme name="Fixture"><a:majorFont>${fonts}</a:majorFont><a:minorFont>${fonts}</a:minorFont></a:fontScheme><a:fmtScheme name="Fixture"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map(width => `<a:ln w="${width}">${fill}<a:prstDash val="solid"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}
function powerpointParts(nonce) {
  const overrides = [['ppt/presentation.xml', 'presentationml.presentation.main'], ['ppt/presProps.xml', 'presentationml.presProps'], ['ppt/theme/theme1.xml', 'theme'], ['ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster'], ['ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout'], ['ppt/slides/slide1.xml', 'presentationml.slide'], ['ppt/slides/slide2.xml', 'presentationml.slide']];
  const mapping = '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';
  const parts = {
    ...packageBase('ppt/presentation.xml', overrides),
    'ppt/presentation.xml': declaration + `<p:presentation xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId3"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml'], ['rId3', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId4', 'presProps', 'presProps.xml']]),
    'ppt/presProps.xml': declaration + `<p:presentationPr xmlns:p="${NS.p}"/>`,
    'ppt/theme/theme1.xml': theme(),
    'ppt/slideMasters/slideMaster1.xml': declaration + `<p:sldMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:spTree>${groupShape}${titleShape('')}</p:spTree></p:cSld>${mapping}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': declaration + `<p:sldLayout xmlns:p="${NS.p}" xmlns:a="${NS.a}" type="titleOnly" preserve="1"><p:cSld name="Title Only"><p:spTree>${groupShape}${titleShape('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  };
  for (const [index, title] of ['Start', 'Finish'].entries()) {
    parts[`ppt/slides/slide${index + 1}.xml`] = declaration + `<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:cSld><p:spTree>${groupShape}${titleShape(`${title} ${nonce}`)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]);
  }
  return parts;
}

export function prepareOffice(ctx, kind) {
  need(typeof ctx.nonce === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(ctx.nonce), 'unsafe Office nonce');
  const specifications = { word: ['Report', 'docx', wordParts], excel: ['Inventory', 'xlsx', excelParts], powerpoint: ['Slides', 'pptx', powerpointParts] };
  need(kind in specifications, 'unknown Office fixture');
  const [name, extension, build] = specifications[kind];
  ctx.officePath = join(ctx.dir, `${name}-${ctx.nonce}.${extension}`);
  writeFileSync(ctx.officePath, zip(build(ctx.nonce)), { flag: 'wx', mode: 0o600 });
}
