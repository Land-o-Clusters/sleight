// Extract rendered rows from the exact JSONL coordinates CPD1 inspected.
// This is a data reader only. Document values and home names are withheld.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sources = [
  ['2026-10-28T01-19-44-623Z/sleight-cc-dropdown-safari-1/transcript.jsonl', [12, 16, 23, 27]],
  ['2026-10-27T23-46-05-981Z/sleight-cc-dropdown-firefox-1/transcript.jsonl', [19, 27, 31]],
  ['2026-10-27T04-22-19-705Z/sleight-textedit-notes-table-1/transcript.jsonl', [14, 21, 27, 233]],
  ['2026-10-27T04-22-19-705Z/sleight-word-memo-1/transcript.jsonl', [31, 45, 75]],
  ['2026-10-27T01-54-13-200Z/sleight-textedit-save-1/transcript.jsonl', [7, 15]],
];
function texts(value) {
  if (!value || typeof value !== 'object') return [];
  if (value.type === 'image' || value.type === 'tool_use') return [];
  if (value.type === 'text' && typeof value.text === 'string') return [value.text];
  return Object.values(value).flatMap(v => Array.isArray(v) ? v.flatMap(texts) : texts(v));
}
export async function extractCompoundRecordingFixtures(root) {
  const rows = [];
  for (const [source, coordinates] of sources) {
    const raw = await readFile(resolve(root, source), 'utf8'), lines = raw.split('\n');
    for (const line of coordinates) {
      const original = lines[line - 1]; if (original === undefined) throw Error('MISSING_RECORDING_COORDINATE');
      const record = JSON.parse(original);
      const rendered = texts(record).join('\n').split('\n').filter(s => /^\t*\d+ /.test(s));
      const published = rendered.filter(s => !/^\t*\d+ (?:text entry|text field|static text|text )/.test(s))
        .map(s => s.replace(/\/Users\/[^/\s]+/g, '~'));
      const text = published.slice(0, 500).join('\n').slice(0, 16384);
      rows.push({ source, line, recordHash: createHash('sha256').update(original).digest('hex'),
        publishedTextMode: 'filtered rendered rows; not raw native evidence', printedRows: rendered.length,
        textTruncated: text.length < published.join('\n').length, text });
    }
  }
  return rows;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 6 || process.argv[2] !== '--evidence-root' || process.argv[4] !== '--output') throw Error('INVALID_ARGS');
  const rows = await extractCompoundRecordingFixtures(process.argv[3]);
  await writeFile(process.argv[5], JSON.stringify(rows, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ records: rows.length, recordsWithTree: rows.filter(r => r.printedRows > 0).length,
    printedRows: rows.reduce((n, r) => n + r.printedRows, 0), truncatedPublishedRecords: rows.filter(r => r.textTruncated).length }));
}
