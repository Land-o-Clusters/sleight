// Shared by the sandboxed mod and the relay. Input is assistant prose only, never a tool result.
// Strip before limiting length: a long URL must never leave its prefix in a bubble.
export function narrationLine(raw, input = {}) {
  if (typeof raw !== 'string') return undefined;
  // Bound before regex or normalization. A partial final token is discarded whole.
  raw = boundedNarration(raw);
  if (typeof input.code === 'string' && !narrationCodeSafe(input.code) ||
      /(?:^|__)browser_fill$/.test(input.tool ?? input.name ?? '') ||
      Array.isArray(input.steps) && input.steps.some(step => ['type', 'fill', 'paste'].includes(step?.do))) return undefined;
  const values = new Set();
  const visit = (value, key = '', depth = 0) => {
    if (depth > 8 || values.size >= 256) return;
    if (typeof value === 'string' && USER_VALUES.has(key)) {
      for (const word of value.slice(0, 1024).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) if (word.length >= 4) values.add(word);
    } else if (Array.isArray(value)) value.slice(0, 256).forEach(v => visit(v, key, depth + 1));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value).slice(0, 256)) visit(v, k, depth + 1);
  };
  visit(input);
  if ((raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).some(word => values.has(word))) return undefined;
  let text = raw.normalize('NFC')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`]*(?:`|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)|(?<![\p{L}])'[^'\n]+'(?=\s|[.,!?]|$)/gu, ' ')
    .replace(/(?:[0-9][ -]?){12,18}[0-9]/g, token => luhn(token) ? ' ' : token)
    .split(/\s+/u).filter(token => !privateToken(token)).join(' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, ' ')
    .replace(/[*_#>|\[\]{}]/g, '')
    .replace(/\s+([.!?,])/g, '$1').replace(/\s+/g, ' ').trim();
  text = text.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? text;
  text = [...text].slice(0, 90).join('').trim();
  return /[\p{L}\p{N}\p{Emoji_Presentation}]/u.test(text) ? text : undefined;
}

const USER_VALUES = new Set(['text', 'value', 'values', 'paste', 'content', 'query', 'search', 'searchQuery']);
export function boundedNarration(raw) {
  // At most 1024 UTF-8 bytes, without traversing an arbitrarily large input.
  let bytes = 0, end = 0, boundary = 0;
  for (const char of raw) {
    const n = char.codePointAt(0), size = n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4;
    if (bytes + size > 1024) return raw.slice(0, boundary);
    bytes += size; end += char.length;
    if (/\s/u.test(char)) boundary = end;
  }
  return raw;
}
function luhn(token) {
  const digits = token.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]); if (double && (n *= 2) > 9) n -= 9;
    sum += n; double = !double;
  }
  return sum % 10 === 0;
}
function privateToken(token) {
  return /[/:\\@]|\.[a-zA-Z]{2,8}(?:\b|$)/u.test(token) ||
    /(?:sk-(?:ant-)?|gh[pousr]_|xox[a-z]?[-_]|AKIA)[A-Za-z0-9_+-]+/i.test(token) ||
    /[A-Fa-f0-9]{24,}|[A-Za-z0-9+/=_-]{32,}/.test(token) ||
    /[0-9]{6,}/.test(token) ||
    (/[A-Za-z]/.test(token) && /[0-9]/.test(token) && /[A-Za-z0-9_-]{8,}/.test(token));
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
  const { accept, clear } = nativeTracker();
  for (const message of messages) for (const block of message?.content ?? []) {
    if (block?.type !== 'tool_use') continue;
    if (block.id === toolId) return accept(current);
    if (/(?:^|__)js_reset$/.test(block.name ?? '')) clear();
    else if (/(?:^|__)js$/.test(block.name ?? '')) accept(block.input?.code);
  }
  return false;
}

function nativeTracker() {
  const known = new Set();
  const methods = new Set(['getApp', 'getState', 'getAXState', 'getAXStateAndScreenshot', 'click', 'doubleClick', 'rightClick', 'scroll', 'drag',
    'selectText', 'typeText', 'setValue', 'paste', 'pressKey']);
  function accept(code) {
    if (typeof code !== 'string' || code.length > 16384 || /[`\\]/.test(code)) { known.clear(); return false; }
    const plain = code.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, t => t.startsWith('/') ? ' ' : '""');
    const acquisitions = [...plain.matchAll(/\b(?:let|const|var)\s+(\w+)\s*=\s*await\s+cua\s*\.\s*getApp\s*\(/g)];
    const rest = plain.replace(/\b(?:let|const|var)\s+\w+\s*=\s*await\s+cua\s*\.\s*getApp\s*\(/g, 'cua.getApp(');
    if (/=(?!=)|=>|[$\w)\]]\s*(?:\?\.)?\s*\[|\//.test(rest)) { known.clear(); return false; }
    for (const acq of acquisitions) known.add(acq[1]);
    if (known.size > 128) { known.clear(); return false; }
    for (const call of plain.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const receiver = /\b(\w+)\s*\.\s*$/.exec(plain.slice(0, call.index))?.[1];
      if (!methods.has(call[1]) || (receiver === 'cua' ? !['getApp', 'getState'].includes(call[1]) : !known.has(receiver))) {
        known.clear(); return false;
      }
    }
    return true;
  }
  return { accept, clear: () => known.clear() };
}

// One bounded cache per loop. Observe only the mod's incoming assistant message events;
// no transcript RPC, retained media, or scan of prior messages on the tool path.
export function createNarrationCache() {
  let enabled = false;
  const loops = new Map();
  function loop(id = '') {
    if (!loops.has(id)) {
      if (loops.size >= 16) loops.delete(loops.keys().next().value);
      loops.set(id, { tracker: nativeTracker(), text: undefined, calls: new Map(), seen: new Set() });
    }
    return loops.get(id);
  }
  return {
    configure(mode) { const next = mode === 'bubbles' || mode === 'voice'; if (next !== enabled) loops.clear(); enabled = next; },
    reset() { loops.clear(); },
    observe(event) {
      if (!enabled) return;
      const state = loop(event.agentId);
      if (event.door === 'compaction') { loops.delete(event.agentId ?? ''); return; }
      const message = event.message;
      if (message?.role !== 'assistant' || event.origin?.kind !== 'model') { state.text = undefined; return; }
      if (state.seen.has(event.uuid)) return;
      state.seen.add(event.uuid); if (state.seen.size > 64) state.seen.delete(state.seen.values().next().value);
      for (const block of message.content ?? []) {
        if (block?.type === 'text') state.text = typeof block.text === 'string' ? boundedNarration(block.text) : undefined;
        if (block?.type !== 'tool_use') continue;
        const input = block.input ?? {}, native = /(?:^|__)js$/.test(block.name ?? '');
        let safe = true;
        if (/(?:^|__)js_reset$/.test(block.name ?? '')) state.tracker.clear();
        if (native) safe = state.tracker.accept(input.code);
        if (state.calls.size >= 128) state.calls.delete(state.calls.keys().next().value);
        state.calls.set(block.id, { line: safe ? narrationLine(state.text, { ...input, tool: block.name }) : undefined,
          code: native && safe ? input.code : undefined });
      }
    },
    take(event) {
      if (!enabled) return undefined;
      const state = loops.get(event.agentId ?? ''), entry = state?.calls.get(event.tool_use_id);
      state?.calls.delete(event.tool_use_id);
      if (!entry || typeof event.code === 'string' && event.code !== entry.code) return undefined;
      return narrationLine(entry.line, event);
    },
  };
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
