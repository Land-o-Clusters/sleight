// Pure output comparison for the frozen fixtures and the Git replay.
import { createHash } from 'node:crypto';
import * as text from '../../plugins/sleight/lib/text-save.mjs';
import * as menu from '../../plugins/sleight/lib/menu-continuation.mjs';
import * as tab from '../../plugins/sleight/lib/tab-probe.mjs';
import { parseCell, memberCall } from '../../plugins/sleight/lib/code-ast.mjs';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function menuResult(consumer, code) {
  const plan = consumer.splitMenuActions(code);
  if (!plan) return null;
  return {
    actions: plan.actions.map(({ start, end, handle, selector }) => ({ start, end, handle, selector })),
    remainders: plan.actions.slice(1).map(action => code.slice(action.start).trim()),
    notes: plan.actions.map((_, index) => consumer.stopNote({ windowStop: true, index }, plan)),
  };
}
const semanticMenu = result => result && { ...result, actions: result.actions.map(({ handle, selector }) => ({ handle, selector })) };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safe = result => result == null ? null : { sha256: hash(result), bytes: Buffer.byteLength(JSON.stringify(result)) };

export function compareRecord(code, old) {
  const before = { statements: old.text.statementSpans(code)?.spans ?? null, textSave: old.text.splitTextSave(code) ?? null,
    menu: menuResult(old.menu, code), tab: old.tab.nativeTabPlan(old.menu.splitMenuActions(code)) };
  const after = { statements: text.statementSpans(code)?.spans ?? null, textSave: text.splitTextSave(code) ?? null,
    menu: menuResult(menu, code), tab: tab.nativeTabPlan(menu.splitMenuActions(code)) };
  const differences = [];
  for (const consumer of Object.keys(before)) {
    if (same(before[consumer], after[consumer])) continue;
    let reason = 'unclassified';
    if (consumer === 'statements') reason = 'engine-statement-ranges';
    if (consumer === 'menu' && same(semanticMenu(before.menu), semanticMenu(after.menu))) reason = 'engine-action-ranges';
    if (consumer === 'menu' && !before.menu && after.menu) {
      // Prove the old refusal is solely its missing awaited-observation shape:
      // removing only those outer awaits must make the original consumer accept.
      let equivalent = code, removed = 0;
      for (const statement of [...parseCell(code).ast.body].reverse()) {
        const expression = statement.type === 'ExpressionStatement' && statement.expression;
        const call = expression?.type === 'AwaitExpression' && memberCall(expression.argument);
        if (call && !call.computed && !call.optional && call.receiver.type === 'Identifier' && call.receiver.name === 'nodeRepl' &&
            ['write', 'emitImage'].includes(call.method)) {
          equivalent = equivalent.slice(0, expression.range[0]) + equivalent.slice(expression.range[0] + 5);
          removed++;
        }
      }
      if (removed && old.menu.splitMenuActions(equivalent)) reason = 'awaited-observation-tail';
    }
    differences.push({ consumer, reason, old: safe(before[consumer]), new: safe(after[consumer]),
      oldAccepted: before[consumer] !== null && before[consumer] !== false,
      newAccepted: after[consumer] !== null && after[consumer] !== false });
  }
  return { differences, before, after };
}

