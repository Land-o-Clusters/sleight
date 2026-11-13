// Offline recorded-tree corpus. No relay, browser, ledger or host access.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
export { baseConsent, baseElements } from './sa2m-base.mjs';

const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
const files = [];
function walk(dir) { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else files.push(path); } }
walk(root);
export const fixtureStrings = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  let values = [text];
  if (file.endsWith('.json')) { try { values = strings(JSON.parse(text)); } catch {} }
  if (file.endsWith('.jsonl')) values = text.split('\n').flatMap(line => { try { return strings(JSON.parse(line)); } catch { return []; } });
  for (const text of values) fixtureStrings.push({ src: relative(root, file), text });
}
const segments = new Map();
for (const { src, text } of fixtureStrings) {
  let current;
  const flush = () => {
    if (current?.rows.length >= 3) {
      const key = current.rows.map(row => row.id + ':' + row.depth).join(',');
      if (!segments.has(key)) segments.set(key, { src, ...current });
    }
  };
  for (const raw of text.split('\n')) {
    const match = /^(\t*)(\d+) (.*)$/.exec(raw);
    if (match && !match[1].length && Number(match[2]) === 0) { flush(); current = { rows: [], lines: [] }; }
    if (current) {
      current.lines.push(raw);
      if (match) current.rows.push({ id: Number(match[2]), depth: match[1].length, body: match[3] });
    }
  }
  flush();
}
export const allSegments = [...segments.values()];
export const completeSegments = allSegments.filter(t => t.rows.some(r => !r.depth && r.body === 'menu bar') &&
  !t.lines.some(l => /^sleight: \d+ tree lines omitted/.test(l)) &&
  // A later header followed by indented rows but no root is a filtered tail,
  // as in excel-reacquire. Footer echoes do not affect completeness.
  !t.lines.some((line, i) => /^Window: /.test(line) && t.lines.slice(i + 1).some(l => /^\t+\d+ /.test(l))));
// Sparse insertion inputs have ascending primary rows. Completeness above does
// not depend on the parser's verdict or on row ordering, including footer IDs.
export const sparseSegments = completeSegments.filter(t =>
  t.rows.every((r, i) => !i || r.id > t.rows[i - 1].id) && !t.rows.every((r, i) => r.id === i));
function wallAt(t, index, depth) {
  const next = t.rows[index].id + 1, following = t.rows[index + 1]?.id ?? Infinity;
  const pos = t.lines.indexOf('\t'.repeat(t.rows[index].depth) + t.rows[index].id + ' ' + t.rows[index].body);
  const out = t.lines.slice(0, pos + 1);
  let rest = t.lines.slice(pos + 1);
  if (following <= next + 3) rest = rest.map(line => line.replace(/^(\t*)(\d+) /,
    (_, tabs, id) => tabs + (Number(id) + next + 4 - following) + ' '));
  const tabs = '\t'.repeat(depth);
  out.push(tabs + next + ' dialog', tabs + '\t' + (next + 1) + ' text We use cookies',
    tabs + '\t' + (next + 2) + ' button Accept all', tabs + '\t' + (next + 3) + ' button Reject all');
  return { text: out.concat(rest).join('\n'), accept: next + 2, reject: next + 3 };
}
export const insertions = sparseSegments.flatMap((tree, segment) => {
  const html = tree.rows.findIndex(r => /^HTML content/i.test(r.body));
  const gap = tree.rows.findIndex((r, i) => i && r.id !== tree.rows[i - 1].id + 1);
  const inPage = i => i > html && tree.rows[i].depth > tree.rows[html].depth;
  const pageGap = html < 0 ? -1 : tree.rows.findIndex((r, i) => inPage(i) && r.id !== tree.rows[i - 1].id + 1);
  const anchors = html >= 0 ? [['page start', html], ['before first gap', gap - 1], ['after first gap row', gap],
    ...(pageGap > 0 ? [['before page gap', pageGap - 1], ['after page gap', pageGap]] : []),
    ['page end', tree.rows.findLastIndex((_, i) => inPage(i))]]
    : [['before first gap', gap - 1], ['after first gap row', gap],
      ['window end', tree.rows.findLastIndex((r, i) => r.depth > 0 && i < tree.rows.findIndex(x => x.body === 'menu bar'))]];
  return anchors.filter(([, i]) => i >= 0).map(([anchor, index]) => ({
    segment, src: tree.src, rows: tree.rows.length, anchor, afterId: tree.rows[index].id,
    ...wallAt(tree, index, tree.rows[index].depth + (index === html ? 1 : 0)),
  }));
});
