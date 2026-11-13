// Runtime-only cell preflight. No engine wording or desktop operations.
import { parseCell, withCellCache, walk, memberCall, literalValue, handleBindings, UNKNOWN } from './code-ast.mjs';
import { MAC_API_ALIASES, normalizeMacAction, apiMisuse, validateMacRead, validateMacAcquisition } from './repl/arguments.mjs';
import { parseKeyChord } from './mac-driver/keys.mjs';

export const MAC_JS_DESCRIPTION = `Mac JS. Await calls; keep handles. Obey refusals.
getApp: let app = await cua.getApp("Calculator"); or {windowId:"123"}.
read: await app.getAXState(); current numbered tree.
click: await app.click(38, {mouseButton:"right", clickCount:1}); number, {id}, {label} or [x,y].
Menus: click the item's number; the menu need not be open.
setValue: await app.setValue(38, "text"); no focus or Return.
type: await app.typeText("text"); current focus.
key: await app.pressKey("super+s"); current focus.
scroll: await app.scroll(38, "down", {pixels:400}); or positive pages.
drag: await app.drag(38, 40); two targets.
screenshot: await app.getScreenshot(); this window.
Output: nodeRepl.write(value). Docs: await cua.rewriteDocumentation(). Apps: await cua.getState().`;

const readMethods = new Set(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']);
const actions = new Set(['click', 'doubleClick', 'rightClick', 'scroll', 'drag', 'setValue',
  'selectText', 'performSecondaryAction', 'typeText', 'paste', 'pressKey']);

// The caller retains handle names for this session, then clears them on reset.
// Literal misuse anywhere in the cell refuses before acquisition or input.
export function normalizeRuntimeCell(code, previous = new Set(['app'])) {
  const parsed = withCellCache(() => parseCell(code), { script: true });
  if (parsed.error) return { fix: `SyntaxError: ${parsed.error.reason} (line ${parsed.error.line}, column ${parsed.error.column})`, parseError: true };
  const bindings = handleBindings(parsed.ast, new Map([...previous].map(name => [name, { kind: 'app' }])));
  const handles = new Set([...bindings].filter(([, hint]) => hint.kind === 'app').map(([name]) => name));
  // Keep aliases visible to the relay, including window-id acquisitions. This
  // tracks possible handles, never authorizes a driver call or a window binding.
  const assignments = [...walk(parsed.ast)].flatMap(node => node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
    ? [{ name: node.id.name, source: node.init }] : node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier'
      ? [{ name: node.left.name, source: node.right }] : []);
  for (let pass = 0; pass <= assignments.length; pass++) {
    const before = handles.size;
    for (const { name, source } of assignments) {
      const acquisition = memberCall(source);
      if (source?.type === 'Identifier' && (handles.has(source.name) || /^__sleightOpenedApp\d+$/.test(source.name)) ||
          acquisition?.receiver.type === 'Identifier' && acquisition.receiver.name === 'cua' && acquisition.method === 'getApp') handles.add(name);
    }
    if (handles.size === before) break;
  }
  const edits = [], rewritten = new Set();
  const aliasFix = name => { throw apiMisuse(name); };
  try {
    for (const node of walk(parsed.ast)) {
      const call = memberCall(node);
      if (!call || node.type !== 'CallExpression') continue;
      const isCua = call.receiver.type === 'Identifier' && call.receiver.name === 'cua';
      const factory = memberCall(call.receiver);
      const app = call.receiver.type === 'Identifier' && handles.has(call.receiver.name) ||
        call.receiver.type === 'AwaitExpression' && factory?.receiver.type === 'Identifier' &&
        factory.receiver.name === 'cua' && factory.method === 'getApp';
      if (isCua && call.method === 'listWindows') throw apiMisuse('listWindows');
      if (isCua && call.method === 'getApp') {
        const values = call.args.map(literalValue);
        if (!values.includes(UNKNOWN)) validateMacAcquisition(values);
      }
      // A chained find().trim() throws before any API can validate its number.
      if (['trim', 'split'].includes(call.method) && memberCall(call.receiver)?.method === 'find' && !call.optional)
        throw apiMisuse('javascript');
      if (!app) {
        if (Object.hasOwn(MAC_API_ALIASES, call.method)) aliasFix(call.method);
        continue;
      }
      if (typeof call.method !== 'string') throw apiMisuse('method');
      const method = MAC_API_ALIASES[call.method] ?? call.method;
      if (method === 'pickFromList') continue; // Each generated input is inspected in the parent.
      if (!actions.has(method) && !readMethods.has(method)) throw apiMisuse('method');
      if (method !== call.method) {
        if (node.optional) aliasFix(call.method);
        // Meriyah's object range excludes wrapping parentheses. Dot edits touch
        // only the property; computed edits need an adjacent bracket to replace.
        const member = node.callee;
        if (member.type !== 'MemberExpression') aliasFix(call.method);
        const start = member.object.range[1];
        if (member.computed && !code.startsWith('[', start) && !code.startsWith('?.[', start)) aliasFix(call.method);
        rewritten.add(node.callee);
        edits.push(member.computed
          ? { start, end: member.range[1], text: (member.optional ? '?.' : '.') + method }
          : { start: member.property.range[0], end: member.property.range[1], text: method });
      }
      const values = call.args.map(literalValue);
      if (values.includes(UNKNOWN)) continue; // The facade validates computed values before dispatch.
      if (readMethods.has(method)) { validateMacRead(method, values); continue; }
      const normalized = normalizeMacAction(method, values);
      if (method === 'pressKey') {
        try { parseKeyChord(normalized.args[0]); } catch { throw apiMisuse('pressKey'); }
      }
      for (const [index, value] of normalized.args.entries()) if (JSON.stringify(value) !== JSON.stringify(values[index]))
        edits.push({ start: call.args[index].range[0], end: call.args[index].range[1], text: JSON.stringify(value) });
    }
    // Extracted aliases cannot be inspected as actions at their eventual call.
    for (const node of walk(parsed.ast)) {
      if (node.type === 'MemberExpression' && !rewritten.has(node) &&
          node.object.type === 'Identifier' && handles.has(node.object.name)) {
        const name = node.computed ? literalValue(node.property) : node.property.name;
        if (Object.hasOwn(MAC_API_ALIASES, name)) aliasFix(name);
      }
      const pattern = node.type === 'VariableDeclarator' ? node.id :
        node.type === 'AssignmentExpression' ? node.left : undefined;
      if (pattern?.type === 'ObjectPattern') for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        const name = property.computed ? literalValue(property.key) : property.key.name ?? property.key.value;
        if (Object.hasOwn(MAC_API_ALIASES, name)) aliasFix(name);
      }
    }
  } catch (error) {
    if (error.code === 'SLEIGHT_API_MISUSE') return { fix: error.message };
    throw error;
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return { code, handles };
}
