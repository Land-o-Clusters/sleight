// Shared by the sandboxed mod and the relay. Input is assistant prose only, never a tool result.
// Strip before limiting length: a long URL must never leave its prefix in a bubble.
export function narrationLine(raw, input = {}) {
  if (typeof raw !== 'string' || raw.length > 32768) return undefined;
  // A sentence that repeats an argument's string value is omitted entirely. Code literals include
  // labels as well as typed text; this deliberately loses some useful narration rather than values.
  // Dynamic input values cannot be reconstructed safely. Omit the entire input call's narration.
  if (typeof input.code === 'string' && !narrationCodeSafe(input.code) ||
      /(?:^|__)browser_fill$/.test(input.tool ?? input.name ?? '') ||
      Array.isArray(input.steps) && input.steps.some(step => ['type', 'fill', 'paste'].includes(step?.do))) return undefined;
  const values = [];
  const visit = (value, key = '', depth = 0) => {
    if (depth > 8 || values.length > 256) return;
    if (typeof value === 'string') {
      if (key === 'code') for (const match of value.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        values.push(match[2]);
        try { if (match[1] === '"') values.push(JSON.parse(match[0])); } catch {}
      }
      else if (!['tool_use_id', 'agentId', 'sleight_say', 'sleight_stats'].includes(key)) values.push(value);
    } else if (Array.isArray(value)) value.slice(0, 256).forEach(v => visit(v, key, depth + 1));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value).slice(0, 256)) visit(v, k, depth + 1);
  };
  visit(input);
  if (values.some(value => value.trim() && raw.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase()))) return undefined;
  let text = raw.normalize('NFC')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`]*(?:`|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)|(?<![\p{L}])'[^'\n]+'(?=\s|[.,!?]|$)/gu, ' ')
    .replace(/\S*(?:[/:\\@]|\.(?:[a-zA-Z]{2,8})(?:\b|$))\S*/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, ' ')
    .replace(/[*_#>|\[\]{}]/g, '')
    .replace(/\s+([.!?,])/g, '$1').replace(/\s+/g, ' ').trim();
  text = text.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? text;
  text = [...text].slice(0, 90).join('').trim();
  return /[\p{L}\p{N}\p{Emoji_Presentation}]/u.test(text) ? text : undefined;
}

// Narration is optional, so unfamiliar JavaScript loses its line. Resolve only direct, known
// read/pointer calls. Computed members, aliases, templates, escapes and unknown calls fail closed.
function narrationCodeSafe(code) {
  if (/\b(?:typeText|paste|setValue|pressKey)\b|[`\\]/.test(code)) return false;
  const plain = code.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    token => token.startsWith('/') ? ' ' : '""');
  if (/[$\w)\]]\s*(?:\?\.)?\s*\[|\//.test(plain)) return false;
  const methods = new Set(['getApp', 'getState', 'getTab', 'getAXState', 'getAXStateAndScreenshot', 'click', 'doubleClick', 'rightClick', 'scroll', 'drag', 'selectText']);
  for (const call of plain.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (plain.slice(0, call.index).trimEnd().at(-1) !== '.' || !methods.has(call[1])) return false;
  }
  return true;
}

// A method name alone is not a capability: an earlier call can alias typeText as click.
// Reconstruct only direct native acquisitions and ordinary method calls. Unknown JS or assignments
// revoke this narration-only knowledge, including after compaction. This grants no input authority.
function nativeNarrationKnown(messages, toolId, current) {
  const known = new Set();
  const methods = new Set(['getApp', 'getState', 'getAXState', 'getAXStateAndScreenshot', 'click', 'doubleClick', 'rightClick', 'scroll', 'drag',
    'selectText', 'typeText', 'setValue', 'paste', 'pressKey']);
  function accept(code) {
    if (typeof code !== 'string' || /[`\\]/.test(code)) { known.clear(); return false; }
    const plain = code.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, t => t.startsWith('/') ? ' ' : '""');
    const acquisitions = [...plain.matchAll(/\b(?:let|const|var)\s+(\w+)\s*=\s*await\s+cua\s*\.\s*getApp\s*\(/g)];
    const rest = plain.replace(/\b(?:let|const|var)\s+\w+\s*=\s*await\s+cua\s*\.\s*getApp\s*\(/g, 'cua.getApp(');
    if (/=(?!=)|=>|[$\w)\]]\s*(?:\?\.)?\s*\[|\//.test(rest)) { known.clear(); return false; }
    for (const acq of acquisitions) known.add(acq[1]);
    for (const call of plain.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const receiver = /\b(\w+)\s*\.\s*$/.exec(plain.slice(0, call.index))?.[1];
      if (!methods.has(call[1]) || (receiver === 'cua' ? !['getApp', 'getState'].includes(call[1]) : !known.has(receiver))) {
        known.clear(); return false;
      }
    }
    return true;
  }
  for (const message of messages) for (const block of message?.content ?? []) {
    if (block?.type !== 'tool_use') continue;
    if (block.id === toolId) return accept(current);
    if (/(?:^|__)js_reset$/.test(block.name ?? '')) known.clear();
    else if (/(?:^|__)js$/.test(block.name ?? '')) accept(block.input?.code);
  }
  return false;
}

// Match the current tool id, then consider only text before that block in that assistant message.
// A missing/currently streaming block fails closed instead of borrowing an earlier action's rationale.
export function assistantNarration(messages, toolId, input) {
  if (!Array.isArray(messages) || typeof toolId !== 'string') return undefined;
  if (typeof input?.code === 'string' && !nativeNarrationKnown(messages, toolId, input.code)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const index = message.content.findIndex(b => b?.type === 'tool_use' && b.id === toolId);
    if (index < 0) continue;
    let block = message.content.slice(0, index).findLast(b => b?.type === 'text');
    for (let j = i - 1; !block && j >= 0 && messages[j]?.role === 'assistant'; j--) {
      block = messages[j].content?.findLast(b => b?.type === 'text');
    }
    return narrationLine(block?.text, input);
  }
}
