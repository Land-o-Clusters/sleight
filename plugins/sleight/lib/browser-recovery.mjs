import { lineCommentEnd } from './code-line-terminators.mjs';
import { browserReply } from './browser-call.mjs';

// Keep positions while masking strings and comments. Ambiguous syntax is left
// out of identity tracking rather than interpreted as a factory call.
export function sourceOf(code) {
  const out = code.split('');
  for (let i = 0; i < code.length; i++) {
    const start = i, quote = code[i];
    if (quote === '`') return null;
    if (quote === '"' || quote === "'") {
      for (i++; i < code.length; i++) {
        if (code[i] === '\\') i++;
        else if (code[i] === quote) break;
      }
    } else if (code.startsWith('//', i)) {
      i = lineCommentEnd(code, i);
    } else if (code.startsWith('/*', i)) {
      i = code.indexOf('*/', i + 2);
      if (i < 0) return null;
      i++;
    } else if (quote === '/') return null;
    else continue;
    for (let j = start; j <= i; j++) out[j] = ' ';
  }
  return out.join('');
}

const topLevel = (source, at) => !source.slice(0, at).replace(/[^{}()[\]]/g, '').length ||
  [...source.slice(0, at)].reduce((depth, char) => depth + ('{(['.includes(char) ? 1 : '})]'.includes(char) ? -1 : 0), 0) === 0;
const factory = /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+([A-Za-z_$][\w$]*)\.(getBrowser|createBrowserTab|tabs\.get)\s*\(/g;

// Destructuring keys and default expressions may also remove a record. That
// conservatively avoids probing a caller's lexical declaration before it runs.
function declarations(source) {
  const found = [];
  for (const match of source.matchAll(/\b(?:let|const|var)\s+/g)) {
    let at = match.index + match[0].length;
    while (at < source.length) {
      while (/\s/.test(source[at] || '') && at < source.length) at++;
      const start = at;
      if ('{['.includes(source[at] || '\0')) {
        let depth = 0;
        do {
          if ('{(['.includes(source[at])) depth++;
          if ('})]'.includes(source[at])) depth--;
          at++;
        } while (at < source.length && depth > 0);
      } else at += /^[A-Za-z_$][\w$]*/.exec(source.slice(at))?.[0].length || 0;
      if (at === start) break;
      for (const name of source.slice(start, at).match(/[A-Za-z_$][\w$]*/g) || []) found.push({ name, at: match.index });
      let depth = 0;
      for (; at < source.length; at++) {
        if ('{(['.includes(source[at])) depth++;
        if ('})]'.includes(source[at])) depth--;
        if (depth <= 0 && (source[at] === ',' || source[at] === ';')) break;
      }
      if (source[at++] !== ',') break;
    }
  }
  for (const match of source.matchAll(/\b(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g)) found.push({ name: match[1], at: match.index });
  return found;
}

// Discard identities on assignments, including patterns and uncertain nested
// writes. Losing a record is preferable to restoring an earlier handle.
function assignments(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:^|[^\w$.])(?:globalThis\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?:=(?!=|>)|(?:\?\?|\|\||&&|[+\-*/%&|^])=|\+\+|--)/g)) {
    const before = source.slice(0, match.index + match[0].lastIndexOf(match[1]));
    if (!/\b(?:let|const|var)\s*$/.test(before)) names.add(match[1]);
  }
  for (const match of source.matchAll(/[}\]]\s*=(?!=|>)/g)) {
    let start = match.index, depth = 0;
    for (; start >= 0; start--) {
      if ('})]'.includes(source[start])) depth++;
      if ('{(['.includes(source[start]) && --depth === 0) break;
    }
    if (start < 0 || /[\w$.)\]]/.test(source.slice(0, start).trimEnd().at(-1) || '')) continue;
    for (const name of source.slice(start, match.index + 1).match(/[A-Za-z_$][\w$]*/g) || []) names.add(name);
  }
  return names;
}

