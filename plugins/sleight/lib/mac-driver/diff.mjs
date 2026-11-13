// Parent-owned read state. Driver observations never imply model delivery.
// Optional display diffs never replace the full parent or worker observations.
import { isPaymentTarget, windowFromText } from '../document-scope.mjs';
import { consequentialLabels, normalizeActionLabel, regexWord, consequentialWords, refuseClipboardLabel } from '../action-labels.mjs';
export { consequentialLabels, clipboardWriteLabels, normalizeActionLabel, MAC_CLIPBOARD_WRITE_REFUSAL } from '../action-labels.mjs';
import { verifyWindowIdentity } from '../repl/identity.mjs';
import { GUARD_MARK, GUARD_END, GUARD_OMIT_MARK, createReadCompactor, alignLines } from '../compact-reads.mjs';
import { formatMacDriverError } from './errors.mjs';
import { keyboardArguments } from './keys.mjs';
import { MAC_DRIVER_ROLES } from './roles.mjs';

export const MAC_DELIVERED_CONTEXT_NOTICE = 'emit:false, same-cell and dead-cell reads grant no rows. End the cell and read again. Use a + line or getAXState({ disableDiffing: true }).';
export const MAC_STRING_TARGET_NOTICE = 'A string target needs exactly one matching ID in both reads and the same GLR1 binding.';
export const MAC_READ_REFUSAL_DETAILS = Object.freeze({
  'handle-readid': 'The handle readId does not match the retained read. End the cell and read again.',
  'worker-copy': 'A worker copy has no exact parent tree for this window in the same display. End the cell and read again.',
  'no-row': MAC_DELIVERED_CONTEXT_NOTICE,
  belief: 'This number was not shown for this row, or its context changed. Use a + line or read again.',
  selector: MAC_STRING_TARGET_NOTICE,
});

export const MAC_NUMBER_REMAP_NOTICE = 'sleight: <name>(N) went to element M';

const bindingKey = value => JSON.stringify([value?.windowId, value?.processStart]);
// Exempt reads, never enumerate inputs: new input methods must check numbers too.
const actedMethods = new Set(['click', 'doubleClick', 'rightClick', 'longPress', 'press', 'performSecondaryAction', 'drag', 'setValue', 'scroll']);
const untargeted = new Set(['typeText', 'pressKey', 'paste', 'modifiers']);
const reads = new Set(['getApp', 'getAXState', 'getAXStateAndScreenshot', 'getScreenshot',
  'getState', 'listApps', 'listWindows', 'resolveApp', 'verifyWindowIdentity', 'ping', 'health']);
