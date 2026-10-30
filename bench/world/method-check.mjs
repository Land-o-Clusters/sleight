import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let ts;

const writers = /^(?:type|typeText|type_text|insert_text|setValue|fill|paste|cut|setClipboard|writeText)$/i;
const cutOrPaste = text => /(?:command|cmd|super|meta|ctrl|control)[+\s-]+(?:(?:command|cmd|super|meta|ctrl|control|shift|alt|option)[+\s-]+)*(?:key[_-]?)?[xv]\b|shift[+\s-]+(?:key[_-]?)?insert\b/i.test(text.replace(/["'\[\],]/g, ' '));
const writeAction = /(?:^|[_\s.-])(?:type|paste|cut)(?:$|[_\s.-])|^(?:set|write)[_\s.-]?clipboard$|^clipboard[_\s.-](?:set|write)$/i;
const indirect = /^(?:eval|Function|apply|call|bind)$/;
// Native app and inventory reads in the saved engine-api-26.1013.40934.md API.
// findElement and readWindowInfo are not defined in any saved engine API.
const optionalReads = new Set(['getState', 'listApps', 'listWindows', 'listBrowsers', 'listTabs',
  'getAXState', 'getScreenshot', 'getAXStateAndScreenshot']);
const sleightPrefix = 'mcp__plugin_sleight_computer__';
// open_file appends this dedicated relay block after document content. Accept the
// full and lean notices, including the optional screenshot lead, as whole blocks.
const openedNotice = /^(?:sleight: screenshot added, the tree has no document text\. |Screenshot added: no text in tree\. )?Window handle: `(__sleightOpenedApp\d+)`(?:\.|, already acquired\. Use it in place of `app`\.|, acquired; use it for `app`\.|, (?:already acquired, but `app` isn't set:|acquired;) start the next call with `let app = \1;`\.)$/;
const builtins = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'Number', 'String', 'Boolean']);
const ordinaryTools = new Set(['notifications', 'turn_ended', 'blocked_app', 'hover', 'open_file', 'js_reset', 'ToolSearch']);
const methods = new Set(['getApp', 'getState', 'listApps', 'listWindows', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot',
  'click', 'doubleClick', 'rightClick', 'scroll', 'drag', 'pressKey', 'press', 'keypress', 'keyPress', 'selectText',
  'performAction', 'performSecondaryAction', 'focus', 'hover', 'waitFor', 'log', 'stringify', 'find', 'filter',
  // Pure string and array reads. The engine API has no method by these names, so none can type or paste.
  'slice', 'includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'trim', 'split', 'join', 'map', 'some', 'every',
  'match', 'test', 'toString', 'toLowerCase', 'toUpperCase', 'at', 'keys', 'values', 'entries']);
function refusedBeforeExecution(name, success, content) {
  if (success || name !== 'mcp__plugin_sleight_computer__js') return false;
  const text = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : '';
  return /^(?:sleight stopped this call before it ran: `js` has no `require` and no file system access\.|sleight skipped this call: `js` has no `require` or file access\.)$/.test(text);
}
function literal(node) {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(literal);
  return ts.isObjectLiteralExpression(node) && node.properties.every(p =>
    ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && literal(p.initializer));
}
// Supplement saved artifacts with drag and prohibited replacement patterns.
export function dragMethodAudit(transcript, { diagnostics = false } = {}) {
  ts ??= require('typescript');
  const logical = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);
  const audit = { drag: false, replacement: false, complete: true }, pending = new Map(), apps = new Set();
  const issues = [];
  let issuesOmitted = 0, transcriptLine = 0;
  // Opt-in offsets identify the unproved expression without copying document text or tool arguments.
  const incomplete = (code, node, file) => {
    audit.complete = false;
    if (!diagnostics) return;
    if (issues.length >= 64) { issuesOmitted++; return; }
    issues.push({ code, call: calls, transcriptLine,
      ...(node ? { start: node.getStart(file), end: node.getEnd() } : {}) });
  };
  let calls = 0, engine = true, openedHandle = false;
  const inspect = (name, input, success, content) => {
    calls++;
    if (!input || typeof input !== 'object' || Array.isArray(input)) { incomplete('invalid-input'); return; }
    // Sleight's preflight never sent this request to the engine. Failed engine calls still need inspection.
    if (refusedBeforeExecution(name, success, content)) return;
    const tool = name.split('__').at(-1);
    const sleight = name === sleightPrefix + tool;
    if (sleight && tool === 'open_file' && success && Array.isArray(content)) {
      const last = content.filter(c => c?.type === 'text').at(-1);
      const match = typeof last?.text === 'string' && openedNotice.exec(last.text);
      if (match) { apps.add(match[1]); openedHandle = true; }
    }
    if (tool === 'replay') incomplete('replay');
    if (tool === 'blocked_app' && input.op === 'type') audit.replacement = true;
    if (typeof input.code === 'string') {
      const file = ts.createSourceFile('tool.js', input.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      if (file.parseDiagnostics.length) incomplete('invalid-code');
      if (!success) apps.clear();
      const bind = (name, value, deferred) => {
        if (!ts.isIdentifier(name)) { apps.clear(); return; }
        if (name.text === 'cua') { engine = false; apps.clear(); incomplete('engine-rebound', name, file); }
        const call = value && ts.isAwaitExpression(value) ? value.expression : undefined;
        const acquired = call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) &&
          ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'cua' &&
          call.expression.name.text === 'getApp' && !(call.flags & ts.NodeFlags.OptionalChain);
        const alias = value && ts.isIdentifier(value) && apps.has(value.text);
        if ((acquired && engine || alias) && !deferred && success) apps.add(name.text);
        else apps.delete(name.text);
      };
      const visit = (node, deferred = false) => {
        deferred ||= ts.isFunctionLike(node) || ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isIterationStatement(node, false) ||
          ts.isCaseClause(node) || ts.isDefaultClause(node) || ts.isCatchClause(node) || ts.isTryStatement(node);
        if (ts.isSourceFile(node) || ts.isBlock(node)) {
          const locals = new Map();
          // Declarations shadow for the whole scope, including calls before a
          // hoisted function or a class's temporal dead zone.
          for (const statement of node.statements) {
            const names = [];
            if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name) names.push(statement.name);
            if (ts.isImportDeclaration(statement) && statement.importClause) {
              const clause = statement.importClause;
              if (clause.name) names.push(clause.name);
              if (clause.namedBindings) {
                if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name);
                else names.push(...clause.namedBindings.elements.map(binding => binding.name));
              }
            }
            for (const name of names) {
              if (!locals.has(name.text)) locals.set(name.text, apps.has(name.text));
              bind(name, undefined, deferred);
            }
          }
          let stopped;
          for (const statement of node.statements) {
            if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped)) for (const declaration of statement.declarationList.declarations) {
              if (ts.isIdentifier(declaration.name) && !locals.has(declaration.name.text)) locals.set(declaration.name.text, apps.has(declaration.name.text));
            }
            const end = visit(statement, deferred);
            if (!deferred && end !== undefined) { stopped = end; deferred = true; }
          }
          if (ts.isBlock(node)) for (const [name, known] of locals) { if (known) apps.add(name); else apps.delete(name); }
          return stopped;
        }
        if (ts.isLabeledStatement(node)) {
          const end = visit(node.statement, deferred);
          return end === ts.SyntaxKind.ReturnStatement || end === ts.SyntaxKind.ThrowStatement ? end : undefined;
        }
        if ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isImportClause(node) ||
          ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) && node.name) bind(node.name, undefined, deferred);
        if (ts.isVariableDeclaration(node)) bind(node.name, node.initializer, deferred);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
          if (ts.isIdentifier(node.left)) bind(node.left, node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined, deferred);
          else { apps.clear(); incomplete('property-assignment', node, file); }
        }
        if (ts.isCallExpression(node)) {
          const expr = node.expression, method = ts.isPropertyAccessExpression(expr) ? expr.name.text :
            ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression) ? expr.argumentExpression.text : '';
          const receiver = ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) &&
            (apps.has(expr.expression.text) || engine && expr.expression.text === 'cua');
          const read = sleight && openedHandle && receiver && (node.flags & ts.NodeFlags.OptionalChain) && optionalReads.has(method) &&
            node.arguments.every(arg => literal(arg) && !cutOrPaste(arg.getText(file)));
          const known = ts.isPropertyAccessExpression(expr) ? methods.has(method) || writers.test(method) || read || ['nodeRepl.write', 'nodeRepl.emitImage'].includes(expr.getText(file)) : ts.isIdentifier(expr) && builtins.has(expr.text);
          if (!known || indirect.test(method)) incomplete(indirect.test(method) ? 'indirect-call' : 'unknown-call', node, file);
          if (writers.test(method)) audit.replacement = true;
          if (/^(pressKey|press|keypress|keyPress)$/.test(method)) {
            if (!node.arguments.length || !node.arguments.every(literal)) incomplete('dynamic-key', node, file);
            if (node.arguments.some(arg => cutOrPaste(arg.getText(file)))) audit.replacement = true;
          }
          if (method === 'drag' && !deferred && !(node.flags & ts.NodeFlags.OptionalChain) &&
            ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && apps.has(expr.expression.text) &&
            ts.isAwaitExpression(node.parent) && success) audit.drag = true;
        }
        const shortCircuit = ts.isBinaryExpression(node) && logical.has(node.operatorToken.kind);
        ts.forEachChild(node, child => { visit(child, deferred || (shortCircuit && child === node.right)); });
        if (!deferred && (ts.isReturnStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node) || ts.isThrowStatement(node))) return node.kind;
      };
      visit(file);
    } else {
      const action = String(input.action ?? input.op ?? tool);
      if (tool === 'js_reset') { apps.clear(); engine = true; openedHandle = false; }
      // A refused drag moved nothing and typed nothing, so it neither proves nor spoils the method (WD1, 2026-10-17).
      if (/^(drag|mouse_drag|drag_and_drop)$/.test(action)) { if (success) audit.drag = true; }
      else if (writers.test(action) || writeAction.test(action)) audit.replacement = true;
      else if (!ordinaryTools.has(tool) && !/^(?:click|double_click|mouse_move|move|scroll|press|keypress|key|hotkey|screenshot|see|read|list|get|focus|select|menu)(?:$|[_\s.-])/i.test(action)) incomplete('unknown-action');
      if (cutOrPaste(JSON.stringify(input))) audit.replacement = true;
    }
  };
  for (const [index, line] of String(transcript ?? '').split('\n').entries()) {
    if (!line) continue;
    transcriptLine = index + 1;
    let event; try { event = JSON.parse(line); } catch { incomplete('invalid-json'); continue; }
    if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
      const item = event.item;
      let input = item.arguments === undefined ? {} : item.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
      const name = item.server ? `mcp__${item.server}__${(item.tool ?? '').split('__').at(-1)}` : item.tool ?? '';
      inspect(name, input, item.status !== 'failed' && !!item.result && item.result.isError !== true && !item.error, item.result?.content);
    }
    for (const item of event.message?.content ?? []) {
      if (item.type === 'tool_use') pending.set(item.id, { item, line: index + 1 });
      if (item.type === 'tool_result') {
        const entry = pending.get(item.tool_use_id);
        if (!entry) { transcriptLine = index + 1; incomplete('unmatched-result'); continue; }
        const request = entry.item;
        transcriptLine = entry.line;
        pending.delete(item.tool_use_id);
        inspect(request.name, request.input, item.is_error !== true && event.tool_use_result?.isError !== true,
          item.content ?? event.tool_use_result?.content);
      }
    }
  }
  if (!calls) incomplete('no-calls');
  for (const entry of pending.values()) { transcriptLine = entry.line; incomplete('pending-call'); }
  return diagnostics ? { ...audit, issues, issuesOmitted } : audit;
}
