import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODULES_REL } from './setup.mjs';

// These IDs are data inside documentation, never prose or JavaScript. In particular,
// quotes, escapes, whitespace, newlines and Unicode are not browser ID characters.
const BROWSER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VALIDATED = Symbol('canonical engine documentation');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// No engine module is imported or executed. read_documentation.js reads these files;
// create_documentation.js joins core + confirmations with one newline, and
// create_bootstrap_emitter.js optionally appends audio with one newline.
export function loadInstalledDocumentation({ app = process.env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app', read = readFileSync, platform = process.platform } = {}) {
  const modules = join(app, MODULES_REL), cua = join(modules, '@oai/cua');
  const doc = name => read(join(cua, 'docs', `tinysky-alt-${name}.md`), 'utf8');
  const builder = read(join(cua, 'dist/lib/js/oai_js_cua/src/tinysky_alt/create_documentation.js'), 'utf8');
  const target = { darwin: 'mac', linux: 'linux', win32: 'windows' }[platform];
  let coreNames;
  // The newer emitter passes computer.target (or "no-cua") to read_core.
  // Select from that version's actual reader, never fall back on a missing file.
  if (builder.includes('n(`${t}-${i}`)') && target) coreNames = [`core-cua-repl-${target}`, 'core-cua-repl-no-cua', `core-node-repl-${target}`, 'core-node-repl-no-cua'];
  else if (builder.includes('const i=yield n(t);')) coreNames = ['core-cua-repl', 'core-node-repl'];
  else throw Error('Unknown engine core documentation format');
  const cores = coreNames.map(doc), policy = doc('confirmations');
  const audio = doc('audio'), other = doc('other-browser-apis');
  if (![...cores, policy, audio, other].every(text => typeof text === 'string' && text.length)) throw Error('Missing engine documentation');
  const texts = [policy, other];
  for (const [index, core] of cores.entries()) for (const base of [core, ...(coreNames[index].startsWith('core-cua-repl') ? [`${core}\n${policy}`] : [])]) texts.push(base, `${base}\n${audio}`);
  const browser = loadBrowserDocumentation(modules, read);
  return { texts, coreNames, matches: text => browser(text) || text.startsWith(other + '\n\n') && browser(text.slice(other.length + 2)) };
}

// Browser documentation is rendered from the installed manifest. All prose and API
// declarations come from the bundle. The selected-browser name must be a literal
// shipped name; custom names fail closed. Only the ID slot admits variable data.
function loadBrowserDocumentation(modules, read) {
  const root = join(modules, '@oai/browser-desktop');
  const source = read(join(root, 'scripts/browser-service.mjs'), 'utf8');
  const names = new Set([...source.matchAll(/\b(?:displayName|shortDisplayName):"((?:\\.|[^"\\])*)"/g)].map(m => JSON.parse(`"${m[1]}"`)));
  for (const match of source.matchAll(/\{id:"[A-Za-z0-9_-]+",name:"((?:\\.|[^"\\])*)",type:"(?:iab|extension|cdp|mcpapps)"\}/g)) names.add(JSON.parse(`"${match[1]}"`));
  const selected = /l=\["# Selected Browser",`- Name: \$\{t.name\}`,`- Type: \$\{t.type\}`,`- ID: \$\{t.id\}`,((?:"(?:\\.|[^"\\])*",?){2})\]\.join/.exec(source);
  if (!selected) throw Error('Unknown engine browser documentation format');
  const binding = [...selected[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => JSON.parse(`"${m[1]}"`)).join('\n');
  const capabilities = new Map([...source.matchAll(/\{id:"([A-Za-z]+)",description:"((?:\\.|[^"\\])*)"\}/g)]
    .map(m => [m[1], JSON.parse(`"${m[2]}"`)]));
  const directory = join(root, 'environment-docs/codex-app');
  const api = JSON.parse(read(join(directory, 'api.json'), 'utf8'));
  const manifest = JSON.parse(read(join(directory, 'documents.json'), 'utf8'));
  const documents = new Map(manifest.map(entry => [entry.name, read(join(directory, `${entry.name}.md`), 'utf8')]));
  const cache = new Map();
  return text => {
    const match = /^# Selected Browser\n- Name: ([^\n]+)\n- Type: (iab|extension|cdp|mcpapps)\n- ID: ([^\n]+)\n/.exec(text);
    if (!match || !names.has(match[1]) || !BROWSER_ID.test(match[3])) return false;
    const [, name, type, id] = match;
    const section = /\n\n# Additional Capabilities\n([\s\S]*?)\n\n# API Reference\n/.exec(text);
    if (!section) return false;
    const caps = { browser: [], tab: [] };
    let group;
    for (const line of section[1].split('\n')) {
      if (line === '## Browser Capabilities') group = 'browser';
      else if (line === '## Tab Capabilities') group = 'tab';
      else if (line.startsWith('- `')) {
        const cap = /^- `([A-Za-z]+)`: /.exec(line)?.[1];
        if (!group || !cap || !capabilities.has(cap) || caps[group].includes(cap)) return false;
        caps[group].push(cap);
      }
    }
    const key = JSON.stringify([name, type, caps]);
    let expected = cache.get(key);
    if (!expected) {
      const disabled = new Set(['Tab.ax']);
      for (const [iface, members] of Object.entries(api.interfaces)) for (const [member, info] of Object.entries(members))
        if (info.unsupportedByDefaultIn?.includes(type)) disabled.add(`${iface}.${member}`);
      const entries = manifest.filter(({ when: w }) => !w ||
        (!w.browserTypes || w.browserTypes.includes(type)) && !w.requiredApiMembers?.some(m => disabled.has(m)) &&
        !w.requiredBrowserCapabilities?.some(c => !caps.browser.includes(c)) &&
        !w.requiredTabCapabilities?.some(c => !caps.tab.includes(c)) && !w.excludedTabCapabilities?.some(c => caps.tab.includes(c)));
      const guidance = entries.filter(e => e.mode === 'included' && !['confirmations', 'tab-claiming-chrome', 'tab-mentions-iab'].includes(e.name));
      const lookup = entries.filter(e => e.mode === 'lookup');
      const capSection = group => [`## ${group === 'browser' ? 'Browser' : 'Tab'} Capabilities`,
        ...(caps[group].length ? caps[group].map(c => `- \`${c}\`: ${capabilities.get(c)}\n  Read with \`await (await ${group}.capabilities.get("${c}")).documentation()\`.`) : ['- None'])].join('\n');
      expected = [`# Selected Browser\n- Name: ${name}\n- Type: ${type}\n- ID: {browser-id}\n${binding}`,
        ...guidance.map(e => documents.get(e.name)),
        ...(lookup.length ? [['# Additional Documentation', 'Use `await agent.documentation.get("<name>")` when you need one of these topics:',
          ...lookup.map(e => `- \`${e.name}\`: ${e.description}`)].join('\n')] : []),
        ['# Additional Capabilities', capSection('browser'), capSection('tab')].join('\n'), renderReference(api, type, disabled)].join('\n\n');
      // Cache only finite manifest choices, never a caller's text or browser ID.
      if (cache.size < 256) cache.set(key, expected);
    }
    return text === expected.replace('- ID: {browser-id}\n', `- ID: ${id}\n`);
  };
}

function renderReference(api, type, disabled) {
  const declarations = (name, members) => Object.entries(members).flatMap(([member, info]) =>
    disabled.has(`${name}.${member}`) || info.documented === false ? [] : info.declarations.filter(d => d.documented !== false && !d.unsupportedByDefaultIn?.includes(type)));
  const used = new Set(), queue = [api.root];
  for (const name of queue) {
    if (used.has(name)) continue;
    const refs = api.interfaces[name] ? declarations(name, api.interfaces[name]).flatMap(d => d.references) : api.types[name]?.references;
    if (!refs) continue;
    used.add(name); for (const ref of refs) if (!used.has(ref)) queue.push(ref);
  }
  const lines = ['# API Reference', '', 'Use this as the supported `agent.browsers.*` surface.', '', '```ts',
    '// Returned by setupBrowserRuntime().', '// browser was selected during bootstrap.'];
  for (const [name, members] of Object.entries(api.interfaces)) if (used.has(name)) lines.push(`interface ${name} {`, ...declarations(name, members).map(d => `  ${d.text}`), '}', '');
  for (const [name, info] of Object.entries(api.types)) if (used.has(name)) lines.push(info.text, '');
  lines[lines.length - 1] = '```';
  return lines.join('\n').trim() + '\n';
}

export function createDocumentationTrust({ load = loadInstalledDocumentation } = {}) {
  let token, texts, patterns, matches;
  const refresh = () => {
    token = {}; texts = new Set(); patterns = []; matches = undefined;
    try {
      const loaded = load();
      texts = new Set(loaded.texts);
      patterns = (loaded.browserTemplates ?? []).map(template => {
        const parts = template.split('{browser-id}');
        if (parts.length !== 2) throw Error('Invalid browser ID slot');
        return new RegExp(`^${escape(parts[0])}([A-Za-z0-9_-]{1,128})${escape(parts[1])}$`);
      });
      matches = loaded.matches;
    } catch { texts = new Set(); patterns = []; matches = undefined; }
  };
  refresh();
  const canonical = text => {
    try { return typeof text === 'string' && (texts.has(text) || patterns.some(p => p.exec(text)?.[0].length === text.length) || matches?.(text) === true); }
    catch { return false; }
  };
  const trusted = item => item?.type === 'text' && item[VALIDATED] === token;
  const mark = item => trusted(item) || item?.type !== 'text' || !canonical(item.text) ? item : { type: 'text', text: item.text, [VALIDATED]: token };
  const split = item => {
    const whole = mark(item);
    if (trusted(whole) || item?.type !== 'text' || !/^(?:## Computer Use|# Other Browser APIs|# Computer Use Confirmations Policy|# Browser Safety|# API Reference|# Selected Browser)\n/.test(item.text)) return [whole];
    // Some adapters join a documentation item and an AX state with a newline.
    // Authenticate the complete prefix; the state never inherits its token.
    let boundaries = 0;
    for (const match of item.text.matchAll(/^Window: /gm)) {
      if (++boundaries > 8 || match.index > 256000) break;
      const prefix = item.text.slice(0, match.index);
      for (const text of [prefix, prefix.slice(0, -1), prefix.slice(0, -2)]) {
        if (!canonical(text)) continue;
        return [mark({ ...item, text }), { ...item, text: item.text.slice(match.index) }];
      }
    }
    return [item];
  };
  return { refresh, canonical, trusted, mark, split };
}
