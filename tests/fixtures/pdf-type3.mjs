// An offline Type 3 font with three vector glyph programs and an explicit Unicode map.
export function type3Pdf() {
  const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream('BT /F1 24 Tf 40 700 Td (ABC) Tj ET'),
    '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] ' +
      '/CharProcs << /A 6 0 R /B 7 0 R /C 8 0 R >> /Encoding << /Type /Encoding /Differences [65 /A /B /C] >> ' +
      '/FirstChar 65 /LastChar 67 /Widths [600 600 600] /Resources << >> /ToUnicode 9 0 R >>',
    stream('600 0 0 0 600 700 d1 40 w 50 0 m 300 700 l 550 0 l S 125 250 m 475 250 l S'),
    stream('600 0 0 0 600 700 d1 40 w 50 0 m 50 700 l 400 700 l 550 525 l 400 350 l 50 350 l 400 350 l 550 175 l 400 0 l h S'),
    stream('600 0 0 0 600 700 d1 40 w 550 650 m 400 700 l 50 550 l 50 150 l 400 0 l 550 50 l S'),
    stream('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /FixtureUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n' +
      '3 beginbfchar\n<41> <0041>\n<42> <0042>\n<43> <0043>\nendbfchar\nendcmap\n' +
      'CMapName currentdict /CMap defineresource pop\nend\nend'),
  ];
  let pdf = '%PDF-1.7\n', offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
