// A text PDF with deterministic page numbers. No app or third-party generator.
export function textPdf(texts, { script = false } = {}) {
  const escape = text => text.replace(/[\\()]/g, '\\$&');
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R' + (script ? ' /OpenAction << /S /JavaScript /JS (app.alert\("PDF_SCRIPT_RAN"\)) >>' : '') + ' >>',
    `<< /Type /Pages /Count ${texts.length} /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const text of texts) {
    const content = 'BT /F1 12 Tf 40 740 Td (' + escape(text) + ') Tj ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let pdf = '%PDF-1.7\n', offsets = [0];
  objects.slice(1).forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
