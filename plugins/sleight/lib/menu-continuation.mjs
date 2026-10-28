import { randomUUID } from 'node:crypto';
import { memberCall, literalValue, arrowRegexTest, UNKNOWN } from './code-ast.mjs';
import { statementSpans } from './text-save.mjs';
import { GUARD_END, GUARD_MARK, documentKey, elementLines, hasIdentifier, hasLabel, sameElement, windowFromText } from './document-scope.mjs';
import { verifyWindowIdentity } from './window-identity.mjs';

export const guardStopMark = () => `[sleight:guard-stop:${randomUUID()}]`;

const ACTIONS = ['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText'];
const isName = node => node?.type === 'Identifier';
const directCall = node => {
  const call = memberCall(node);
  return call && !call.optional && !call.computed ? call : null;
};
const onHandle = (call, handle) => call && isName(call.receiver) && call.receiver.name === handle;
const integer = node => node?.type === 'Literal' && Number.isInteger(node.value) && node.value >= 0;
const string = node => typeof literalValue(node) === 'string';
const propertyName = node => isName(node) ? node.name : literalValue(node);
// Preserve the data-only argument subset, excluding spread, holes, getters and computed keys.
function literalArgument(node) {
  if (string(node) || integer(node)) return true;
  if (node?.type === 'Literal') return node.value === null || typeof node.value === 'boolean';
  if (node?.type === 'UnaryExpression') return node.operator === '-' && integer(node.argument);
  if (node?.type === 'ArrayExpression') return node.elements.every(literalArgument);
  if (node?.type === 'ObjectExpression') return node.properties.every(property =>
    property.type === 'Property' && property.kind === 'init' && !property.method && !property.shorthand && !property.computed &&
    (isName(property.key) || string(property.key) || integer(property.key)) && literalArgument(property.value));
  return false;
}
const literalArgs = args => args.every(literalArgument);
const binding = node => {
  if (node.type === 'VariableDeclaration' && node.declarations.length === 1) {
    const declaration = node.declarations[0];
    if (isName(declaration.id)) return { name: declaration.id.name, value: declaration.init };
  }
  const expression = node.type === 'ExpressionStatement' ? node.expression : undefined;
  if (expression?.type === 'AssignmentExpression' && expression.operator === '=' && isName(expression.left))
    return { name: expression.left.name, value: expression.right };
};

// Only the call's first statement can acquire or rename its one action handle.
function acquisition(node, alias) {
  const bound = binding(node);
  if (!bound) return;
  if (isName(bound.value) && !forbidden.has(bound.value.name) && bound.value.name !== bound.name)
    return alias(bound.value.name) ? bound.name : undefined;
  const call = bound.value?.type === 'AwaitExpression' ? directCall(bound.value.argument) : null;
  if (!onHandle(call, 'cua') || call.method !== 'getApp' || call.args.length !== 1) return;
  const argument = call.args[0];
  const window = argument.type === 'ObjectExpression' && argument.properties.length === 1 && argument.properties[0];
  const selector = string(argument) || window && window.type === 'Property' && !window.computed && !window.method && !window.shorthand &&
    window.kind === 'init' && propertyName(window.key) === 'windowId' && integer(window.value);
  return selector ? bound.name : undefined;
}

const forbidden = new Set(['await', 'cua', 'nodeRepl', 'import', 'require', 'eval', 'Function', 'globalThis', 'process', 'constructor',
  '__proto__', 'prototype', 'then', 'catch', 'finally', 'call', 'apply', 'bind', ...ACTIONS]);
