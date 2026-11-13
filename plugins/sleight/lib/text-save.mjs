import { parseCell, statements, memberCall, literalValue, walk } from './code-ast.mjs';
import { verifyWindowIdentity } from './window-identity.mjs';

// The engine's top-level module statements, including ASI and every line terminator.
// Keep the nodes so splitters inspect the same parse that supplied their ranges.
export function statementSpans(code) {
  if (typeof code !== 'string') return;
  const { ast, error } = parseCell(code);
  if (error) return;
  const entries = statements(ast);
  return { spans: entries.map(entry => entry.range), nodes: entries.map(entry => entry.node), ast };
}

export function splitTextSave(code) {
  try { return textSave(code); } catch { return undefined; }
}

function textSave(code) {
  const split = statementSpans(code);
  if (!split) return;
  const written = new Set();
  let exits = false;
  for (const node of split.nodes) {
    if (node.type === 'EmptyStatement') continue;
    let expression = node.type === 'ExpressionStatement' ? node.expression : undefined;
    if (node.type === 'VariableDeclaration' && ['const', 'let', 'var'].includes(node.kind) &&
        node.declarations.length === 1 && node.declarations[0].id.type === 'Identifier')
      expression = node.declarations[0].init;
    const call = expression?.type === 'AwaitExpression' ? memberCall(expression.argument) : null;
    const opaque = call && [...walk(expression)].some(part => part.regex || part.type === 'TemplateLiteral' && part.expressions.length);
    if (!call || call.optional || call.computed || call.receiver.type !== 'Identifier' || opaque) written.clear();
    else {
      const handle = call.receiver.name;
      if (call.method === 'setValue') written.add(handle);
      else if (call.method === 'pressKey' && call.args.length === 1 &&
          typeof literalValue(call.args[0]) === 'string' && /^(?:cmd|command|super|meta)\+s$/i.test(literalValue(call.args[0])) && written.has(handle)) {
        // Do not move a save past an earlier return or throw, including one in a nested scope.
        if (exits) return;
        return { handle, head: code.slice(0, node.range[0]).trim(), tail: code.slice(node.range[0]).trim() };
      }
    }
    if ([...walk(node)].some(part => ['ReturnStatement', 'ThrowStatement'].includes(part.type))) exits = true;
  }
}

export async function prepareTextWrite(target, current, { identity, run }) {
  if (typeof identity !== 'function' || typeof run !== 'function') throw new Error('Text-write settle helper is unavailable.');
  const observed = await identity(target);
  let checked;
  try { checked = verifyWindowIdentity(target, observed); }
  catch (error) {
    error.textSaveStop = observed?.status === 'mismatch' ||
      !/^Input lease: (?:native window identity is unavailable|window identity is ambiguous)/.test(error.message);
    throw error;
  }
  if (!current()) throw new Error('Text save was stopped before settling.');
  return checked;
}

export async function settleTextWrite(target, current, grant, { identity, run }) {
  const checked = await prepareTextWrite(target, current, { identity, run });
  let result;
  try {
    result = await run('settle-text-write.js', { appId: target.appId, pid: checked.pid,
      processStart: checked.processStart, lease: grant });
  } catch (error) { error.textSaveStop = error.code !== 'ENOENT'; throw error; }
  if (!result?.ok) {
    const error = new Error(result?.error ?? 'Text-write settle failed.');
    error.textSaveStop = !['Text-write settle needs one running app', 'Cannot create Shift event'].includes(result?.error);
    throw error;
  }
}
