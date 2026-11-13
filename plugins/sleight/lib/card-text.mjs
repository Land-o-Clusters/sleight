// Plain card text: escape display controls, then cap the rendered UTF-8 bytes.
export function cardText(value, { maxBytes = 2048, indent = false, diff = false } = {}) {
  const text = String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200d-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const draw = text => indent ? text.replace(/^/gm, '  ') : text;
  const drawn = draw(text);
  if (Buffer.byteLength(drawn) <= maxBytes) return drawn;
  if (diff) {
    const lines = text.replace(/\n$/, '').split('\n');
    let shown = 0, bytes = 0;
    // Reserve the exact marker size, including indentation and its line break.
    while (shown < lines.length) {
      const next = Buffer.byteLength(draw(lines[shown])) + 1;
      const marker = draw(`[diff truncated, ${lines.length - shown - 1} lines not shown]`);
      if (bytes + next + Buffer.byteLength(marker) > maxBytes) break;
      bytes += next; shown++;
    }
    return lines.slice(0, shown).map(draw).join('\n') + (shown ? '\n' : '') +
      draw(`[diff truncated, ${lines.length - shown} lines not shown]`);
  }
  // Keep the payment card's existing 2020-byte prefix and marker byte for byte.
  const marker = '\n[request truncated]';
  const reserve = maxBytes === 2048 && !indent ? 28 : Buffer.byteLength(draw(marker));
  let prefix = Buffer.from(text).subarray(0, Math.max(0, maxBytes - reserve)).toString('utf8').replace(/\uFFFD$/, '');
  while (Buffer.byteLength(draw(prefix + marker)) > maxBytes) prefix = Array.from(prefix).slice(0, -1).join('');
  return draw(prefix + marker);
}