const READS = new Set(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']);
const STRING_READS = new Set(['split', 'slice', 'join', 'trim']), CALLBACK_READS = new Set(['filter', 'find', 'some']);
const writeLiteral = node => string(node) || integer(node) || node?.type === 'UnaryExpression' && node.operator === '-' && integer(node.argument);

// An AST allowlist: this handle's getAXState, an earlier bound read, or literal text/number,
// followed only by named properties and the existing string/regex read methods.
function writeArgument(node, handle, names) {
  if (writeLiteral(node)) return true;
  if (isName(node)) return names.has(node.name) && !forbidden.has(node.name);
  if (node?.type === 'MemberExpression') return !node.computed && !node.optional && isName(node.property) &&
    !forbidden.has(node.property.name) && node.property.name !== 'getAXState' && writeArgument(node.object, handle, names);
  if (node?.type !== 'CallExpression') return false;
  const call = directCall(node);
  if (!call) return false;
  if (onHandle(call, handle) && call.method === 'getAXState') return literalArgs(call.args);
  if (!writeArgument(call.receiver, handle, names)) return false;
  if (STRING_READS.has(call.method)) return call.args.every(writeLiteral);
  return CALLBACK_READS.has(call.method) && call.args.length === 1 && arrowRegexTest(call.args[0]) !== null;
}

// Returns the name a trailing read binds, '' when it binds none, or undefined on refusal.
function trailingRead(node, handle, names) {
  if (node.type === 'DebuggerStatement') return '';
  const expression = node.type === 'ExpressionStatement' ? node.expression : undefined;
  if (expression) {
    if (expression.type === 'ThisExpression' || expression.type === 'Literal' &&
        (expression.value === null || typeof expression.value === 'boolean')) return '';
    if (isName(expression) && !forbidden.has(expression.name) || writeArgument(expression, handle, names)) return '';
    const call = directCall(expression);
    if (onHandle(call, 'nodeRepl') && call.args.length === 1) {
      if (call.method === 'write' && writeArgument(call.args[0], handle, names)) return '';
      const argument = call.args[0];
      const shot = argument.type === 'AwaitExpression' ? directCall(argument.argument) : null;
      if (call.method === 'emitImage' && onHandle(shot, handle) && shot.method === 'getScreenshot' && literalArgs(shot.args)) return '';
    }
    const read = expression.type === 'AwaitExpression' ? directCall(expression.argument) : null;
    if (onHandle(read, handle) && read.method === 'getAXState' && literalArgs(read.args)) return '';
  }
  const bound = binding(node);
  if (!bound || bound.name === handle || forbidden.has(bound.name) || bound.value?.type !== 'AwaitExpression') return;
  const read = directCall(bound.value.argument);
  return onHandle(read, handle) && READS.has(read.method) && literalArgs(read.args) ? bound.name : undefined;
}

function actionSelector(call) {
  const value = literalValue(call.args[0]);
  if (call.args.length !== 1 || value === UNKNOWN) return;
  if (call.method === 'pressKey' && typeof value === 'string') return { kind: 'key', value };
  if (call.method !== 'click') return;
  if (typeof value === 'string') return { kind: 'label', value };
  if (integer(call.args[0])) return { kind: 'number', value };
  if (Array.isArray(value) && value.length === 2 && call.args[0].elements.every(integer)) return { kind: 'point', value };
  const property = call.args[0].type === 'ObjectExpression' && call.args[0].properties.length === 1 && call.args[0].properties[0];
  const key = property && propertyName(property.key);
  if (['label', 'id'].includes(key) && typeof value[key] === 'string') return { kind: key, value: value[key] };
}

// Only standalone awaited inputs on one handle. Reads can follow, but never precede another input.
export function splitMenuActions(code, { alias = name => /^__sleightOpenedApp\d+$/.test(name) } = {}) {
  if (typeof code !== 'string' || code.length > 65536) return;
  const split = statementSpans(code);
  if (!split) return;
  const actions = [];
  let acquired, count = 0, tail = false;
  const names = new Set();
  for (const node of split.nodes) {
    if (node.type === 'EmptyStatement') continue;
    count++;
    if (count === 1 && (acquired = acquisition(node, alias))) continue;
    const expression = node.type === 'ExpressionStatement' ? node.expression : undefined;
    const call = expression?.type === 'AwaitExpression' ? directCall(expression.argument) : null;
    if (!call || !isName(call.receiver) || !ACTIONS.includes(call.method)) {
      const bound = actions.length ? trailingRead(node, actions[0].handle, names) : undefined;
      if (bound === undefined) return;
      if (bound) names.add(bound);
      tail = true; continue;
    }
    if (tail || !literalArgs(call.args)) return;
    const handle = call.receiver.name;
    if (actions.length ? handle !== actions[0].handle : acquired && handle !== acquired) return;
    actions.push({ start: node.range[0], end: node.range[1], handle, selector: actionSelector(call), node: expression });
  }
  return actions.length > 1 ? { code, actions } : undefined;
}

export function takeGuardStop(content, mark) {
  let receipt, count = 0, input = false, adopted;
  const paid = [];
  const bindings = [];
  const tabProbes = [];
  const head = [];
  const cleaned = content.flatMap(item => {
    if (item?.type !== 'text' || typeof item.text !== 'string') { if (!count) head.push(item); return [item]; }
    const text = item.text.split('\n').filter(line => {
      if (!line.startsWith(mark)) { if (!count) head.push({ ...item, text: line }); return true; }
      let record;
      try { record = JSON.parse(line.slice(mark.length)); } catch { /* An invalid receipt proves nothing. */ }
      if (record?.input === true) { input = true; return false; }
      // The guard moved to a window in another app this call acquired; the last one counts.
      if (record?.adopted) { adopted = record.adopted; return false; }
      // A payment the guard let through (payment-gate.mjs), for the request's count.
      if (record?.paid) { paid.push(record.paid); return false; }
      if (record?.binding) { bindings.push(record.binding); return false; }
      if (record?.tabProbe) { tabProbes.push(record.tabProbe); return false; }
      count++; receipt = record;
      return false;
    }).join('\n');
    return text ? [{ ...item, text }] : [];
  });
  return { content: cleaned, head, receipt: count === 1 ? receipt : undefined, input, adopted, paid, bindings, tabProbes };
}

// A tab or navigation continuation passes through a stop on a page Claude never asked about (Firefox's New Tab, 381
// lines). takeGuardStop's head holds that tree one line per item and the stop's own copy follows whole, so the continued
// result carried it twice, 101,881 characters before the page on MDN (2026-10-18), and Claude Code rejected it. This
// takes both copies and the notes about the stop's window out and returns them apart, so the result is what the call
// reached; text around the tree (safety and refusal lines, output before it) stays.
const STOP_TREE_HEADER = /^(?:Window: |Browser tab: )[^\n]+$/;
const STOP_TREE_LINE = /^$|^(?:[+~-] )?\t*\d+ |^\t|^Close tab$/;
const STOP_WINDOW_NOTE = /^sleight: (?:this call acted on |UI changed \()/;
const FOCUS_LINE = /^The focused UI element/m;
const stopTreeLine = item => item?.type === 'text' && typeof item.text === 'string' && !item.text.includes('\n') &&
  (STOP_TREE_LINE.test(item.text) || item.text.startsWith('The focused UI element'));
export const hasWholeTree = content => (content ?? []).some(item => item?.type === 'text' && /^\n*(?:Window: |Browser tab: )[^\n]*\n0 /.test(item.text ?? ''));
export function withoutStopTree(content) {
  const kept = [], tree = [];
  for (let i = 0; i < content.length; i++) {
    const item = content[i], text = item?.type === 'text' && typeof item.text === 'string' ? item.text : undefined;
    if (text === undefined) { kept.push(item); continue; }
    if (STOP_TREE_HEADER.test(text)) {
      // One line per item, up to and including the focus line.
      tree.push(item);
      while (i + 1 < content.length && stopTreeLine(content[i + 1])) {
        tree.push(content[++i]);
        if (content[i].text.startsWith('The focused UI element')) break;
      }
      continue;
    }
    if (/^\n*(?:Window: |Browser tab: )[^\n]+\n/.test(text)) {
      // The whole copy, then anything the stop said after its focus line, then the notes about the stop's window.
      const focus = FOCUS_LINE.exec(text), after = focus ? text.slice(focus.index + text.slice(focus.index).search(/\n|$/)).replace(/^\n+/, '') : '';
      tree.push(item);
      if (after.trim()) kept.push({ ...item, text: after });
      while (i + 1 < content.length && STOP_WINDOW_NOTE.test(content[i + 1]?.text ?? '')) tree.push(content[++i]);
      continue;
    }
    kept.push(item);
  }
  return { content: kept, tree };
}

// The stop came right after plan action n - 1, the one the receipt names, so n indexes the rest.
function stoppedAfter(plan, receipt) {
  const n = receipt?.index, prev = receipt?.prev;
  if (!plan || receipt?.windowStop === false || !Number.isSafeInteger(n) || n < 1 || n >= plan.actions.length || !prev) return;
  const selector = plan.actions[n - 1].selector;
  if (!selector || JSON.stringify(selector.value) !== JSON.stringify(prev.value) ||
      !['label', 'id', 'key', 'number', 'point'].includes(prev.kind) ||
      (selector.kind === 'label' ? !['label', 'id'].includes(prev.kind) : selector.kind !== prev.kind)) return;
  return n;
}
const stopTree = (receipt, content) => {
  const text = content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const window = windowFromText(text), tree = text.slice(text.indexOf('Window: ')), root = /^\d+ (.*)$/m.exec(tree);
  return window && root && receipt.root === root[0] ? { window, tree, line: root[1] } : undefined;
};

// `palette` (SLEIGHT_WB1=1): a gallery or palette window the call's own label or ID click opened continues the call too.
// Word's Styles button opened "0 window Styles" and stopped the gallery pick after it in 5 of 107 saved word-edit runs
// (2026-10-17 and 18), each costing one to three calls. Only a URL-less window, floating window or popover of the same
// app, titled exactly as the clicked control and holding no document area. The relay then checks that it is the app's
// focused window in the same process with no user input since the call (paletteRefusal).
export function menuRemainder(plan, receipt, expected, content, { palette = false } = {}) {
  const n = stoppedAfter(plan, receipt), prev = receipt?.prev;
  if (n === undefined) return;
  const stopped = stopTree(receipt, content);
  if (!stopped || stopped.window.app !== expected.app) return;
  const { window, tree, line } = stopped;
  // Only label or ID clicks may follow (review F1, 2026-10-18): a "Sign In" or "Share" button can open a window with an
  // account field, and keys or text after the click would land in it. A window with a secure field never takes the rest.
  if (palette && ['label', 'id'].includes(prev.kind) && plan.actions.slice(n).every(action => ['label', 'id'].includes(action.selector?.kind))) {
    const role = PALETTE_ROLES.find(role => line.startsWith(role + ' '));
    const title = role && line.slice(role.length + 1).split(/, (?:Secondary Actions|ID|Description|Help|URL): /)[0];
    const named = !!title && window.title === title && (prev.kind === 'label' ? title === prev.value
      : typeof prev.line === 'string' && hasIdentifier(prev.line, prev.value) && hasLabel(prev.line, title));
    if (named && !window.url && !/(?:^|, )URL: /.test(line) && !/^\t*\d+ (?:text area|text entry area|web area|HTML content|secure text field)\b/im.test(tree)) {
      return { code: plan.code.slice(plan.actions[n].start).trim(), window, tree, palette: true };
    }
  }
  if (/^standard window(?: |,|$)/.test(line)) {
    if (window.title === expected.title || /^\s*\d+ (?:sheet|dialog)\b/m.test(tree)) return;
    // Only windows without editable document content: nothing proves this call's key caused the retitle, and a
    // retitle into a document (Return opening a file, a tab switch) would put the rest of the call's input there.
    // Any case: Firefox names its page "HTML Content" (342 of 342 reads in the 2026-10-17 race round), which the
    // lowercase test let through as a navigation.
    if (/^\t*\d+ (?:text area|text entry area|web area|HTML content)\b/im.test(tree)) return;
    return { code: plan.code.slice(plan.actions[n].start).trim(), window, tree, navigation: true };
  }
  if (!['label', 'id'].includes(prev.kind)) return;
  // Some engine menus have a named parent at the root and an unnamed menu below it.
  const role = /^menu(?: |,|$)/.test(line), secondary = /(?:^|, )Secondary Actions: Cancel(?:,|$)/.test(line);
  if (!role && !(secondary && /^\t+\d+ menu(?: |$)/m.test(tree))) return;
  const title = (role ? line.replace(/^menu(?: |$)/, '') : line).split(/, (?:Secondary Actions|ID|Description|Help): /)[0];
  if (!title || /^(?:Secondary Actions|ID|Description|Help):/.test(title)) return;
  const named = prev.kind === 'label' ? title === prev.value : typeof prev.line === 'string' &&
    hasIdentifier(prev.line, prev.value) && hasLabel(prev.line, title) &&
    (!/^[a-z]+(?: [a-z]+)* /.test(prev.line) || /^(?:menu item|menu bar item|menu button|pop up button) /.test(prev.line));
  if (!named) return;
  return { code: plan.code.slice(plan.actions[n].start).trim(), window, tree };
}

// A tab this call's own shortcut or new-tab button opened in the window it leased. In the Firefox race round (2026-10-17)
// Cmd+T retitled the window to the new tab's in 8 of 12 tasks and stopped the URL's typing; the 2026-10-18 round stopped 9
// of 9 (6 Cmd+T, 3 clicks on the button) with the continuation firing 0 of 9. Only Cmd+T or Ctrl+T, or a plain click on a
// button that sits among the window's tabs, and only when the tree shows exactly one tab more
// than the window Claude last saw, that tab selected, no sheet or dialog, and focus on an editable field outside
// any page or document, where the rest's typing lands. `before` is the earlier tree's lines by element number.
const TAB_KEY = /^(?:super|cmd|command|meta|ctrl|control)\+t$/i;
// The tabs of a tree's entries ({ depth, line }), leaving out any under a page or document: an ARIA tab list inside page
// content is not the window's own tab strip. `valueOn`: a tab line with no state in parentheses is selected by its
// `Value: on` attribute, as Safari marks its tabs (Value: on or off, no "(selected)").
const tabsOf = (entries, { valueOn = false } = {}) => entries.flatMap((entry, index) => {
  // "tab group" is the strip itself (and Safari's page area), never a tab; a tab titled "group chat" stays one (review).
  const tab = !/^tab group(?:$|,| (?:Description|ID|Help|Secondary Actions): )/.test(entry.line) && /^tab((?: \([^)]*\))*)(?: (.*))?$/.exec(entry.line);
  if (!tab || underDocument(entries, index)) return [];
  const label = tab[2] ?? '';
  const selected = tab[1] ? /\((?:[^)]*, )?selected(?:, [^)]*)?\)/.test(tab[1]) : valueOn && /, Value: on(?:,|$)/.test(label);
  return [{ label, selected, index }];
});
// A tab's label without the attributes that follow selection: Safari's active tab alone carries a Help line and
// `isActive=true` in its ID, and every tab a `Value: on` or `off`. The same tab before and after Cmd+T then compares equal.
const tabKey = label => label.replace(/, Help: .*?(?=, (?:Value|Secondary Actions|ID): |$)/, '')
  .replace(/, Value: (?:on|off)(?=,|$)/, '').replace(/\bisActive=(?:true|false)\b/g, 'isActive=');
