// Parse a single inventory expression, allowing only data inspection around
// cua's three inventory methods. No evaluation, statements or mutation.
export function isInventoryRead(code) {
  const tokens = [];
  const token = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\\r\n]|\\[^\r\n])+\/[dgimsuvy]*|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|==|!=|<=|>=|&&|\|\||=>|[().,!<>+?:;])/y;
  let offset = 0;
  while (offset < code.trimEnd().length) {
    token.lastIndex = offset;
    const match = token.exec(code);
    if (!match) return false;
    tokens.push(match[1]); offset = token.lastIndex;
  }
  let at = 0, inventories = 0;
  const take = value => tokens[at] === value && (++at, true);
  const need = value => { if (!take(value)) throw new Error('inventory syntax'); };
  const identifier = () => {
    const name = tokens[at++];
    if (!/^[A-Za-z_$][\w$]*$/.test(name ?? '')) throw new Error('inventory identifier');
    return name;
  };
  const methods = new Set(['filter', 'map', 'find', 'some', 'every', 'includes', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'join', 'slice']);
  const operators = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '+']);
  function expression(locals = new Set()) {
    primary(locals);
    while (operators.has(tokens[at])) { at++; primary(locals); }
    if (take('?')) { expression(locals); need(':'); expression(locals); }
  }
  function argument(locals) {
    if (/^[A-Za-z_$][\w$]*$/.test(tokens[at] ?? '') && tokens[at + 1] === '=>') {
      const name = identifier(); at++;
      expression(new Set([...locals, name]));
    } else expression(locals);
  }
  function primary(locals) {
    let regexValue = false;
    if (take('!') || take('await')) return primary(locals);
    if (take('(')) { expression(locals); need(')'); }
    else if (take('cua')) {
      need('.');
      if (!['listApps', 'listWindows', 'getState'].includes(identifier())) throw new Error('inventory method');
      need('('); need(')'); inventories++;
    } else if (take('JSON')) {
      need('.'); need('stringify'); need('('); expression(locals); need(')');
    } else if (take('nodeRepl')) {
      need('.'); need('write'); need('('); expression(locals); need(')');
    } else {
      const value = tokens[at++];
      regexValue = value?.startsWith('/');
      if (!/^(?:"|'|\/)/.test(value ?? '') && !/^\d/.test(value ?? '') &&
          !['true', 'false', 'null', 'undefined'].includes(value) && !locals.has(value)) throw new Error('inventory value');
    }
    while (take('.')) {
      const name = identifier();
      if (['constructor', '__proto__', 'prototype'].includes(name)) throw new Error('inventory property');
      if (take('(')) {
        if (!methods.has(name) && !(regexValue && name === 'test')) throw new Error('inventory transform');
        if (!take(')')) {
          argument(locals);
          while (take(',')) argument(locals);
          need(')');
        }
      }
      regexValue = false;
    }
  }
  try { expression(); take(';'); return at === tokens.length && inventories > 0; }
  catch { return false; }
}
