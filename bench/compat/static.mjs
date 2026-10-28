// The static half of the compatibility check: reads an unpacked ChatGPT.app's engine files (JavaScript, Markdown, plists
// and the node_repl binary's strings) and checks the contract in contract.mjs, without running anything from the bundle,
// so it works on Linux. Results name only sleight's own contract items: nothing from the engine's files is printed.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HELPER_REL, MODULES_REL, NODE_REL, NODE_REPL_REL, REPL_REL } from '../../plugins/sleight/lib/setup.mjs';
import { engineJsVariant } from '../../plugins/sleight/lib/tool-description.mjs';
import { API_MEMBERS, CUA_METHODS, checkApiContract, checkPolicyRewrite, checkWorkflowRewrite, jsDescriptionResult } from './contract.mjs';
import { checkDocumentationFormat } from './documentation.mjs';
import { checkCellParser } from './parser.mjs';

const OAI = join(MODULES_REL, '@oai');
export const BUNDLE = {
  appInfo: 'Contents/Info.plist',
  helperInfo: join(HELPER_REL, 'Contents/Info.plist'),
  node: NODE_REL,
  nodeRepl: NODE_REPL_REL,
  replBin: REPL_REL,
  launch: join(OAI, 'cua-repl/dist/lib/js/oai_js_cua_repl/src/launch.js'),
  instructions: join(OAI, 'cua-repl/instructions'),
  coreDoc: join(OAI, 'cua/docs/tinysky-alt-core-cua-repl.md'),
  policy: join(OAI, 'cua/docs/tinysky-alt-confirmations.md'),
  tinysky: join(OAI, 'cua/dist/lib/js/oai_js_cua/src/tinysky_alt'),
  plugin: 'Contents/Resources/plugins/openai-bundled/plugins/unified-computer-use',
};
// The js tool description, as cua-repl's launch.js joins it on macOS for each surface setting.
const DESCRIPTION_PARTS = { computer: ['macos/description', 'browser-disabled', 'macos/computer', 'macos/output'],
  'browser,computer': ['macos/description', 'macos/browser', 'macos/computer', 'macos/output'] };
// What the relay sends the engine and relies on it accepting: js arguments, the turn end and its turn metadata.
// node_repl is a compiled binary, so this finds only a name removed outright, not a changed schema; the Mac's engine
// checks (bench/compat.mjs) read the real tools/list.
export const NODE_REPL_STRINGS = ['timeout_ms', 'js_reset', 'turn_ended', 'hook_event_name', 'x-codex-turn-metadata', 'session_id', 'turn_id', 'elicitation'];
// What cua-repl's launcher must still read and build for sleight's environment (launch.mjs resolveServer, setup.mjs).
export const LAUNCH_STRINGS = ['CUA_REPL_NODE_REPL_PATH', 'CUA_REPL_ENABLED_SURFACES', 'NODE_REPL_TOOL_OVERRIDES', 'js_reset'];

// Versions go into file names and output, so only plain version strings are used.
export const SAFE_VERSION = /^[\w.+-]{1,40}$/;
const safeVersion = value => (typeof value === 'string' && SAFE_VERSION.test(value) ? value : undefined);
const result = (id, status, reason) => ({ id, status, ...(reason ? { reason } : {}) });
const read = (app, rel) => readFileSync(join(app, rel), 'utf8');

export function plistString(xml, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml ?? '');
  return match?.[1];
}

// Is `name` defined in minified JavaScript, as a method with a body (`getApp(t){`), a property holding a function
// (`getApp:function(`, `getApp:(t)=>`) or an assigned one (`getApp=async(t)=>`)? A call (`.getApp(`) or a bare mention
// doesn't count.
export function definesMember(source, name) {
  const id = name.replace(/\$/g, '\\$');
  const fn = '(?:async\\s*)?(?:function\\b|\\([^()]*\\)\\s*=>|[\\w$]+\\s*=>)';
  return new RegExp(`(?:^|[^\\w$.])${id}\\s*(?:\\([^()]*\\)\\s*\\{|:\\s*${fn}|=\\s*${fn})`).test(source);
}