// The title a tab line names before its attributes ("Gate" in "tab Gate, Value: off, ID: ..."), or '' for a label that
// starts with an attribute (Firefox's "Value: <title>, <title>").
const tabTitle = label => /^(?:Description|Help|Value|Secondary Actions|ID): /.test(label) ? ''
  : label.split(/, (?:Description|Help|Value|Secondary Actions|ID): /)[0];
// An app that hides its tab strip for a single tab (Safari) shows none in the earlier tree, and the strip appears with two
// tabs when Cmd+T opens the second: the window's own tab, unselected and named as the window Claude last saw (`title`, which
// may carry a profile name in front), and the new one, selected. Anything else (more tabs, the old tab still selected, a tab
// named otherwise) is not this window gaining one tab.
function hiddenStripOpened(was, now, title) {
  if (was.length !== 0 || now.length !== 2 || typeof title !== 'string' || !title) return false;
  if (now.filter(tab => tab.selected).length !== 1) return false;
  const old = tabTitle(now.find(tab => !tab.selected).label);
  return !!old && (title === old || title.endsWith(' ' + old));
}
// The window's own tab strip: the tabs directly under the first tab group of a standard window's tree, read from the numbered
// chain that runs 0, 1, 2... without a gap and stops at the first page or document. Page text shaped like a tab line sits
// after the page's root or breaks the chain, so it never counts. undefined when the tree has no such strip.
function windowTabs(tree) {
  if (typeof tree !== 'string') return;
  const lines = tree.split('\n'), root = lines.findIndex(line => /^0 standard window(?: |,|$)/.test(line));
  if (root < 0) return;
  const entries = [];
  for (const line of lines.slice(root)) {
    const entry = /^(\t*)(\d+) (.*)$/.exec(line);
    if (!entry) continue; // A value's own later lines (Firefox's "Close tab").
    if (Number(entry[2]) !== entries.length || DOCUMENT_ROLE.test(entry[3])) break;
    entries.push({ depth: entry[1].length, line: entry[3] });
  }
  const group = entries.findIndex(entry => /^tab group(?: |,|$)/.test(entry.line));
  if (group < 0) return;
  const tabs = [];
  for (let i = group + 1; i < entries.length && entries[i].depth > entries[group].depth; i++) {
    const tab = entries[i].depth === entries[group].depth + 1 && /^tab((?: \([^)]*\))*)(?: (.*))?$/.exec(entries[i].line);
    if (tab) tabs.push({ label: tab[2] ?? '', selected: /\((?:[^)]*, )?selected(?:, [^)]*)?\)/.test(tab[1]) });
  }
  return tabs.length ? tabs : undefined;
}
// The same tab strip with exactly one tab more, that tab selected: tabs only as labels, by count.
function oneMoreTab(was, now) {
  const selected = now.filter(tab => tab.selected);
  if (now.length !== was.length + 1 || selected.length !== 1) return false;
  const left = new Map();
  for (const tab of now) left.set(tabKey(tab.label), (left.get(tabKey(tab.label)) ?? 0) + 1);
  for (const tab of was) {
    if (!left.get(tabKey(tab.label))) return false;
    left.set(tabKey(tab.label), left.get(tabKey(tab.label)) - 1);
  }
  return [...left].every(([label, count]) => count === (label === tabKey(selected[0].label) ? 1 : 0));
}
// Whether `after` is the window Claude last saw as `before` with one new tab opened in it. A browser window's title follows its
// active tab, so a new tab retitles the same window: Firefox's New Tab page has no title, and the window reads "Mozilla
// Firefox" (mdn b7 r2, 2026-10-19). The earlier strip must list `title` whole, as Firefox's `Value: <title>, <title>` or a
// plain label. A tab switch adds no tab, and another window that merely lists the title has other tabs, so both stay false.
export function oneTabAdded(before, after, title) {
  const was = windowTabs(before), now = windowTabs(after);
  if (!was || !now || !title || !was.some(({ label }) => [title, `Value: ${title}, ${title}`].includes(label))) return false;
  return oneMoreTab(was, now);
}
// Whether a tree's standard window shows tabs outside any page with exactly one marked selected: the earlier tree a Cmd+T
// tab continuation compares against (tabRefusal's tabsOf). Safari marks its tabs Value: on/off and shows no strip for one tab.
export function selectedTabShown(tree) {
  if (typeof tree !== 'string' || !/^0 standard window(?: |,|$)/m.test(tree)) return false;
  const entries = [...tree.matchAll(/^(\t*)\d+ (.*)$/gm)].map(([, depth, line]) => ({ depth: depth.length, line }));
  return tabsOf(entries).filter(tab => tab.selected).length === 1;
}
// The earlier tree as entries. seenLines keeps the indentation when asked, which says what sat under a page; lines without it
// all count as the window's own.
const earlierEntries = before => Object.entries(before).filter(([, line]) => typeof line === 'string').sort(([a], [b]) => a - b)
  .map(([number, line]) => ({ depth: /^\t*/.exec(line)[0].length, number: Number(number), line: line.replace(/^\t*/, '') }));
