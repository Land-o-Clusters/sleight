import { userInfo } from 'node:os';

// Primary diagnostics only. Swift's source gutters and caret annotations do not
// identify a cause, even when the source contains a diagnostic-looking string.
export function compilerDiagnostics(stderr) {
  return String(stderr ?? '').split(/\r?\n/).flatMap(line => {
    const match = /^(?:[^|\r\n]+:\d+(?::\d+)?:\s*|(?:swiftc|<unknown>):\s*)?error:\s*(.+)$/.exec(line);
    return match ? [match[1]] : [];
  });
}

// Saved markers are at most 1 KB. Keep one bounded diagnostic, never a source
// excerpt, control sequence or a home directory, including on marker readback.
export function compilerDiagnosticLine(stderr) {
  const first = compilerDiagnostics(stderr)[0];
  if (!first) return;
  const safe = ('error: ' + first).replace(/\u001b\[[0-9;]*m/g, '')
    .split(userInfo().homedir).join('~').replace(/\/(?:Users|home)\/[^/\s'":]+/g, '~')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  let line = '', bytes = 0;
  for (const character of safe) {
    bytes += Buffer.byteLength(character);
    if (bytes > 240) break;
    line += character;
  }
  return line;
}
