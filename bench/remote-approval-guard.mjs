// The live arm may only acquire TextEdit and read its state. Generated context never gains app authority.
import ts from 'typescript';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const TOOL = 'mcp__plugin_sleight_computer__js';
const TURN_END = 'mcp__plugin_sleight_computer__turn_ended';
export const MOD_KEYS = new Set(['sleight_turbo', 'sleight_resume', 'sleight_stop', 'sleight_stats', 'hook_event_name']);
// The mod's tool.call hook owns origin checks. This arm passes only its control key set, never model code or extra keys.
export function modOwnCall(event) {
  if (event?.tool_name !== TURN_END || !event.tool_input || typeof event.tool_input !== 'object' || Array.isArray(event.tool_input)) return false;
  const keys = Object.keys(event.tool_input);
  return keys.length > 0 && keys.every(key => MOD_KEYS.has(key));
}
export function remoteGuardDecision(event, { upfront = false } = {}) {
  if (modOwnCall(event)) return true;
  if (upfront || event?.tool_name !== TOOL || typeof event.tool_input?.code !== 'string') return false;
  const ast = ts.createSourceFile('fixture.js', event.tool_input.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length || !ast.statements.length) return false;
  const path = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? path(node.expression) + '.' + node.name.text : '';
  const literal = node => ts.isStringLiteral(node) ? node.text : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    && literal(node.left) !== undefined && literal(node.right) !== undefined ? literal(node.left) + literal(node.right) : undefined;
  const read = node => {
    if (ts.isAwaitExpression(node)) return read(node.expression);
    if (!ts.isCallExpression(node)) return false;
    if (path(node.expression) === 'cua.getApp') return node.arguments.length === 1 && ['TextEdit', 'com.apple.TextEdit'].includes(literal(node.arguments[0]));
    if (path(node.expression) !== 'app.getAXState' || node.arguments.length > 1) return false;
    return !node.arguments.length || ts.isObjectLiteralExpression(node.arguments[0]) && node.arguments[0].properties.length === 1 &&
      ts.isPropertyAssignment(node.arguments[0].properties[0]) && node.arguments[0].properties[0].name.getText(ast) === 'disableDiffing' &&
      node.arguments[0].properties[0].initializer.kind === ts.SyntaxKind.TrueKeyword;
  };
  const output = node => ts.isIdentifier(node) && node.text === 'state' || read(node) ||
    ts.isCallExpression(node) && path(node.expression) === 'nodeRepl.write' && node.arguments.length === 1 && output(node.arguments[0]);
  return ast.statements.every(statement => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.every(decl =>
      ts.isIdentifier(decl.name) && !!decl.initializer && (decl.name.text === 'app' && read(decl.initializer) && /cua\.getApp/.test(decl.initializer.getText(ast)) ||
        decl.name.text === 'state' && read(decl.initializer) && /app\.getAXState/.test(decl.initializer.getText(ast))));
    return ts.isExpressionStatement(statement) && (read(statement.expression) || output(statement.expression));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = ''; for await (const chunk of process.stdin) text += chunk;
  let allow = false, mod = false;
  try { const event = JSON.parse(text); mod = modOwnCall(event); allow = remoteGuardDecision(event, { upfront: process.env.RA1_UPFRONT === '1' }); } catch {}
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny',
    permissionDecisionReason: allow ? mod ? 'RA1 mod turn binding' : 'RA1 owned TextEdit read' : 'RA1 allows only TextEdit acquisition and state reads; upfront asks use no tools' } }));
}
