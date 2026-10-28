import { isLeaseRead } from './input-lease.mjs';

// Retry admission is narrower than browser routing: unknown JavaScript may have acted.
export function isBrowserRead(code) {
  const source = code.replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\//g,
    value => value.startsWith('/') ? ' ' : '""');
  if (source.includes('`')) return false;
  const names = new Set();
  let reads = 0;
  for (let statement of source.split(';').map(s => s.trim()).filter(Boolean)) {
    const bound = /^(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(await\s+[\s\S]*)$/.exec(statement);
    if (bound) { names.add(bound[1]); statement = bound[2]; }
    if (names.has(statement.replace(/^return\s+/, ''))) continue;
    const alias = /^globalThis\.[A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*)$/.exec(statement);
    if (alias && names.has(alias[1])) continue;
    if (isLeaseRead(statement)) { reads++; continue; }
    if (/^(?:await\s+)?nodeRepl\.write\(\s*await\s+[A-Za-z_$][\w$]*\.playwright\.evaluate\(\s*\(\s*\)\s*=>\s*document(?:\.[A-Za-z_$][\w$]*)+\s*\)\s*\)$/.test(statement)) { reads++; continue; }
    const discovery = /^await\s+cua\.(?:getBrowser|getTab|listBrowsers|listTabs)\(([^()]*)\)$/.exec(statement);
    // Arguments are data only. Calls, computed expressions, templates and spreads are refused.
    if (discovery && /^[\w$.,:{}\s"']*$/.test(discovery[1]) && !/\.\./.test(discovery[1])) { reads++; continue; }
    return false;
  }
  return reads > 0;
}
