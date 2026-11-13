import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export function requireReplayLauncher(worktree) {
  const entry = join(worktree, 'plugins/sleight/lib/launch.mjs');
  const ast = ts.createSourceFile(entry, readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const run = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'run' && n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  const pattern = run?.parameters[0]?.name;
  const keys = pattern && ts.isObjectBindingPattern(pattern) ? pattern.elements.map(p => (p.propertyName ?? p.name).text) : [];
  if (!keys.includes('approvalStorage') || !keys.includes('paymentCardFactory'))
    throw Error(`Replay requires SR2 launcher injection in ${worktree}; apply the original SR2 harness to both comparison builds`);
  return entry;
}
