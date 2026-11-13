import { isLineTerminator } from './code-line-terminators.mjs';
import { pageCode, escapedSyntax, unchain } from './page-code.mjs';

export function pageCallbackEscape(code, handles, analysis) {
  if (typeof code !== 'string' || !code.includes('\\')) return;
  const plan = analysis ?? pageCode(code, handles);
  if (!plan.evaluations.length) return;
  for (const { node } of plan.evaluations) {
    const property = unchain(node.callee).property ?? unchain(node.callee);
    if (code.slice(...property.range).includes('\\')) return { at: property.range[0], v: 'evaluate' };
  }
  const unresolved = plan.evaluations.some(evaluation => !evaluation.masked);
  const spans = unresolved ? [[0, code.length]] : plan.evaluations.flatMap(({ argument, resolved }) =>
    [argument.range, resolved.fn.range, ...resolved.bindings.flatMap(binding =>
      [...binding.values.map(value => value.node?.range).filter(Boolean), ...binding.refs.map(ref => ref.range)])]);
  const escaped = escapedSyntax(code, plan.ast, spans);
  if (escaped) return { at: escaped.range[0], v: 'evaluate' };
}

export function withoutPageCallbacks(code, handles) {
  if (typeof code !== 'string') return code;
  const plan = pageCode(code, handles);
  if (pageCallbackEscape(code, handles, plan) || !plan.ranges.length) return code;
  const masked = code.split('');
  for (const [start, end] of plan.ranges)
    for (let i = start; i < end; i++) if (!isLineTerminator(masked[i])) masked[i] = ' ';
  return masked.join('');
}