const fail = code => { throw Object.assign(Error(code), { code }); };
const stale = (detail = '', step = 'belief') => { throw Object.assign(Error(formatMacDriverError({ code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' }).replace('STALE_READ:', `STALE_READ step=${step}:`) + '\n' + (detail || MAC_READ_REFUSAL_DETAILS[step])),
  { code: 'STALE_READ', parentSafety: true, delivery: 'not-sent', retry: 'safe' }); };

// The driver prints one state group immediately after its role.
const stateFlag = 'disabled|focused|selected|selectable|checked|expanded|collapsed|settable|float|boolean';
const flagPattern = new RegExp(`^\\((?:${stateFlag})(?:, (?:${stateFlag}))*\\)(?= |$)`);
function flagMatch(body) {
  const name = role(body), offset = name ? name.length + 1 : 0;
  const match = flagPattern.exec(body.slice(offset));
  return match && { text: match[0], offset };
}
const flags = body => flagMatch(body)?.text.slice(1, -1).split(', ') ?? [];
function withoutFlags(body) {
  const match = flagMatch(body);
  if (!match) return body;
  const tail = body.slice(match.offset + match.text.length);
  return match.offset ? body.slice(0, match.offset - 1) + tail : tail.replace(/^ /, '');
}
// The driver's closed role vocabulary (DriverTree.swift driverRoles and driverSubroles, default "container"), longest match
// first. A regex that stops at the first capital letter reads "button cancel" as the role "button cancel".
export { MAC_DRIVER_ROLES };
const allRoles = [...MAC_DRIVER_ROLES, 'group', 'search text field', 'text area', 'system window', 'dialog window', 'window', 'system dialog', 'check box', 'pop over', 'web dialog'].sort((a, b) => b.length - a.length);
const printedNumber = new RegExp(`\\b\\d+ (?:${allRoles.join('|')})(?:\\b|,)`);
const role = body => allRoles.find(r => body === r || body.startsWith(r + ' ') || body.startsWith(r + ',')) ?? '';
// Value is metadata only after the role or an attribute separator. Label text
// such as "text field lower Value: alpha" remains identity text.
function valueMatch(body) {
  const plain = withoutFlags(body), name = role(plain);
  const offset = name && plain.startsWith(name + ' ') ? name.length + 1 : 0;
  const match = /(^|, )Value: ?(.*?)(?=, [A-Za-z][A-Za-z ]*:|$)/.exec(plain.slice(offset));
  return match && { value: match[2], start: offset + match.index, length: match[0].length };
}
const shownValue = body => valueMatch(body)?.value;
function identityText(body) {
  let plain = withoutFlags(body);
  const value = valueMatch(body);
  if (value) plain = plain.slice(0, value.start) + plain.slice(value.start + value.length);
  return plain;
}
function bareRole(body) {
  const identity = identityText(body), tail = identity.slice(role(body).length).trim();
  const pieces = tail.split(/, (?=[A-Za-z][A-Za-z ]*:)/);
  return !pieces.some((part, i) => i === 0 && part && !/^[A-Za-z][A-Za-z ]*:/.test(part) ||
    /^(?:Description|ID|URL|Placeholder): .+/.test(part));
}
const secureField = body => /^(?:secure (?:text )?field|password (?:text )?field)(?: |,|$)/.test(withoutFlags(body));
// Exclusive-selection groups: choosing one same-role sibling changes the others.
const selectionRole = /^(?:radio button|tab|row|cell|toggle button)$/;
const modalRole = /^(?:menu|menu bar|menu bar item|menu item|sheet|dialog|alert|system dialog|popover|pop over|window|standard window|floating window|system window|dialog window|web dialog)$/;
const currencies = Intl.supportedValuesOf('currency').join('|');
const moneyFigure = new RegExp(`\\p{Sc}\\s*[-+−]?\\s*\\d|\\b(?:${currencies})\\s*[-+−]?\\s*\\d|\\d[\\d.,]*\\s*(?:${currencies})\\b|\\b\\d[\\d.,]*[.,]\\d{2}\\b`, 'iu');
const moneyOrSecret = body => moneyFigure.test(body) || /\b(?:pay|card|cc-|credit|debit|cvv|cvc|expir|iban|routing|account|ssn|passw|passcode|pin|otp|secret|security code|billing|bank|secure|checkout|place order|purchase|buy)\b/i.test(body);
// Consequential actions bind the whole tree, including their own state and later lines.
const clipboardActivation = new Set(['click', 'doubleClick', 'performSecondaryAction']);
function refuseClipboardWrite(row) {
  if (!row) return;
  refuseClipboardLabel(Object.hasOwn(row, 'label') ? row.label : actionLabel(row.body));
}
// Mirror the native retained-map label/ID selectors. Unknown and ambiguous
// selectors refuse before any policy keyed by element number runs.
function selectorMatches(row, target) {
  const parts = withoutFlags(row.body).slice(row.role.length).replace(/^,? /, '').split(/, (?=[A-Za-z][A-Za-z ]*:)/);
  if (typeof target.id === 'string') return parts.includes('ID: ' + target.id);
  const title = parts.find((part, i) => i === 0 && !/^[A-Za-z][A-Za-z ]*:/.test(part))
    ?.replace(/ \(submenu, \d+ items\)$/, '');
  const description = parts.find(part => part.startsWith('Description: '))?.slice(13).replace(/ \(submenu, \d+ items\)$/, '');
  return typeof target.label === 'string' && target.label === (title || description || '');
}
// Preserve the old English ASCII-boundary refusals too. Normalizing Confirmé
// yields confirme, which otherwise loses the old boundary after Confirm.
// Both matchers use the same table; this compatibility check can only refuse.
const englishCompatibilityWords = new RegExp(`\\b(?:${consequentialLabels.en.split('|').map(regexWord).join('|')})\\b`, 'i');
function actionLabel(line) {
  const field = /^(?:text field|text area|text entry area|search field|search text field|combo box|link)$/.test(role(line));
  return withoutFlags(line).slice(role(line).length).replace(/^,? /, '').split(/, (?=[A-Za-z][A-Za-z ]*:)/)
    .filter(part => !/^[A-Za-z][A-Za-z ]*:/.test(part) || /^Description:/.test(part) || !field && /^Value:/.test(part))
    .map(part => part.replace(/^(?:Description|Value): ?/, '')).join(' ');
}
function possibleFormEnd(row, lines) {
  if (row.role !== 'button') return false;
  // AX has no form-submit bit. A button after a form field in a shared
  // ancestor may end that form, even through wrappers or before another button.
  // Ambiguity binds it too, rather than trusting an empty/malformed label.
  for (let parent = row.parentIndex; parent !== undefined; parent = lines[parent].parentIndex) {
    if (lines.slice(parent + 1, row.index).some(line =>
      /^(?:text field|secure text field|text area|text entry area|search field|search text field|combo box|checkbox|check box|radio button|switch|toggle button|pop up button|menu button|slider|stepper)$/.test(line.role))) return true;
  }
  return false;
}
function consequentialTarget(row, lines) {
  const { body, parents } = row;
  if (isPaymentTarget(body, parents)) return true;
  // Match the shown label and Description (and a control's Value), as the
  // existing submit rules do. Help, IDs and secondary-action names are metadata.
  const labels = [body, ...parents.slice(-2).filter(parent => /^(?:button|link|container|group)\b/.test(parent))];
  return labels.some(line => {
    const classification = classifyConsequentialLabel(actionLabel(line));
    return classification === 'boundary' || classification === 'unknown' && line === body && possibleFormEnd(row, lines);
  });
}
// The shared skeleton folds case before mapping confusables, so capitals whose
// lowercase looks different (Greek Nu, Cyrillic Ve) escape it. A word mixing
// Latin with Greek or Cyrillic letters is treated as consequential (fail closed).
function mixedScriptWord(shown) {
  try {
    return typeof shown === 'string' && shown.normalize('NFKC').split(/[^\p{L}\p{M}]+/u).some(word =>
      /\p{Script=Latin}/u.test(word) && /[\p{Script=Greek}\p{Script=Cyrillic}]/u.test(word));
  } catch { return true; }
}

// The same finite lexical rule serves numbered actions and compound targets.
// Unknown labels still need the caller's structural fail-closed rule.
export function classifyConsequentialLabel(shown) {
  const label = normalizeActionLabel(shown);
  if (!!label && consequentialWords.test(label) || englishCompatibilityWords.test(shown) || mixedScriptWord(shown)) return 'boundary';
  return label ? 'clear' : 'unknown';
}

function numberedTree(text) {
  const numbers = new Map(), lines = [], stack = [];
  for (const line of text.split('\n')) {
    const match = /^(\t*)(\d+) (.*)$/.exec(line);
    if (!match) continue;
    const depth = match[1].length, number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number !== lines.length) fail('DRIVER_PROTOCOL');
    while (stack.length && stack.at(-1).depth >= depth) stack.pop().end = lines.length;
    const row = { text: line, depth, key: match[1] + match[3], body: match[3], role: role(match[3]),
      parents: stack.map(parent => parent.body), parentIndex: stack.at(-1)?.index, index: lines.length, end: undefined };
    numbers.set(number, lines.length); lines.push(row); stack.push(row);
  }
  while (stack.length) stack.pop().end = lines.length;
  return { numbers, lines };
}

// Policy sees the same numbered target for every selector. Keep the original
// selector on the native request so the helper still rechecks focus/liveness.
export function resolveMacPolicyTargets(method, args, text) {
  const resolved = [...args];
  if (untargeted.has(method)) return resolved;
  for (const index of method === 'drag' ? [0, 1] : [0]) {
    const target = resolved[index];
    if (!target || typeof target !== 'object' || Array.isArray(target)) continue;
    if (Object.keys(target).length !== 1 || !['focused', 'id', 'label'].some(key => Object.hasOwn(target, key))) fail('INVALID_PARAMS');
    const candidates = numberedTree(text).lines.filter(row => target.focused === true
      ? flags(row.body).includes('focused') : selectorMatches(row, target));
    if (candidates.length !== 1) stale();
    resolved[index] = candidates[0].index;
  }
  return resolved;
}

// E1 is a metadata-only viewport, never a web/document region or a price.
// Store row objects so both sides must independently qualify for the exemption.
function displayRows(lines) {
  const display = new Set();
  for (const row of lines) {
    if (!['scroll area', 'layout area'].includes(row.role) || !/\bID: [^,]+/.test(row.body)) continue;
    if (row.parents.some(p => role(p) === 'web area')) continue;
    const part = lines.slice(row.index, row.end);
    if (part.some(r => moneyOrSecret(r.body))) continue;
    if (part.some((r, j) => flags(r.body).includes('settable') || j > 0 &&
        (!['text', 'image', 'progress indicator', 'value indicator', 'group', 'container', 'layout item'].includes(r.role) ||
         r.role === 'text' && !/\b(?:Description|ID): .+/.test(r.body)))) continue;
    for (const r of part) display.add(r);
  }
  return display;
}
const buttonIdentityRole = /^(?:button|toggle button|menu button|pop up button)$/;
const surfaceRole = /^(?:menu|sheet|dialog|alert|system window|system dialog|popover|pop over|floating window|dialog window|web dialog)$/;
const inClosedMenu = row => row.parents.some(p => role(p) === 'menu' && flags(p).includes('collapsed') && !flags(p).includes('expanded'));
const numericDisplayValue = value => typeof value === 'string' && /\d/.test(value) && /^[\d.,+−\-%*/×÷^E ]+$/.test(value.trim());
const displayIdentity = row => ['scroll area', 'layout area'].includes(row.role) ? identityText(row.body).replace(/((?:^scroll area |^layout area |, )ID: [^,]*?);value:([^,]*(?:,(?! [A-Za-z][A-Za-z ]*:)[^,]*)*)/, (all, id, value) => numericDisplayValue(value) ? id : all) : identityText(row.body);
const buttonMetadata = body => withoutFlags(body).slice(role(body).length).trim().split(/, (?=[A-Za-z][A-Za-z ]*:)/)
  .filter(part => /^[A-Za-z][A-Za-z ]*:/.test(part) && !/^(?:Description|ID|Value):/.test(part)).join(', ');

const siblingName = row => withoutFlags(row.body).slice(row.role.length).trim().split(/, (?=[A-Za-z][A-Za-z ]*:)/)
  .filter(part => !/^[A-Za-z][A-Za-z ]*:/.test(part) || /^(?:Description|ID):/.test(part)).join(', ');

// E2b grants context identity drift only to a same-role sibling of this cell's
// acted button. It grants no target, state, modal or structural freedom.
function siblingIdentity(a, b, i, ctx) {
  if (i === ctx.target || !buttonIdentityRole.test(a.role)) return false;
  if (a.parents.some(p => surfaceRole.test(role(p)) || role(p) === 'web area') ||
      b.parents.some(p => surfaceRole.test(role(p)) || role(p) === 'web area')) return false;
  const old = ctx.delivered.filter(r => r.parentIndex === a.parentIndex && !ctx.display.has(r));
  const fresh = ctx.current.filter(r => r.parentIndex === b.parentIndex && !ctx.display.has(r));
  if (old.length !== fresh.length) return false;
  if (![...ctx.acted].some(n => n !== i && ctx.delivered[n]?.parentIndex === a.parentIndex &&
      ctx.delivered[n]?.role === a.role)) return false;
  const ai = siblingName(a), bi = siblingName(b);
  if ([ai, bi].some(text => moneyOrSecret(text) || classifyConsequentialLabel(text) === 'boundary')) return false;
  if (ctx.delivered.some(r => r.parentIndex === a.parentIndex && r.index !== i && siblingName(r) === bi)) return false;
  if (buttonMetadata(a.body) !== buttonMetadata(b.body)) return false;
  const keptFlags = body => flags(body).filter(flag => !['focused', 'disabled'].includes(flag)).join();
  if (keptFlags(a.body) !== keptFlags(b.body)) return false;
  return shownValue(a.body) === shownValue(b.body);
}

// A row's identity and state are compared in both directions. E2 gives identity
// freedom to an acted button, or to context satisfying the E2b sibling rule.
function lineDiff(a, b, i, ctx) {
  if (!a || !b) return 'target-missing';
  if (a.depth !== b.depth) return 'depth';
  if (a.role !== b.role) return 'role';
  if (secureField(a.body) || secureField(b.body)) {
    if (shownValue(a.body) !== undefined || shownValue(b.body) !== undefined) return 'secure';
  }
  const own = ctx.acted.has(i), isTarget = i === ctx.target;
  if (ctx.writes.has(i)) {
    const written = ownWrite(a.body, b.body, ctx.writes.get(i));
    if (written === 'other-value') return 'own-write-other-value';
    if (written === true) return;
    return 'own-write-identity';
  }
  if (a.body === b.body) return;
  if (own && buttonIdentityRole.test(a.role)) return buttonMetadata(a.body) === buttonMetadata(b.body) ? undefined : 'metadata';
  const fa = flags(a.body), fb = flags(b.body);
  const free = new Set(['focused', ...isTarget ? [] : ['disabled']]);
  if (own) for (const flag of [...fa, ...fb]) free.add(flag);
  if (ctx.actedSiblings.has(i)) for (const flag of ['checked', 'selected']) free.add(flag);
  if (fa.filter(f => !free.has(f)).join() !== fb.filter(f => !free.has(f)).join()) return 'flags';
  // E3 permits labels and enabled state only under a still-collapsed menu.
  if (!isTarget && a.role === 'menu item' && inClosedMenu(a) && inClosedMenu(b)) {
    if (fb.includes('selected') && !fa.includes('selected')) return 'menu-selection';
    const id = row => /(?:^|, )ID: ([^,]*)/.exec(withoutFlags(row.body))?.[1];
    if (id(a) === id(b) && shownValue(a.body) === shownValue(b.body)) return;
  }
  const display = ctx.display.has(a) && ctx.display.has(b);
  if ((display ? displayIdentity(a) !== displayIdentity(b) : identityText(a.body) !== identityText(b.body)) &&
      !siblingIdentity(a, b, i, ctx)) return 'identity';
  if (shownValue(a.body) === shownValue(b.body)) return;
  if (display && numericDisplayValue(shownValue(a.body)) && numericDisplayValue(shownValue(b.body)) || !display && own) return;
  return 'value-drift';
}

function fieldParts(body) {
  const plain = withoutFlags(body);
  const tail = /^(?:text field|search field|search text field|combo box|text area|text entry area)(?: |$)(.*)$/.exec(plain)?.[1];
  if (tail === undefined) return;
  const pieces = tail.split(/, (?=[A-Za-z][A-Za-z ]*:)/);
  if (['Value', 'Placeholder'].some(name => pieces.filter(part => part.startsWith(name + ':')).length > 1)) return;
  const bare = /^[A-Za-z][A-Za-z ]*:/.test(pieces[0]) ? '' : pieces.shift();
  const value = pieces.find(p => p.startsWith('Value:'))?.replace(/^Value: ?/, '') ?? bare;
  const placeholder = pieces.find(p => p.startsWith('Placeholder:'))?.replace(/^Placeholder: ?/, '');
  return { value, placeholder, bare, explicitValue: pieces.some(p => p.startsWith('Value:')), rest: pieces.filter(p => !/^(?:Value|Placeholder):/.test(p)).join(', ') };
}
function ownWrite(before, after, written) {
  if (!flags(before).includes('settable') || !flags(after).includes('settable')) return false;
  const a = fieldParts(before), b = fieldParts(after);
  if (!a || !b || a.rest !== b.rest || a.explicitValue && a.bare !== b.bare || b.explicitValue && b.bare && (!a.explicitValue || a.bare !== b.bare)) return false;
  if (b.value !== written) return 'other-value';
  return a.placeholder === undefined ? b.placeholder === undefined || b.placeholder === a.value : b.placeholder === a.placeholder;
}

function makeCtx(delivered, { acted = [], writes = new Map(), target }) {
  const actedSet = new Set(acted);
  const actedSiblings = new Set();
  for (const i of actedSet) {
    const row = delivered[i]; if (!row) continue;
    if (!selectionRole.test(row.role)) continue;
    for (const s of delivered) if (s.parentIndex === row.parentIndex && s.role === row.role && s.index !== i) actedSiblings.add(s.index);
  }
  return { acted: actedSet, writes, target, actedSiblings };
}

// All modal surfaces and their children are context even after the target.
// The standard root window is deliberately excluded from this global set.
function surfaceChanged(delivered, current, ctx) {
  // Closed-menu leaves after the target are outside prefix context. AppKit may
  // omit an unselected alternate command there, as in the recorded Calculator
  // read. Bind every surface and expanded/non-menu modal subtree, plus selection gains.
  const nonMenuModal = body => surfaceRole.test(role(body)) && role(body) !== 'menu';
  const expandedMenu = body => role(body) === 'menu' && (!flags(body).includes('collapsed') || flags(body).includes('expanded'));
  // GLS2 D: expanded menu context is byte-exact. Generic context exemptions
  // such as a sibling's disabled flag cannot authorize a popup choice.
  const expanded = lines => lines.filter(row => expandedMenu(row.body) || row.parents.some(expandedMenu))
    .map(row => [row.index, row.depth, row.body]);
  if (JSON.stringify(expanded(delivered)) !== JSON.stringify(expanded(current))) return true;
  const surface = lines => lines.filter(row => surfaceRole.test(row.role) || row.parents.some(nonMenuModal) || row.parents.some(expandedMenu));
  const a = surface(delivered), b = surface(current);
  if (a.length !== b.length || a.some((row, i) => lineDiff(row, b[i], row.index, ctx))) return true;
  for (let i = 0; i < a.length; i++) {
    let ai = a[i].parentIndex, bi = b[i].parentIndex;
    while (ai !== undefined && bi !== undefined) {
      if (lineDiff(delivered[ai], current[bi], ai, ctx)) return true;
      ai = delivered[ai].parentIndex; bi = current[bi].parentIndex;
    }
    if (ai !== bi) return true;
  }
  const items = lines => lines.filter(row => ['menu item', 'menu bar item'].includes(row.role));
  const prior = items(delivered);
  return items(current).some((row, i) => flags(row.body).includes('selected') &&
    (row.role !== prior[i]?.role || row.depth !== prior[i]?.depth || !flags(prior[i].body).includes('selected')));
}

function check(delivered, current, n, ctx) {
  const d = delivered[n], c = current[n];
  if (!d || !c) return { allow: false, why: 'target-missing' };
  if ((consequentialTarget(c, current) || secureField(c.body)) &&
      (delivered.length !== current.length || delivered.some((row, i) => row.text !== current[i].text)))
    return { allow: false, why: 'consequential-tree' };
  if (d.end !== c.end) return { allow: false, why: 'subtree-size' };
  for (let i = 0; i < d.end; i++) {
    const why = lineDiff(delivered[i], current[i], i, ctx);
    if (why) return { allow: false, why: (i < n ? 'above:' : i === n ? 'target:' : 'subtree:') + why };
  }
  return { allow: true, why: 'none' };
}
function removableBlock(block, current, ctx, afterContext) {
  // A removed seen row must still exist in the same parent context, unless its
  // entire metadata viewport qualifies for E1. Multiplicity must survive too.
  const used = new Set(), relocated = new Map();
  for (const row of block) {
    if (ctx.display.has(row) && block.some(root => ['scroll area', 'layout area'].includes(root.role) &&
        ctx.display.has(root) && root.index <= row.index && root.end > row.index && block.at(-1).index >= root.end - 1)) continue;
    const parentInBlock = block.some(parent => parent.index === row.parentIndex);
    if (parentInBlock && !relocated.has(row.parentIndex)) return false;
    const expectedParent = parentInBlock ? relocated.get(row.parentIndex) : row.parentIndex;
    const candidates = current.filter(other => !used.has(other) && other.parentIndex === expectedParent &&
      other.parents.length === row.parents.length &&
      other.parents.every((p, i) => identityText(p) === identityText(row.parents[i])) &&
      identityText(row.body) === identityText(other.body) && !lineDiff(row, other, row.index, ctx));
    if (candidates.length !== 1 || candidates[0].index < afterContext) return false;
    used.add(candidates[0]); relocated.set(row.index, candidates[0].index);
  }
  return true;
}

// E4: exactly one contiguous, well-formed insertion/removal before the target.
// Count alignments, not just target candidates: two possible block boundaries
// are ambiguous even if they happen to reach the same fresh number.
function remap(delivered, current, n, ctx) {
  const d = delivered[n];
  if (!d) return { refuse: 'target-missing' };
  if (bareRole(d.body) || modalRole.test(d.role) || secureField(d.body)) return { refuse: 'unmapped-role' };
  const size = d.end - n, candidates = [];
  for (let m = 0; m < current.length; m++) {
    const k = m - n, c = current[m];
    if (!k || c.end - m !== size || consequentialTarget(c, current) || secureField(c.body)) continue;
    if (lineDiff(d, c, n, ctx)) continue;
    let ok = true;
    for (let j = 1; j < size && ok; j++) if (lineDiff(delivered[n + j], current[m + j], n + j, ctx)) ok = false;
    if (!ok) continue;
    const insert = k > 0, len = Math.abs(k), long = insert ? current : delivered, shortTarget = insert ? n : m;
    for (let p = 0; p <= shortTarget; p++) {
      let good = true;
      for (let i = 0; i < p && good; i++) if (lineDiff(delivered[i], current[i], i, ctx)) good = false;
      if (!good) break;
      const block = long.slice(p, p + len), depth0 = block[0]?.depth, after = long[p + len];
      if (block.length !== len || !after || block.some(r => r.depth < depth0) || after.depth > depth0) continue;
      if (insert && block.some(r => modalRole.test(r.role) || moneyOrSecret(r.body) || isPaymentTarget(r.body) ||
          secureField(r.body) || flags(r.body).some(f => ['settable', 'selected', 'checked'].includes(f)))) continue;
      if (!insert && !removableBlock(block, current, ctx, c.end)) continue;
      for (let i = p; i < shortTarget && good; i++) {
        const di = insert ? i : i + len, ci = insert ? i + len : i;
        if (lineDiff(delivered[di], current[ci], di, ctx)) good = false;
      }
      if (good) candidates.push({ to: m, k, p });
      if (candidates.length > 1) return { refuse: 'ambiguous-shift' };
    }
  }
  return candidates[0] ?? { refuse: 'no-shift' };
}
function matchTarget(delivered, current, target, evidence) {
  const ctx = { ...makeCtx(delivered, { ...evidence, target }), delivered, current };
  ctx.display = new Set([...displayRows(delivered), ...displayRows(current)]);
  const d = delivered[target];
  if (!d) return { refuse: 'target-missing' };
  // Whole-read byte equality has no E1-E4 exceptions for consequential/secure
  // controls, regardless of whether the old number now names another control.
  if (consequentialTarget(d, delivered) || secureField(d.body)) {
    if (delivered.length !== current.length || delivered.some((row, i) => row.text !== current[i].text)) return { refuse: 'consequential-tree', why: 'consequential-tree' };
  }
  if (surfaceChanged(delivered, current, ctx)) return { refuse: 'surface' };
  const same = check(delivered, current, target, ctx);
  // E2 belongs to the acted control at its last structural alignment. A new
  // button at the old number cannot borrow that control's identity freedom.
  const movedBefore = evidence.remaps?.has(target) === true;
  const stableIdentity = current[target] && identityText(d.body) === identityText(current[target].body);
  if (same.allow && (!movedBefore || stableIdentity)) return { to: target, invariant: true };
  const moved = remap(delivered, current, target, ctx);
  return { ...moved, invariant: false, why: same.why };
}
export function compareMacElement(deliveredText, currentText, target, evidence = {}) {
  return matchTarget(numberedTree(deliveredText).lines, numberedTree(currentText).lines, target, evidence);
}

// The selector adds uniqueness in both reads and must agree with the structural
// alignment. It never supplies a separate, weaker identity/context rule.
function matchSelector(delivered, current, selector, evidence) {
  const before = delivered.filter(row => selectorMatches(row, selector));
  const after = current.filter(row => selectorMatches(row, selector));
  if (before.length !== 1 || after.length !== 1) return {};
  const a = before[0], b = after[0];
  const bound = matchTarget(delivered, current, a.index, evidence);
  if (bound.to !== b.index) return {};
  return bound;
}

export function createMacReadState() {
  const windows = new Map(), observations = new WeakMap();
  const pendingDisplays = new Set();
  let epoch = 0, displayOrder = 0;
  function read(result) {
    const key = bindingKey(result?.window), previous = windows.get(key);
    try {
      verifyWindowIdentity(result?.window, result?.window, 'darwin');
      if (previous) verifyWindowIdentity(previous.snapshot.window, result.window, 'darwin');
      const reused = result.reused === true;
      if (typeof result.text !== 'string' || !Number.isSafeInteger(result.readId) || result.readId < 1 ||
          result.reused !== undefined && typeof result.reused !== 'boolean' ||
          (reused ? !previous || result.readId !== previous.snapshot.readId || result.text !== previous.snapshot.text ||
            result.truncated === true || previous.snapshot.truncated : previous && result.readId <= previous.snapshot.readId) ||
          result.truncated !== undefined && typeof result.truncated !== 'boolean' ||
          !/^0 (?:standard window|floating window|system window|dialog window|window|sheet|dialog)\b/.test(result.text.split('\n', 2)[1] ?? '') ||
          [GUARD_MARK, GUARD_END, GUARD_OMIT_MARK].some(mark => result.text.includes(mark))) fail('DRIVER_PROTOCOL');
      const header = windowFromText(result.text);
      if (!header || header.app !== result.window.app || header.title !== result.window.title) fail('DRIVER_PROTOCOL');
      const snapshot = Object.freeze({ text: result.text, readId: result.readId, truncated: result.truncated === true,
        window: Object.freeze({ ...result.window }) });
      const token = previous?.token ?? Symbol();
      observations.set(snapshot, { ...numberedTree(result.text), key, epoch, token, snapshot });
      windows.delete(key);
      windows.set(key, { snapshot, complete: snapshot.truncated ? previous?.complete : observations.get(snapshot), token, delivered: previous?.delivered, actions: previous?.actions,
        belief: previous?.belief, full: previous?.full, undelivered: previous?.undelivered, deliveredOrder: previous?.deliveredOrder });
      if (windows.size > 16) windows.delete(windows.keys().next().value);
      return snapshot;
    } catch (error) { windows.delete(key); throw error; }
  }
  function assertCurrent(method, params, cell) {
    const entry = windows.get(bindingKey(params));
    if (entry && (!entry.actions || entry.actions.cell !== cell)) entry.actions = { cell, writes: new Map(), acted: new Set(), remaps: new Map() };
    const actions = entry?.actions;
    if (actions && method !== 'typeText') actions.click = undefined;
    if (reads.has(method)) return;
    // Coordinates use the separately delivered image map. They still enter
    // this method to retire click/type evidence from earlier numbered input.
    if (['click', 'doubleClick', 'rightClick'].includes(method) && Array.isArray(params?.args?.[0])) return;
    // A key has no element number to retain. Parent admission takes a fresh
    // read and the native keyboard still checks its map, focus and identity.
    if (method === 'pressKey' && typeof params?.args?.[0] === 'string' && params.target === undefined) return;
    if (!entry || params?.readId !== entry.snapshot.readId) stale('', 'handle-readid');
    if (entry.snapshot.truncated) stale(MAC_DELIVERED_CONTEXT_NOTICE, 'no-row');
    const current = observations.get(entry.snapshot), delivered = entry.delivered;
    // Check the full printed label before selector parsing can mistake label
    // text for metadata. A refusal here grants no target or delivery evidence.
    if (clipboardActivation.has(method)) {
      const target = params.args?.[0];
      if (target && typeof target === 'object' && !Array.isArray(target))
        for (const row of current.lines) {
          const fullLabel = withoutFlags(row.body).slice(row.role.length).replace(/^,? /, '');
          if (target.label === fullLabel) refuseClipboardWrite({ label: fullLabel });
          if (selectorMatches(row, target)) refuseClipboardWrite(row);
        }
    }
    const targets = [['target', params.target], ['first', params.args?.[0]],
      ...(method === 'drag' ? [['second', params.args?.[1]]] : [])];
    const mapped = [], notices = [];
    for (const [slot, rawTarget] of targets) {
      const focused = rawTarget && typeof rawTarget === 'object' && !Array.isArray(rawTarget) &&
        Object.keys(rawTarget).length === 1 && rawTarget.focused === true;
      const stringId = typeof rawTarget === 'string' && (slot !== 'first' || !untargeted.has(method));
      const selectorTarget = stringId ? { id: rawTarget } : rawTarget;
      const object = selectorTarget && typeof selectorTarget === 'object' && !Array.isArray(selectorTarget);
      const modifierOptions = method === 'modifiers' && slot === 'first' && object;
      if (modifierOptions) keyboardArguments(method, params.args);
      const selector = object && !modifierOptions;
      let target = rawTarget;
      if (selector) {
        if (focused && !['click', 'setValue', 'selectText'].includes(method)) fail('INVALID_PARAMS');
        const candidates = delivered?.lines.filter(row => focused ? flags(row.body).includes('focused') : selectorMatches(row, selectorTarget)) ?? [];
        if (candidates.length !== 1) stale(stringId ? MAC_STRING_TARGET_NOTICE : MAC_DELIVERED_CONTEXT_NOTICE, 'selector');
        target = candidates[0].index;
      }
      if (typeof target === 'string' && (slot !== 'first' || !untargeted.has(method))) fail('INVALID_PARAMS');
      if (typeof target !== 'number') continue;
      if (!Number.isSafeInteger(target) || target < 0) fail('INVALID_PARAMS');
      if (entry.undelivered) stale('', 'worker-copy');
      if (!delivered?.lines[target]) stale(MAC_DELIVERED_CONTEXT_NOTICE, 'no-row');
      if (!selector && entry.belief?.get(target) !== beliefKey(delivered.lines[target])) stale(MAC_DELIVERED_CONTEXT_NOTICE);
      const result = selector && !focused
        ? matchSelector(delivered.lines, current.lines, selectorTarget, actions)
        : matchTarget(delivered.lines, current.lines, target, actions);
      if (result.to === undefined) stale(stringId ? MAC_STRING_TARGET_NOTICE : '', selector ? 'selector' : 'belief');
      if (focused && !flags(current.lines[result.to].body).includes('focused')) stale();
      const to = result.to, bound = actions.remaps.get(target);
      if (bound?.readId === entry.snapshot.readId && bound.to !== to) stale();
      if (to !== target) {
        const name = withoutFlags(delivered.lines[target].body);
        notices.push(MAC_NUMBER_REMAP_NOTICE.replace('<name>(N)', () => `${name}(${target})`).replace(/ M$/, ` ${to}`));
      }
      mapped.push({ slot, from: target, to, focused, selector, stringId });
    }
    if (clipboardActivation.has(method)) {
      if (method === 'performSecondaryAction') refuseClipboardWrite({ label: params.args?.[1] });
      for (const { to } of mapped) refuseClipboardWrite(current.lines[to]);
    }
    // Validate every endpoint before mutating the outgoing request or granting evidence.
    for (const { slot, to, selector, stringId } of mapped) {
      if (stringId) {
        if (slot === 'target') params.target = { id: params.target };
        else params.args[slot === 'first' ? 0 : 1] = { id: params.args[slot === 'first' ? 0 : 1] };
      }
      if (selector) continue;
      if (slot === 'target') params.target = to;
      else params.args[slot === 'first' ? 0 : 1] = to;
    }
    const originalTarget = mapped.find(row => row.slot === 'first')?.from ?? mapped.find(row => row.slot === 'target')?.from;
    const value = params.args?.[1], typed = params.args?.[0], token = entry.token, turn = epoch;
    let completed = false;
    const complete = () => {
      const live = windows.get(bindingKey(params));
      if (completed || epoch !== turn || live?.token !== token || live.actions !== actions || live.delivered !== delivered) return;
      completed = true;
      for (const { from, to } of mapped) {
        if (actedMethods.has(method)) actions.acted.add(from);
        if (from !== to) actions.remaps.set(from, { to, readId: params.readId });
      }
      if (method === 'setValue' && originalTarget !== undefined && typeof value === 'string') actions.writes.set(originalTarget, value);
      if (method === 'typeText' && actions.click && typeof typed === 'string') {
        actions.click.text += typed; actions.writes.set(actions.click.target, actions.click.text);
      } else actions.click = method === 'click' && originalTarget !== undefined ? { target: originalTarget, text: '' } : undefined;
    };
    complete.notices = notices;
    complete.targets = mapped.map(({ to }) => to);
    return complete;
  }
  const beliefKey = row => row.depth + ':' + identityText(row.body);
  function endCell(content, snapshots) {
    // Only exact complete trees from this parent's observations count. Slices,
    // worker lookalikes, delivery caps and old-turn callbacks cannot widen this.
    const candidates = new Map();
    for (const snapshot of snapshots) {
      const observed = observations.get(snapshot), entry = observed && windows.get(observed.key);
      if (!observed || observed.epoch !== epoch || entry?.token !== observed.token || snapshot.truncated) continue;
      const matches = candidates.get(snapshot.text) ?? new Map();
      matches.set(observed.key, observed); candidates.set(snapshot.text, matches);
    }
    for (const item of content ?? []) {
      if (item.type !== 'text') continue;
      const matches = candidates.get(item.text);
      if (matches?.size !== 1) continue;
      const observed = matches.values().next().value;
      const entry = windows.get(observed.key);
      // Final write callbacks can arrive out of order. Never restore an older map.
      if (entry.delivered?.snapshot.readId > observed.snapshot.readId) continue;
      entry.delivered = observed; entry.actions = undefined;
      entry.full = observed; entry.belief = new Map(observed.lines.map(row => [row.index, beliefKey(row)]));
    }
  }
  function prepareDisplay(content, snapshots, { compact = false, forceFull = new Set(), deliveryContent = content,
    allowDelivery = true, incomplete = [], prompt, actionNumbers = true } = {}) {
    const candidates = new Map(), scratch = new Map(), fullTexts = new Set(), turn = epoch, order = ++displayOrder;
    const recoveries = new Map(), beliefs = new Map(), full = new Map(), projected = new Map(), seenInCell = new Map(), affected = new Set();
    const mark = (key, force = false) => {
      if (!force && !compact && allowDelivery) return;
      const entry = windows.get(key);
      if (!entry || entry.deliveredOrder > order) return;
      entry.undelivered = Math.max(entry.undelivered ?? 0, order);
      affected.add(key); recoveries.delete(key);
      // Keep the in-cell history blocked too, even after a later complete read.
      scratch.set(key, null);
    };
    for (const snapshot of incomplete) {
      const observation = observations.get(snapshot);
      if (observation?.epoch === epoch) mark(observation.key);
    }
    for (const snapshot of snapshots) {
      const observation = observations.get(snapshot), entry = observation && windows.get(observation.key);
      if (!observation || observation.epoch !== epoch || entry?.token !== observation.token) continue;
      if (snapshot.truncated || forceFull.has(snapshot)) fullTexts.add(snapshot.text);
      const matches = candidates.get(snapshot.text) ?? new Map();
      matches.set(observation.key, snapshot); candidates.set(snapshot.text, matches);
    }
    // A worker may repeat exact current rows beside the parent's complete
    // display (for example a display-value filter). They add no belief. E5
    // below also ignores nonexact copies for windows with a parent baseline.
    const currentRows = new Set(), parentBaselines = new Set();
    for (const snapshot of snapshots) {
      const observation = observations.get(snapshot), entry = observation && windows.get(observation.key);
      if (allowDelivery && !snapshot.truncated && candidates.get(snapshot.text)?.size === 1 &&
          content.some(item => item.type === 'text' && item.text === snapshot.text)) parentBaselines.add(observation.key);
      if (!snapshot.truncated && entry?.snapshot === snapshot && candidates.get(snapshot.text)?.size === 1 &&
          content.some(item => item.type === 'text' && item.text === snapshot.text))
        for (const row of observation.lines) currentRows.add(row.text.trim());
    }
    const exactCurrentRows = item => {
      if (item.type !== 'text') return false;
      const rows = item.text.trim().split('\n').map(row => row.trim()).filter(Boolean);
      return rows.length > 0 && rows.every(row => /^\d+ /.test(row) && currentRows.has(row));
    };
    // While a write is unacknowledged, another diff against the old baseline
    // could omit a value that the pending write changed. Send the later tree whole.
    // A stored or partial tree has no certified baseline in this cell. It may
    // change what the model believes before a following current read.
    let treeLines;
    const lineKeys = new Map(), partialCache = new Map();
    const partialKeys = !compact && allowDelivery ? () => [] : item => {
      if (item.type !== 'text' || candidates.get(item.text)?.size === 1 || exactCurrentRows(item)) return [];
      if (partialCache.has(item)) return partialCache.get(item);
      if (!treeLines) {
        treeLines = new Set();
        // Include intermediate observations and retained delivered trees once.
        const sources = new Set([...snapshots, ...[...windows.values()].flatMap(entry =>
          [entry.snapshot, entry.delivered?.snapshot].filter(Boolean))]);
        for (const snapshot of sources) {
          const key = observations.get(snapshot)?.key;
          if (key === undefined) continue;
          for (const row of snapshot.text.split('\n')) {
            const line = row.trim();
            if (!line) continue;
            treeLines.add(line);
            const keys = lineKeys.get(line) ?? new Set();
            keys.add(key); lineKeys.set(line, keys);
          }
        }
      }
      const matches = new Set();
      let unknownTree = false;
      for (const row of item.text.split('\n')) {
        const line = row.trim();
        if (treeLines.has(line)) for (const key of lineKeys.get(line)) matches.add(key);
        else {
          const printed = line.replaceAll('\\t', '\t');
          unknownTree ||= /^(?:Window: |sleight: (?:lines changed|no change since)|[+-] ?\t*\d+ |\t*\d+(?: |$))/.test(printed) || printedNumber.test(printed);
        }
      }
      // Wrapped or JSON-escaped numbered rows without an exact line match have
      // unknown ownership, so conservatively block every retained window.
      const keys = unknownTree ? [...windows.keys()] : [...matches];
      // E5: the exact parent tree is the baseline for its window. Copies grant
      // no rows, even when they resemble a diff or contain forged numbers.
      const blocked = keys.filter(key => !parentBaselines.has(key));
      partialCache.set(item, blocked); return blocked;
    };
    const unboundTree = content.some(item => partialKeys(item).length > 0);
    const canCompact = compact && pendingDisplays.size === 0 && !unboundTree;
    const displayed = content.map(item => {
      for (const key of partialKeys(item)) mark(key);
      const matches = item.type === 'text' && candidates.get(item.text);
      if (matches?.size !== 1) return item;
      const snapshot = matches.values().next().value, observation = observations.get(snapshot);
      if (snapshot.truncated || fullTexts.has(snapshot.text) && snapshots.some(row => row.text === snapshot.text && row.truncated) || !allowDelivery) {
        mark(observation.key); return item;
      }
      const previous = seenInCell.get(observation.key) ?? windows.get(observation.key)?.delivered;
      if (previous && snapshot.readId < previous.snapshot.readId) {
        mark(observation.key, true); return item;
      }
      seenInCell.set(observation.key, observation);
      recoveries.set(observation.key, observation);
      if (!canCompact || windows.get(observation.key)?.undelivered || scratch.has(observation.key) && scratch.get(observation.key) === null) return item;
      let compactor = scratch.get(observation.key);
      if (!compactor) {
        compactor = createReadCompactor({ compactReacquire: true, compactAcquisition: false, prompt, renumberRefusalNote: false, reacquireNumbers: actionNumbers, removalDiffs: true,
          resultTrim: false, compactToolbars: false, callTrees: false, scrollNote: false,
          screenshotReads: false, routeSteering: false, undoReceipts: false, actionNumbers });
        const baseline = windows.get(observation.key)?.delivered?.snapshot;
        if (baseline) compactor.process([{ type: 'text', text: baseline.text }], { forceFull: true, filterMark: null });
        scratch.set(observation.key, compactor);
      }
      const output = compactor.process([item], { acquisition: true, code: actionNumbers ? 'app.getAXState()' : '',
        forceFull: fullTexts.has(snapshot.text), filterMark: null });
      const candidate = output.length === 1 ? output[0] : undefined;
      const prefix = snapshot.text.split('\n').slice(0, 2).join('\n') + '\n';
      const nativeDiff = candidate?.text.startsWith(prefix) &&
        /^sleight: (?:lines changed|no change since)/.test(candidate.text.slice(prefix.length));
      // The ChatGPT path can fold degraded button metadata by ID. Delivery of
      // every current line here requires exact text, so keep that read whole.
      if (!candidate || candidate.text !== snapshot.text && !nativeDiff || /button lines returned fewer attributes/.test(candidate.text)) {
        compactor.process([item], { forceFull: true, filterMark: null }); return item;
      }
      return candidate;
    });
    for (let i = 0; i < displayed.length; i++) {
      const matches = content[i]?.type === 'text' && candidates.get(content[i].text);
      if (matches?.size !== 1) continue;
      const snapshot = matches.values().next().value, observation = observations.get(snapshot), key = observation.key;
      if (snapshot.truncated || !allowDelivery) continue;
      if (displayed[i].text === snapshot.text) {
        beliefs.set(key, new Map(observation.lines.map(row => [row.index, beliefKey(row)])));
        full.set(key, observation);
      } else {
        const belief = new Map(beliefs.get(key) ?? windows.get(key)?.belief ?? []);
        const previous = projected.get(key) ?? windows.get(key)?.delivered;
        const alignment = previous && alignLines(previous.lines.map(row => row.key), observation.lines.map(row => row.key));
        for (const [old, current] of alignment ?? []) if (old >= 0 && current < 0) {
          const removed = previous.lines[old], n = removed.index;
          if (belief.get(n) === beliefKey(removed)) belief.delete(n);
        }
        for (const line of displayed[i].text.split('\n')) {
          const added = /^\+ (\t*)(\d+) (.*)$/.exec(line);
          if (added) {
            const n = Number(added[2]), row = observation.lines[n];
            if (row?.text === line.slice(2)) belief.set(n, beliefKey(row));
          }
        }
        beliefs.set(key, belief);
      }
      projected.set(key, observation);
    }
    const receipt = Symbol(); pendingDisplays.add(receipt);
    return { content: displayed, commit(error) {
      const pending = pendingDisplays.delete(receipt);
      if (!pending || turn !== epoch) return;
      if (error || !allowDelivery) { for (const key of [...affected, ...recoveries.keys()]) mark(key); return; }
      // Only this parent's generated display can vouch for the corresponding
      // full observations. Worker-authored diff text never enters endCell.
      const previousFull = new Map([...windows].map(([key, entry]) => [key, entry.full]));
      endCell(deliveryContent, snapshots);
      for (const [key, observation] of recoveries) {
        const entry = windows.get(key);
        if (entry?.delivered !== observation || entry.undelivered > order) continue;
        entry.undelivered = undefined; entry.deliveredOrder = order;
        entry.belief = beliefs.get(key); entry.full = full.get(key) ?? previousFull.get(key);
      }
    } };
  }
  return {
    read, assertCurrent, endCell, prepareDisplay,
    displayContext: binding => { const entry = windows.get(bindingKey(binding)); return entry && {
      F: entry.full?.snapshot.text, Ok: entry.complete?.snapshot.text, believed: new Map(entry.belief) }; },
    fullTree: binding => windows.get(bindingKey(binding))?.snapshot.text,
    invalidate: binding => windows.delete(bindingKey(binding)),
    endTurn() { epoch++; pendingDisplays.clear(); for (const entry of windows.values()) { entry.delivered = undefined; entry.actions = undefined; entry.belief = undefined; entry.full = undefined; } },
    reset() { epoch++; pendingDisplays.clear(); windows.clear(); },
  };
}
