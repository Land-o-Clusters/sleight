// First filter only. Candidates keep native guards until the engine replies.
export function browserReply(reply) {
  return !reply.error && !reply.result?.isError &&
    reply.result?._meta?.['codex/toolSurface']?.kind === 'browserUse';
}

export function browserLeaseNote(code, handles = new Set()) {
  if (typeof code !== 'string' || (!handles.size && !/\bcua\s*\.\s*(?:getBrowser|getTab|createBrowserTab)\s*\(/.test(sourceOf(code)))) return;
  return 'For browser work, use cua.getBrowser(...) and its tab handle, or cua.listTabs() for inventory. cua.getApp(...) acquires a native app.';
}

const nativeApi = /\bcua\s*(?:\?\.|\.)\s*(?:getApp|computer|listApps|listWindows|getState)\b/;
function sourceOf(code) {
  code = code.replace(/\bcua\s*\[\s*["'](getApp|computer|listApps|listWindows|getState)["']\s*\]/g, 'cua.$1');
  // Strings become "" and comments a space, so a comment can't hide what precedes a bracket.
  return code.replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\//g, match => {
    if (match.startsWith('/')) return ' ';
    if (match.startsWith('`')) return [...match.matchAll(/\$\{([\s\S]*?)\}/g)].map(m => sourceOf(m[1])).join(' ');
    return '""';
  });
}

function assignments(source) {
  return [...source.matchAll(/(?:(?:let|const|var)\s+)?(\[[^\]]*\]|\{[^{}]*\}|[A-Za-z_$][\w$]*)\s*=(?!=|>)\s*([^;]+)/g)]
    .map(([, lhs, rhs]) => ({ lhs, rhs, names: (lhs.startsWith('[') || lhs.startsWith('{') ? lhs.slice(1, -1) : lhs)
      .split(',').map(part => part.split('=')[0].split(':').at(-1).trim().replace(/^\.\.\./, ''))
      .filter(name => /^[A-Za-z_$][\w$]*$/.test(name)) }));
}

export function nativeBindings(code, handles = new Set()) {
  const known = new Set(handles), found = new Set();
  for (const { lhs, rhs, names } of assignments(sourceOf(code))) {
    const cuaBinding = /^cua\s*$/.test(rhs) && (!lhs.startsWith('{') || /\b(?:getApp|computer|listApps|listWindows|getState)\b/.test(lhs));
    if (nativeApi.test(rhs) || cuaBinding || [...rhs.matchAll(/\b[A-Za-z_$][\w$]*\b/g)].some(m => known.has(m[0]))) {
      for (const name of names) { known.add(name); found.add(name); }
    }
  }
  return [...found];
}

export function browserCall(code, handles = new Set(), nativeHandles = new Set()) {
  if (!code.trim()) return undefined;
  const source = sourceOf(code);
  // This is a routing hint, not a JavaScript security boundary. Name native access rather than
  // trying to prove every other expression browser-only. The runtime guard still denies native input.
  if (nativeApi.test(source)) return undefined;
  const bound = new Set(nativeBindings(code, nativeHandles));
  // The engine's default app root keeps its native route unless this call or a confirmed reply
  // binds it locally or to a tab. Only observed bindings propagate native names to aliases.
  const native = new Set(['app', ...nativeHandles, ...bound]);
  // A callback's local DOM variable may have the same name as a persistent native handle.
  const local = new Set(assignments(source).flatMap(binding => binding.names.filter(name => !bound.has(name))));
  const bindings = new Set();
  for (const match of source.matchAll(/(?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.(?:getBrowser|getTab|createBrowserTab)\(/g)) {
    bindings.add(match[1]);
  }
  const factories = /\.(?:getByRole|getByText|getByLabel|getByPlaceholder|getByTestId|locator|frameLocator|filter|first|last|nth|and|or|new|get)\(/;
  for (const match of source.matchAll(/(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)(\.[^;]*)/g)) {
    if ((handles.has(match[2]) || bindings.has(match[2])) && factories.test(match[3])) bindings.add(match[1]);
  }
  const roots = [...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\)*\s*(?:\?\.|\.|\[|\()/g)].map(m => m[1]);
  if (roots.some(h => native.has(h) && !handles.has(h) && !bindings.has(h) && !local.has(h))) return undefined;
  return { handles: [...bindings] };
}
