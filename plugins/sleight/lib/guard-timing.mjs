// Cooperative diagnostics, never evidence that an action or scope check passed.
// Keep the trace schema numeric: no app names, window titles or document text.
export function stripGuardTiming(content, record) {
  return content.flatMap(block => {
    if (block.type !== 'text') return [block];
    // write() does not add separators; a user's text can precede our marker.
    const text = block.text.replace(/\[sleight:guard-timing\]([^\r\n]*)(?:\r?\n|$)/g, (_, json) => {
      try {
        const { phase, ms, chars, failed } = JSON.parse(json);
        if (['before-action', 'after-call', 'reused', 'reuse-refused', 'skipped'].includes(phase) && Number.isFinite(ms) && ms >= 0 &&
            Number.isSafeInteger(chars) && chars >= 0 && typeof failed === 'boolean') record({ phase, ms, chars, failed });
      } catch { /* A malformed diagnostic must not affect the result. */ }
      return '';
    });
    return text ? [{ ...block, text }] : [];
  });
}
