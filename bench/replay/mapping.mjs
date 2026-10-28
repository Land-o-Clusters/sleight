import ts from 'typescript';
import { FrameMapper, windowReceipts, isNativeSelection } from './frames.mjs';
import { imageShape, matchingMedia } from './images.mjs';
import { resultItems, taskResult } from './documentation.mjs';

export const resultText = result => (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');

// Include the full ancestor path. Equal labels in two groups never select by position.
export function elements(text) {
  const rows = [], parents = [];
  for (const line of text.split('\n')) {
    const match = /^(?:\+ )?(\s*)(\d+) ([a-z][^\n]*)$/.exec(line);
    if (!match) continue;
    const depth = match[1].replaceAll('\t', '    ').length;
    while (parents.length && parents.at(-1).depth >= depth) parents.pop();
    const label = match[3].replace(/,? Value:.*?(?=, (?:ID|Description|Help|Placeholder|Secondary Actions):|$)/g, '').trim();
    const row = { id: Number(match[2]), label, key: [...parents.map(p => p.label), label].join(' > '), depth };
    rows.push(row); parents.push(row);
  }
  return rows.filter((row, i) => rows.findIndex(other => other.id === row.id && other.key === row.key) === i);
}

export function elementMapping(before, after) {
  return matchRows(elements(before), elements(after));
}

function matchRows(old, fresh) {
  const map = new Map();
  for (const row of old) {
    if (old.filter(r => r.id === row.id).length !== 1) continue;
    if ([...old, ...fresh].some(r => r.label === row.label && r.uncertain)) continue;
    const source = old.filter(r => r.key === row.key), targets = fresh.filter(r => r.key === row.key);
    const targetIds = [...new Set(targets.map(r => r.id))];
    if (new Set(source.map(r => r.id)).size === 1 && targetIds.length === 1 && fresh.filter(r => r.id === targetIds[0]).length === 1) map.set(row.id, targetIds[0]);
  }
  return map;
}

function mergeElements(previous, text) {
  const rows = elements(text);
  if (!/lines changed since the last full tree/.test(text)) return rows.length ? rows : previous;
  const merged = [...previous];
  for (const row of rows) {
    const index = merged.findIndex(r => r.id === row.id);
    if (index >= 0) merged[index] = { ...row, uncertain: merged[index].uncertain, key: merged[index].label === row.label ? merged[index].key : row.key };
    // A new number could be an added sibling or a renumbered control. Only a full read resolves it.
    else merged.push({ ...row, uncertain: true });
  }
  return merged;
}

function mergeRefs(previous, text) {
  const fresh = refs(text);
  if (/^# Snapshot \d+/m.test(text)) return fresh;
  const merged = new Map(previous.map(row => [row.id, row]));
  for (const line of text.split('\n')) {
    if (/^-\s+- /.test(line)) { const id = /\[ref=([^\]]+)\]/.exec(line)?.[1]; if (id) merged.delete(id); }
  }
  for (const row of fresh) merged.set(row.id, row);
  return [...merged.values()];
}

export function refs(text) {
  const rows = [], parents = [];
  for (const line of text.split('\n')) {
    if (/^-\s+- /.test(line)) continue;
    const match = /^(?:[+\-] )?(\s*)- (.+?) \[ref=((?:f\d+)?e\d+|s\d+)\]/.exec(line);
    if (!match) continue;
    const depth = match[1].length;
    while (parents.length && parents.at(-1).depth >= depth) parents.pop();
    const label = match[2].replace(/ \[(?:active|checked|selected)\]/g, '');
    const row = { id: match[3], label, depth, key: [...parents.map(p => p.label), label].join(' > ') };
    rows.push(row); parents.push(row);
  }
  return rows.filter((row, i) => rows.findIndex(other => other.id === row.id && other.key === row.key) === i);
}

const tabHeaders = text => [...text.matchAll(/^(t[a-f0-9]{16,}) (https?:\/\/[^\s]+)\nTitle[^\n]*: ([^\n]+)/gm)];
const elementMethods = new Set(['click', 'doubleClick', 'rightClick', 'hover', 'setValue', 'selectText', 'scroll', 'pickFromList', 'performSecondaryAction', 'drag', 'pressKey', 'typeText', 'paste']);
const observationMethods = new Set(['getApp', 'getTab', 'getBrowser', 'getState', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'listApps', 'listWindows', 'listTabs', 'listBrowsers', 'documentation']);

function nativeReceiver(args) {
  if (!args.code) return args.app ? `app:${args.app}` : undefined;
  const ast = ts.createSourceFile('scope.js', args.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), receivers = new Set();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      let init = node.initializer;
      if (init && ts.isAwaitExpression(init)) init = init.expression;
      if (init && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'getApp') receivers.add(node.name.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        (elementMethods.has(node.expression.name.text) || ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot'].includes(node.expression.name.text)))
      receivers.add(node.expression.expression.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return receivers.size === 1 ? [...receivers][0] : undefined;
}

function nativeWindow(text) {
  const headers = [...text.matchAll(/^Window: "([^"]+)", App: (.+?)\.?$/gm)];
  if (headers.length === 1) return { window: headers[0][1], app: headers[0][2] };
}

export class TargetMapper {
  constructor() { this.strings = new Map(); this.handles = new Map(); this.identities = new Map(); this.tabs = new Map(); this.frames = new FrameMapper(); this.nativeTrees = new Map(); this.lastNative = undefined; }
  refMapping(tab) {
    if (!tab || !this.tabs.has(tab) || !this.strings.has(tab)) throw Error(`Unmapped tab or missing tab snapshot: ${tab ?? '(absent)'}`);
    return this.tabs.get(tab).refMap;
  }
  refresh(text, args = {}) {
    this.frames.observe([]);
    if (elements(text).length) {
      const receiver = nativeReceiver(args), window = nativeWindow(text), state = this.nativeTrees.get(this.lastNative?.key);
      if (!state || receiver !== this.lastNative.receiver || !window || this.replaceStrings(this.lastNative.window) !== window.window || window.app !== this.lastNative.app)
        throw Error('Refresh returned a different native receiver or window');
      state.afterRows = elements(text);
    }
    if (refs(text).length || /^# Snapshot \d+/m.test(text)) {
      this.refMapping(args.tab);
      const headers = tabHeaders(text);
      if (headers.length > 1 || headers.length === 1 && headers[0][1] !== this.strings.get(args.tab)) throw Error('Refresh returned a different tab');
      const state = this.tabs.get(args.tab);
      state.afterRefs = mergeRefs([], text);
      state.refMap = matchRows(state.beforeRefs, state.afterRefs);
    }
  }
  observe(before, after, args = {}, source) {
    if (source?.server === 'plugin:sleight:computer' && source.name === 'open_file') {
      const handles = text => [...text.matchAll(/^Window handle: `([A-Za-z_$][\w$]*)`/gm)].map(m => m[1]);
      const old = handles(before), fresh = handles(after);
      if (old.length) {
        if (old.length !== 1 || fresh.length !== 1 || !nativeWindow(before) || !nativeWindow(after) || windowDifference(before, after, this) ||
            this.handles.has(old[0]) && this.handles.get(old[0]) !== fresh[0] ||
            [...this.handles].some(([key, value]) => key !== old[0] && value === fresh[0])) throw Error('Ambiguous acquired app handle mapping');
        this.handles.set(old[0], fresh[0]);
      }
    }
    if (source?.server === 'plugin:sleight:computer' && source.name === 'js' && !elements(before).length && args.code && this.lastNative &&
        new RegExp(`\\b${this.lastNative.receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(args.code)) this.lastNative = undefined;
    if (isNativeSelection(source)) this.lastNative = undefined;
    if (elements(before).length && source?.server === 'plugin:sleight:computer') {
      const receiver = nativeReceiver(args), window = nativeWindow(before), freshWindow = nativeWindow(after);
      this.lastNative = undefined;
      if (receiver && window && freshWindow && this.replaceStrings(window.window) === freshWindow.window && window.app === freshWindow.app) {
        const key = JSON.stringify([receiver, window.app, window.window]), state = this.nativeTrees.get(key) ?? { beforeRows: [], afterRows: [] };
        state.beforeRows = mergeElements(state.beforeRows, this.replaceStrings(before)); state.afterRows = mergeElements(state.afterRows, after);
        this.nativeTrees.set(key, state); this.lastNative = { key, receiver, ...window };
      }
    }
    const a = tabHeaders(before), b = tabHeaders(after);
    let tab = args.tab;
    if (a.length || b.length) {
      if (a.length !== 1 || b.length !== 1 || a[0][2] !== b[0][2] || this.replaceStrings(a[0][3]) !== b[0][3]) throw Error('Ambiguous tab handle mapping');
      if ([...this.tabs.keys()].some(key => key !== a[0][1] && this.strings.get(key) === b[0][1])) throw Error('Ambiguous tab handle mapping');
      this.addString(a[0][1], b[0][1]);
      tab = a[0][1];
    }
    if (refs(before).length || refs(after).length || /^# (?:Snapshot|Changes)/m.test(before + '\n' + after)) {
      if (!tab || !this.strings.has(tab)) throw Error('Cannot scope refs without a mapped tab');
      const state = this.tabs.get(tab) ?? { beforeRefs: [], afterRefs: [] };
      state.beforeRefs = mergeRefs(state.beforeRefs, before); state.afterRefs = mergeRefs(state.afterRefs, after);
      state.refMap = matchRows(state.beforeRefs, state.afterRefs);
      this.tabs.set(tab, state);
    }
    // A native select_window receipt binds a changing window number to app + title.
    const x = isNativeSelection(source) ? windowReceipts(before) : [], y = isNativeSelection(source) ? windowReceipts(after) : [], pairs = [];
    for (const old of x) {
      const same = row => this.replaceStrings(old.target.title) === row.target.title && old.target.appId === row.target.appId;
      const matches = y.filter(same);
      if (x.filter(row => row.target.appId === old.target.appId && row.target.title === old.target.title).length !== 1 || matches.length !== 1) continue;
      const fresh = matches[0]; pairs.push([old, fresh]);
      for (const key of ['windowNumber', 'windowId']) if (Number.isSafeInteger(old.identity[key]) && Number.isSafeInteger(fresh.identity[key]))
        for (const alias of ['windowNumber', 'windowId', 'toWindowId']) this.identities.set(`${alias}:${old.identity[key]}`, fresh.identity[key]);
    }
    this.frames.observe(pairs);
  }
  addString(before, after) {
    if (!before || !after || (this.strings.has(before) && this.strings.get(before) !== after)) throw Error('Ambiguous fixture mapping');
    this.strings.set(before, after);
  }
  replaceStrings(value, includeHandles = true) {
    if (this.strings.size) {
      const keys = [...this.strings.keys()].sort((a, b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      value = value.replace(new RegExp(keys.join('|'), 'g'), key => this.strings.get(key));
    }
    return includeHandles && this.handles.size ? value.replace(/(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])/g, key => this.handles.get(key) ?? key) : value;
  }
  mapElement(id, receiver) {
    if (!this.lastNative || this.replaceStrings(receiver ?? '') !== this.replaceStrings(this.lastNative.receiver)) throw Error('Native receiver differs from last-observed tree; read this receiver first');
    const { beforeRows, afterRows } = this.nativeTrees.get(this.lastNative.key);
    const matches = beforeRows.filter(row => row.id === id);
    const mapped = matchRows(beforeRows, afterRows).get(id);
    if (matches.length !== 1 || mapped === undefined) throw Error(`Ambiguous or missing element ${id}; refresh required`);
    return mapped;
  }
  code(code) {
    code = this.replaceStrings(code, false);
    const ast = ts.createSourceFile('recorded.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw Error('Recorded JavaScript cannot be parsed');
    const edits = [];
    const assertReceiverBinding = receiver => {
      const visitBinding = node => {
        let init;
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === receiver) init = node.initializer;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(ast) === receiver) init = node.right;
        if (init) {
          if (ts.isAwaitExpression(init)) init = init.expression;
          if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression) || init.expression.name.text !== 'getApp')
            throw Error('Rebound native receiver needs a new observed tree');
          const selector = init.arguments[0];
          if (!selector || !ts.isStringLiteral(selector) || selector.text !== this.lastNative?.app)
            throw Error('Native app or window receiver differs from last-observed tree');
        }
        ts.forEachChild(node, visitBinding);
      };
      visitBinding(ast);
    };
    const receiverFor = node => {
      for (let current = node.parent; current; current = current.parent) if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) return current.expression.expression.getText(ast);
    };
    const map = (id, receiver) => { assertReceiverBinding(receiver); return this.mapElement(id, receiver); };
    const visit = node => {
      if (ts.isIdentifier(node) && this.handles.has(node.text) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node))
        edits.push([node.getStart(ast), node.end, this.handles.get(node.text)]);
      if (ts.isPropertyAssignment(node)) {
        const key = node.name.text;
        if (['elementIndex', 'targetIndex', 'element', 'windowId', 'windowNumber', 'toWindowId'].includes(key) && !ts.isNumericLiteral(node.initializer))
          throw Error('Computed numeric selectors cannot be remapped safely');
        if (['from', 'to'].includes(key) && !ts.isNumericLiteral(node.initializer) && !ts.isStringLiteral(node.initializer))
          throw Error('Computed or coordinate targets cannot be remapped without a window frame');
      }
      if (ts.isPropertyAssignment(node) && ts.isNumericLiteral(node.initializer)) {
        const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
        if (['elementIndex', 'targetIndex', 'element', 'from', 'to'].includes(key)) edits.push([node.initializer.getStart(ast), node.initializer.end, String(map(Number(node.initializer.text), receiverFor(node)))]);
        if (['windowId', 'windowNumber', 'toWindowId'].includes(key)) {
          const id = this.identities.get(`${key}:${node.initializer.text}`);
          if (id === undefined) throw Error(`Unmapped ${key}: ${node.initializer.text}`);
          edits.push([node.initializer.getStart(ast), node.initializer.end, String(id)]);
        }
        if (['id', 'tabId', 'providerTabId'].includes(key)) throw Error(`Unmapped numeric selector ${key}`);
      }
      if (ts.isCallExpression(node)) {
        const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
        if (elementMethods.has(method)) {
          const targets = method === 'drag' ? [0, 1] : [0];
          for (const [index, arg] of node.arguments.entries()) {
            const numeric = ts.isNumericLiteral(arg) || ts.isPrefixUnaryExpression(arg) && ts.isNumericLiteral(arg.operand);
            if (numeric && !targets.includes(index) && !(method === 'scroll' && index === 2))
              throw Error('Unmapped numeric argument outside the supported element positions');
          }
          for (const index of targets) {
            const arg = node.arguments[index];
            if (!arg) continue;
            if (ts.isNumericLiteral(arg)) edits.push([arg.getStart(ast), arg.end, String(map(Number(arg.text), node.expression.expression.getText(ast)))]);
            else if (ts.isArrayLiteralExpression(arg)) throw Error('Coordinate handle targets have no verified window frame');
            else if (ts.isObjectLiteralExpression(arg)) {
              const names = arg.properties.map(p => p.name?.text);
              if (!names.some(key => ['elementIndex', 'element', 'targetIndex', 'id'].includes(key))) throw Error('Object handle targets have no verified window frame');
              if (names.some(key => ['x', 'y', 'from', 'to'].includes(key))) throw Error('Coordinate handle targets have no verified window frame');
              if (arg.properties.some(p => !ts.isPropertyAssignment(p))) throw Error('Computed element targets cannot be remapped safely');
            }
            else if (!ts.isStringLiteral(arg) && arg.kind !== ts.SyntaxKind.NullKeyword)
              throw Error('Computed element targets cannot be remapped safely');
          }
        } else {
          const numeric = node.arguments.some(arg => {
            const contains = n => ts.isNumericLiteral(n) || ts.forEachChild(n, contains);
            return contains(arg);
          });
          // Object window selectors are handled above. Every other unknown numeric method refuses.
          if (numeric && !['getApp', 'getTab'].includes(method)) throw Error('Unmapped numeric argument to an unsupported method');
          if (['getApp', 'getTab'].includes(method) && node.arguments.some(ts.isNumericLiteral)) throw Error('Unmapped numeric selector');
          const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression.getText(ast) : '';
          if (!observationMethods.has(method) && !['console', 'JSON', 'nodeRepl'].includes(receiver) && node.arguments.some(arg => !ts.isStringLiteral(arg)))
            throw Error('Computed arguments to an unsupported method cannot be remapped safely');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + value + code.slice(end);
    return code;
  }
  arguments(args) {
    const coordinate = value => Array.isArray(value) || value && typeof value === 'object' && ('x' in value || 'y' in value);
    if (coordinate(args.from) || coordinate(args.to) || 'x' in args || 'y' in args) {
      this.frames.assert(args.windowId, args.app);
      if (args.toWindowId !== undefined) this.frames.assert(args.toWindowId, args.app);
    }
    const walk = (value, key) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && value !== args &&
          ('x' in value || 'y' in value || coordinate(value.from) || coordinate(value.to)))
        throw Error('Nested coordinates have no verified window frame');
      if (['point', 'position', 'coordinates', 'target'].includes(key) && coordinate(value))
        throw Error('Coordinate target has no verified window frame');
      if (key === 'code' && typeof value === 'string') return this.code(value);
      if (['ref', 'to', 'submit'].includes(key) && typeof value === 'string' && /^(?:f\d+)?e\d+$|^s\d+$/.test(value)) {
        const refMap = this.refMapping(args.tab);
        if (!refMap.has(value)) throw Error(`Ambiguous or missing ref ${value}; refresh required`);
        return refMap.get(value);
      }
      if (key === 'tab' && (!this.strings.has(value) || value !== args.tab)) throw Error(`Unmapped tab or conflicting target tab: ${value}`);
      if (['elementIndex', 'element', 'targetIndex', 'from', 'to'].includes(key) && typeof value === 'number') return this.mapElement(value, nativeReceiver(args));
      if (['windowId', 'toWindowId', 'windowNumber', 'tabId', 'tab_id'].includes(key)) {
        if (!this.identities.has(`${key}:${value}`)) throw Error(`Unmapped ${key}: ${value}`);
        return this.identities.get(`${key}:${value}`);
      }
      if (Array.isArray(value)) return value.map(v => walk(v));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
      return typeof value === 'string' ? this.replaceStrings(value, false) : value;
    };
    return walk(args);
  }
}

export function normalized(text, mapper = new TargetMapper(), recorded = false, tab) {
  tab ??= tabHeaders(text)[0]?.[1];
  text = mapper.frames.normalized(text, recorded);
  text = mapper.replaceStrings(text).replace(/\r\n/g, '\n');
  if (recorded) text = text.replace(/("(?:windowId|toWindowId)"\s*:\s*)(\d+)/g, (all, prefix, id) => {
    const key = /"([^"]+)"/.exec(prefix)[1];
    return mapper.identities.has(`${key}:${id}`) ? prefix + mapper.identities.get(`${key}:${id}`) : all;
  }).replace(/(\b(?:ref|click|type|select|check|uncheck|hover|drag|fill) )((?:f\d+)?e\d+|s\d+)\b/g,
    (_, prefix, id) => prefix + (tab && mapper.tabs.get(tab)?.refMap.get(id) || id));
  const ids = new Map(elements(text).map(r => [r.id, r.key]));
  return text.replace(/^(\+ )?(\s*)\d+ (?=[a-z])/gm, '$1$2# ')
    .replace(/\[ref=(?:f\d+)?[es]\d+\]/g, '[ref=#]')
    .replace(/\b(element|index) (\d+)\b/g, (_, label, id) => `${label} ${ids.get(Number(id)) ?? id}`)
    .replace(/(\b(?:pid|windowNumber)"?\s*[:=]\s*)\d+/g,
      (_, prefix) => prefix + (prefix.includes('"') ? '"<runtime-id>"' : '<runtime-id>'))
    .trim();
}

export function refreshCode(args) {
  const ast = ts.createSourceFile('refresh.js', args.code ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const receivers = new Set();
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        elementMethods.has(node.expression.name.text)) {
      const receiver = node.expression.expression;
      if (!ts.isIdentifier(receiver)) throw Error('Refresh requires a named app handle');
      receivers.add(receiver.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (receivers.size !== 1) throw Error('Refresh needs exactly one app handle');
  return `await ${[...receivers][0]}.getAXState({ disableDiffing: true });`;
}

// Give both arms the recording's handles before comparing their observable results.
export function comparisonResult(result, mapper, documentation) {
  const reverse = new TargetMapper();
  for (const [before, after] of mapper.strings) reverse.addString(after, before.replace(/^\/private(?=\/(?:var|tmp)\/)/, ''));
  for (const [before, after] of mapper.handles) reverse.handles.set(after, before);
  for (const [key, id] of mapper.identities) reverse.identities.set(`${key.split(':')[0]}:${id}`, Number(key.split(':')[1]));
  return { isError: Boolean(result.isError),
    content: resultItems(result, documentation).map(block => {
      if (documentation?.trusted(block)) return { type: 'text', text: block.text, documentation: true };
      // The comparison marker belongs to the harness, never incoming MCP data.
      const { documentation: ignored, ...item } = block;
      return item.type === 'text' ? { ...item, text: normalized(item.text, reverse, true) }
        : item.type === 'image' ? imageShape(item) ?? { type: 'image', dimensions: 'unknown' } : item;
    }),
    structuredContent: JSON.parse(normalized(JSON.stringify(result.structuredContent ?? result.structured_content ?? null), reverse, true)) };
}

const approvalGate = /sleight stopped this payment|payment (?:confirmation|approval) (?:blocked|required)|confirmation required through the trusted consent UI|Replay approval declined|^\s*(?:approval declined|permission denied|not approved)\s*$|The user (?:didn't allow|did not allow|did not approve)|Computer Use was not approved|permission request[^\n]*(?:denied|dismissed)|waiting for (?:a |the )?(?:payment |confirmation )?card/im;

// Result status and explicit stop messages are barriers even when both arms return them.
export function replayResultStop(result, documentation) {
  const text = resultText(taskResult(result, documentation));
  if (approvalGate.test(text)) return 'confirmation or approval gate';
  if (!result || result.isError || result.error) return 'recording or replay error';
  if (/^\s*(?:[\w.]*Error:|Error\b|(?:Read or input|Input|Action|Call) refused\b|sleight stopped this call\b|Computer Use is not allowed\b|[^\n]*\bnot run:)/im.test(text))
    return 'recording or replay refusal or error';
  return null;
}

export function windowDifference(before, after, mapper = new TargetMapper(), { ordered = false } = {}) {
  const headers = text => [...text.replace(/\r\n/g, '\n').matchAll(/^Window: "[^\n]+", App: [^\n]+$/gm)].map(m => m[0]);
  const sameWindows = (a, b) => JSON.stringify(ordered ? a : a.sort()) === JSON.stringify(ordered ? b : b.sort());
  const a = headers(before), b = headers(after);
  if (!sameWindows(a.map(header => mapper.replaceStrings(header)), b))
    return 'native window or app changed';
  const x = windowReceipts(before), y = windowReceipts(after);
  const targets = (rows, recorded) => rows.map(({ target }) => JSON.stringify([
    target.appId, recorded ? mapper.replaceStrings(target.title) : target.title,
  ]));
  if (!sameWindows(targets(x, true), targets(y, false))) return 'native window or app changed';
  return null;
}

export function divergence(expected, actual, mapper = new TargetMapper(), args = {}, { comparison = 'recording', documentation } = {}) {
  const expectedText = resultText(taskResult(expected, documentation)), text = resultText(taskResult(actual, documentation));
  if (comparison === 'switches') {
    const stop = replayResultStop(expected, documentation) ?? replayResultStop(actual, documentation) ?? windowDifference(expectedText, text, mapper);
    if (stop) return stop;
  }
  if (approvalGate.test(text)) return 'confirmation or approval gate';
  if (Boolean(expected?.isError) !== Boolean(actual?.isError)) return 'success/error changed';
  const expectedMedia = (expected?.content ?? []).filter(b => b.type !== 'text');
  const actualMedia = (actual?.content ?? []).filter(b => b.type !== 'text');
  if (!matchingMedia(expectedMedia, actualMedia, expectedText, text, mapper)) return 'non-text evidence changed; visual interpretation required';
  const a = expected?.structuredContent ?? expected?.structured_content, b = actual?.structuredContent ?? actual?.structured_content;
  if (normalized(JSON.stringify(a ?? null), mapper, true, args.tab) !== normalized(JSON.stringify(b ?? null), mapper)) return 'structured result changed';
  if (comparison !== 'switches' && normalized(resultText(expected), mapper, true, tabHeaders(resultText(expected))[0]?.[1] ?? args.tab) !== normalized(resultText(actual), mapper)) return 'observable text changed';
  return null;
}
