import { join } from 'node:path';
import { MODULES_REL } from '../../plugins/sleight/lib/setup.mjs';

// Structure recorded from ChatGPT 26.1111.21308, engine 26.1111.1001923:
// @oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/read_documentation.js reads
// docs/tinysky-alt-${name}.md from @oai/cua. create_documentation.js in that
// directory reads `${t}-${i}` and joins CUA core + confirmations with one newline.
// create_bootstrap_emitter.js appends audio with one newline and joins
// other-browser-apis + browser docs with two. Prose below is test data.
// Browser paths are @oai/browser-desktop/scripts/browser-service.mjs and
// @oai/browser-desktop/environment-docs/codex-app/{api.json,documents.json,*.md}.
export const recordedCoreNames = ['core-cua-repl-mac', 'core-cua-repl-no-cua', 'core-node-repl-mac', 'core-node-repl-no-cua'];
export const recordedDocPath = name => join(MODULES_REL, '@oai/cua/docs', `tinysky-alt-${name}.md`);
export const recordedBuilderPath = join(MODULES_REL, '@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/create_documentation.js');
export const recordedBrowserRoot = join(MODULES_REL, '@oai/browser-desktop');

export function recordedDocumentation(put, { core = '## Computer Use\nMac core.\n', policy = '# Computer Use Confirmations Policy\nAsk.\n' } = {}) {
  // Exact read_core call from the shipped builder, read as data and never run.
  put(recordedBuilderPath, 'const e=yield n(`${t}-${i}`);');
  for (const name of recordedCoreNames) put(recordedDocPath(name), name === recordedCoreNames[0] ? core : `${name}.\n`);
  put(recordedDocPath('confirmations'), policy);
  put(recordedDocPath('audio'), 'Audio.\n');
  put(recordedDocPath('other-browser-apis'), '# Other Browser APIs\nBrowser.\n');
  put(join(recordedBrowserRoot, 'scripts/browser-service.mjs'),
    'displayName:"Google Chrome";l=["# Selected Browser",`- Name: ${t.name}`,`- Type: ${t.type}`,`- ID: ${t.id}`,"Reuse.","Recover."].join');
  put(join(recordedBrowserRoot, 'environment-docs/codex-app/api.json'), '{"root":"Agent","interfaces":{"Agent":{}},"types":{}}');
  put(join(recordedBrowserRoot, 'environment-docs/codex-app/documents.json'), '[{"name":"browser-safety","mode":"included"}]');
  put(join(recordedBrowserRoot, 'environment-docs/codex-app/browser-safety.md'), '# Browser Safety\nKeep tabs.\n');
}
