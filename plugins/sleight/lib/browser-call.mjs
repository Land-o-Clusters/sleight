// Cooperative classification, not a boundary against arbitrary JavaScript.
export function browserCall(code, handles = new Set()) {
  // Template expressions and prototype chains would hide native access from the checks below.
  if (/`(?:[^`\\]|\\.)*\$\{/.test(code) || /\b(?:constructor|__proto__|prototype)\b/.test(code)) return undefined;
  const source =code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '""');
  if (/cua\.(?:getApp|computer)\b/.test(source)) return undefined;
  // Fail closed: cua reached other than by a literal browser method (computed access, destructuring,
  // aliasing), or a global escape hatch, keeps the call on the native path and its guards.
  if (/\bcua\b(?!\s*\.\s*(?:listBrowsers|listTabs|getBrowser|getTab|createBrowserTab)\s*\()/.test(source)) return undefined;
  if (/\b(?:globalThis|window|self|eval|Function|Reflect|Proxy|require|import)\b/.test(source)) return undefined;
  const acquisition = source.match(/(?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.(?:getBrowser|getTab|createBrowserTab)\(/);
  const bindings = new Set(acquisition?.[1] ? [acquisition[1]] : []);
  const factories = /\.(?:getByRole|getByText|getByLabel|getByPlaceholder|getByTestId|locator|frameLocator|filter|first|last|nth|and|or|new|get)\(/;
  for (const match of source.matchAll(/(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)(\.[^;]*)/g)) {
    if ((handles.has(match[2]) || bindings.has(match[2])) && factories.test(match[3])) bindings.add(match[1]);
  }
  const roots = [...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\./g)].map(m => m[1]);
  const browser = /cua\.(?:listBrowsers|listTabs|getBrowser|getTab|createBrowserTab)\(/.test(source) || roots.some(h => handles.has(h));
  if (!browser) return undefined;
  // A native handle in the same call must still go through the native guard.
  const allowed = new Set(['cua', 'nodeRepl', 'playwright', 'dom_cua', 'tabs', 'user', 'capabilities', 'clipboard', 'content', 'dev', 'JSON', ...handles, ...bindings]);
  if (roots.some(h => !allowed.has(h))) return undefined;
  return { handles: [...bindings] };
}
