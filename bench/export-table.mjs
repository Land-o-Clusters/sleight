// Held-out export task. The caller owns the loopback server and any isolated browser fixture.
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function exportTableFixture(seed = 1) {
  const columns = ['Item', 'Price', 'Note'];
  const rows = Array.from({ length: 200 }, (_, i) => [
    `item-${seed}-${String(i + 1).padStart(3, '0')}`, ((seed * 31 + i * 17) % 10000 / 100).toFixed(2),
    (i % 7 === 0 ? `comma, "quote" ${i}` : i % 11 === 0 ? `two\nlines ${i}` : `桃 ${i}`) + ' ' + 'fixture text '.repeat(15).trim(),
  ]);
  const html = '<!doctype html><meta charset="utf-8"><title>Export fixture</title><table aria-label="Prices"><thead><tr>' +
    columns.map(value => '<th>' + escape(value) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(row => '<tr>' + row.map(value => '<td>' + escape(value).replaceAll('\n', '<br>') + '</td>').join('') + '</tr>').join('') +
    '</tbody></table><script>window.effects=[];document.addEventListener("click",()=>effects.push("click"));document.addEventListener("submit",e=>{e.preventDefault();effects.push("submit")});</script>';
  return { html, columns, rows, prompt: 'Export the whole Prices table to a JSON file in sleight\'s folder. Report its path, row count and completeness. Do not transcribe the rows.' };
}
export function gradeTableExport(content, fixture, answer) {
  let actual;
  try { actual = JSON.parse(content); } catch { return { pass: false, code: 'EXPORT_INVALID_JSON' }; }
  if (JSON.stringify(actual.columns) !== JSON.stringify(fixture.columns) || JSON.stringify(actual.rows) !== JSON.stringify(fixture.rows)) return { pass: false, code: 'EXPORT_DATA_MISMATCH' };
  if (actual.rowCount !== fixture.rows.length || actual.complete !== true || actual.reasons?.length) return { pass: false, code: 'EXPORT_COMPLETENESS_MISMATCH' };
  if (!/\b200\b/.test(answer) || !/complete:\s*yes/i.test(answer)) return { pass: false, code: 'EXPORT_ANSWER_MISSING_COUNTS' };
  return { pass: true, code: 'EXPORT_EXACT' };
}