// A downloaded archive could plant a symbolic link where the check reads a file, pointing at anything on the machine
// that runs it. Every path the check reads, and each folder on the way, must be a real file or folder.
export function symlinksIn(app) {
  const found = new Set();
  const visit = (rel, deep) => {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      let info;
      try { info = lstatSync(join(app, sub)); } catch { return; }
      if (info.isSymbolicLink()) { found.add(sub); return; }
    }
    if (!deep) return;
    for (const entry of readdirSync(join(app, rel), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) found.add(join(rel, entry.name));
      else if (entry.isDirectory()) visit(join(rel, entry.name), true);
    }
  };
  for (const [key, rel] of Object.entries(BUNDLE)) visit(rel, ['instructions', 'tinysky', 'plugin'].includes(key) && existsSync(join(app, rel)));
  return [...found];
}

export function analyzeBundle(app) {
  const results = [];
  const links = symlinksIn(app);
  if (links.length) return { results: [result('bundle-layout', 'fail', `refusing ${links.length} symbolic links among the files it reads`)], fingerprint: undefined };
  const missing = Object.entries(BUNDLE).filter(([, rel]) => !existsSync(join(app, rel))).map(([key]) => key);
  const appVersion = existsSync(join(app, BUNDLE.appInfo)) ? safeVersion(plistString(read(app, BUNDLE.appInfo), 'CFBundleShortVersionString')) : undefined;
  // The helper's version is what `sleight-mcp --doctor` prints as "Codex computer-use <version>".
  const engineVersion = existsSync(join(app, BUNDLE.helperInfo)) ? safeVersion(plistString(read(app, BUNDLE.helperInfo), 'CFBundleShortVersionString')) : undefined;
  results.push(missing.length ? result('bundle-layout', 'fail', `missing ${missing.join(', ')}`) : result('bundle-layout', 'pass'));
  if (!missing.includes('nodeRepl')) {
    const binary = readFileSync(join(app, BUNDLE.nodeRepl)).toString('latin1');
    const absent = NODE_REPL_STRINGS.filter(name => !binary.includes(name));
    results.push(absent.length ? result('tool-schema', 'fail', `node_repl no longer contains ${absent.join(', ')}`) : result('tool-schema', 'pass'));
    results.push(checkCellParser(binary));
  }
  if (missing.includes('plugin') || missing.includes('coreDoc') || missing.includes('tinysky')) {
    return { appVersion, engineVersion, results, fingerprint: undefined };
  }

  // The engine plugin's server entry and the turn-end hook arguments the relay copies.
  try {
    const server = JSON.parse(read(app, join(BUNDLE.plugin, '.mcp.json'))).mcpServers?.cua_repl;
    const plugin = read(app, join(BUNDLE.plugin, '.codex-plugin/plugin.json'));
    const problems = [];
    if (!server) problems.push('no cua_repl server');
    const enabled = server?.enabled_tools;
    if (Array.isArray(enabled)) for (const tool of ['js', 'turn_ended']) if (!enabled.includes(tool)) problems.push(`${tool} not in enabled_tools`);
    // A text search, so it finds only a key removed outright.
    for (const key of ['turn_ended', 'hook_event_name', 'session_id', 'turn_id']) if (!plugin.includes(key)) problems.push(`plugin hooks lack ${key}`);
    results.push(problems.length ? result('engine-plugin', 'fail', problems.join('; ')) : result('engine-plugin', 'pass'));
  } catch (error) { results.push(result('engine-plugin', 'fail', `unreadable plugin config (${error.code ?? error.name})`)); }

  if (!missing.includes('launch')) {
    const launch = read(app, BUNDLE.launch);
    const absent = LAUNCH_STRINGS.filter(name => !launch.includes(name));
    results.push(absent.length ? result('launch-env', 'fail', `cua-repl's launcher no longer mentions ${absent.join(', ')}`) : result('launch-env', 'pass'));
  }
  const coreDoc = read(app, BUNDLE.coreDoc);
  const policy = existsSync(join(app, BUNDLE.policy)) ? read(app, BUNDLE.policy) : '';
  // The engine sends both files in one first result, so the headings are checked across both.
  results.push(...checkApiContract(`${coreDoc.trimEnd()}\n\n${policy}`));
  results.push(checkDocumentationFormat(`${coreDoc.trimEnd()}\n\n${policy}`));

  const scripts = readdirSync(join(app, BUNDLE.tinysky)).filter(name => name.endsWith('.js')).map(name => read(app, join(BUNDLE.tinysky, name)));
  const macApp = existsSync(join(app, BUNDLE.tinysky, 'bind_mac_app.js')) ? read(app, join(BUNDLE.tinysky, 'bind_mac_app.js')) : '';
  const absent = [...CUA_METHODS.filter(name => !scripts.some(source => definesMember(source, name))).map(name => `cua.${name}`),
    ...API_MEMBERS.App.filter(name => !definesMember(macApp, name)).map(name => `App.${name}`)];
  results.push(absent.length ? result('repl-methods', 'fail', `the engine's JavaScript no longer defines ${absent.join(', ')}`)
    : result('repl-methods', 'pass', `${CUA_METHODS.length} cua methods and ${API_MEMBERS.App.length} App methods defined`));

  const part = name => { const file = join(app, BUNDLE.instructions, `${name}.md`); return existsSync(file) ? readFileSync(file, 'utf8').trimEnd() : undefined; };
  const descriptions = Object.fromEntries(Object.entries(DESCRIPTION_PARTS).map(([mode, parts]) => {
    const texts = parts.map(part);
    return [mode, texts.every(text => text !== undefined) ? texts.join('\n\n') : undefined];
  }));
  // sleight starts the engine with CUA_REPL_ENABLED_SURFACES=computer unless a Codex browser extension is connected
  // (launch.mjs selectSurfaces), so that setting is the one that has to match.
  // The pins of the engine's current descriptions apply only with SLEIGHT_FS=1 until its A/B (tool-description.mjs).
  const pins = Object.fromEntries(Object.entries(descriptions).map(([mode, text]) => [mode, text === undefined ? undefined : engineJsVariant(text)]));
  const known = Object.keys(pins).filter(mode => pins[mode]);
  results.push(jsDescriptionResult(pins.computer, known.length && !pins.computer ? 'computer' : undefined));

  results.push(...checkPolicyRewrite([`${coreDoc.trimEnd()}\n\n${policy}`]));
  results.push(...checkWorkflowRewrite([coreDoc]));

  // One hash over everything checked, so a later run can say whether any of it changed without keeping engine text.
  const hash = createHash('sha256');
  hash.update(JSON.stringify(results.find(item => item.id === 'cell-parser') ?? null)).update('\0');
  for (const text of [coreDoc, policy, ...Object.values(descriptions).map(text => text ?? ''), macApp, ...scripts]) hash.update(text).update('\0');
  return { appVersion, engineVersion, results, fingerprint: hash.digest('hex') };
}

// The engine's docs, for a private diff on the machine that runs the check (never printed or uploaded).
export function engineDocs(app) {
  return { 'api.md': read(app, BUNDLE.coreDoc), 'confirmations.md': existsSync(join(app, BUNDLE.policy)) ? read(app, BUNDLE.policy) : '' };
}

// The unpacked ChatGPT.app under an extraction folder: the shallowest .app holding the engine's node.
export function findApp(root, depth = 4) {
  const queue = [[root, 0]];
  while (queue.length) {
    const [dir, level] = queue.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name.endsWith('.app') && existsSync(join(path, NODE_REL)) && statSync(join(path, NODE_REL)).isFile()) return path;
      if (level < depth && !entry.name.endsWith('.app')) queue.push([path, level + 1]);
    }
  }
  return undefined;
}
