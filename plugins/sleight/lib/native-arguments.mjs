import { codeInspectionRefusal } from './flow-rules.mjs';
import { parseCell, walk, memberCall, handleBindings, UNKNOWN } from './code-ast.mjs';
import { argumentValue, unsafeHandleUse, unsafeHandleRefusal } from './call-inspection.mjs';
import { quitKeyBlocked, QUIT_KEY_REFUSAL } from './quit-key.mjs';

// Runtime text only. Keep self-contained for injection into the engine app proxy.
export function engineTypeTextNeedsPaste(text) {
  return /[^\x20-\x7e\t\n\r]/.test(text);
}

// Recovery advice only, from the latest AX read. Keep self-contained for injection.
export function engineTypeTextField(text) {
  if (typeof text !== 'string') return;
  const focus = [...text.matchAll(/^The focused UI element is (\d+) (.*?)\r?$/gm)];
  if (focus.length !== 1) return;
  // Each row matching the focused number, with the rows above it (a plain field can sit inside a secure one).
  const paths = [], stack = [];
  for (const line of text.split('\n')) {
    const row = /^(\t*)(\d+) (.*?)\r?$/.exec(line);
    if (!row) continue;
    while (stack.length && stack.at(-1).depth >= row[1].length) stack.pop();
    stack.push({ depth: row[1].length, line: row[3] });
    if (Number(row[2]) === Number(focus[0][1])) paths.push(stack.map(entry => entry.line));
  }
  if (paths.length !== 1) return;
  const path = paths[0], descriptions = [focus[0][2], path.at(-1)];
  const plain = /^(?:text field|text entry area|text area|combo box|AXTextField|AXTextArea|AXComboBox)(?: |,|$)/;
  const secureRole = /^(?:AXSecureTextField|(?:secure|password)(?: text)? field)(?: |,|$)/i;
  const secure = line => {
    // Roles and subroles only: stop before content attributes, so a title, value or label cannot supply a subrole.
    const metadata = line.split(/(?:^|\s|,)(?:Description|Value|Title|Label|ID|Help|URL|Secondary Actions|Placeholder|Details|Selected text):/i)[0];
    return secureRole.test(line) || /(?:^|,\s*)(?:AX)?Subrole:\s*AXSecureTextField(?:\s|,|$)/i.test(metadata);
  };
  if ([focus[0][2], ...path].some(secure)) return 'secure';
  // A field that names itself a password, or shows only mask characters, is left unknown: reread before any paste.
  const ownWords = line => line.split(/(?:^|\s|,)(?:Value|Selected text):/i)[0];
  if (descriptions.some(line => /\b(?:password|passcode|passwd|pin|secret)\b/i.test(ownWords(line)) ||
    /(?:^|,\s*)Value:\s*[•●*·]+(?:,|$)/.test(line))) return;
  if (descriptions.every(line => plain.test(line))) return 'plain';
}

// Also injected into the app proxy. Keep this function self-contained.
export function nativeArgumentError(name, args, unknown = Symbol(), inspection = {}) {
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
    case 'scroll': {
      signature = 'scroll(<observed element number or [x, y]>, direction, pages?: number) e.g. scroll(23, "down", 1)';
      const distanceObject = known(c) && c !== null && typeof c === 'object' && !Array.isArray(c);
      valid = args.length >= 2 && target(a) && string(b) && (c == null || number(c) || inspection?.allowScrollPixels && distanceObject && 'pixels' in c);
      break;
    }
    case 'drag':
      signature = 'drag(from: Vec2, to: Vec2)';
      valid = args.length >= 2 && point(a) && point(b);
      break;
  }
  return valid ? undefined : (name === 'pressKey' || name === 'typeText') && known(a) && Number.isInteger(a) && a >= 0 &&
    (!known(b) || typeof b === 'string' && b.length > 0)
    ? 'sleight: invalid native arguments. Engine App.' + signature + '; no target; click field first if focus wrong; nothing was sent'
    : 'sleight: invalid native arguments. Engine App.' + signature + '; nothing was sent';
}

// This is a literal mistake check, not an interpreter. The runtime proxy checks computed values.
export function nativeArgumentsProblem(code, nativeHandles = new Set(), browserHandles = new Set(), inspection = {}) {
  const { ast, error } = parseCell(code);
  if (error) return codeInspectionRefusal;
  const native = new Set(['app', ...nativeHandles]);
  for (const handle of browserHandles) native.delete(handle);
  const unsafe = unsafeHandleUse(ast, new Set([...native, ...browserHandles]), { code, ...inspection });
  if (unsafe) return unsafeHandleRefusal(unsafe);
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
      if (!['pressKey', 'click', 'doubleClick', 'rightClick', 'selectText', 'typeText', 'scroll', 'drag'].includes(call.method)) continue;
      // A spread has unknown arity. The runtime proxy validates the actual list.
      if (call.args.some(arg => arg.type === 'SpreadElement')) continue;
      const args = call.args.map(argumentValue);
      // Keep the runtime's more specific pointer refusal, including when pixels can lower to a swipe.
      if (['click', 'doubleClick', 'rightClick', 'drag', 'scroll'].includes(call.method) && quitKeyBlocked(call.method, args)) return QUIT_KEY_REFUSAL;
      const problem = nativeArgumentError(call.method, args, UNKNOWN, inspection);
      if (problem) return problem + '.';
    }
  }
}
