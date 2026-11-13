// Cooperative observations only. No field from this channel authorizes input or proves selection.
const phases = new Set(['start', 'focus-wait', 'focus-repeat', 'focus-ready', 'frame-retry', 'frame-wait', 'frame-move', 'frame-ready', 'end']);
const outcomes = new Set(['pending', 'selected', 'refused', 'error']);

export function stripPickerTrace(content, record) {
  let accepted = 0;
  return content.flatMap(block => {
    if (block.type !== 'text') return [block];
    const text = block.text.replace(/\[sleight:picker-phase\]([^\r\n]*)(?:\r?\n|$)/g, (_, json) => {
      try {
        if (accepted >= 256 || json.length > 512) return '';
        const { search, phase, outcome, at, ms, reads, keys, ticks } = JSON.parse(json);
        if (!Number.isSafeInteger(search) || search < 1 || search > 16 || !phases.has(phase) || !outcomes.has(outcome) ||
            !Number.isFinite(at) || at < 0 || !Number.isFinite(ms) || ms < 0 || ![reads, keys, ticks].every(n => Number.isSafeInteger(n) && n >= 0) ||
            reads > 101 || keys > 400 || ticks > 400) return '';
        accepted++;
        record({ search, phase, outcome, at, ms, reads, keys, ticks });
      } catch { /* Diagnostic parsing or recording cannot change the tool result. */ }
      return '';
    });
    return text ? [{ ...block, text }] : [];
  });
}

export function documentationCounts(content = []) {
  let blocks = 0, chars = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    if (!/^(?:## Computer Use|# Other Browser APIs|# Computer Use Confirmations Policy|# Browser Safety|# API Reference)\n/m.test(block.text)) continue;
    blocks++; chars += block.text.length;
  }
  return { blocks, chars };
}
