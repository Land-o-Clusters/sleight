import { parseCell, walk, memberCall, literalValue, UNKNOWN } from './code-ast.mjs';

// Literal consumers share the parser, but retain their own policy for UNKNOWN.
export function inspectCalls(code) {
  const { ast, error } = parseCell(code);
  if (error) return { ast, error, calls: [] };
  return { ast, error, calls: [...walk(ast)].filter(node => node.type === 'CallExpression')
    .map(node => ({ node, call: memberCall(node) })).filter(entry => entry.call) };
}

export function receiverRoot(node) {
  if (node?.type === 'ChainExpression') return receiverRoot(node.expression);
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression') return receiverRoot(node.object);
  if (node?.type === 'CallExpression') return receiverRoot(node.callee);
}

// Native options can be partly known. Preserve known mistakes beside unknown
// fields, without evaluating expressions or assuming a spread's final value.
export function argumentValue(node) {
  const value = literalValue(node);
  if (value !== UNKNOWN) return value;
  if (node?.type === 'ArrayExpression' && !node.elements.some(item => item?.type === 'SpreadElement'))
    return node.elements.map(item => item ? argumentValue(item) : undefined);
  if (node?.type === 'ObjectExpression') {
    const out = Object.create(null);
    for (const field of node.properties) {
      if (field.type !== 'Property' || field.kind !== 'init' || field.method || field.shorthand || field.computed) return UNKNOWN;
      const key = field.key.type === 'Identifier' ? field.key.name : literalValue(field.key);
      if (!['string', 'number'].includes(typeof key)) return UNKNOWN;
      out[key] = argumentValue(field.value);
    }
    return out;
  }
  return UNKNOWN;
}
