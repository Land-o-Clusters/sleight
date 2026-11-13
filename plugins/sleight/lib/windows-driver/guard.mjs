// Only relay-authored source runs here. Worker code and worker results never enter
// this context. The app stub can grant admission but cannot send native input.
import { runInNewContext } from 'node:vm';
import { guardedCode, elementLines, windowFromText, hasIdentifier, hasLabel } from '../document-scope.mjs';
import { paymentAction } from '../payment-gate.mjs';
import { guardWindowsClipboard } from './clipboard.mjs';
import { ACTION_METHODS } from './actions.mjs';

export function windowsGuardTree(text, focusedElement) {
  // UIA has no HTML-content role. Treat the app's content as payment scope too,
  // and translate UIA's focus flag to the common engine guard's focus record.
  let tree = text.replace(/^(\t*\d+) standard window\b/gm, '$1 HTML content');
  if (Number.isSafeInteger(focusedElement) && focusedElement >= 0) {
    const focus = elementLines(text).get(focusedElement);
    if (focus) tree += `\nThe focused UI element is ${focusedElement} ${focus}`;
  }
  return tree;
}

export function windowsDriverResult(result) {
  return { content: typeof result?.text === 'string' ? [{ type: 'text', text: result.text }] : [],
    ...(result?.window ? { _meta: { 'codex/toolSurface': { app: { appId: (result.window.aumid || result.window.image).toLowerCase() } } } } : {}) };
}

export async function guardWindowsAction({ method, args, text, before, focusedElement, expected = windowFromText(text), payment }) {
  if (!ACTION_METHODS.includes(method) || !expected || typeof text !== 'string' || typeof before !== 'string')
    throw Object.assign(Error('WINDOWS_GUARD_UNAVAILABLE'), { code: 'WINDOWS_GUARD_UNAVAILABLE' });
  guardWindowsClipboard({ method, args, text, focusedElement });
  if (method === 'scroll' || method === 'drag') {
    // These Windows signatures differ from the Mac API. They do not submit;
    // bind their endpoints here, under the same parent document/identity gate.
    const observed = windowFromText(text), rows = elementLines(text), prior = elementLines(before);
    if (!observed || ['title', 'app', 'url'].some(key => observed[key] !== expected[key])) throw Error('DOCUMENT_SCOPE_REFUSED');
    const bind = target => {
      if (Array.isArray(target)) return target;
      if (typeof target === 'number') {
        if (!rows.has(target) || rows.get(target) !== prior.get(target)) throw Error('STALE_ELEMENT');
        return target;
      }
      const matches = [...rows].filter(([, line]) => target.id !== undefined ? hasIdentifier(line, target.id)
        : target.label !== undefined ? hasLabel(line, target.label) : line === target.line.trimStart());
      if (matches.length !== 1) throw Error('ELEMENT_NOT_FOUND');
      return matches[0][0];
    };
    return { args: method === 'scroll' ? [bind(args[0]), args[1]] : [bind(args[0]), bind(args[1]), ...args.slice(2)] };
  }
  if (['pressKey', 'typeText', 'paste'].includes(method) && paymentAction(method, args) &&
      (!Number.isSafeInteger(focusedElement) || !elementLines(text).has(focusedElement))) throw Error('WINDOWS_FOCUS_UNAVAILABLE');
  const tree = windowsGuardTree(text, focusedElement), outputs = [];
  let admitted;
  const app = { getAXState: async () => tree };
  for (const name of ACTION_METHODS) app[name] = async (...resolved) => {
    if (name !== method || admitted) throw Error('WINDOWS_GUARD_REFUSED');
    admitted = JSON.parse(JSON.stringify(resolved));
  };
  // Identifiers and method names come from closed parent lists; every argument is
  // serialized as data. No model-authored statement is evaluated in this process.
  const code = `const app = await cua.getApp("parent-bound"); await app.${method}(...${JSON.stringify(args)});`;
  const source = guardedCode(code, expected, undefined, undefined, {
    careful: true, payment, guardStopMark: 'parent-guard:',
    seenLines: Object.fromEntries(elementLines(windowsGuardTree(before))),
    literals: typeof args[0] === 'number' ? [args[0]] : [],
  });
  await runInNewContext(`(async () => { ${source} })()`, {
    cua: { getApp: async () => app }, nodeRepl: { write: value => outputs.push(value) },
  }, { timeout: 1000 });
  if (!admitted) throw Object.assign(Error('WINDOWS_GUARD_REFUSED'), { code: 'WINDOWS_GUARD_REFUSED' });
  for (const output of outputs) if (typeof output === 'string' && output.startsWith('parent-guard:')) {
    try { const record = JSON.parse(output.slice('parent-guard:'.length)); if (record.paid) return { args: admitted, paid: record.paid }; } catch {}
  }
  return { args: admitted };
}
