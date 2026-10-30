// Independent TypeScript checks for newly accepted statement-consumer results.
// Parse only. Nothing links, evaluates, launches an app or loads bench/run.mjs.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let ts;
import { createHash } from 'node:crypto';
import * as text from '../../plugins/sleight/lib/text-save.mjs';
import * as menu from '../../plugins/sleight/lib/menu-continuation.mjs';
import * as tab from '../../plugins/sleight/lib/tab-probe.mjs';
import { legacyConsumers } from '../../tests/fixtures/statement-legacy/index.mjs';

const actions = new Set(['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']);
// Match the engine's module context, including top-level await before a regex.
const sourceFile = code => ts.createSourceFile('cell.mjs', code, { languageVersion: ts.ScriptTarget.Latest,
  impliedNodeFormat: ts.ModuleKind.ESNext, setExternalModuleIndicator: source => { source.externalModuleIndicator = true; } }, true, ts.ScriptKind.JS);
const forbidden = new Set(['await', 'cua', 'nodeRepl', 'import', 'require', 'eval', 'Function', 'globalThis', 'process', 'constructor',
  '__proto__', 'prototype', 'then', 'catch', 'finally', 'call', 'apply', 'bind', ...actions]);
const unparen = node => { while (node && ts.isParenthesizedExpression(node)) node = node.expression; return node; };
const name = node => node && ts.isIdentifier(node) ? node.text : undefined;
const string = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const integer = node => node && ts.isNumericLiteral(node) && Number.isInteger(Number(node.text)) && Number(node.text) >= 0;
const awaited = node => node && ts.isAwaitExpression(node) ? unparen(node.expression) : undefined;
const call = node => {
  node = unparen(node);
  if (!node || !ts.isCallExpression(node) || node.questionDotToken) return;
  const member = unparen(node.expression);
  if (!ts.isPropertyAccessExpression(member) || member.questionDotToken) return;
  return { receiver: unparen(member.expression), method: member.name.text, args: [...node.arguments] };
};
const data = root => {
  const pending = [root];
  while (pending.length) {
    const node = unparen(pending.pop());
    if (string(node) !== undefined || integer(node) || node &&
        [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) continue;
    if (node && ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) { pending.push(node.operand); continue; }
    if (node && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.MinusToken) {
      pending.push(node.left, node.right); continue;
    }
    if (node && ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) if (!ts.isOmittedExpression(element)) pending.push(element);
      continue;
    }
    if (!node || !ts.isObjectLiteralExpression(node)) return false;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return false;
      if (ts.isComputedPropertyName(property.name)) pending.push(property.name.expression);
      else if (!name(property.name) && string(property.name) === undefined && !integer(property.name)) return false;
      pending.push(property.initializer);
    }
  }
  return true;
};
const binding = (statement, source) => {
  if (ts.isVariableStatement(statement) && /^(?:const|let|var)\b/.test(statement.getText(source)) &&
      statement.declarationList.declarations.length === 1) {
    const declaration = statement.declarationList.declarations[0];
    if (name(declaration.name)) return { name: name(declaration.name), value: unparen(declaration.initializer) };
  }
  const expression = ts.isExpressionStatement(statement) && unparen(statement.expression);
  if (expression && ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && name(expression.left))
    return { name: name(expression.left), value: unparen(expression.right) };
};
const writeLiteral = node => string(unparen(node)) !== undefined || integer(unparen(node)) || node &&
  ts.isPrefixUnaryExpression(unparen(node)) && unparen(node).operator === ts.SyntaxKind.MinusToken && integer(unparen(node).operand);