async function sessionTab(cua, pairs, query, options) {
  if (!query || typeof query !== 'object' || Object.keys(query).length !== 1 || typeof query.url !== 'string' || options?.browser !== undefined) {
    return cua.getTab(query, options);
  }
  const found = [];
  for (const selector of [...new Set(pairs.map(pair => JSON.stringify(pair.selector)))]) {
    const browser = await cua.getBrowser(JSON.parse(selector));
    for (const tab of await browser.tabs.list()) {
      if (tab.url === query.url && pairs.some(pair => JSON.stringify(pair.selector) === selector && pair.id === String(tab.id) && pair.url === tab.url)) {
        found.push({ id: tab.id, browser: browser.browserId });
      }
    }
  }
  if (found.length !== 1) throw new Error('getTab by URL needs exactly one previously observed session tab. Acquire the intended tab explicitly. Next: await cua.listTabs().');
  nodeRepl.write('sleight: getTab by URL found one previously observed session tab.');
  return cua.getTab(found[0].id, { browser: found[0].browser });
}

async function restore(cua, records) {
  const restored = [];
  let browser, rebind = '';
  if (records.b && typeof b === 'undefined') { browser = await cua.getBrowser(records.b); }
  if (records.tab && typeof tab === 'undefined') {
    const pair = records.tab;
    const owner = browser && JSON.stringify(records.b) === JSON.stringify(pair.selector) ? browser : await cua.getBrowser(pair.selector);
    const tabs = await owner.tabs.list();
    if (tabs.filter(tab => String(tab.id) === pair.id && tab.url === pair.url).length !== 1) {
      throw new Error('The last session tab is gone or changed. Acquire a tab explicitly before input. Next: await cua.listTabs().');
    }
    globalThis.tab = await owner.tabs.get(pair.id); restored.push('tab');
    if (typeof owner.browserId === 'string' && owner.browserId.length <= 128 && JSON.stringify(pair.selector).length <= 300) {
      rebind = ` Browser selector ${JSON.stringify(pair.selector)}. Rebind with await cua.getTab(${JSON.stringify(pair.id)}, { browser: ${JSON.stringify(owner.browserId)} }).`;
    }
  }
  if (browser) { globalThis.b = browser; restored.unshift('b'); }
  if (restored.length) nodeRepl.write('sleight: restored session handles ' + restored.join(' and ') + ' after a reset.' + rebind);
}

export class BrowserRecovery {
  browsers = new Map();
  tabs = new Map();
  pairs = new Map();
  pending = false;
  docsShown = false;
  restoring = false;
  missingTab = false;

  reset() { this.pending = true; }

