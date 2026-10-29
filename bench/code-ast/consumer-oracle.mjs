// Static qualification only. Generated caller programs never execute.
import { calls } from '../../plugins/sleight/lib/flow-rules.mjs';
import { nativeArgumentsProblem } from '../../plugins/sleight/lib/native-arguments.mjs';
import { literalElements } from '../../plugins/sleight/lib/literal-elements.mjs';
import { clipboardActions } from '../../plugins/sleight/lib/clipboard.mjs';
import { dispatchInspection } from '../../plugins/sleight/lib/dispatched-calls.mjs';
import { walk, memberCall, literalValue } from '../../plugins/sleight/lib/code-ast.mjs';

export function checkConsumers(source, ast, oracle) {
  const problems = [], expectText = oracle.filter(c => c.receiver === 'app' && c.method === 'typeText' && c.args[0]?.value === 'PAYLOAD');
  const visible = calls(source, new Map(), {app:'Fixture'}).inputs.filter(c => c.method === 'typeText' && c.value === 'PAYLOAD');
  if (visible.length < expectText.length) problems.push('flow omitted literal payload');
  const expectedKeys = oracle.filter(c => c.method === 'pressKey').flatMap(c => {
    const value = c.args[0]?.value;
    if (typeof value !== 'string') return [];
    const parts = value.toLowerCase().split('+');
    return parts.some(p => ['super','cmd','command','meta'].includes(p)) && ['c','x','v'].includes(parts.at(-1)) ? [parts.at(-1)] : [];
  });
  try { if (JSON.stringify(clipboardActions(source)) !== JSON.stringify(expectedKeys)) problems.push('clipboard inventory'); }
  catch (error) { if (error.message !== 'sleight: cannot inspect JavaScript. Use direct calls with literal arguments.') problems.push('unexpected clipboard refusal'); }
  const dynamicTemplate = [...walk(ast)].some(n => n.type === 'TemplateLiteral' && n.expressions.length);
  const expectedNumbers = dynamicTemplate ? [] : oracle.filter(c => ['click','doubleClick','rightClick','setValue','typeText','pressKey','paste','scroll','selectText','performSecondaryAction','performAction'].includes(c.method))
    .map(c => c.args[0]?.value).filter(n => Number.isInteger(n) && n >= 0);
  try { if (JSON.stringify(literalElements(source)) !== JSON.stringify(expectedNumbers)) problems.push('literal element inventory'); }
  catch (error) { if (error.message !== 'sleight: cannot inspect JavaScript. Use direct calls with literal arguments.') problems.push('unexpected element refusal'); }
  const input = [...walk(ast)].find(node => memberCall(node)?.receiver.type === 'Identifier' && memberCall(node)?.receiver.name === 'app' &&
    memberCall(node)?.method === 'typeText' && literalValue(memberCall(node)?.args[0]) === 'PAYLOAD');
  if (input) {
    const argument = memberCall(input).args[0];
    const changed = source.slice(0, argument.range[0]) + '7' + source.slice(argument.range[1]);
    const problem = nativeArgumentsProblem(changed);
    if (problem !== 'sleight: invalid native arguments. Engine App.typeText(text: string); nothing was sent.' &&
        problem !== 'sleight: cannot inspect JavaScript. Use direct calls with literal arguments.') problems.push('native malformed typeText');
  }
  const check = dispatchInspection(source), output = check.mark(source);
  if (!check.verify(output)) problems.push('dispatch identity');
  if (check.verify(output + '\n;app.click(999);')) problems.push('dispatch extra input');
  return { problems };
}