function regexCallback(node) {
  node = unparen(node);
  if (!node || !ts.isArrowFunction(node) || node.modifiers?.length || node.parameters.length !== 1 ||
      !name(node.parameters[0].name) || node.parameters[0].dotDotDotToken || node.parameters[0].initializer) return false;
  const test = call(node.body);
  return test?.method === 'test' && test.args.length === 1 && name(test.args[0]) === name(node.parameters[0].name) &&
    test.receiver.kind === ts.SyntaxKind.RegularExpressionLiteral;
}
function readExpression(node, handle, names) {
  for (let depth = 0; depth < 1024; depth++) {
    node = unparen(node);
    if (writeLiteral(node)) return true;
    if (name(node)) return names.has(name(node)) && !forbidden.has(name(node));
    if (node && ts.isPropertyAccessExpression(node)) {
      if (node.questionDotToken || forbidden.has(node.name.text) || node.name.text === 'getAXState') return false;
      node = node.expression; continue;
    }
    const read = call(node);
    if (!read) return false;
    if (name(read.receiver) === handle && read.method === 'getAXState') return read.args.every(data);
    if (['split', 'slice', 'join', 'trim'].includes(read.method) ? !read.args.every(writeLiteral)
      : !['filter', 'find', 'some'].includes(read.method) || read.args.length !== 1 || !regexCallback(read.args[0])) return false;
    node = read.receiver;
  }
  return false;
}
function trailing(statement, source, handle, names) {
  if (statement.kind === ts.SyntaxKind.DebuggerStatement) return true;
  let expression = ts.isExpressionStatement(statement) && unparen(statement.expression);
  if (expression) {
    if ([ts.SyntaxKind.ThisKeyword, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(expression.kind) ||
        name(expression) && !forbidden.has(name(expression)) || readExpression(expression, handle, names)) return true;
    expression = awaited(expression) ?? expression;
    const output = call(expression);
    if (name(output?.receiver) === 'nodeRepl' && output.args.length === 1) {
      if (output.method === 'write' && readExpression(output.args[0], handle, names)) return true;
      const screenshot = call(awaited(output.args[0]));
      if (output.method === 'emitImage' && name(screenshot?.receiver) === handle && screenshot.method === 'getScreenshot' && screenshot.args.every(data)) return true;
    }
    const read = ts.isAwaitExpression(statement.expression) && call(expression);
    if (name(read?.receiver) === handle && read.method === 'getAXState' && read.args.every(data)) return true;
  }
  const bound = binding(statement, source), read = call(awaited(bound?.value));
  if (!bound || bound.name === handle || forbidden.has(bound.name) || name(read?.receiver) !== handle ||
      !['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(read.method) || !read.args.every(data)) return false;
  names.add(bound.name); return true;
}

export function justifyResult(code, consumer, result) {
  ts ??= require('typescript');
  const source = sourceFile(code);
  const statements = [...source.statements];
  if (consumer === 'statements') return JSON.stringify(result.spans) ===
    JSON.stringify(statements.map(statement => [statement.getStart(source), statement.end])) ? null : 'statement-ranges';
  if (source.parseDiagnostics.length) return 'typescript-syntax';
  if (consumer === 'textSave') {
    let written = new Set(), exits = false;
    for (const statement of statements) {
      if (statement.kind === ts.SyntaxKind.EmptyStatement) continue;
      const bound = binding(statement, source);
      const expression = ts.isExpressionStatement(statement) ? unparen(statement.expression) :
        ts.isVariableStatement(statement) && bound ? bound.value : undefined;
      const action = call(awaited(expression));
      let opaque = false, exit = false;
      const visit = node => {
        if (node.kind === ts.SyntaxKind.RegularExpressionLiteral || ts.isTemplateExpression(node)) opaque = true;
        if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) exit = true;
        ts.forEachChild(node, visit);
      };
      visit(statement);
      if (!action || !name(action.receiver) || opaque) written = new Set();
      else if (action.method === 'setValue') written.add(name(action.receiver));
      else if (action.method === 'pressKey' && action.args.length === 1 &&
          /^(?:cmd|command|super|meta)\+s$/i.test(string(unparen(action.args[0])) ?? '') && written.has(name(action.receiver))) {
        return !exits && result.handle === name(action.receiver) && result.head === code.slice(0, statement.getStart(source)).trim() &&
          result.tail === code.slice(statement.getStart(source)).trim() ? null : 'save-boundary';
      }
      exits ||= exit;
    }
    return 'missing-save';
  }
  const plan = consumer === 'tab' ? result.plan : result;
  if (!plan || plan.actions.length < 2) return 'missing-plan';
  const byStart = new Map(plan.actions.map(action => [action.start, action]));
  const names = new Set();
  let acquired, count = 0, tail = false, actionCount = 0;
  for (const statement of statements) {
    if (statement.kind === ts.SyntaxKind.EmptyStatement) continue;
    count++;
    const bound = binding(statement, source);
    if (count === 1 && bound) {
      const app = call(awaited(bound.value));
      const argument = app?.args[0];
      const window = argument && ts.isObjectLiteralExpression(argument) && argument.properties.length === 1 && argument.properties[0];
      const selector = string(argument) !== undefined || window && ts.isPropertyAssignment(window) &&
        (name(window.name) ?? string(window.name)) === 'windowId' && integer(window.initializer);
      if (/^__sleightOpenedApp\d+$/.test(name(bound.value) ?? '') || name(app?.receiver) === 'cua' && app.method === 'getApp' && app.args.length === 1 && selector) {
        acquired = bound.name; continue;
      }
    }
    const action = byStart.get(statement.getStart(source));
    if (action) {
      const invoked = ts.isExpressionStatement(statement) && call(awaited(unparen(statement.expression)));
      if (tail || statement.end !== action.end || !invoked || name(invoked.receiver) !== action.handle ||
          action.handle !== plan.actions[0].handle || acquired && acquired !== action.handle || !actions.has(invoked.method) || !invoked.args.every(data)) return 'action-shape';
      const selected = action.selector;
      if (selected) {
        const argument = unparen(invoked.args[0]);
        if (invoked.args.length !== 1) return 'selector-arity';
        if ((selected.kind === 'key' || selected.kind === 'label' && string(argument) !== undefined) &&
            selected.value !== string(argument)) return 'selector-string';
        if (selected.kind === 'number' && (!integer(argument) || selected.value !== Number(argument.text))) return 'selector-number';
        if (selected.kind === 'point' && (!ts.isArrayLiteralExpression(argument) || argument.elements.length !== 2 ||
            !argument.elements.every(integer) || JSON.stringify(selected.value) !== JSON.stringify(argument.elements.map(element => Number(element.text))))) return 'selector-point';
        if (selected.kind === 'id' || selected.kind === 'label' && string(argument) === undefined) {
          const property = ts.isObjectLiteralExpression(argument) && argument.properties.length === 1 && argument.properties[0];
          if (!property || !ts.isPropertyAssignment(property) || (name(property.name) ?? string(property.name)) !== selected.kind ||
              string(property.initializer) !== selected.value) return 'selector-object';
        }
      }
      actionCount++;
    } else {
      if (!actionCount || !trailing(statement, source, plan.actions[0].handle, names)) return 'executable-tail';
      tail = true;
    }
  }
  if (actionCount !== plan.actions.length) return 'action-count';
  if (consumer === 'tab') {
    if (plan.actions.length !== 3) return 'tab-count';
    const calls = plan.actions.map(action => call(awaited(source.statements.find(statement => statement.getStart(source) === action.start)?.expression)));
    if (calls.some(item => !item || item.args.length !== 1) || calls[0].method !== 'pressKey' ||
        !/^(?:super|cmd|command|meta)\+t$/i.test(string(calls[0].args[0]) ?? '') || calls[1].method !== 'typeText' ||
        !/^https?:\/\/[^\s\u0000-\u001f]+$/i.test(string(calls[1].args[0]) ?? '') || calls[2].method !== 'pressKey' ||
        !/^(?:return|enter)$/i.test(string(calls[2].args[0]) ?? '')) return 'tab-shape';
  }
  return null;
}

const accepted = value => value !== undefined && value !== null && value !== false;
export function statementOracle({ label = 'statement-consumers', caseOffset = 0, reportFailure = entry => console.log(JSON.stringify(entry)) } = {}) {
  const counts = { label, tested: 0, cells: 0, rawCells: 0, failures: 0, legacyThrows: 0, newThrows: 0, oracleChecks: 0 };
  const ranges = { newlyAccepted: 0, checked: 0, grammarDisagreements: 0, mismatches: 0 };
  const consumers = Object.fromEntries(['textSave', 'menu', 'tab'].map(consumer => [consumer,
    { oldAccepted: 0, newAccepted: 0, newlyAccepted: 0, justified: 0, unjustified: 0 }]));
  function cell(code, context) {
    counts.cells++;
    if (context === 'raw') counts.rawCells++;
    let oldPlan, newPlan;
    const pairs = {
      statements: [() => legacyConsumers.text.statementSpans(code), () => text.statementSpans(code)],
      textSave: [() => legacyConsumers.text.splitTextSave(code), () => text.splitTextSave(code)],
      menu: [() => oldPlan = legacyConsumers.menu.splitMenuActions(code), () => newPlan = menu.splitMenuActions(code)],
      tab: [() => legacyConsumers.tab.nativeTabPlan(oldPlan), () => tab.nativeTabPlan(newPlan)],
    };
    for (const [consumer, [before, after]] of Object.entries(pairs)) {
      let old, current;
      try { old = before(); } catch { counts.legacyThrows++; }
      try { current = after(); } catch { counts.newThrows++; counts.failures++; }
      // Statement spans alone authorize no continuation. TypeScript may recover a
      // different tree after a grammar error on engine-valid syntax. Keep those
      // diagnostics separate from the three consumers' acceptance decisions.
      if (consumer === 'statements') {
        if (accepted(old) || !accepted(current)) continue;
        ranges.newlyAccepted++;
        const source = sourceFile(code);
        if (source.parseDiagnostics.length) { ranges.grammarDisagreements++; continue; }
        ranges.checked++;
        if (justifyResult(code, consumer, current)) { ranges.mismatches++; counts.failures++; }
        continue;
      }
      const totals = consumers[consumer];
      if (accepted(old)) totals.oldAccepted++;
      if (accepted(current)) totals.newAccepted++;
      if (accepted(old) || !accepted(current)) continue;
      totals.newlyAccepted++; counts.oracleChecks++;
      let reason;
      try { reason = justifyResult(code, consumer, consumer === 'tab' ? { plan: newPlan } : current); } catch { reason = 'oracle-exception'; }
      if (!reason) { totals.justified++; continue; }
      totals.unjustified++; counts.failures++;
      reportFailure({ label, case: caseOffset + counts.tested, context, consumer, reason,
        sha256: createHash('sha256').update(code).digest('hex') });
    }
  }
  return {
    counts,
    check(code, wrapper = 'async function f()') {
      counts.tested++;
      cell(wrapper ? `${wrapper}{${code}\n}` : code, 'wrapped');
      // Check raw consumer cells too. FR3's async wrapper occurs once per program.
      if (wrapper === 'async function f()') cell(code, 'raw');
    },
    finish() {
      const result = { ...counts, consumers, ranges };
      console.log(JSON.stringify(result));
      if (counts.failures) process.exitCode = 1;
      return result;
    },
  };
}
