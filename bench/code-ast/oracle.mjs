// Compile generated/recorded cells without linking or executing them. TypeScript
// supplies an independent static call inventory. V8 supplies module acceptance.
import * as vm from 'node:vm';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parseCell, walk, memberCall, literalValue, UNKNOWN } from '../../plugins/sleight/lib/code-ast.mjs';
import { tokens, invalidTokens } from '../../plugins/sleight/lib/flow-rules.mjs';
import { unsupportedCodeLines } from '../../plugins/sleight/lib/code-line-terminators.mjs';

export function astCalls(ast) {
  if (!ast) return [];
  return [...walk(ast)].filter(node => node.type === 'CallExpression').flatMap(node => {
    const call = memberCall(node);
    if (!call || call.receiver.type !== 'Identifier' || call.method === UNKNOWN) return [];
    const args = call.args.map(literalValue).map(value => value === UNKNOWN ? { unknown: true } : { value });
    return [{ receiver: call.receiver.name, method: call.method, args }];
  });
}

export function typescriptCalls(code) {
  const source = ts.createSourceFile('cell.mjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  function value(node) {
    if (!node) return { unknown: true };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { value: node.text };
    if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { value: null };
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)) {
      const inner = value(node.operand);
      if (typeof inner.value === 'number') return { value: node.operator === ts.SyntaxKind.MinusToken ? -inner.value : inner.value };
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map(value);
      if (values.every(item => Object.hasOwn(item, 'value'))) return { value: values.map(item => item.value) };
    }
    if (ts.isObjectLiteralExpression(node)) {
      const entries = [];
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || ![ts.SyntaxKind.Identifier, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral].includes(property.name.kind)) return { unknown: true };
        const item = value(property.initializer);
        if (!Object.hasOwn(item, 'value')) return { unknown: true };
        entries.push([property.name.text, item.value]);
      }
      return { value: Object.fromEntries(entries) };
    }
    return { unknown: true };
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const receiver = (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && callee.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? value(callee.argumentExpression).value : undefined;
      if (receiver && ts.isIdentifier(receiver) && typeof method === 'string')
        calls.push({ receiver: receiver.text, method, args: node.arguments.map(value) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

export function legacyCalls(code) {
  const list = tokens(code), calls = [];
  for (let i = 0; i + 3 < list.length; i++) {
    const [receiver, dot, method, open] = list.slice(i, i + 4);
    if (receiver.string || dot.string || dot.v !== '.' || method.string || open.string || open.v !== '(') continue;
    const args = [];
    let depth = 0, current = [];
    for (let j = i + 4; j < list.length; j++) {
      const token = list[j];
      if (!token.string && token.v === ')' && depth === 0) {
        if (current.length || args.length) args.push(current);
        break;
      }
      if (!token.string && token.v === ',' && depth === 0) { args.push(current); current = []; continue; }
      current.push(token);
      if (!token.string && ['(', '[', '{'].includes(token.v)) depth++;
      if (!token.string && [')', ']', '}'].includes(token.v)) depth--;
    }
    calls.push({ receiver: receiver.v, method: method.v, args: args.map(parts => {
      if (parts.length !== 1) return { unknown: true };
      const item = parts[0];
      if (item.string) return { value: item.v };
      if (['true', 'false', 'null'].includes(item.v)) return { value: JSON.parse(item.v) };
      if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(item.v)) return { value: Number(item.v) };
      return { unknown: true };
    }) });
  }
  return { calls, refused: invalidTokens(list) || unsupportedCodeLines(code) };
}

const multiset = values => {
  const counts = new Map();
  for (const item of values) { const key = JSON.stringify(item); counts.set(key, (counts.get(key) ?? 0) + 1); }
  return counts;
};
const missing = (expected, visible) => {
  const a = multiset(expected), b = multiset(visible);
  return [...a].some(([key, count]) => count > (b.get(key) ?? 0));
};

export function oracle({ label = 'code-ast', caseOffset = 0, reportFailure = entry => console.log(JSON.stringify(entry)) } = {}) {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('code-ast oracle needs --experimental-vm-modules');
  const counts = { label, tested: 0, nodeAccepted: 0, meriyahAccepted: 0, bothRefuse: 0, falseRefusal: 0, meriyahOnly: 0,
    failOpen: 0, falsePositive: 0, oracleCalls: 0, legacyInventoryMiss: 0, legacyAdmissionRefusal: 0 };
  function check(code, wrapper = 'async function f()') {
    counts.tested++;
    const source = wrapper ? `${wrapper}{${code}\n}` : code;
    const parsed = parseCell(source);
    let nodeAccepted = true;
    // The engine prepends a prelude, so a hashbang in a cell is never at offset 0.
    try { new vm.SourceTextModule(`;\n${source}`); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      nodeAccepted = false;
    }
    const meriyahAccepted = !parsed.error;
    if (nodeAccepted) counts.nodeAccepted++;
    if (meriyahAccepted) counts.meriyahAccepted++;
    if (!nodeAccepted && !meriyahAccepted) counts.bothRefuse++;
    if (nodeAccepted && !meriyahAccepted) counts.falseRefusal++;
    if (!nodeAccepted && meriyahAccepted) counts.meriyahOnly++;
    const expected = nodeAccepted ? typescriptCalls(source) : [];
    const visible = meriyahAccepted ? astCalls(parsed.ast) : [];
    const legacy = legacyCalls(source);
    counts.oracleCalls += expected.length;
    const failOpen = nodeAccepted && meriyahAccepted && missing(expected, visible);
    const falsePositive = nodeAccepted && meriyahAccepted && missing(visible, expected);
    if (failOpen) counts.failOpen++;
    if (falsePositive) counts.falsePositive++;
    if (nodeAccepted && legacy.refused) counts.legacyAdmissionRefusal++;
    // This is the benchmark's deliberately small token adapter, not a finding
    // that every production consumer missed the call.
    if (nodeAccepted && !legacy.refused && missing(expected, legacy.calls)) counts.legacyInventoryMiss++;
    if (nodeAccepted !== meriyahAccepted || failOpen || falsePositive) reportFailure({ label, case: caseOffset + counts.tested,
      sha256: createHash('sha256').update(code).digest('hex'), nodeAccepted, meriyahAccepted, failOpen, falsePositive, error: parsed.error });
    return { nodeAccepted, meriyahAccepted, expected, visible, legacy, ast: parsed.ast };
  }
  function finish() {
    console.log(JSON.stringify(counts));
    if (counts.failOpen || counts.falseRefusal || counts.falsePositive) process.exitCode = 1;
    return counts;
  }
  return { counts, check, finish };
}
