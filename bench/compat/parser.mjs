import { ENGINE_PARSE_OPTIONS } from '../../plugins/sleight/lib/code-ast.mjs';

export const ENGINE_MERIYAH_VERSION = '7.0.0';

// Only inspect strings in node_repl. Never run or persist engine source.
// Diagnostic token/comment callbacks do not alter the parsed AST.
export function checkCellParser(binary) {
  const banners = [...binary.matchAll(/Meriyah v(\d+\.\d+\.\d+)/g)].map(match => match[1]);
  const starts = [...binary.matchAll(/\bparseModule\(\s*code,\s*\{/g)];
  const blocks = starts.map(match => {
    // The pinned block has one diagnostic callback and one nested object. Match
    // its closing sequence too, so an option after that callback cannot hide.
    const tail = binary.slice(match.index + match[0].length, match.index + match[0].length + 2000);
    return /^([\s\S]*?onComment\s*\([^)]*\)\s*\{\s*diagnosticComments\.push\(\s*\{\s*start\s*,\s*end\s*\}\s*\)\s*;\s*\}\s*,?\s*)\}\s*\)/.exec(tail)?.[1];
  });
  const expected = Object.entries(ENGINE_PARSE_OPTIONS).map(([key, value]) => `${key}:${value}`).join(',');
  const valid = blocks.length === 2 && blocks.every(block => {
    if (!block) return false;
    // Pin all scalar options before the diagnostic callbacks, including their order.
    const prefix = block.split(/\bonToken\s*:/)[0].replace(/\s/g, '').replace(/,$/, '');
    return prefix === expected && /\bonToken\s*:\s*diagnosticTokens\s*,\s*onComment\s*\(/.test(block) &&
      !/\b(?:next|module|ranges|loc|disableWebCompat)\s*:/.test(block.slice(block.indexOf('onToken')));
  });
  const pass = banners.length > 0 && banners.every(version => version === ENGINE_MERIYAH_VERSION) && valid;
  return { id: 'cell-parser', status: pass ? 'pass' : 'fail',
    reason: pass ? 'Meriyah 7.0.0 and both cell parser option blocks match' : 'node_repl cell parser banner or option blocks changed',
    ...(pass ? { version: ENGINE_MERIYAH_VERSION, options: ENGINE_PARSE_OPTIONS, blocks: blocks.length } : {}) };
}