export function underDocument(entries, at) {
  for (let i = at - 1, depth = entries[at].depth; i >= 0 && depth > 0; i--) {
    if (entries[i].depth >= depth) continue;
    depth = entries[i].depth;
    if (DOCUMENT_ROLE.test(entries[i].line)) return true;
  }
  return false;
}
// The line a click named, as Claude saw it before the call: its receipt's line for a label or ID, else the earlier tree's.
const clickedLine = (prev, before) => {
  const line = prev.kind === 'number' ? before?.[prev.value] : ['label', 'id'].includes(prev.kind) ? prev.line : undefined;
  return typeof line === 'string' ? line.replace(/^\t*/, '') : undefined;
};
// The new-tab button, by where it is and not by what it says: a button whose line is unique in the stopped tree, outside any
// page or document, with a tab beside it (same parent), the way Firefox lists "Open a new tab" among its tabs. Its entry index,
// or -1. The tab count check proves it opened a tab.
const isTab = line => /^tab(?: |$)/.test(line) && !/^tab group(?: |,|$)/.test(line);
function tabStripButton(entries, line) {
  if (!/^button(?: |,|$)/.test(line)) return -1;
  const at = entries.flatMap((entry, i) => entry.line === line ? [i] : []);
  if (at.length !== 1 || underDocument(entries, at[0])) return -1;
  const depth = entries[at[0]].depth;
  for (const step of [-1, 1]) for (let i = at[0] + step; entries[i]?.depth >= depth; i += step) if (entries[i].depth === depth && isTab(entries[i].line)) return at[0];
  return -1;
}
const DOCUMENT_ROLE = /^(?:web area|HTML content|text area|text entry area)(?: |,|$)/i;
const APP_FIELD = /^(?:text field|combo box|search field|search text field)(?: |,|$)/i;
// `hiddenStrip` (SLEIGHT_TABC, on by default): Safari's tabs count by `Value: on`, and a window that showed no strip before
// may show two (hiddenStripOpened). Safari's Cmd+T stopped 36 of 36 runs inside Codex and 7 of 7 in Claude Code (race-1017).
export function tabRefusal(plan, receipt, expected, content, before, { hiddenStrip = false } = {}) {
  if (!receipt) return 'no-receipt';
  if (receipt.windowStop !== true) return 'not-a-window-stop';
  if (!plan) return 'unsplit-call';
  const n = stoppedAfter(plan, receipt);
  if (n === undefined) return 'receipt-mismatch';
  const key = receipt.prev.kind === 'key', button = key ? undefined : clickedLine(receipt.prev, before);
  if (key ? !TAB_KEY.test(receipt.prev.value) : button === undefined || !/^button(?: |,|$)/.test(button)) return 'not-a-tab-shortcut';
  const stopped = stopTree(receipt, content);
  if (!stopped) return 'tree-mismatch';
  if (stopped.window.app !== expected?.app) return 'other-app';
  if (!/^standard window(?: |,|$)/.test(stopped.line)) return 'root-not-standard';
  if (stopped.window.title === expected.title && stopped.window.url === expected.url) return 'same-header';
  if (/^\s*\d+ (?:sheet|dialog|system dialog)\b/m.test(stopped.tree)) return 'sheet';
  if (!before || typeof before !== 'object') return 'no-earlier-tree';
  const entries = [...stopped.tree.matchAll(/^(\t*)(\d+) (.*)$/gm)].map(([, depth, number, line]) => ({ depth: depth.length, number: Number(number), line }));
  const was = tabsOf(earlierEntries(before), { valueOn: hiddenStrip }), now = tabsOf(entries, { valueOn: hiddenStrip });
  // The hidden strip needs the earlier tree to be this window's whole tree: its root line, under the title Claude saw, and
  // every number from 0 up with none left out. A result that folded or trimmed lines (a toolbar holding a strip) leaves a gap,
  // and a strip Claude never saw can't count as none (review: a tab switch would then look like a tab opening).
  const numbers = Object.keys(before).map(Number).sort((a, b) => a - b);
  const whole = numbers.every((number, i) => number === i) && typeof before[0] === 'string' &&
    before[0].replace(/^\t*/, '').startsWith(`standard window ${expected.title}`);
  const hidden = hiddenStrip && button === undefined && whole && hiddenStripOpened(was, now, expected.title);
  if (!oneMoreTab(was, now) && !hidden) return 'no-new-tab';
  const selected = now.filter(tab => tab.selected);
  if (button !== undefined) {
    const at = tabStripButton(entries, button);
    if (at < 0) return 'not-a-tab-button';
    // The new tab is the last one or the one beside the button; a button that opens a tab elsewhere in the strip is not this one.
    const near = [now.findLast(tab => tab.index < at), now.find(tab => tab.index > at)];
    if (selected[0] !== now.at(-1) && !near.includes(selected[0])) return 'not-a-tab-button';
  }
  // The engine names focus after the tree; it must be an app field, and none of its ancestors a page or document.
  const focused = Number(/^The focused UI element is (\d+) /m.exec(stopped.tree)?.[1]);
  const at = entries.findIndex(entry => entry.number === focused);
  if (at < 0 || !APP_FIELD.test(entries[at].line)) return 'focus-not-app-field';
  if (underDocument(entries, at)) return 'focus-in-document';
}
export function tabRemainder(plan, receipt, expected, content, before, options) {
  if (tabRefusal(plan, receipt, expected, content, before, options)) return;
  const stopped = stopTree(receipt, content);
  return { code: plan.code.slice(plan.actions[stoppedAfter(plan, receipt)].start).trim(), window: stopped.window, tree: stopped.tree,
    navigation: true, tab: true };
}
// LB6: after a tab continuation's Return, the engine's header can name the page while the tree under it is still the new tab
// (Firefox mdn inside Codex, 2 of 37 continuations: "Window: 418 I'm a teapot" over "0 standard window Mozilla Firefox" and
// the New Tab page). Whether the last whole tree in `text` has landed: its standard window root names the header's title.
// 'title-lag' when it doesn't, undefined when it does or there is no standard window tree to judge.
const ROOT_ATTRIBUTE = /(?:^|, )(?:Secondary Actions|ID|Description|Help|URL|Value): /;
export function landingRefusal(text) {
  if (typeof text !== 'string') return;
  const headers = [...text.matchAll(/^Window: .*$/gm)], last = headers.at(-1);
  if (!last) return;
  const tree = text.slice(last.index), window = windowFromText(tree), root = /^0 standard window(.*)$/m.exec(tree);
  if (!window || !root || /^\d+ /m.exec(tree)?.index !== root.index) return;
  const title = root[1].replace(/^ /, '').split(ROOT_ATTRIBUTE)[0];
  return title === window.title ? undefined : 'title-lag';
}
// A text's last whole window tree: its header through the focus line, or up to a guard mark after it, or to the end.
function lastTree(text) {
  const header = [...text.matchAll(/^Window: .*\n0 /gm)].at(-1);
  if (!header) return;
  const rest = text.slice(header.index), focus = /^The focused UI element[^\n]*/m.exec(rest), mark = rest.search(/\n\[\/?sleight:/);
  return { start: header.index, end: header.index + Math.min(focus ? focus.index + focus[0].length : rest.length, mark >= 0 ? mark : rest.length) };
}
// The window the last header in `text` names, or undefined.
export function lastHeader(text) {
  const header = typeof text === 'string' ? [...text.matchAll(/^Window: .*$/gm)].at(-1) : undefined;
  return header ? windowFromText(text.slice(header.index)) : undefined;
}
// `content` with its last whole window tree replaced by the last whole tree in `fresh`, a later read's text (the guard may
// print its own copy of the read first). Undefined when either has no tree.
export function replaceLastTree(content, fresh) {
  const found = typeof fresh === 'string' ? lastTree(fresh) : undefined;
  if (!found || !Array.isArray(content)) return;
  const tree = fresh.slice(found.start, found.end).replace(/\n+$/, '');
  for (let i = content.length - 1; i >= 0; i--) {
    const item = content[i];
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    const at = lastTree(item.text);
    if (!at) continue;
    const { start, end } = at;
    return content.map((other, j) => j === i ? { ...item, text: item.text.slice(0, start) + tree + item.text.slice(end) } : other);
  }
}

// The native side of the same check, from the helper's focus observation of the window: no sheet, and focus on a
// text field or combo box in it that isn't a password field and has no web area (or HTML content) above it. A helper
// that doesn't report the page check refuses.
export function tabFocusRefusal(observed) {
  const focus = observed?.focus;
  if (!focus || typeof focus !== 'object') return 'no-native-focus';
  if (focus.sheets !== 0) return 'native-sheet';
  if (focus.inWindow !== true) return 'focus-outside-window';
  if (focus.subrole === 'AXSecureTextField') return 'secure-field';
  if (!['AXTextField', 'AXComboBox'].includes(focus.role)) return 'focus-not-text-field';
  if (focus.inPage !== false) return 'focus-in-page';
}

// The lease held a dialog or sheet, the call's own action closed it, and the window in front is the one the lease
// held before it appeared: same app, title and URL. Word's Replace All alert stopped 7 of 8 word-edit runs on its
// OK this way (2026-10-17). Anything else (another document, app or new window) is not the covered window.
export function dialogRemainder(plan, receipt, covered, content) {
  const refusal = dialogRefusal(plan, receipt, covered, content);
  if (refusal && refusal !== 'palette-needs-close-check') return;
  const stopped = stopTree(receipt, content);
  return { code: plan.code.slice(plan.actions[stoppedAfter(plan, receipt)].start).trim(), window: stopped.window, tree: stopped.tree, dialog: true,
    closeCheck: !!refusal };
}
const certifiedWindow = identity => Number.isSafeInteger(identity?.windowNumber) && identity.windowNumber > 0 &&
  typeof identity.epoch === 'string' && identity.epoch !== '' && Number.isSafeInteger(identity.pid);
// Why a stop is no dialog remainder, for the relay's trace: live runs showed only that none fired (word-edit, 2026-10-17).
export function dialogRefusal(plan, receipt, covered, content) {
  if (!receipt) return 'no-receipt';
  if (receipt.windowStop !== true) return 'not-a-window-stop';
  if (!covered) return 'no-covered-window';
  if (!plan) return 'unsplit-call';
  if (stoppedAfter(plan, receipt) === undefined) return 'receipt-mismatch';
  const stopped = stopTree(receipt, content);
  if (!stopped) return 'tree-mismatch';
  const key = ['app', 'title', 'url'].find(key => stopped.window[key] !== covered[key]);
  if (key) return `other-${key}`;
  // A dialog over the document closing onto another dialog under its title (Word's sheet root) is not the document.
  if (!/^standard window(?: |,|$)/.test(stopped.line)) return 'returned-root-not-standard';
  // "Don't Save" on an untitled document's dialog or sheet closes the document too, and focus can land on another window
  // with its title. Without a URL, only the native window certified when it was read tells them apart.
  if (!covered.url && ['dialog', 'sheet', 'system dialog'].includes(covered.over) && !certifiedWindow(covered.nativeIdentity)) return 'untitled-needs-certified-window';
  // A palette that stays open hands focus back without closing; only Escape or a native check that it is gone counts.
  if (PALETTE_ROLES.includes(covered.over) && !(receipt.prev?.kind === 'key' && /^(?:escape|esc)$/i.test(receipt.prev.value))) return 'palette-needs-close-check';
}
// Roots that cover a standard window without being a dialog: a palette, Word's Styles gallery or Table grid (plain
// `window`), Excel's Sort panel (`floating window`), and an AXPopover. SLEIGHT_POPOVER_CONTINUATION=0 leaves out popover only.
export const PALETTE_ROLES = ['window', 'floating window', 'popover'];
export const COVER_ROLES = ['sheet', 'dialog', 'system dialog', ...PALETTE_ROLES];

// The standard windows a result showed, by documentKey: each header whose own section has a standard-window root.
// A filtered write's extra header (no root line) adds nothing.
export function shownStandardWindows(text) {
  const keys = new Set();
  if (typeof text !== 'string') return keys;
  const headers = [...text.matchAll(/^Window: .*$/gm)];
  headers.forEach((header, i) => {
    const section = text.slice(header.index, headers[i + 1]?.index);
    if (!/^0 standard window(?: |,|$)/.test(/^0 .*$/m.exec(section)?.[0] ?? '')) return;
    const window = windowFromText(section);
    if (window) keys.add(documentKey({ title: window.title, app: window.app, url: window.url }));
  });
  return keys;
}

// SLEIGHT_PARENT_LEASE: the dialog or palette the lease last held closed between calls, the lease dropped on a degraded
// read, and the next call's re-acquisition shows the standard window it covered. That stopped 7 calls as stale in the
// 2026-10-17 office runs ("it was Insert Table", Word's alert, Styles). The covered window becomes the lease only when
// every check holds; LA1's in-call adoption failed review for typing into a window it hadn't verified, so this one needs
// Claude's last result to show that window, this call's read to show it standard with no dialog, and the helper to see
// the dialog gone and that exact window focused, standard, in the process it was seen in, with no HID input since.
// `stale` is the dialog lease (with .parent), `shown` the last result's shownStandardWindows, `reply` this call's read,
// `gone` whether the helper found no window with the dialog's title and URL, `observed` the helper's look at the parent.
// Which relay states never take the parent lease: the flag off, a stale window that isn't the recovery re-acquisition's,
// an active select_window selection, document scope, change review, no helper, element numbers in the rest (they may be
// the dialog's), or a read showing anything but the covered window with its bundle.
export function parentLeaseGate({ enabled, recovered, selected, documentMode, changeReview, helper, numbers = [], browser, stale, window }) {
  if (!enabled) return 'off';
  if (!recovered) return 'not-recovered';
  if (selected) return 'selected-window';
  if (documentMode) return 'document-scope';
  if (changeReview) return 'change-review';
  if (!helper) return 'no-helper';
  const parent = stale?.parent;
  if (!parent) return 'no-parent';
  if (!window || window.appId !== parent.appId || ['title', 'app', 'url'].some(key => window[key] !== parent[key])) return 'not-the-covered-window';
  if (numbers.length) return 'element-numbers';
  // A browser plan skips the native admission that checks the pin.
  if (browser) return 'browser-plan';
}
export function parentLeaseRefusal({ stale, shown, reply, gone, observed, now = performance.now() }) {
  const parent = stale?.parent;
  if (!parent) return 'no-parent';
  if (!COVER_ROLES.includes(parent.over)) return 'not-over-a-dialog';
  if (!parent.appId || stale.appId !== parent.appId) return 'other-bundle';
  // The helper skips windows without a title, so `gone` can't see an untitled dialog or palette. A sheet is no window
  // of its own: the tree and the native sheet count below see it.
  if (!stale.title && parent.over !== 'sheet') return 'untitled-cover';
  const key = documentKey({ title: parent.title, app: parent.app, url: parent.url });
  if (!shown?.has(key)) return 'not-shown';
  const window = typeof reply === 'string' ? windowFromText(reply) : undefined;
  if (!window) return 'no-header';
  const differs = ['app', 'title', 'url'].find(name => window[name] !== parent[name]);
  if (differs) return `other-${differs}`;
  const roots = [...reply.matchAll(/^0 .*$/gm)];
  if (!roots.length || roots.some(root => !/^0 standard window(?: |,|$)/.test(root[0]))) return 'returned-root-not-standard';
  if (/^\s*\d+ (?:sheet|dialog|system dialog)\b/m.test(reply)) return 'dialog-present';
  if (gone !== true) return 'dialog-still-open';
  const certified = certifiedWindow(parent.nativeIdentity) ? parent.nativeIdentity : undefined;
  if (!parent.url && !certified) return 'untitled-needs-certified-window';
  // The helper answers mismatch when the window with this header isn't the app's focused one.
  if (observed?.status === 'mismatch') return 'identity-mismatch';
  if (!observed || observed.status !== 'ok') return 'identity-unavailable';
  if (!Number.isSafeInteger(observed.windowNumber) || observed.windowNumber <= 0) return 'no-window-number';
  if (observed.windowSubrole !== 'AXStandardWindow') return 'not-standard-native';
  if (observed.focus?.sheets !== 0) return 'native-sheet';
  // HID idle since the parent was last seen standard and since the dialog was leased, as in the in-call path.
  if (!idle(observed, Math.min(parent.at, parent.seenAt), now)) return 'hid-input';
  if (typeof parent.seen?.process !== 'string' || parent.seen.process !== `${observed.pid}:${observed.processStart}`) return 'covered-process-changed';
  if (!certified && observed.headerMatches !== 1) return `header-matches-${observed.headerMatches ?? 'missing'}`;
  try {
    verifyWindowIdentity({ appId: parent.appId, title: parent.title, url: parent.url,
      ...(certified ? { windowNumber: certified.windowNumber, nativeIdentity: certified } : {}) }, observed);
  } catch { return 'identity-mismatch'; }
}
// The palette the lease held is gone: no window of the app has its title and URL any more.
export async function windowGone(identity, window, timeoutMs = 600) {
  let timer;
  try {
    const observed = await Promise.race([Promise.resolve().then(() => identity(window)), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    return observed?.status === 'ok' && observed.headerMatches === 0;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

const idle = (observed, since, now = performance.now()) => Number.isFinite(observed.hidIdleSeconds) && Number.isFinite(since) &&
  observed.hidIdleSeconds >= (now - since) / 1000 + 0.05;

// The covered window is the app's focused one again: its certified native window, or else the only window with its
// title and URL before focus narrows them (a second same-title window would take the rest otherwise), the process
// the dialog's baseline had, and no user input since the dialog was leased and the call was sampled.
export const returnedWindow = (covered, baseline, observed, since, now) => !returnRefusal(covered, baseline, observed, since, now);
export function returnRefusal(covered, baseline, observed, since, now = performance.now()) {
  if (!covered) return 'no-covered-window';
  if (!observed) return 'identity-unavailable';
  // The dialog's own identity from before the call ties the returned window to the same process.
  if (!baseline) return 'no-baseline';
  if (!Number.isSafeInteger(observed.windowNumber) || observed.windowNumber <= 0) return 'no-window-number';
  if (!idle(observed, since, now)) return 'hid-input';
  if (['epoch', 'pid', 'processStart'].some(key => observed[key] !== baseline[key])) return 'process-changed';
  const certified = covered.nativeIdentity;
  if (!certified && observed.headerMatches !== 1) return `header-matches-${observed.headerMatches ?? 'missing'}`;
  try {
    verifyWindowIdentity({ appId: covered.appId, title: covered.title, url: covered.url,
      ...(certified ? { windowNumber: certified.windowNumber, nativeIdentity: certified } : {}) }, observed);
  } catch { return 'identity-mismatch'; }
}

// Why a palette the call's own click opened (menuRemainder's `palette`) can't take the rest of the call, or undefined when
// it can: the helper must see it as the app's focused window, the only one with its title and no URL, in the process the
// call's baseline had, with a window number of its own, and no user input since the call was sampled. `expected` is the
// palette ({ appId, title, url: null }) and `baseline` the leased window's identity from before the call.
export function paletteRefusal(expected, baseline, observed, since, now = performance.now()) {
  if (!observed) return 'identity-unavailable';
  if (!baseline) return 'no-baseline';
  // A dialog, system dialog or sheet asks for a decision; only a panel-like window takes the rest (review F1).
  if (['AXDialog', 'AXSystemDialog', 'AXSheet'].includes(observed.windowSubrole)) return 'dialog-subrole';
  if (!Number.isSafeInteger(observed.windowNumber) || observed.windowNumber <= 0) return 'no-window-number';
  if (observed.windowNumber === baseline.windowNumber) return 'same-window';
  if (!idle(observed, since, now)) return 'hid-input';
  if (['epoch', 'pid', 'processStart'].some(key => observed[key] !== baseline[key])) return 'process-changed';
  if (observed.headerMatches !== 1) return `header-matches-${observed.headerMatches ?? 'missing'}`;
  try { verifyWindowIdentity({ appId: expected.appId, title: expected.title, url: null }, observed); } catch { return 'identity-mismatch'; }
}

// A key that types nothing: a named key, or a shortcut with a modifier other than Shift.
const NAMED_KEY = /^(?:(?:shift\+)*(?:return|enter|escape|esc|tab|space|delete|backspace|forwarddelete|home|end|pageup|pagedown|(?:arrow)?(?:up|down|left|right)|f\d{1,2})|(?:[a-z]+\+)*(?:super|cmd|command|meta|ctrl|control|alt|option)\+(?:[a-z]+\+)*[^+]+)$/i;

// What a lease stop sent and didn't, so Claude needn't take a screenshot to find out. Method names, IDs, element
// numbers and non-typing keys only: typed or set text, single characters and label text stay out.
// `closed`: the lease held a dialog, sheet or panel over a standard window, so an action that ran and then a stop onto a
// standard window means the call's own action closed it (OK, then a click: 6 of 15 Office mid-call stops, 2026-10-17).
// `tab`: the stop is a tab this call opened (tabRefusal passes). Its title changes but the window keeps its app handle, and
// the select_window advice sent Claude to a refused call in 2 of 9 Firefox runs (2026-10-18). The wording holds whether or
// not the continuation then runs.
export function stopNote(receipt, plan, earlier = 0, { content, seen, uniqueSeen, closed = false, tab = false } = {}) {
  if (receipt?.refused === true) return refusalNote(receipt, plan, earlier, content, seen, uniqueSeen);
  if (receipt?.windowStop !== true || /: app changed\./.test(receipt.error ?? '')) return;
  const dialog = closed && /^standard window(?: |,|$)/.test(stopTree(receipt, content ?? [])?.line ?? '');
  // The stop leased the window it shows, so the rest needs no re-read: in the Firefox race round (2026-10-17) Claude
  // spent a call only reading again after 10 of 12 new-tab stops.
  const recipe = ran => /* lean notice */ !ran ? '' : dialog ? ' Closing the dialog stopped the rest; the next call can send it to the window shown here with no new read.'
    : tab ? ' After an action that opens a tab or page, end the call there; this window keeps its app handle, so send the rest on it after reading the result.'
    : ' After an action that opens a tab or page, end the call there; the next call can send the rest to the window shown here with no new read.';
  const n = receipt.index;
  if (plan && !earlier && Number.isSafeInteger(n) && n >= 0 && n < plan.actions.length) {
    const list = actionList(plan);
    const ran = plan.actions.slice(0, n);
    return /* lean notice */ `sleight: this call ran ${count(n)}${n ? ` (${list(ran)})` : ''}; not sent: ${list(plan.actions.slice(n))}.${recipe(n)}`;
  }
  const ran = (Number.isSafeInteger(receipt.completed) ? receipt.completed : 0) + earlier;
  return /* lean notice */ `sleight: this call ran ${count(ran)}; the stopped ${typeof receipt.name === 'string' ? receipt.name : 'action'} and everything after it were not sent.${recipe(ran)}`;
}
const count = n => `${n} action${n === 1 ? '' : 's'}`;
const actionName = plan => action => {
  const method = memberCall(action.node)?.method ?? 'unknown action', { kind, value } = action.selector ?? {};
  const shown = kind === 'number' || kind === 'id' && value.length <= 40 || kind === 'key' && NAMED_KEY.test(value);
  return shown ? `${method} ${kind === 'id' ? `id ${JSON.stringify(value)}` : kind === 'key' ? JSON.stringify(value) : value}` : method;
};
const actionList = plan => {
  const name = actionName(plan);
  return actions => actions.slice(0, 4).map(name).join(', ') + (actions.length > 4 ? ` and ${actions.length - 4} more` : '');
};

// An action that threw (not a lease stop or refusal, which stopNote words): its error, the methods that ran before it,
// the action as the guard showed it, and an app handle's argument order when the call used a tab's. Safari mdn r2
// (race-1017): `pressKey(null, "Return")` after a setValue got only "call failed (partial input possible)", and Claude
// read the window again before sending Return (6.0 s). Strings show only as named keys or the guard's lengths.
const APP_SHAPES = { pressKey: ['key', key => key ?? '<key>'], typeText: ['text', () => '<text>'] };
export function failedActionText(receipt) {
  const error = typeof receipt?.error === 'string' ? receipt.error : undefined;
  if (!error || receipt.windowStop === true || receipt.refused === true || /^(?:Input lease|sleight\b)/.test(error) ||
      typeof receipt.shown !== 'string') return error;
  // The guard cuts an argument over 40 characters to 37 and "...", which can leave its string open.
  const shown = receipt.shown.replace(/"(?:[^"\\]|\\.)*"|"[^"]*?\.\.\.(?=, |\)$)/g, literal => {
    try { const value = JSON.parse(literal); return receipt.name === 'pressKey' && NAMED_KEY.test(value) ? literal : '"…"'; } catch { return '"…"'; }
  });
  const ran = (Array.isArray(receipt.ran) ? receipt.ran : []).map(action => /^(\w+)\(/.exec(String(action))?.[1]).filter(Boolean);
  const shape = APP_SHAPES[receipt.name], tabForm = /^\w+\((?:null|undefined|\d+), /.exec(shown);
  const key = /^\w+\([^,]+, ("[^"]*")\)$/.exec(shown)?.[1];
  const hint = shape && tabForm ? /* lean notice */ ` An app handle's ${receipt.name} takes the ${shape[0]} first: ${receipt.name}(${shape[1](key)}).` : '';
  if (!ran.length && !hint) return error;
  const list = ran.slice(0, 4).join(', ') + (ran.length > 4 ? ` and ${ran.length - 4} more` : '');
  return /* lean notice */ `${error.replace(/[.!?]?$/, '.')} ${ran.length ? `${list} ran; ` : ''}${shown} failed.${hint}`;
}

// The line a call that went on past its own dialog close, menu, tab or navigation opens with. It had opened with the stop
// it no longer was in 6 of 6 such Office calls (2026-10-17), and 4 cost a turn redoing or checking an action that had run.
// `n` actions ran before the window changed, `over` is the root the lease held (sheet, dialog, window), `title` the
// window the rest went to, and `failed` whether the rest's result is an error. Names as in stopNote.
const CHANGED = { menu: 'opened a menu', palette: 'opened a panel', tab: 'opened a tab', navigation: 'changed the window' };
export function continuedNote(plan, n, kind, { over, title, failed } = {}) {
  if (!plan || !Number.isSafeInteger(n) || n < 1 || n >= plan.actions.length) return;
  const list = actionList(plan);
  const what = kind === 'dialog' ? `closed the ${over === 'sheet' ? 'sheet' : PALETTE_ROLES.includes(over) ? 'panel' : 'dialog'}`
    : CHANGED[kind] ?? CHANGED.navigation;
  const first = list(plan.actions.slice(0, n)), rest = list(plan.actions.slice(n));
  const where = typeof title === 'string' && title ? ` in ${JSON.stringify(title)}` : '';
  return failed ? /* lean notice */ `sleight: ${first} ${what}, and the call went on${where} with ${rest} until an error stopped it.`
    : /* lean notice */ `sleight: all ${count(plan.actions.length)} ran: ${first} ${what}, then ${rest}${where}.`;
}

// The engine refused an element number its capture no longer held: a date picker re-rendered its days after the
// first date's click (Firefox travel, 2026-10-17), and Claude spent a diff read, a full read and a lone click (9.4 s)
// finding out what ran. With the guard's fresh tree (receipt.fresh), this says what ran, what didn't, and where each
// remaining target is now. Numbers only: label text stays out, as above. A number Claude wrote maps through the line it
// saw only as the guard's own remap allows: that line was unique in Claude's tree and carries an ID, Description or Help.
function refusalNote(receipt, plan, earlier, content, seen, uniqueSeen) {
  const n = receipt.index, element = /(\d+) is an invalid element ID/.exec(receipt.error ?? '')?.[1];
  const refused = /* lean notice */ `the engine refused the next ${typeof receipt.name === 'string' ? receipt.name : 'action'}` +
    (element ? ` (element ${element})` : '') + (receipt.bound
    ? ': its number came from this call\'s first read, and the element changed (perhaps replaced by an earlier action)' : ': that element is gone');
  const after = /* lean notice */ receipt.bound ? ' sleight now reads this window before each numbered or named action, so the rest can go in one call.' : '';
  // The tree the guard emitted after the refusal: the call's last marked read, since the refusal ended the call.
  const text = (content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
  const mark = text.lastIndexOf(GUARD_MARK), end = mark >= 0 ? text.indexOf(GUARD_END, mark) : -1;
  const fresh = receipt.fresh === true && end >= 0 ? text.slice(mark + GUARD_MARK.length, end) : undefined;
  const current = /* lean notice */ fresh ? ' This result\'s window is current.' : ' sleight couldn\'t read the window after it, so read it before acting.';
  const aligned = plan && !earlier && Number.isSafeInteger(n) && n >= 0 && n < plan.actions.length && receipt.completed === n;
  if (!aligned) {
    const ran = (Number.isSafeInteger(receipt.completed) ? receipt.completed : 0) + earlier;
    return /* lean notice */ `sleight: this call ran ${count(ran)}; ${refused}. Nothing after it was sent.${current}${after}`;
  }
  const name = actionName(plan), list = actionList(plan);
  const lines = fresh ? [...elementLines(fresh)] : [];
  const only = found => found.length === 1 ? found[0][0] : '?';
  const now = action => {
    const { kind, value } = action.selector ?? {}, method = name(action).split(' ')[0];
    if (kind === 'label') return `${method} ${only(lines.filter(([, line]) => hasLabel(line, value)))}`;
    if (kind === 'id') return `${method} ${only(lines.filter(([, line]) => hasIdentifier(line, value)))}`;
    if (kind === 'number') {
      const was = seen?.[value];
      const mapped = typeof was === 'string' && uniqueSeen?.includes(value) && /\b(?:ID|Description|Help): /.test(was);
      return `${method} ${mapped ? only(lines.filter(([, line]) => sameElement(was, line))) : '?'}`;
    }
    return name(action);
  };
  const rest = plan.actions.slice(n), shown = rest.slice(0, 8).map(now);
  const targets = fresh && rest.some(action => ['label', 'id', 'number'].includes(action.selector?.kind))
    ? /* lean notice */ ` In this result's window, the refused action and the rest are now ${shown.join(', ')}${rest.length > 8 ? ` and ${rest.length - 8} more` : ''}` +
      (shown.some(action => action.endsWith(' ?')) ? ' (? where the target is ambiguous or missing).' : '.') : current;
  return /* lean notice */ `sleight: this call ran ${count(n)}${n ? ` (${list(plan.actions.slice(0, n))})` : ''}; ` +
    `${refused}. Not sent after it: ${rest.length > 1 ? list(rest.slice(1)) : 'nothing'}.${targets}${after}`;
}

export async function menuIdentity(identity, expected, timeoutMs = 600, refused) {
  let timer;
  try {
    const observed = await Promise.race([Promise.resolve().then(() => identity(expected)),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    return verifyWindowIdentity(expected, observed);
  } catch (error) { refused?.(String(error?.message ?? error)); return undefined; }
  finally { clearTimeout(timer); }
}

// Why a menu, navigation or tab continuation's window isn't the one the call started in, or undefined when it is.
export function menuWindowRefusal(expected, baseline, observed, forwardedAt, now = performance.now()) {
  if (!baseline || !Number.isSafeInteger(baseline.windowNumber) || baseline.windowNumber <= 0) return 'no-window-number';
  if (!observed) return 'identity-unavailable';
  if (observed.windowNumber !== baseline.windowNumber) return 'window-number-changed';
  if (!idle(observed, forwardedAt, now)) return 'hid-input';
  try { verifyWindowIdentity({ ...expected, nativeIdentity: baseline }, observed); } catch { return 'identity-mismatch'; }
}
export const unchangedMenuWindow = (expected, baseline, observed, forwardedAt, now = performance.now()) =>
  !menuWindowRefusal(expected, baseline, observed, forwardedAt, now);
// What the HID-idle test saw, for the relay's trace. A tab continuation asks for idle since its stop result arrived (`stopAt`):
// the engine's own key presses all came before it, and the user's input after it could interleave with the rest's typing.
// `callAt` adds whether idle also covered the whole call, which the 2026-10-18 Firefox stops (0 of 9) never did.
export const idleSample = (observed, stopAt, now = performance.now(), callAt) => ({
  hidIdleSeconds: Number.isFinite(observed?.hidIdleSeconds) ? observed.hidIdleSeconds : null,
  sinceStopSeconds: Number.isFinite(stopAt) ? Math.round(now - stopAt) / 1000 : null,
  idleSinceStop: !!observed && idle(observed, stopAt, now),
  ...(Number.isFinite(callAt) ? { idleCoversCall: !!observed && idle(observed, callAt, now) } : {}) });
