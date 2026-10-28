import { ENGINE_PARSE_OPTIONS } from '../../plugins/sleight/lib/code-ast.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_REPL_REL } from '../../plugins/sleight/lib/setup.mjs';

export const ENGINE_MERIYAH_VERSION = '7.0.0';

export function checkInstalledCellParser({ app = process.env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app', readFile = readFileSync } = {}) {
  try { return checkCellParser(readFile(join(app, NODE_REPL_REL)).toString('latin1')); }
  catch { return { id: 'cell-parser', status: 'fail', reason: 'node_repl cell parser is unreadable' }; }
}

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkInstalledCellParser();
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'pass' ? 0 : 1;
}