  observe(code = '', reply) {
    const texts = (reply.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text);
    const docs = texts.some(text => /^## Computer Use\n/m.test(text));
    if ((reply.error || reply.result?.isError) && texts.some(text => /\btab is not defined\b/.test(text))) this.missingTab = true;
    if (docs && this.docsShown) this.reset();
    if (docs) this.docsShown = true;
    if ((reply.error || reply.result?.isError) && texts.some(text => /\b(?:b|tab) is not defined\b|(?:kernel|REPL|JavaScript session).*(?:reset|restart)|(?:execution|script) timed out|Timed out after \d+ms waiting for CDP command/i.test(text))) this.reset();
    const source = sourceOf(code);
    const assigned = !reply.error && !reply.result?.isError ? assignments(source ?? code) : new Set();
    if (!reply.error && !reply.result?.isError) {
      const changed = new Set(assigned);
      for (const { name, at } of declarations(source ?? code)) if (!source || topLevel(source, at)) changed.add(name);
      for (const name of changed) { this.tabs.delete(name); this.browsers.delete(name); }
    }
    if (!browserReply(reply)) return;
    if (this.restoring && !docs) { this.pending = false; this.restoring = false; }
    if (!source) return;
    const candidates = [];
    for (const match of source.matchAll(factory)) {
      if (!topLevel(source, match.index)) continue;
      const [, name, root, method] = match, rest = code.slice(match.index + match[0].length);
      this.tabs.delete(name); this.browsers.delete(name);
      if (root === 'cua' && method === 'getBrowser') {
        const selector = /^\s*\{\s*(id|extensionInstanceId)\s*:\s*(["'])([A-Za-z0-9_.:-]+)\2\s*\}/.exec(rest);
        if (selector) this.browsers.set(name, { [selector[1]]: selector[3] });
      } else if (this.browsers.has(root) && !assigned.has(root) && method === 'tabs.get') {
        const id = /^\s*(["'])([^"'\\]+)\1/.exec(rest)?.[2];
        if (id) candidates.push({ name, selector: this.browsers.get(root), id });
      } else if (root === 'cua' && method === 'createBrowserTab') {
        const browser = /^\s*([A-Za-z_$][\w$]*)\.browserId\s*,/.exec(rest)?.[1];
        if (this.browsers.has(browser) && !assigned.has(browser)) candidates.push({ name, selector: this.browsers.get(browser) });
      }
    }
    for (const name of assigned) { this.tabs.delete(name); this.browsers.delete(name); }
    for (const [name, pair] of this.tabs) {
      if (new RegExp('\\b' + name.replace(/[$]/g, '\\$&') + '\\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\\s*\\(').test(source)) candidates.push({ name, ...pair });
    }
    const headers = texts.flatMap(text => [...text.matchAll(/^Browser tab: ([^,\n]+), Title: "(?:[^"\\]|\\.)*", URL: ("(?:[^"\\]|\\.)*")\./gm)])
      .flatMap(([, id, url]) => {
        try { return id.length <= 128 && url.length <= 8192 ? [{ id, url: JSON.parse(url) }] : []; }
        catch { return []; }
      });
    if (candidates.length !== 1 || assigned.has(candidates[0].name) || headers.length !== 1 || (candidates[0].id && candidates[0].id !== headers[0].id)) return;
    const { name, selector } = candidates[0], pair = { selector, ...headers[0] };
    this.tabs.set(name, pair);
    this.pairs.set(JSON.stringify([selector, pair.id]), pair);
  }

  code(code) {
    const source = sourceOf(code);
    if (!source || /\bcua\.(?:getApp|computer|listApps|listWindows|getState)\b/.test(source)) return code;
    let prefix = '';
    if (this.pending && /\b(?:b|tab)\b/.test(source)) {
      const declared = new Set(declarations(source).map(binding => binding.name));
      for (const name of assignments(source)) declared.add(name);
      const records = { b: declared.has('b') || !/\bb\b/.test(source) ? undefined : this.browsers.get('b'),
        tab: declared.has('tab') || !/\btab\b/.test(source) ? undefined : this.tabs.get('tab') };
      if (this.missingTab && !declared.has('tab') && /\btab\b/.test(source) && !records.tab) {
        prefix += 'nodeRepl.write("sleight: no verified session tab is available for a rebind. Next: await cua.listTabs().");\n';
      }
      if ((records.b && /\bb\b/.test(source)) || (records.tab && /\btab\b/.test(source))) {
        prefix += `await (${restore.toString()})(cua, ${JSON.stringify(records)});\n`;
        this.restoring = true;
      }
    }
    if (this.pairs.size && /\bcua\.getTab\s*\(\s*\{\s*url\b/.test(source)) {
      const replacements = [...source.matchAll(/\bcua\.getTab(?=\s*\()/g)].reverse();
      for (const match of replacements) code = code.slice(0, match.index) + 'sleight.sessionTab' + code.slice(match.index + match[0].length);
      prefix += `globalThis.sleight ??= {}; globalThis.sleight.sessionTab = (query, options) => (${sessionTab.toString()})(cua, ${JSON.stringify([...this.pairs.values()])}, query, options);\n`;
    }
    return prefix + code;
  }
}
