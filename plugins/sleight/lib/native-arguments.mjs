import { codeInspectionRefusal } from './flow-rules.mjs';
import { parseCell, walk, memberCall, handleBindings, UNKNOWN } from './code-ast.mjs';
import { argumentValue } from './call-inspection.mjs';

// Also injected into the app proxy. Keep this function self-contained.
export function nativeArgumentError(name, args, unknown = Symbol()) {
  const known = value => value !== unknown;
  const string = value => !known(value) || typeof value === 'string';
  const number = value => !known(value) || typeof value === 'number' && Number.isFinite(value);
  const object = value => !known(value) || value !== null && typeof value === 'object' && !Array.isArray(value);
  const point = value => !known(value) || Array.isArray(value) && value.length === 2 && number(value[0]) && number(value[1]);
  // Sleight resolves these selectors to engine element numbers after validation.
  const element = value => !known(value) || Number.isInteger(value) && value >= 0 || typeof value === 'string' ||
    object(value) && value && ['id', 'label', 'line'].some(key => key in value && string(value[key]));
  const target = value => element(value) || point(value);
  const options = (value, fields) => value == null || object(value) && (!known(value) ||
    Object.entries(fields).every(([key, valid]) => value[key] === undefined || valid(value[key])));
  const [a, b, c] = args;
  let valid = true, signature;
  switch (name) {
    case 'pressKey':
      signature = 'pressKey(key: string, options?: PressKeyOptions)';
      valid = args.length >= 1 && string(a) && (!known(a) || a.length > 0) &&
        options(b, { durationMs: number });
      break;
    case 'typeText':
      signature = 'typeText(text: string)';
      valid = args.length >= 1 && string(a);
      break;
    case 'click':
      if (known(b) && b != null && typeof b === 'object' && 'button' in b) {
        const button = ['left', 'right', 'middle', 'l', 'r', 'm'].find(value => value === b.button);
        return /* notice */ 'sleight: use ' + (button ? '{mouseButton:"' + button + '"}' : 'mouseButton') + ', not button; nothing sent';
      }
      signature = 'click(target: number | Vec2, options?: ClickOptions)';
      valid = args.length >= 1 && target(a) && options(b, {
        key: string, durationMs: number, clickCount: number, mouseButton: string,
      });
      break;
    case 'selectText':
      signature = 'selectText(elementIndex: number, text: string, options?: SelectTextOptions)';
      valid = args.length >= 2 && element(a) && string(b) && options(c, {
        prefix: string, suffix: string, selectionType: string,
      });
      break;
    case 'scroll':
      signature = 'scroll(target: number | Vec2, direction: Direction, distance?: number | { pixels: number })';
      valid = args.length >= 2 && target(a) && string(b) && (c == null || number(c) || object(c));
      break;
    case 'drag':
      signature = 'drag(from: Vec2, to: Vec2)';
      valid = args.length >= 2 && point(a) && point(b);
      break;
  }
  return valid ? undefined : 'sleight: invalid native arguments. Engine App.' + signature + '; nothing was sent';
}

// This is a literal mistake check, not an interpreter. The runtime proxy checks computed values.
export function nativeArgumentsProblem(code, nativeHandles = new Set(), browserHandles = new Set()) {
  const { ast, error } = parseCell(code);
  if (error) return codeInspectionRefusal;
  const native = new Set(['app', ...nativeHandles]);
  for (const handle of browserHandles) native.delete(handle);
  for (const statement of ast.body) {
    const hints = handleBindings({ body: [statement] });
    for (const [name, hint] of hints) {
      if (hint.kind === 'app') native.add(name);
      else native.delete(name);
    }
    for (const node of walk(statement)) {
      const assignment = node.type === 'VariableDeclarator' ? { left: node.id, right: node.init, operator: '=' }
        : node.type === 'AssignmentExpression' ? node : undefined;
      if (assignment?.left.type === 'Identifier') {
        const name = assignment.left.name, source = assignment.right;
        if (!hints.has(name)) {
          const acquisition = memberCall(source);
          if (assignment.operator === '=' && acquisition?.receiver.type === 'Identifier' && acquisition.receiver.name === 'cua' && acquisition.method === 'getApp') native.add(name);
          else if (assignment.operator === '=' && source?.type === 'Identifier' && native.has(source.name)) native.add(name);
          else native.delete(name);
        }
      }
      if (node.type !== 'CallExpression') continue;
      const call = memberCall(node);
      if (!call) continue;
      const factory = memberCall(call.receiver);
      const acquired = factory?.receiver.type === 'Identifier' && factory.receiver.name === 'cua' && factory.method === 'getApp';
      if (!acquired && (call.receiver.type !== 'Identifier' || !native.has(call.receiver.name))) continue;
      // A computed name cannot be checked against a signature. Refuse it rather
      // than silently omitting a possible native action from inspection.
      if (call.method === UNKNOWN) return codeInspectionRefusal;
      if (!['pressKey', 'click', 'selectText', 'typeText', 'scroll', 'drag'].includes(call.method)) continue;
      // A spread has unknown arity. The runtime proxy validates the actual list.
      if (call.args.some(arg => arg.type === 'SpreadElement')) continue;
      const problem = nativeArgumentError(call.method, call.args.map(argumentValue), UNKNOWN);
      if (problem) return problem + '.';
    }
  }
}
