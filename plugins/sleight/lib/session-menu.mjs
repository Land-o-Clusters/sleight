import { quitAppAllowed } from './quit-key.mjs';
import { MAC_DRIVER_MENU_DETAILS, formatMacDriverError } from './mac-driver/errors.mjs';

export const MENU_BAR_REFUSAL = MAC_DRIVER_MENU_DETAILS['menu-compound'];
export const SESSION_MENU_REFUSAL = MAC_DRIVER_MENU_DETAILS['not-requested'];
export const PERSON_POPUP_REFUSAL = MAC_DRIVER_MENU_DETAILS['person-popup'];
const refuse = menuRefusal => {
  const fields = { menuRefusal,
    code: 'ACTION_UNSUPPORTED', parentSafety: true, delivery: 'not-sent', retry: 'safe',
  };
  throw Object.assign(Error(formatMacDriverError(fields)), fields);
};

// Shared by numbered clicks and raw compound targets. Only the parent supplies
// requests parsed from the authenticated user message, never the intent or AX.
export function sessionMenuRequestAllowed(title, { app, apple = false } = {}, requests = []) {
  const label = title.replace(/(?:\.{3}|…)$/, '').trim();
  const system = /^(log out|shut down|restart|force quit|lock screen|sleep)(?: |$)/i.exec(label)?.[1]?.toLowerCase();
  let required;
  if (/^quit(?: |$)/i.test(label)) {
    const name = label.slice(4).trim() || app;
    if (typeof name !== 'string' || !name.trim()) return false;
    required = 'menu:quit:' + name;
  }
  else if (system) {
    required = 'menu:session:' + system;
    const suffix = label.slice(system.length).trim();
    if (suffix && quitAppAllowed(required + ':' + suffix, requests)) required += ':' + suffix;
    else if (!suffix && system === 'force quit' && quitAppAllowed('menu:chooser:force quit', requests)) required = 'menu:chooser:force quit';
  }
  else if (apple) required = 'menu:label:' + label;
  if (required && !quitAppAllowed(required, requests)) return false;
  return true;
}

// The native policy calls this with a resolved number and its fresh admission
// read. Neither an app label nor model source supplies user-message authority.
export function checkSessionMenu({ method, args, text, window }, requests = []) {
  if (!['click', 'doubleClick', 'rightClick', 'press', 'performSecondaryAction', 'performAction'].includes(method)) return;
  if (!Number.isSafeInteger(args?.[0]) || typeof text !== 'string') return;
  const stack = [];
  for (const line of text.split('\n')) {
    const row = /^(\t*)(\d+) (.*)$/.exec(line); if (!row) continue;
    const depth = row[1].length, body = row[3];
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const title = body.replace(/^(?:menu bar item|menu item)(?: \([^)]*\))?(?: |$)/, '')
      .split(/, (?=[A-Za-z][A-Za-z ]*:)/)[0].replace(/^Description: /, '').replace(/ \(submenu, \d+ items\)$/, '').trim();
    const barChild = /^menu bar item(?: |$)/.test(body) || /^menu bar(?: |$)/.test(stack.at(-1)?.body ?? '');
    if (Number(row[2]) === args[0]) {
      if (barChild) refuse('menu-compound');
      if (!/^menu item(?: |$)/.test(body)) return;
      const apple = stack.some(parent => parent.barChild && /^(?:Apple|)(?: menu)?$/i.test(parent.title));
      if (!sessionMenuRequestAllowed(title, { app: window?.app, apple }, requests)) refuse('not-requested');
      return;
    }
    stack.push({ depth, body, title, barChild });
  }
}
