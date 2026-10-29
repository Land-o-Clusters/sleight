// The window guard reads the whole tree with diffing off after every js action,
// so the lease can check the window header (document-scope.mjs guardedCode).
// That read is also the engine's new diff baseline. Sending it whole costs
// tokens on every click: a browser page resends its sidebar each time.
//
// The relay keeps, per window, the last full tree it forwarded to Claude, and
// replaces a guard read with the lines that changed since then. Claude's view
// stays the latest full tree (what it saw plus every change since), which is
// the engine's baseline, so the engine's next diff starts from what Claude
// knows. Any full tree Claude reads itself also becomes the copy.
//
// Pages that load content renumber every element after the new ones. Lines
// are matched by their text without the element number, and elements whose
// only change is their number are left out and counted. Their old numbers are
// stale, so the relay tracks which numbers Claude has seen since its last full
// read and refuses actions on any other (staleIndex).

import { GUARD_END, GUARD_MARK, GUARD_OMIT_MARK, documentKey, windowFromText, hasIdentifier, hasLabel, menuRoot, selectedMenuEntry } from './document-scope.mjs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { trimBrowserResults } from './browser-read-cap.mjs';
import { bareValue, finalExpression, printValueCode } from './no-output.mjs';
import { promptNotice } from './prompt-notice.mjs';
import { unchangedListClicks } from './offscreen-click.mjs';
import { sortedListShift } from './native-list-pick.mjs';
import { underDocument } from './menu-continuation.mjs';
import { renderOutcomes } from './action-outcomes.mjs';
import { wrongFieldEffects } from './write-effect.mjs';

export { GUARD_END, GUARD_MARK, GUARD_OMIT_MARK };
const MAX_LINES = 3000; // above this, the line diff costs more than it saves
const MAX_SHARE = 0.6; // a diff longer than this share of the tree is sent whole
const ELEMENT = /^(\t*)(\d+) (.*)$/;
const FILTERED_MARK = '[sleight:filtered-read]';
const maskCode = code => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
  value => ' '.repeat(value.length));

// Recognize the common read/filter/write shape without changing bindings or evaluating twice.
// The runtime receipt, not source order, decides whether input happened after that read.
export const filteredReadMark = () => `[sleight:filtered-read:${randomBytes(8).toString('hex')}]`;

export function filteredReadCode(code, mark = FILTERED_MARK) {
  const final = finalExpression(code);
  if (!final) return code;
  const write = /^(await\s+)?(nodeRepl\.write|console\.log)\s*\(([\s\S]*)\)$/.exec(final.expression);
  const expression = write ? write[3].replace(/,(?:\s|\/\/[^\n\r\u2028\u2029]*(?:\r\n|[\n\r\u2028\u2029]|$)|\/\*[\s\S]*?\*\/)*$/, '') : final.expression;
  // A computed property accepts one assignment expression, not a comma list or spread arguments.
  if (write ? !finalExpression(`({[\n${expression}\n]: 0})`) : !bareValue(expression)) return code;
  // A bare read or read variable keeps its ordinary diff; so does autoprint's own wrapper (SLEIGHT_AUTOPRINT=1).
  if (!write && (/^(?:await\s+)?[A-Za-z_$][\w$]*(?:\s*\.\s*getAXState\s*\([^)]*\))?$/.test(expression.trim()) || /__sleightValue/.test(expression))) return code;
  const masked = maskCode(code);
  const reads = [...masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*getAXState\s*\(/g)];
  if (reads.length !== 1) return code;
  const read = reads[0], sources = new Set(), declarations = new Map();
  const references = source => [...source.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)].some(match =>
    sources.has(match[1]) && !/^\s*:/.test(source.slice(match.index + match[1].length)));
  for (const match of masked.slice(0, final.start).matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)(?:;|$)/g)) {
    if ((match.index <= read.index && match.index + match[0].length > read.index) || references(match[2])) {
      sources.add(match[1]); declarations.set(match[1], match.index + match[0].length);
    }
  }
  for (const [name, end] of declarations) {
    const escaped = name.replace(/\$/g, '\\$');
    if (new RegExp(`(?<![\\w$])${escaped}\\s*(?:=(?!=|>)|\\+\\+|--|(?:\\*\\*|&&|\\|\\||\\?\\?|[+*/%&|^-])=)`).test(masked.slice(end))) return code;
  }
  if (read.index < final.start && !references(maskCode(expression))) return code;
  return code.slice(0, final.start) + `\n{
  const __sleightValue = ${write ? '' : 'await '}(\n${expression}\n);
  const __sleightGuard = globalThis.__sleightDocumentGuard;
  const __sleightLast = __sleightGuard?.reads.get(${read[1]});
  ${write ? `${write[1] ?? ''}${write[2]}(__sleightValue);` : `if (__sleightValue !== __sleightLast?.text) { ${printValueCode('__sleightValue')}; }`}
  const __sleightFiltered = __sleightLast?.emitted && __sleightLast.version === __sleightGuard.actionVersion &&
    !__sleightGuard.failures?.length && (typeof __sleightValue === 'string' ? !!__sleightValue.trim() : Array.isArray(__sleightValue) && __sleightValue.length > 0) && __sleightValue !== __sleightLast.text;
  try {
    const visible = typeof __sleightValue === 'string' ? __sleightValue : Array.isArray(__sleightValue)
      ? Object.entries(Object.getOwnPropertyDescriptors(__sleightValue))
        .filter(([key, d]) => /^(?:0|[1-9]\\d*)$/.test(key) && Number(key) < __sleightValue.length && typeof d.value === 'string').map(([, d]) => d.value) : [];
    // A printed bare value that can't filter needs no full mark: the ordinary diff still follows it.
    if (__sleightFiltered || ${!!write}) nodeRepl.write(${JSON.stringify(mark)} + JSON.stringify(__sleightFiltered ? { visible } : { full: true }) + '\\n');
  } catch { /* Unserializable output keeps the ordinary result. */ }
}` + code.slice(final.end);
}

// number -> text without the number, for every element line.
const numbered = lines => lines.map(parse).filter(l => l.num !== undefined).map(l => [l.num, l.key]);

// An element line's number and its text without the number.
function parse(line) {
  const m = ELEMENT.exec(line);
  return m ? { num: Number(m[2]), key: `${m[1]}${m[3]}` } : { num: undefined, key: line };
}

// Under load Calculator can return `button Two` instead of its description and ID.
// Fold only a button's unique ID, never a lost value, state, indentation or guessed label.
function degradedButton(full, bare) {
  const m = /^(\t*)button ([^,:]+)$/.exec(bare);
  return !!m && full.startsWith(m[1] + 'button ') && !/\(|\bValue:/.test(full) &&
    full !== bare && hasIdentifier(full, m[2]);
}
const bareButtonId = key => /^\t*button ([^,:]+)$/.exec(key)?.[1];
const buttonHasId = (key, id) => /^\t*button /.test(key) &&
  (bareButtonId(key) === id || hasIdentifier(key, id));

// The alignment of two trees by longest common subsequence of their keys,
// after trimming the shared head and tail: [beforeIndex, afterIndex] pairs,
// with -1 where a line has no partner.
export function alignLines(before, after, key = line => line) {
  const a = before.map(key), b = after.map(key);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail, m = b.length - head - tail;
  if (n > MAX_LINES || m > MAX_LINES) return undefined;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[head + i] === b[head + j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) { pairs.push([head + i, head + j]); i++; j++; }
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) pairs.push([head + i++, -1]);
    else pairs.push([-1, head + j++]);
  }
  for (let k = 0; k < tail; k++) pairs.push([a.length - tail + k, b.length - tail + k]);
  return pairs;
}

export function lineDiff(before, after) {
  return alignLines(before, after)?.filter(([i, j]) => i < 0 || j < 0)
    .map(([i, j]) => (j < 0 ? '- ' + before[i] : '+ ' + after[j]));
}

const folderPath = value => value.startsWith('/') || value.startsWith('~/');
const baseName = value => value && !/[\/]/.test(value) && !['.', '..'].includes(value);

// A click's locator: a bare string, or an object with id, label or line, where { id, label } together
// means the element with both (excel-edit-5, 2026-10-17). Numbers are parsed where they are used.
function clickLocator(args) {
  const bare = /^\s*(['"])([^'"\\]*)\1\s*(?:,|$)/.exec(args);
  if (bare) return { bare: bare[2] };
  const object = /^\s*\{([^{}]*)\}?/.exec(args)?.[1];
  if (object === undefined) return;
  const fields = {};
  for (const field of object.matchAll(/(?:^|,)\s*(label|id|line)\s*:\s*(['"])([^'"\\]*)\2\s*(?=,|$)/g)) fields[field[1]] = field[3];
  return Object.keys(fields).length ? fields : undefined;
}

// Bare strings match a label or an ID, as the guard does; object fields must all match.
const locatorMatches = (locator, body) => locator.bare !== undefined ? hasLabel(body, locator.bare) || hasIdentifier(body, locator.bare)
  : (locator.id === undefined || hasIdentifier(body, locator.id)) && (locator.label === undefined || hasLabel(body, locator.label)) &&
    (locator.line === undefined || body === locator.line);

// Recognize literal native calls without treating strings or comments as actions. This is
// advisory, like the window headers themselves; computed methods and aliases are not receipts.
function actionKind(code, before) {
  if (typeof code !== 'string') return undefined;
  const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    value => ' '.repeat(value.length));
  const calls = [...masked.matchAll(/\.\s*(click|setValue|selectText|performSecondaryAction|scroll|drag|pressKey|typeText|paste)\s*\(/g)];
  if (!calls.length) return undefined;
  const receiver = call => /([A-Za-z_$][\w$]*)\s*$/.exec(masked.slice(0, call.index))?.[1];
  const literal = args => /^\s*['"]([^'"\\]*)['"]\s*(?:,|$)/.exec(args)?.[1];
  const argsOf = call => code.slice(call.index + call[0].length).split(')')[0];
  const savePanel = /\b(?:sheet|dialog)\b.*\b(?:save-panel|save)\b/i.test(before?.root ?? '');
  let save = false, opens = false, navigates = false, deletes = false, reorders = false, saveCall, saveHandle;
  const editableClicks = new Set();
  // A folder and name count only on the way to a save: an Open panel reached the same way named the
  // file it opened, and its URL would have read as a save.
  let folderHandle, folder, fileName, nameHandle, folderReady, saveOpened = savePanel;
  for (const call of calls) {
    const args = argsOf(call);
    let isSave = false, gotoReturn = false;
    if (call[1] === 'pressKey') {
      const key = literal(args) ?? '';
      const handle = receiver(call);
      const isReturn = /^(?:return|enter)$/i.test(key);
      if (/^(?:super|cmd|command)\+(?:shift\+)?s$/i.test(key)) saveOpened = true;
      if (/^(?:super|cmd|command)\+shift\+g$/i.test(key)) { folderHandle = handle; folderReady = false; }
      if (isReturn && folderHandle && handle === folderHandle && folder && !folderReady) {
        folderReady = true;
        gotoReturn = true;
      }
      isSave = /^(?:super|cmd|command)\+s$/i.test(key) ||
        (isReturn && savePanel) ||
        (isReturn && !gotoReturn && saveOpened && folder && fileName && handle === folderHandle);
      deletes ||= /^(?:fn\+)?(?:delete|backspace|forwarddelete)$/i.test(key);
      opens ||= key.includes('+') || /^(?:return|enter|escape|esc)$/i.test(key);
      navigates ||= !isSave && !gotoReturn && /^(?:(?:super|cmd|command)\+(?:[a-z]+\+)*[now]|return|enter|escape|esc)$/i.test(key);
    }
    if (call[1] === 'click') {
      opens = true;
      const number = /^\s*(\d+)\s*(?:,|$)/.exec(args)?.[1];
      const line = number && before?.lines.find(line => parse(line).num === Number(number));
      const target = line && parse(line).key.trim();
      const locator = clickLocator(args);
      const namedTargets = locator && before?.lines.map(line => parse(line).key.trim()).filter(line => locatorMatches(locator, line));
      reorders ||= [locator?.bare, locator?.label, locator?.id, locator?.line, ...[target, ...(namedTargets ?? [])].filter(Boolean).flatMap(body =>
        [describeSibling({ body })?.label, /(?:^|, )ID: ([^,]+)/.exec(body)?.[1]])]
        .some(label => label && /move|up|down|sort|order|rank/i.test(label));
      // ID and first-call clicks have no numbered line. A following edit on the same handle
      // supplies context; only the existing save-state or file-time evidence can prove a save.
      const followsEdit = calls.slice(calls.indexOf(call) + 1).some(next => receiver(call) && receiver(next) === receiver(call) &&
        (['paste', 'typeText'].includes(next[1]) || next[1] === 'pressKey' && /^(?:super|cmd|command)\+a$/i.test(literal(argsOf(next)) ?? '')));
      const editable = target ? /^text (?:entry area|area|field)\b/.test(target) ||
        (!/^(?:[^(:]*button|menu item|row|link)\b/.test(target) && /^[^(,:]+\([^)]*\bsettable\b[^)]*\).*\bValue:/.test(target))
        : !before || followsEdit;
      if (editable) editableClicks.add(call);
      const locatorValue = locator && (locator.bare ?? locator.label ?? locator.id ?? locator.line);
      isSave = (!!target && hasLabel(target, 'Save')) || ['Save', 'button Save'].includes(locatorValue);
      navigates ||= !isSave && !editable;
    }
    if (call[1] === 'typeText' && folderHandle && receiver(call) === folderHandle) {
      const value = literal(args);
      if (value && folderPath(value) && !folderReady) folder = value;
      else if (baseName(value)) { fileName = value; nameHandle = receiver(call); }
    }
    if (call[1] === 'setValue') {
      const named = /^\s*(\{\s*id\s*:\s*['"]saveAsNameTextField['"]\s*\}|\d+)\s*,([\s\S]*)/.exec(args);
      const line = named && /^\d+$/.test(named[1]) && before?.lines.find(line => parse(line).num === Number(named[1]));
      if (named && (named[1].startsWith('{') || (line && hasIdentifier(line, 'saveAsNameTextField')))) {
        fileName = literal(named[2]); nameHandle = receiver(call);
      }
    }
    if (isSave) { save = true; saveCall = call; saveHandle = receiver(call); }
  }
  const otherRead = save && [...masked.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*(?:getAXState|getAXStateAndScreenshot|getScreenshot)\s*\(/g)]
    .some(read => read[1] !== saveHandle);
  const acquisitionAfterSave = save && [...masked.matchAll(/\bcua\s*\.\s*getApp\s*\(/g)].some(read => read.index > saveCall.index);
  const namedPath = folder?.startsWith('~/') ? join(homedir(), folder.slice(2)) : folder;
  const namedURL = save && folderHandle === saveHandle && nameHandle === saveHandle && baseName(fileName) &&
    namedPath && isAbsolute(namedPath) ? pathToFileURL(join(namedPath, fileName)).href : undefined;
  const otherTarget = navigates || otherRead || acquisitionAfterSave || calls.some(call => receiver(call) !== saveHandle);
  const clickAndTyping = !reorders && calls.some(call => call[1] === 'click') && calls.every(call =>
    ['click', 'typeText', 'paste'].includes(call[1]) || call[1] === 'pressKey' && /^(?:return|enter)$/i.test(literal(argsOf(call)) ?? ''));
  const first = calls[0], number = first[1] === 'click' && /^\s*(\d+)\s*$/.exec(argsOf(first))?.[1];
  const clicked = number && before?.lines.map(parse).find(line => line.num === Number(number));
  const typedTarget = clicked && textField(clicked.key) && calls[1]?.[1] === 'typeText' && calls.slice(1).every((call, index) =>
    receiver(call) === receiver(first) && (index === 0 || call[1] === 'pressKey' && index === calls.length - 2 &&
      /^(?:return|enter)$/i.test(literal(argsOf(call)) ?? ''))) ? clicked : undefined;
  // Where input was aimed: an element's key, null when unknown (coordinates, a shortcut, Tab), undefined for none.
  const aim = call => {
    const args = argsOf(call), lines = before?.lines.map(parse) ?? [];
    if (call[1] === 'pressKey') return /\+|^tab$/i.test(literal(args) ?? '+') ? null : undefined;
    if (!['click', 'setValue', 'selectText', 'performSecondaryAction'].includes(call[1])) return;
    const number = /^\s*(\d+)\s*(?:,|$)/.exec(args)?.[1], locator = !number && clickLocator(args);
    if (!number && !locator) return null;
    const matches = lines.filter(line => line.num !== undefined && (number ? line.num === Number(number) : locatorMatches(locator, line.key.trim())));
    return matches.length === 1 ? fieldKey(matches[0].key) : number ? null : undefined;
  };
  const aims = calls.map(aim), firstTyping = calls.findIndex(call => ['typeText', 'paste'].includes(call[1]));
  const lastAim = list => list.findLast(value => value !== undefined);
  const typing = {
    first: firstTyping >= 0 ? literal(argsOf(calls[firstTyping])) : undefined,
    aim: firstTyping >= 0 ? lastAim(aims.slice(0, firstTyping)) : undefined, lastAim: lastAim(aims),
    texts: calls.filter(call => call[1] === 'typeText').map(call => literal(argsOf(call))),
  };
  // setValue on a settable field with a literal value, then Return or a paste on the same handle: a name box
  // given "A2" this way kept A1 in 4/9 excel-edit runs (2026-10-17), and the paste went over the header.
  const setValues = calls.flatMap((call, index) => {
    if (call[1] !== 'setValue' || !before) return [];
    const args = argsOf(call), number = /^\s*(\d+)\s*,/.exec(args)?.[1], locator = !number && clickLocator(args);
    const value = /,\s*(['"])([^'"\\]*)\1\s*$/.exec(args)?.[2];
    if ((!number && !locator) || value === undefined) return [];
    const later = calls.slice(index + 1).filter(next => receiver(next) === receiver(call));
    if (!later.some(next => next[1] === 'paste' || next[1] === 'pressKey' && /^(?:return|enter)$/i.test(literal(argsOf(next)) ?? ''))) return [];
    const resolve = locator?.bare !== undefined ? { label: locator.bare } : locator;
    const matches = before.lines.map(parse).filter(line => line.num !== undefined &&
      (number ? line.num === Number(number) : locatorMatches(resolve, line.key.trim())));
    if (matches.length !== 1 || !textField(matches[0].key.trim())) return [];
    return [{ key: fieldKey(matches[0].key), was: fieldValue(matches[0].key), value, pasted: later.some(next => next[1] === 'paste') }];
  });
  // WB1: a click on a single-line field, then typing on the same handle (missedFieldNote). Text areas are documents.
  const fieldTypings = calls.flatMap((call, index) => {
    const next = calls[index + 1];
    if (!before || call[1] !== 'click' || next?.[1] !== 'typeText' || receiver(next) !== receiver(call)) return [];
    const typed = literal(argsOf(next))?.trim().toLowerCase();
    const args = argsOf(call), number = /^\s*(\d+)\s*$/.exec(args)?.[1], locator = !number && clickLocator(args);
    if (!typed || typed.length < 3 || (!number && !locator)) return [];
    const matches = before.lines.map(parse).filter(line => line.num !== undefined &&
      (number ? line.num === Number(number) : locatorMatches(locator, line.key.trim())));
    if (matches.length !== 1 || !/^\s*(?:text field|search (?:text )?field|combo box)\b/.test(matches[0].key) || !textField(matches[0].key)) return [];
    return [{ key: fieldKey(matches[0].key), typed }];
  });
  return { save, opens, deletes, clickAndTyping, typedTarget, typing, setValues, fieldTypings, namedURL, mixedSave: save && (otherTarget || calls.at(-1) !== saveCall),
    fileSaveSafe: save && !otherTarget && calls.slice(calls.indexOf(saveCall) + 1).every(call => editableClicks.has(call)) };
}

// Compare state itself, so losing Help or renaming an unselected row cannot become a value change.
function stateFields(line) {
  const fields = [];
  for (const pattern of [/\bValue: ?(.*?)(?=, (?:Secondary Actions|ID|Help|Description):|$)/,
    /;value:([^,]*)/, /\bSelected text: (.*?)(?=, (?:Secondary Actions|ID|Help|Description):|$)/]) {
    const match = pattern.exec(line); if (match) fields.push(match[0].startsWith('Selected') ? 'text:' + match[1] : 'value:' + match[1]);
  }
  const flags = /\(([^)]*)\)/.exec(line)?.[1] ?? '';
  if (/\b(?:selected|selectable)\b/.test(flags)) fields.push('selected:' + /\bselected\b/.test(flags));
  if (/\b(?:checked|checkable)\b/.test(flags)) fields.push('checked:' + /\bchecked\b/.test(flags));
  return fields;
}
// A line's depth, role and identity without what changes between reads (Value, flags such as selected,
// Help): its ID, else the role and title, plus the Description when there is no title.
// Controls whose title is their value (a field's text, a scroll bar's position, a triangle's 0 or 1) key on role and ID;
// an untitled row, cell or field without ID or Description keys on its Value too, since that is all that tells repeated
// blocks such as Finder's file rows apart (LS1 review, 2026-10-17).
function structuralKey(key) {
  const valued = /^(\t*)(text field|text entry area|text area|search field|combo box|scroll bar|value indicator|slider|stepper|disclosure triangle|row|cell)\b/.exec(key);
  if (valued) {
    const [, depth, role] = valued, id = /(?:^|, )ID: ([^,]*)/.exec(key)?.[1];
    const description = /\bDescription: (.*?)(?=, (?:ID|Help|Value|Details|Secondary Actions|URL|Placeholder):|$)/.exec(key)?.[1];
    const value = id === undefined && description === undefined && /^(?:row|cell|text field)$/.test(role)
      ? /\bValue: (.*?)(?=, (?:Help|Details|Secondary Actions|URL|Placeholder):|$)/.exec(key)?.[1] ?? '' : undefined;
    if (!/^(?:row|cell)$/.test(role) || value !== undefined) return `${depth}${role}|${id ?? description ?? value ?? ''}`;
  }
  const plain = key.replace(/ \((?:[a-z]+(?:, )?)+\)/, '');
  const at = plain.search(/,|\b(?:Value|Help|Description|Details|ID|Secondary Actions|URL|Selected text):/);
  const head = (at < 0 ? plain : plain.slice(0, at)).trimEnd(), id = /(?:^|, )ID: ([^,]*)/.exec(plain)?.[1];
  const description = id === undefined && /^[^,]*?\bDescription: (.*?)(?=, (?:ID|Help|Value|Details|Secondary Actions|URL):|$)/.exec(plain)?.[1];
  return `${head}|${id ?? description ?? ''}`;
}
const attributes = line => (line.match(/\b(?:Help|Description|ID):/g) ?? []).length;
const windowRoot = root => /^(?:(?:standard|floating|system|dialog) window|window|sheet|dialog)\b/.test(root);
const panel = line => /(?:^|\t)(?:sheet|dialog)\b/.test(line);
const saveSheet = root => /\bsave-panel\b/.test(root ?? '') && !/\bopen-panel\b/.test(root ?? '');
function saveNameId(lines) {
  for (const line of lines ?? []) {
    const id = /(?:^|, )ID: ([^,\n]+)/.exec(line)?.[1];
    if (id && (id === 'saveAsNameTextField' || /saveAsName/.test(id))) return id;
  }
}
function saveFinishLine(after, before, failed, overlap) {
  if (failed || overlap || !after || !before || !saveSheet(after.root) || saveSheet(before.root)) return;
  const id = saveNameId(after.lines);
  if (!id) return;
  return /* lean notice */ 'sleight: finish the save in the next call: await app.pressKey("super+shift+g"); await app.typeText("<folder>"); await app.pressKey("Return"); await app.setValue({ id: ' +
    JSON.stringify(id) + ' }, "<name>"); await app.pressKey("Return").';
}
const edited = title => /(?: — | - )Edited$/.test(title);
// A file:// document's modification time, null when it has none or can't be read.
function fileTime(url) {
  try { return url?.startsWith('file://') ? statSync(fileURLToPath(url)).mtimeMs : null; } catch { return null; }
}
// A confirmed save's file from metadata only, never its content: size from stat, kind from the system's type
// identifier (Spotlight's, about 40 ms), else the extension. After a confirmed save, 3 of 20 textedit-save runs
// opened the Format menu to check for plain text (4-17 s each) and 3 tried `require('fs')` (Fable study, 2026-10-17).
const EXTENSION_TYPES = { txt: 'public.plain-text', text: 'public.plain-text', md: 'public.plain-text', csv: 'public.plain-text',
  rtf: 'public.rtf', rtfd: 'com.apple.rtfd', pdf: 'com.adobe.pdf' };
// The file's type identifier first, then the types it conforms to; undefined when Spotlight has none.
export function spotlightTypes(path) {
  const run = spawnSync('/usr/bin/mdls', ['-raw', '-name', 'kMDItemContentType', '-name', 'kMDItemContentTypeTree', path],
    { encoding: 'utf8', timeout: 1000 });
  const [type, tree = ''] = run.status === 0 ? run.stdout.split('\0') : [];
  if (!type || type === '(null)') return;
  return [type, ...[...tree.matchAll(/"([^"]+)"/g)].map(m => m[1])];
}
export function fileReceipt(url, typesOf = spotlightTypes) {
  try {
    const path = fileURLToPath(url), info = statSync(path);
    const extension = /\.([^./]+)$/.exec(path)?.[1].toLowerCase();
    const types = typesOf(path) ?? (EXTENSION_TYPES[extension] ? [EXTENSION_TYPES[extension]] : []);
    const kind = /* lean notice */ types.includes('com.apple.rtfd') ? 'rich text with attachments' : types.includes('public.rtf') ? 'rich text (RTF)'
      : types.includes('com.adobe.pdf') ? 'PDF' : types.some(type => /^public\.(?:utf8-)?plain-text$/.test(type)) ? 'plain text'
      : types[0] ? types[0].split('.').at(-1) : extension ? `.${extension} file` : 'unknown type';
    return /* lean notice */ info.isDirectory() ? `on disk: a package folder, ${kind}` : `on disk: ${info.size} bytes, ${kind}`;
  } catch { return; }
}
const withoutValue = line => line.replace(/(?:, )?Value: ?.*?(?=, (?:Secondary Actions|ID|Help|Description):|$)/, '')
  .replace(/, (?=(?:Secondary Actions|ID|Help|Description):)/g, ' ').replace(/ +/g, ' ').trimEnd();

const textField = line => /^\s*(?:text (?:entry area|area|field)|search (?:text )?field|combo box)\b/.test(line) &&
  /\([^)]*\bsettable\b[^)]*\)/.test(line);
const fieldKey = line => withoutValue(line).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const fieldValue = line => stateFields(line).find(field => field.startsWith('value:'))?.slice(6).toLowerCase();
// Match a field at the same position under the same ancestors, independent of AX numbering.
function positionedFields(lines) {
  const stack = [], fields = [];
  let roots = 0;
  for (const line of lines) {
    const match = ELEMENT.exec(line);
    if (!match) continue;
    const depth = match[1].length;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1), position = parent ? parent.children++ : roots++;
    const node = { ...parse(line), depth, children: 0,
      path: `${parent?.path ?? ''}/${depth}:${position}:${fieldKey(match[3])}` };
    stack.push(node);
    if (textField(node.key)) fields.push(node);
  }
  return fields;
}
function misplacedTextNote(action, observation, typed) {
  if (!action.typedTarget || !Array.isArray(typed) || typed.length !== 1 || typeof typed[0] !== 'string' || typed[0].trim().length < 3) return;
  const value = typed[0].trim().toLowerCase(), target = fieldKey(action.typedTarget.key);
  const before = positionedFields(action.before.lines), after = positionedFields(observation.lines);
  const clicked = after.filter(line => fieldKey(line.key) === target);
  if (before.filter(line => fieldKey(line.key) === target).length !== 1 || clicked.length !== 1 || fieldValue(clicked[0].key)?.includes(value)) return;
  const landed = after.filter(line =>
    fieldKey(line.key) !== target && fieldValue(line.key)?.includes(value) &&
    !before.some(old => old.path === line.path && fieldValue(old.key)?.includes(value)));
  if (landed.length !== 1 || !before.some(old => old.path === landed[0].path)) return;
  return /* lean notice */ `sleight: typed text landed in ${describeField(landed[0])}, not in the clicked ${describeField(clicked[0])}.`;
}
const describeField = line => {
  const label = /\bDescription: (.*?)(?=, (?:Value|Secondary Actions|ID|Help):|$)/.exec(line.key)?.[1];
  return `element ${line.num}` + (label ? ` (${label})` : '');
};

// Typing aimed elsewhere that shows up as a single-line field's new value: in word-edit-1 (2026-10-17) a sidebar's
// Replace With combo box kept focus, a table's text went there, and Claude took 3 calls to find it.
// aim is the call's last target before typing, else the window's (lastAim); unknown or the field itself stays silent.
function strayTypingNote(action, observation, lastAim) {
  const typed = action.typing?.first?.trim().toLowerCase(), aim = action.typing.aim !== undefined ? action.typing.aim : lastAim;
  if (action.typedTarget || !typed || typed.length < 3 || typeof aim !== 'string') return;
  const before = positionedFields(action.before.lines);
  const landed = positionedFields(observation.lines).filter(field => /^\s*(?:text field|search (?:text )?field|combo box)\b/.test(field.key) &&
    fieldKey(field.key) !== aim && fieldValue(field.key)?.includes(typed) &&
    before.some(old => old.path === field.path && !fieldValue(old.key)?.includes(typed)));
  if (landed.length !== 1) return;
  return /* lean notice */ `sleight: typed text landed in ${describeField(landed[0])}, not the document; click the document before typing.`;
}

// Typing that reached nothing: no typed string of 3+ characters anywhere in the tree after the call, and no value or
// count line changed ("N words"). After a sidebar closed in word-edit-1 (2026-10-17) the window kept focus and 4 calls
// of typing changed nothing; in word-edit-2 (2026-10-18) the Table menu stayed selected and typing went nowhere for
// 10 calls. Silent without a text value in the tree to show typing, or with a secure field, whose value is hidden.
const valueLines = lines => lines.flatMap(line => {
  const body = ELEMENT.exec(line)?.[3];
  if (body === undefined) return [];
  const fields = stateFields(body).filter(field => !/^(?:selected|checked):/.test(field));
  const count = /\d/.test(body.replace(/(?:^|, )(?:ID|Help): [^,]*/g, '')) ? [body.replace(/(?:^|, )(?:ID|Help): [^,]*/g, '')] : [];
  return [...fields, ...count];
}).sort().join('\n');
function focuslessTypingNote(action, observation) {
  const texts = action.typing?.texts ?? [];
  const typed = texts.map(text => text?.trim().toLowerCase()).filter(text => text?.length >= 3);
  if (!typed.length || texts.some(text => text === undefined) || observation.delta?.semantic) return;
  // IDs and Help never hold typed text ("WindowMenu_MenuItem" held "item").
  const tree = observation.lines.join('\n').replace(/(?:^|, )(?:ID|Help): [^,\n]*/gm, '').toLowerCase();
  if (typed.some(text => tree.includes(text)) || valueLines(observation.lines) !== valueLines(action.before.lines)) return;
  const shown = [...action.before.lines, ...observation.lines].filter(line => ELEMENT.test(line));
  if (shown.some(line => /\bsecure\b|\bpassword\b/i.test(line)) || !shown.some(line => textField(ELEMENT.exec(line)[3]) && /\bValue: ?\S/.test(line))) return;
  const menu = selectedMenuEntry(observation.lines.join('\n'));
  if (menu) return /* lean notice */ `sleight: typing reached nothing; menu-bar item ${menu.number} is still selected: cancel the menu first.`;
  const focus = /^The focused UI element is (\d+) /.exec(observation.lines.find(line => line.startsWith('The focused UI element is ')) ?? '');
  if (focus && /\bwindow\b/.test(observation.root) && Number(focus[1]) === parse(observation.lines[1] ?? '').num) {
    return /* lean notice */ 'sleight: keyboard focus is on the window itself, so typed keys have no target. Click the document first.';
  }
  return /* lean notice */ 'sleight: typing reached nothing; no typed text or value appears. Click the target first.';
}

// WB1 (SLEIGHT_WB1=1): a click on a single-line field followed by typing, where the field doesn't hold the text after the
// call. In word-edit (2026-10-18, 01-26-39 #1 and 00-52-36 #5) the first of two sidebar fields stayed empty, Replace All
// ran on nothing, and the result said only "UI changed (element)"; finding out took 3 and 4 calls. setValue is the one
// route that doesn't depend on focus. The typed text stays out of the note, as in the stop notes.
function missedFieldNote(action, observation) {
  const missed = (action.fieldTypings ?? []).flatMap(typing => {
    const fields = observation.lines.map(parse).filter(line => line.num !== undefined && textField(line.key) && fieldKey(line.key) === typing.key);
    return fields.length === 1 && !fieldValue(fields[0].key)?.includes(typing.typed) ? [fields[0]] : [];
  }).filter((field, i, all) => all.findIndex(other => other.num === field.num) === i);
  if (!missed.length) return;
  const named = missed.map(describeField).join(' and '), numbers = missed.map(field => `setValue(${field.num}, text)`).join(', ');
  return /* lean notice */ `sleight: the text typed after clicking ${named} isn't in ${missed.length === 1 ? 'that field' : 'those fields'}. \`${numbers}\` sets a field without typing.`;
}

// WB2 (SLEIGHT_WB2=1): the app's Undo item, a menu item, button or menu button whose title, Description or Help is "Undo
// <action>" or "Can't Undo" (English titles; other locales stay silent). One distinct title per read, else none. In
// word-edit (2026-10-18) Haiku saw "Undo Style" after the heading shortcut and still opened the Styles gallery to check in
// 11 of 18 runs (Fable study 2026-10-17, 1.7 verification turns and 7.2 s a run).
// Lines under a web or text area are document content (review F3): a page's "Undo Send" button is not the app's item.
// The Redo item (same shape) tells an undo from an edit (review F2).
const UNDO_TITLE = /^(?:Undo(?: [^,]{1,60})?|Can['’]t Undo)$/, REDO_TITLE = /^(?:Redo(?: [^,]{1,60})?|Can['’]t Redo)$/;
function undoTitle(lines, pattern = UNDO_TITLE) {
  const titles = new Set();
  const entries = lines.flatMap(line => { const m = ELEMENT.exec(line); return m ? [{ depth: m[1].length, line: m[3] }] : []; });
  for (const [at, { line: body }] of entries.entries()) {
    const role = /^(?:menu item|menu button|button|pop up button)\s+(?:\([^)]*\)\s*)?/.exec(body);
    if (!role || underDocument(entries, at)) continue;
    const rest = body.slice(role[0].length);
    const found = [rest.split(', ')[0], /(?:^|, )Description: ([^,]*)/.exec(rest)?.[1], /(?:^|, )Help: ([^,]*)/.exec(rest)?.[1]]
      .map(field => field?.trim()).filter(field => field && pattern.test(field)).sort((a, b) => b.length - a.length)[0];
    if (found) titles.add(found);
  }
  return titles.size === 1 ? [...titles][0] : undefined;
}
const undoNote = (was, now) => /* lean notice */ `sleight: the Undo item changed from "${was}" to "${now}", so the app recorded an edit since your last read of this window. Treat that edit as done; don't open a gallery or pane to confirm it.`;

// A field that reads its old value after setValue and Return: the write never went through the field's own
// input, so the Return and a paste acted from wherever the app already was. In excel-edit (2026-10-17, runs
// 23-30, 23-37, r1, r5) the name box kept A1, the paste went over the header, and r5 took "A,1 Apples" as success.
function setValueNote(set, observation) {
  const fields = observation.lines.map(parse).filter(line => line.num !== undefined && textField(line.key) && fieldKey(line.key) === set.key);
  const wanted = set.value.trim().toLowerCase();
  if (fields.length !== 1 || !set.was || !wanted || wanted === set.was) return;
  const field = fields[0], now = fieldValue(field.key);
  if (now !== set.was || now.includes(wanted)) return;
  const shown = /\bValue: ?(.*?)(?=, (?:Secondary Actions|ID|Help|Description):|$)/.exec(field.key)?.[1] ?? now;
  const label = /\bDescription: (.*?)(?=, (?:Value|Secondary Actions|ID|Help):|$)/.exec(field.key)?.[1] ?? /(?:^|, )ID: ([^,]+)/.exec(field.key)?.[1];
  // Where the input went: a focused element other than the window and the field, else the app's own position,
  // which a go-to field shows as its value.
  const focus = /^The focused UI element is (\d+) (.*)$/.exec(observation.lines.find(line => line.startsWith('The focused UI element is ')) ?? '');
  const root = parse(observation.lines[1] ?? '').num;
  const focused = focus && ![root, field.num].includes(Number(focus[1])) &&
    (/\bDescription: (.*?)(?=, (?:Value|Secondary Actions|ID|Help):|$)/.exec(focus[2])?.[1] ?? focus[2].split(', ')[0]);
  const where = (focused || shown).slice(0, 60), name = `${field.num}${label ? ` (${label})` : ''}`;
  // Only a paste leaves something to undo.
  return set.pasted
    ? /* lean notice */ `sleight: setValue on ${name} didn't hold (Value: ${shown}); the next action began at ${where}. Undo restores. Click the field, type, Return.`
    : /* lean notice */ `sleight: setValue on ${name} didn't hold (Value: ${shown}); the next action began at ${where}. Click the field, type, Return.`;
}

// An alert the call ended on, quoted with its buttons: 3 excel-edit runs (2026-10-17) spent a turn matching
// action-button--999 to Cancel. Only a small dialog or sheet with text and buttons and no field to fill.
function alertNote(observation) {
  if (!/^(?:dialog|sheet|alert|system dialog)\b/.test(observation.root)) return;
  const children = [];
  for (const line of observation.lines.slice(2)) {
    const match = ELEMENT.exec(line);
    if (!match || !match[1].length) break;
    if (match[1].length === 1) children.push(match[3]);
  }
  if (children.length > 10 || children.some(body => textField(body))) return;
  const texts = children.filter(body => /^(?:static )?text /.test(body)).map(body => body.replace(/^(?:static )?text /, '').replace(/, (?:Value|ID|Help):.*$/, ''));
  const buttons = children.filter(body => /^button /.test(body)).map(body => {
    const id = /(?:^|, )ID: ([^,]+)/.exec(body)?.[1], title = body.replace(/^button /, '').split(', ')[0];
    return id && id !== title ? `${title} ({ id: "${id}" })` : title;
  });
  const text = texts.join(' ');
  if (!text || !buttons.length || buttons.length > 6) return;
  return /* lean notice */ `sleight: the alert says "${text.length > 300 ? text.slice(0, 297) + '...' : text}" Its buttons: ${buttons.join(', ')}.`;
}

function tabSelections(lines) {
  const groups = new Map(), stack = [];
  for (const line of lines) {
    const match = ELEMENT.exec(line);
    if (!match) { stack.length = 0; continue; }
    const depth = match[1].length, body = match[3];
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1);
    const path = [...(parent?.path ?? []), withoutValue(body).replace(/\s*\([^)]*\)/g, '')];
    const node = { depth, path };
    if (/^(?:tab group|tab bar|sheet tab strip|segmented control|page selector)\b/.test(body)) {
      const key = JSON.stringify(path);
      node.selection = { value: /^tab group\b/.test(body) ? stateFields(body).find(field => field.startsWith('value:'))?.slice(6) : undefined,
        children: [] };
      const matches = groups.get(key) ?? [];
      matches.push(node.selection); groups.set(key, matches);
    }
    if (parent?.selection && /^(?:radio button|tab|button|segment|page)\b/.test(body)) {
      const label = /\bDescription: (.*?)(?=, (?:Value|Secondary Actions|ID|Help):|$)/.exec(body)?.[1] ??
        body.replace(/^(?:radio button|tab|button|segment|page)\b\s*/, '').replace(/^\([^)]*\)\s*/, '')
          .replace(/,? (?:Value|Secondary Actions|ID|Help):.*$/, '');
      const key = /(?:^|, )ID: ([^,]+)/.exec(body)?.[1] ?? body.replace(/\s*\([^)]*\)/g, '');
      parent.selection.children.push({ key, label: label.trim(), selected: /\([^)]*\bselected\b[^)]*\)/.test(body) });
    }
    stack.push(node);
  }
  return groups;
}

// The engine names the focused element after the tree. The same element keeping focus with a new description
// is a switch inside it, such as another sheet becoming active in a workbook area: in excel-edit-1 (2026-10-17)
// that was the only signal, and Claude typed into the wrong sheet. Another element taking focus is not reported.
function focusedDescriptionChange(before, after) {
  const focus = lines => {
    const line = lines.find(l => l.startsWith('The focused UI element is '))?.replace(/^The focused UI element is \d+ /, '');
    const m = line && /^(.*?), Description: (.*?)(?=, (?:Help|ID|Secondary Actions|Value):|$)/.exec(line);
    return m && { element: m[1], description: m[2] };
  };
  const was = focus(before), now = focus(after);
  if (!was || !now || was.element !== now.element || was.description === now.description) return [];
  const short = text => text.length > 60 ? text.slice(0, 57) + '...' : text;
  return [/* lean notice */ `UI changed (${now.element}: ${short(was.description)} to ${short(now.description)})`];
}

// Match the same selector and its selected siblings, ignoring element renumbering.
function selectedTabChanges(before, after) {
  const old = tabSelections(before), changes = [];
  for (const [key, matches] of tabSelections(after)) {
    const previous = old.get(key);
    if (matches.length !== 1 || previous?.length !== 1) continue;
    const was = previous[0], now = matches[0];
    const oldSelected = was.children.filter(child => child.selected), newSelected = now.children.filter(child => child.selected);
    let from, to;
    if (!oldSelected.length && !newSelected.length) { from = was.value; to = now.value; }
    else if (oldSelected.length === 1 && newSelected.length === 1 &&
        (now.children.some(child => child.key === oldSelected[0].key && !child.selected) ||
          was.children.some(child => child.key === newSelected[0].key && !child.selected))) {
      from = oldSelected[0].label; to = newSelected[0].label;
    }
    if (from && to && from !== to) changes.push(/* lean notice */ `UI changed (selected tab: ${from} to ${to})`);
  }
  return changes;
}

// Match a unique parent's role and child multiset: an active tab can change every ancestor's
// description without changing its siblings. Repeated groups stay ambiguous.
function siblingGroups(lines) {
  const found = new Map(), nodes = [], stack = [];
  for (const line of lines) {
    const match = ELEMENT.exec(line);
    if (!match) { stack.length = 0; continue; }
    const depth = match[1].length;
    const key = match[3].replace(/\s*\((?:selected|selectable|focused)(?:, (?:selected|selectable|focused))*\)/g, '')
      .replace(/^([a-z][a-z ]*?) Selected, /, '$1 ')
      .replace(/,? Value:.*?(?=, (?:Secondary Actions|ID|Help|Description):|$)/, '');
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const node = { key, depth, body: match[3], role: /^[a-z]+(?: [a-z]+)*/.exec(key)?.[0], children: [] };
    stack.at(-1)?.children.push(node);
    nodes.push(node); stack.push(node);
  }
  for (const node of nodes) {
    if (node.children.length < 2) continue;
    const id = JSON.stringify([node.role, node.depth, node.children.map(child => child.key).sort()]);
    const matches = found.get(id) ?? [];
    matches.push(node); found.set(id, matches);
  }
  return found;
}

function describeSibling(node) {
  const match = /^([a-z][a-z ]*?)(?= \(| Description:| [^a-z ])\s+(.*)$/.exec(node.body) ??
    /^([a-z]+) (.+)$/.exec(node.body);
  if (!match) return;
  const body = match[2].replace(/^\([^)]*\)\s*/, '').replace(/^Selected, /, '');
  // Excel's sheet tabs carry empty fields after the title ("Inventory, , Used range: A1 to D4, Description:
  // Inventory"), which put the whole line into excel-edit-1's swap note (2026-10-17).
  const label = /^(?:Description: )?(.*?)(?=, ,|, (?:Value|Secondary Actions|ID|Help|Details|Description):|$)/.exec(body)?.[1];
  return label && { role: match[1], label };
}

// Two changed positions must exchange the same lines; inserts and rotations cannot count as swaps.
function swappedSiblings(before, after) {
  // A table's column header anywhere means a click may have sorted it. Sort words count only inside the
  // swapped group: Excel's ribbon "Sort & Filter" hid both tab swaps in the 2026-10-17 rerun.
  const header = line => /^column header\b/.test(ELEMENT.exec(line)?.[3] ?? '');
  if (before.some(header) || after.some(header)) return;
  const sortWords = body => /\b(?:Sort|Ascending|Descending)\b/i.test(body ?? '');
  const old = siblingGroups(before), swaps = [];
  for (const [key, matches] of siblingGroups(after)) {
    const previous = old.get(key);
    if (matches.length !== 1 || previous?.length !== 1) continue;
    const was = previous[0].children, parent = matches[0], now = parent.children;
    if ([previous[0], parent, ...was, ...now].some(node => sortWords(node.body))) continue;
    // A value or real selection change can itself reorder a list. Only the engine's
    // "Selected, " label prefix is ignored when comparing these sibling states.
    if (was.some(node => {
      const matches = now.filter(other => other.key === node.key);
      return matches.length !== 1 || JSON.stringify(stateFields(node.body)) !== JSON.stringify(stateFields(matches[0].body));
    })) continue;
    const changed = was.map((node, i) => node.key !== now[i].key ? i : -1).filter(i => i >= 0);
    if (changed.length !== 2) continue;
    const [i, j] = changed, a = was[i], b = was[j];
    if (a.depth !== b.depth || a.depth !== now[i].depth || b.depth !== now[j].depth ||
        a.key !== now[j].key || b.key !== now[i].key ||
        [a, b].some(node => was.filter(other => other.key === node.key).length !== 1)) continue;
    const left = describeSibling(a), right = describeSibling(b), order = now.map(describeSibling);
    if (left && right && left.role === right.role && left.label !== right.label && order.every(Boolean)) {
      const tabs = tabStrip(parent.role, order.map(node => node.role));
      swaps.push({ key, pair: [left.label, right.label], order: now.map(node => node.key), tabs,
        summary: /* lean notice */ `${tabs ? 'tabs' : 'siblings'} now: ${order.map(node => node.label).join(', ')}` });
    }
  }
  return swaps.length === 1 ? swaps[0] : undefined;
}

// Undo first: in excel-edit-3 (2026-10-17) Cmd+Z restored a tab swap in one call, while runs 1 and 5
// spent 20 to 25 s in a Move or Copy dialog.
const RESTORE_ORDER = /* lean notice */ "if that wasn't intended, Undo (Cmd+Z) restores the order; a move dialog is the fallback.";
// AN1 (2026-10-17): posted clicks on sheet tabs dragged them in 6 of 8 runs, while next/previous-sheet keys
// switched in the background in 586 to 656 ms (6/6). Only a tab strip gets the advice; list rows have no such key.
const restoreOrder = tabs => tabs
  ? /* lean notice */ `${RESTORE_ORDER} To switch tabs, use the app's next/previous-tab key or go-to control, not a click.` : RESTORE_ORDER;

// A tab strip by its parent's role, or by every sibling's role.
function tabStrip(parent, roles) {
  return /^(?:tab group|tab bar|sheet tab strip|layout area|segmented control|page selector)$/.test(parent ?? '') ||
    roles.length > 0 && roles.every(role => /^(?:tab|radio button|segment|page)$/.test(role ?? ''));
}

function siblingSwapNote(swap) {
  return /* lean notice */ `sleight: clicking also swapped ${swap.pair[0]} and ${swap.pair[1]}; ${swap.summary}; ${restoreOrder(swap.tabs)}`;
}

// Selection and AX numbering can change on a click; sibling membership cannot.
function clickLists(lines) {
  const nodes = [], stack = [];
  for (const line of lines) {
    const match = ELEMENT.exec(line);
    if (!match) { stack.length = 0; continue; }
    const depth = match[1].length;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const node = { num: Number(match[2]), body: match[3], depth, children: [] };
    node.description = describeSibling(node);
    node.key = match[3].replace(/\s*\((?:selected|selectable|focused)(?:, (?:selected|selectable|focused))*\)/g, '')
      .replace(/^([a-z][a-z ]*?) Selected, /, '$1 ');
    stack.at(-1)?.children.push(node);
    nodes.push(node); stack.push(node);
  }
  const found = new Map();
  for (const parent of nodes) {
    for (const role of new Set(parent.children.map(child => child.description?.role))) {
      const siblings = parent.children.filter(child => role && child.description?.role === role);
      if (siblings.length < 2 || new Set(siblings.map(child => child.key)).size !== siblings.length) continue;
      // The parent's role as siblingGroups takes it: describeSibling reads a bare "tab group" as role "tab".
      const parentRole = /^[a-z]+(?: [a-z]+)*/.exec(parent.key)?.[0];
      const key = JSON.stringify([parentRole, parent.depth, role, siblings.map(child => child.key).sort()]);
      const matches = found.get(key) ?? [];
      matches.push(siblings); found.set(key, matches);
    }
  }
  return found;
}

const siblingLabel = node =>
  /(?:^|, )Description: (.*?)(?=, (?:Value|Secondary Actions|ID|Help|Details):|$)/.exec(node.body)?.[1] ?? node.description.label;

// Each tab strip by its labels, which survive selection, renumbering and a sheet's own content changing:
// list key -> { labels in order, element numbers }.
function tabLists(lines) {
  const found = new Map();
  for (const [key, matches] of clickLists(lines)) {
    const [parentRole, depth, role] = JSON.parse(key);
    if (matches.length !== 1 || !tabStrip(parentRole, [role])) continue;
    const labels = matches[0].map(siblingLabel);
    if (new Set(labels).size !== labels.length) continue;
    const id = JSON.stringify([parentRole, depth, role, [...labels].sort()]);
    found.set(id, found.has(id) ? undefined : { labels, nums: matches[0].map(child => child.num) });
  }
  return new Map([...found].filter(([, list]) => list));
}

// The part of two orders that differs, without the ends they share (an Excel strip's arrows and Insert sheet).
function changedRun(now, was) {
  let start = 0, end = 0;
  while (start < now.length && now[start] === was[start]) start++;
  while (end < now.length - start && now[now.length - 1 - end] === was[was.length - 1 - end]) end++;
  return [now.slice(start, now.length - end), was.slice(start, was.length - end)];
}

// Every click in the call whose target sits in a sibling list. A call with other clicks counts too: in
// excel-edit-2 (2026-10-17) click(7) plus a Name Box click swapped the sheet tabs with no note, and
// Claude saved the wrong order.
function clickedSiblings(action) {
  if (!action?.before || action.before.incomplete || action.before.degraded) return [];
  const lists = clickLists(action.before.lines), clicks = [];
  for (const call of maskCode(action.code).matchAll(/\.\s*click\s*\(/g)) {
    const args = action.code.slice(call.index + call[0].length).split(')')[0];
    const number = /^\s*(\d+)\s*(?:,|$)/.exec(args)?.[1];
    const locator = !number && clickLocator(args);
    // A bare string resolves by label alone here, as it did before { id, label }.
    const resolve = locator?.bare !== undefined ? { label: locator.bare } : locator;
    const targets = action.before.lines.filter(line => {
      const parsed = parse(line), body = parsed.key.trim();
      return parsed.num !== undefined && (number ? parsed.num === Number(number) : !!resolve && locatorMatches(resolve, body));
    });
    if (targets.length !== 1) continue;
    const num = parse(targets[0]).num;
    if (clicks.some(click => click.num === num)) continue;
    for (const [key, matches] of lists) {
      if (matches.length !== 1) continue;
      const index = matches[0].findIndex(child => child.num === num);
      if (index < 0) continue;
      const target = matches[0][index], label = siblingLabel(target);
      const [parentRole, , role] = JSON.parse(key);
      clicks.push({ num, key, target: target.key, label, position: index + 1, order: matches[0].map(child => child.key),
        tabs: tabStrip(parentRole, [role]), window: swapDocumentKey(action.before.window) });
      break;
    }
  }
  return clicks;
}

// Only the clicked item may have moved: another sibling jumping across it is not the click's doing.
function clickMoveNote(click, observation) {
  const matches = clickLists(observation.lines).get(click.key);
  if (matches?.length !== 1) return;
  const order = matches[0].map(child => child.key), position = order.indexOf(click.target) + 1;
  const others = keys => JSON.stringify(keys.filter(key => key !== click.target));
  if (position && position !== click.position && others(order) === others(click.order))
    return /* lean notice */ `sleight: the click on ${click.label} moved it from position ${click.position} to ${position}; ${restoreOrder(click.tabs)}`;
}

// Reminders survive an edited title marker; input guards and document grants still use exact identity.
const swapDocumentKey = window => window && documentKey({ ...window,
  title: window.title.replace(/(?: — | - | )Edited$/, '') });

// Capture the error before relay notices and trees can bury it. The engine puts its exception
// after ordinary output; a guard exception carries its tree after the first line.
export function failureReason(content) {
  return (content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string' && !/^#/.test(item.text))
    .flatMap(item => item.text.split('\n'))
    .filter(line => !/^\s*\d+ |^\s+at /.test(line)).map(line => line.trim())
    .filter(line => line && !/^(?:#|Warning:|Window: |URL: |\[\/?sleight:|sleight:guard-ready)/.test(line)).at(-1);
}

// outcomes: per-action outcome lines already say what changed, so the call-level UI line is left out.
function resultNote(action, after, failed, failure, outcomes = false) {
  const before = action.before;
  const invalidRead = after?.invalid;
  if (invalidRead) after = undefined;
  const degradedRead = before?.degraded || after?.degraded;
  let reason = /* lean notice */ failed ? 'call failed' : action.overlap ? 'overlapping calls' : !after ? invalidRead ?? 'no read after input'
    : !before ? 'no earlier read' : before.window.app !== after.window.app ? 'another app' : degradedRead ? 'degraded read' : undefined;
  const windowChanged = !reason && action.opens &&
    (before.window.title !== after.window.title || before.window.url !== after.window.url);
  let ui = /* lean notice */ windowChanged ? 'UI changed (window)' : undefined;
  const incomplete = before?.incomplete || after?.incomplete;
  const sameDocument = before && after && /^standard window\b/.test(before.root) &&
    before.window.url?.startsWith('file://') && before.window.url === after.window.url;
  const modifiedCleared = sameDocument && /\b(?:Modified|Edited): true\b/i.test(before.root) &&
    /\b(?:Modified|Edited): false\b/i.test(after.root);
  const degraded = after?.delta?.degraded || (after?.delta?.lostState && !(action.deletes && after.delta.clearedValue));
  if (!ui) {
    reason ||= /* lean notice */ incomplete ? 'incomplete read' : degraded ? 'degraded read'
      : after?.delta?.baseline !== before.id ? 'comparison unavailable' : undefined;
    if (!reason && after.delta.panel) ui = /* lean notice */ 'UI changed (sheet or dialog)';
    if (!reason && (after.delta.semantic || (action.deletes && after.delta.clearedValue))) ui = /* lean notice */ 'UI changed (value)';
    if (!reason && action.save && modifiedCleared) ui = /* lean notice */ 'UI changed (modified state)';
    if (!reason && after.delta.element) ui ||= /* lean notice */ 'UI changed (element)';
    // Without a comparison Claude already has the full tree (a retitled window, its own full read),
    // so the line would only add tokens.
    if (reason) ui = /* lean notice */ reason === 'comparison unavailable' ? undefined : `UI unverified (${reason})`;
  }
  let saved;
  if (action.save) {
    // Without a standard-window read just before, the app's last read of the same document (app, title
    // without its Edited marker, file URL) and that file's time at the start of this call stand in.
    const unedited = title => title.replace(/(?: — | - )Edited$/, '');
    const base = !sameDocument && after && /^standard window\b/.test(after.root) && after.window.url?.startsWith('file://') &&
      (!before || before.window.app === after.window.app) &&
      action.saveBases?.find(base => base.window.app === after.window.app && base.window.url === after.window.url &&
        unedited(base.window.title) === unedited(after.window.title));
    const fileWritten = sameDocument ? before.window.app === after.window.app && before.window.title === after.window.title &&
      action.fileTime !== undefined && (fileTime(after.window.url) ?? -Infinity) > (action.fileTime ?? -Infinity)
      : !!base && typeof base.fileTime === 'number' && (fileTime(after.window.url) ?? -Infinity) > base.fileTime;
    // A degraded or incomplete trailing read can't show the save state, but the same window's file changing on disk
    // during the call still can. "not confirmed (degraded read)" after a save that worked sent Claude through six
    // checking turns, about 17 s of a 38.5 s textedit-calculator run (Fable study, 2026-10-17).
    const readIssue = degradedRead ? 'degraded read' : incomplete ? 'incomplete read' : degraded ? 'degraded read' : undefined;
    const unavailable = /* lean notice */ failed ? 'call failed' : action.overlap ? 'overlapping calls' : action.mixedSave && !(fileWritten && action.fileSaveSafe) ? 'mixed save targets' : !after ? invalidRead ?? 'no read after input'
      : fileWritten ? undefined : !before ? 'no earlier read' : before.window.app !== after.window.app ? 'another app' : readIssue;
    const document = after && /^standard window\b/.test(after.root) && !/\b(?:save|open)-panel\b/.test(after.root);
    const editedTitleCleared = sameDocument && edited(before.window.title) && !edited(after.window.title) &&
      before.window.title.replace(/(?: — | - )Edited$/, '') === after.window.title && before.window.url === after.window.url;
    const named = action.namedURL && action.namedURL === after?.window.url;
    // A same-window file write can confirm a save around editable clicks, but never around
    // navigation, another target, or input that edits again after saving.
    // The two ordinary steps of a Save panel get no saved field: the panel opening, and the panel
    // closing on a document with a file URL when the call named no path it could check. The header
    // shows both, and "not confirmed" there sent Claude to check again (h2h-3, 2026-10-10). A named
    // path that doesn't match still says so.
    const panelRoot = root => /^(?:sheet|dialog)\b|\b(?:save|open)-panel\b/.test(root ?? '');
    const panelStep = !unavailable && after && (panelRoot(after.root) ||
      (panelRoot(before?.root) && /^standard window\b/.test(after.root) && after.window.url?.startsWith('file://') && !action.namedURL));
    if (panelStep) saved = undefined;
    else saved = /* lean notice */ unavailable ? `not confirmed (${unavailable})`
      : readIssue ? `observed ${JSON.stringify(after.window.url)} (its file on disk changed during this call)`
      : !document ? 'not confirmed (no document save state change seen)'
      : !sameDocument && !named && !fileWritten ? `not confirmed (${after.window.url ? 'different document' : 'document identity unavailable'})`
      : modifiedCleared || editedTitleCleared ? `observed ${JSON.stringify(after.window.url)} (modified state cleared; cause unknown)`
      : named ? `observed ${JSON.stringify(after.window.url)} (named file URL)`
      : fileWritten ? `observed ${JSON.stringify(after.window.url)} (its file on disk changed during this call)` : 'not confirmed (no document save state change seen)';
  }
  const selectedTabs = !reason && !incomplete && !degraded && after?.delta?.baseline === before.id
    ? after.delta.selectedTabs : [];
  const fields = [/* lean notice */ failed ? 'call failed (' + (failure?.noInput && !action.overlap ? 'no input was sent' : 'partial input possible') + ')' +
    (failure?.message ? ': ' + failure.message : ': engine returned no error text') : outcomes ? undefined : ui, ...selectedTabs, saved && /* lean notice */ 'saved: ' + saved,
    saved?.startsWith('observed') && after.window.url?.startsWith('file://') && fileReceipt(after.window.url)].filter(Boolean);
  const finish = saveFinishLine(after, before, failed, action.overlap);
  if (!fields.length) return finish;
  const note = fields.join('; ');
  return /* lean notice */ 'sleight: ' + note + (/[.!?]$/.test(note) ? '' : '.') + (finish ? '\n' + finish : '');
}

// Whether text holds a full tree: a window header whose next lines aren't a diff of an earlier one.
export function hasFullTree(text) {
  if (typeof text !== 'string') return false;
  for (const m of text.matchAll(/^Window: [^\n]*\n/gm)) {
    const next = text.slice(m.index + m[0].length).split('\n', 3);
    if (ELEMENT.test(next[0] ?? '') && !next.slice(1).some(line => /^sleight: (?:lines changed|no change since)/.test(line))) return true;
  }
  return false;
}

// A split acquisition's tree, left out when the rest of its call returns a full tree of the same app:
// that later tree is newer, and in 74 of 150 results (2026-10-11) the acquisition's tree came first,
// 370,328 of 1,620,273 characters Claude read. Text before the tree (the engine's docs) stays.
// With SLEIGHT_COMPACT_REACQUIRE=0 (reacquire false) this is the rule as it was before compacted
// re-acquisitions, for the A/B baseline. Otherwise a whole tree is numbered 0, 1, 2… without a gap,
// which a filtered or folded print is not. Code that slices its output can print a whole tree's first
// part, so there a tree counts only when the engine's "The focused UI element" or "Selected:" footer
// follows it. A compacted re-acquisition that found no change also goes when the call's own diff or
// "no change" for that window follows: that diff was taken against the same lines. A full head stays
// then (the diff is against it), and so does a head diff (its changes are in no later view).
export function dropAcquisitionTree(head, rest, code, reacquire = true) {
  const later = (rest ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n');
  if (!reacquire) {
    const laterWindow = hasFullTree(later) && windowFromText(later.slice(later.search(/^Window: /m)));
    if (!laterWindow) return head;
    return head.flatMap(item => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return [item];
      const at = item.text.search(/^Window: /m);
      if (at < 0 || documentKey(windowFromText(item.text.slice(at)) ?? {}) !== documentKey(laterWindow)) return [item];
      const kept = item.text.slice(0, at).replace(/\n+$/, '');
      return kept ? [{ ...item, text: kept }] : [];
    });
  }
  const sliced = typeof code === 'string' && /\.\s*(?:slice|substring|substr)\s*\(/.test(maskCode(code));
  const views = windowViews(later);
  if (!views.length) return head;
  const out = head.flatMap(item => {
    if (item?.type !== 'text' || typeof item.text !== 'string') return [item];
    const at = item.text.search(/^Window: /m);
    const window = at >= 0 && windowFromText(item.text.slice(at));
    if (!window) return [item];
    // Only the same window's view: an acquisition of another window is the only view Claude has of it.
    const same = views.filter(view => documentKey(view.window) === documentKey(window));
    const unchanged = /^Window: [^\n]*\n0 [^\n]*\nsleight: no change since the last full tree you saw for this window\.\s*$/.test(item.text.slice(at));
    if (!same.some(view => view.full && (view.footer || !sliced)) && !(unchanged && same.some(view => view.compact))) return [item];
    const kept = item.text.slice(0, at).replace(/\n+$/, '');
    return kept ? [{ ...item, text: kept }] : [];
  });
  return out.length === head.length && out.every((item, i) => item === head[i]) ? head : out;
}

function windowViews(text) {
  return [...text.matchAll(/^Window: [^\n]*\n/gm)].flatMap(match => {
    const body = text.slice(match.index + match[0].length).split('\n');
    const window = /^0 /.test(body[0] ?? '') && windowFromText(match[0] + body[0]);
    if (!window) return [];
    const end = body.findIndex((line, i) => i > 0 && /^(?:Window: |Selected:|The focused UI element )/.test(line));
    const numbers = (end < 0 ? body : body.slice(0, end)).map(line => ELEMENT.exec(line)?.[2]).filter(n => n !== undefined);
    return [{ window, compact: /^sleight: (?:lines changed|no change since)/.test(body[1] ?? ''),
      full: numbers.length > 1 && numbers.every((n, i) => n === String(i)), footer: end >= 0 && !/^Window: /.test(body[end]) }];
  });
}

function trimSiblingRows(text, fullRead = '') {
  if (text.length < 25000 || !hasFullTree(text) || !windowFromText(text)) return;
  const lines = text.split('\n'), names = [windowFromText(text).title];
  for (const line of lines) {
    if (/\btext (?:field|entry area)\b/.test(line) && /\b(?:Name|saveAsNameTextField|nameField)\b/i.test(line)) {
      const value = /\bValue: (.*?)(?=, (?:ID|Help|Description|Secondary Actions):|$)/.exec(line)?.[1];
      if (value) names.push(value);
    }
  }
  const targets = names.filter(name => name.length >= 3).map(name => name.toLowerCase());
  const stack = [], groups = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ELEMENT.exec(lines[i]);
    if (!m) { stack.length = 0; continue; }
    const depth = m[1].length;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1);
    if (/^row\b/.test(m[3]) && /^(?:list|outline)\b/.test(parent?.role ?? '')) {
      let end = i + 1;
      while (end < lines.length) {
        const child = ELEMENT.exec(lines[end]);
        if (!child || child[1].length <= depth) break;
        end++;
      }
      const body = lines.slice(i, end).join('\n');
      const keep = /\([^)]*\bselected\b[^)]*\)|\b(?:folder|directory)\b/i.test(body) ||
        targets.some(name => body.toLowerCase().includes(name));
      let group = groups.at(-1);
      if (!group || group.parent !== parent.index || group.rows.at(-1).end !== i) {
        group = { parent: parent.index, rows: [] }; groups.push(group);
      }
      group.rows.push({ start: i, end, keep });
    }
    stack.push({ depth, index: i, role: m[3] });
  }
  const replacements = new Map(), hidden = new Set();
  for (const group of groups) {
    if (group.rows.length < 20) continue;
    let run = [];
    const flush = () => {
      if (!run.length) return;
      replacements.set(run[0].start, { end: run.at(-1).end,
        text: /* notice */ `sleight: ${run.length} sibling rows omitted (${run.reduce((count, row) => count + row.end - row.start, 0)} lines).${replacements.size ? '' : fullRead}` });
      for (const row of run) for (const line of lines.slice(row.start, row.end)) {
        const num = parse(line).num; if (num !== undefined) hidden.add(num);
      }
      run = [];
    };
    for (const row of group.rows) { if (row.keep) flush(); else run.push(row); }
    flush();
  }
  if (!replacements.size) return;
  const out = [];
  for (let i = 0; i < lines.length;) {
    const replacement = replacements.get(i);
    if (replacement) { out.push(replacement.text); i = replacement.end; }
    else out.push(lines[i++]);
  }
  return { text: out.join('\n'), hidden };
}

// First-read hints are per document, plus the root element's ID when the tree names one:
// two windows with one title and no URL are otherwise the same key.
function hintKey(window, root = '') {
  const key = documentKey(window), id = /\bID: ([^,]+)/.exec(root)?.[1];
  return key && id ? `${key}#${id.trim()}` : key;
}
// One key per window section in the text (a multi-window acquisition holds several).
function hintKeys(text) {
  const starts = [...text.matchAll(/^Window: /gm)];
  return starts.map((start, i) => {
    const section = text.slice(start.index, starts[i + 1]?.index);
    return hintKey(windowFromText(section), parse(section.split('\n')[1] ?? '').key);
  }).filter(Boolean);
}

function trimAcquisition(text, fullRead = '', hinted = new Set()) {
  if (!hasFullTree(text) || !windowFromText(text) || /…\(\d+\)/.test(text)) return;
  const starts = [...text.matchAll(/^Window: /gm)];
  if (starts.length > 1) {
    let out = text.slice(0, starts[0].index);
    const hidden = new Set();
    for (let i = 0; i < starts.length; i++) {
      const section = text.slice(starts[i].index, starts[i + 1]?.index), body = section.replace(/\n+$/, '');
      const trimmed = trimAcquisition(body, fullRead, hinted);
      out += trimmed ? trimmed.text + section.slice(body.length) : section;
      for (const num of trimmed?.hidden ?? []) hidden.add(num);
    }
    return hidden.size ? { text: out, hidden } : undefined;
  }
  const at = text.search(/^Window: /m), lines = text.slice(at).split('\n');
  if (!/^(?:(?:standard|floating|system|dialog) window|window|sheet|dialog)\b/.test(parse(lines[1]).key)) return;
  // Unknown continuations may be document text or separate output. Keep them whole.
  if (lines.slice(2).some(line => line.trim() && !ELEMENT.test(line))) return;
  const out = lines.slice(0, 2), hidden = new Set(), stack = [];
  for (const line of lines.slice(2)) {
    const match = ELEMENT.exec(line);
    if (!match) { out.push(line); continue; }
    const depth = match[1].length, key = match[3];
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const menu = /^menu\b/.test(key) || stack.at(-1)?.menu;
    stack.push({ depth, menu });
    const actionable = menu || /^(?:[a-z ]*button|text field|text entry area|search field|combo box|check box|checkbox|link|slider|stepper|switch|tab|disclosure triangle|scroll bar)\b/.test(key) ||
      /\bSecondary Actions:|\([^)]*\b(?:settable|selectable|checkable)\b/.test(key);
    const value = /\bValue: ?(.*?)(?=, (?:Secondary Actions|ID|Help|Description):|$)/.exec(key)?.[1] ??
      key.replace(/^(?:static )?text\s*/, '');
    const shortText = /^(?:static )?text\b/.test(key) && value.length < 80;
    if (actionable || shortText) out.push(line);
    else hidden.add(Number(match[2]));
  }
  if (!hidden.size) return;
  const key = hintKey(windowFromText(text), parse(lines[1]).key);
  out.push(/* notice */ `sleight: ${hidden.size} static or structural lines omitted.${hinted.has(key) ? '' : fullRead}`);
  const compacted = text.slice(0, at) + out.join('\n');
  if (compacted.length >= text.length) return;
  hinted.add(key);
  return { text: compacted, hidden };
}

// relay.mjs finds this note by its exact text in either wording.
export const TEXTLESS_NOTE = /* lean notice */ 'sleight: the document area exposes no text values. Read the window with `nodeRepl.emitImage(await app.getScreenshot())`.';

// Inspect each document subtree, not toolbar values or the compacted diff (which may hide text).
// With openedFiles (path -> size), an empty text area counts only for a file open_file found non-empty on
// disk: a blank new document is an empty text area too, and the hint cost it a screenshot turn.
function textlessDocument(observation, openedFiles) {
  if (!observation || observation.invalid || observation.incomplete || observation.degraded ||
      !/^(?:standard|floating) window\b/.test(observation.root)) return false;
  const lines = observation.lines.map(parse);
  let fileSize;
  try { fileSize = observation.window?.url ? openedFiles?.get(fileURLToPath(observation.window.url)) : undefined; } catch { /* Not a file URL. */ }
  return lines.some((line, i) => {
    if (line.num === undefined) return false;
    const key = line.key.trimStart();
    if (!/^(?:layout area|table|document|text (?:entry )?area)\b/.test(key) &&
        !/^(?:split group|group|container|scroll area)\b/.test(key)) return false;
    if (!/^(?:layout area|table|document|text (?:entry )?area)\b/.test(key) &&
        !/\b(?:document pane|document area|content area)\b/i.test(key)) return false;
    if (openedFiles && /^text (?:entry )?area\b/.test(key) && !(fileSize > 0)) return false;
    const depth = line.key.length - key.length;
    for (let j = i; j < lines.length; j++) {
      const child = lines[j], body = child.key.trimStart();
      if (j > i && child.num !== undefined && child.key.length - body.length <= depth) break;
      if (child.num === undefined || !/^(?:(?:static )?text|cell|row)\b/.test(body)) continue;
      const value = /\bValue:\s*(.*)/.exec(body)?.[1];
      if (value !== undefined) {
        if (value.split(/,?\s*(?:ID|Help|Description|Secondary Actions):/)[0].trim().replace(/^(?:""|'')$/, '')) return false;
      } else if (/^(?:static text|text)\s+(?!entry area\b|area\b|field\b)/.test(body) &&
          !/^(?:static text|text)\s+(?:ID|Help|Description|Secondary Actions):/.test(body)) return false;
    }
    return true;
  });
}

const toolbarGroup = key => /^toolbar\b/.test(key) ||
  /^(?:tab group|group) (?:Description: )?ribbon(?:,|$)/i.test(key);
const control = key => /^(?:[a-z ]*button|text field|text entry area|search field|combo box|check box|checkbox|link|slider|stepper|switch|tab|disclosure triangle|scroll bar)\b/.test(key) ||
  /\bSecondary Actions:|\([^)]*\b(?:settable|selectable|checkable)\b/.test(key);

function toolbarGroups(lines) {
  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    const row = ELEMENT.exec(lines[i]);
    if (!row || !toolbarGroup(row[3])) continue;
    let end = i + 1;
    while (end < lines.length) {
      const child = ELEMENT.exec(lines[end]);
      if (!child || child[1].length <= row[1].length) break;
      end++;
    }
    groups.push({ start: i, end, key: parse(lines[i]).key.trim() });
  }
  return groups;
}

// Uncertain or non-element input keeps every group. Match targets in the earlier
// observation too: a click can remove its control or renumber the whole ribbon.
function actedToolbars(code, action, lines, window) {
  if (!action) return new Set();
  if (action.overlap || !action.before || documentKey(action.before.window) !== documentKey(window) || typeof code !== 'string') return;
  const masked = maskCode(code), calls = [...masked.matchAll(/\.\s*(click|setValue|selectText|performSecondaryAction|scroll|drag|pressKey|typeText|paste)\s*\(/g)];
  if (!calls.length) return;
  const kept = new Set(), before = action.before.lines;
  for (const call of calls) {
    if (!['click', 'setValue', 'selectText', 'performSecondaryAction', 'scroll'].includes(call[1])) return;
    const args = code.slice(call.index + call[0].length);
    const number = /^\s*(\d+)\s*(?:,|\))/.exec(args);
    const named = /^\s*\{\s*(id|label|line)\s*:\s*(["'])([^"'\\]*)\2\s*\}\s*(?:,|\))/.exec(args);
    const label = /^\s*(["'])([^"'\\]*)\1\s*(?:,|\))/.exec(args);
    if (!number && !named && !label) return;
    let found = false;
    for (const source of [before, lines]) {
      const groups = toolbarGroups(source);
      for (let i = 0; i < source.length; i++) {
        const row = parse(source[i]);
        if (row.num === undefined) continue;
        const matches = number ? row.num === Number(number[1]) : named?.[1] === 'id' ? hasIdentifier(row.key, named[3])
          : named?.[1] === 'line' ? row.key.trim() === named[3] : hasLabel(row.key, named?.[3] ?? label[2]);
        if (!matches) continue;
        found = true;
        for (const group of groups) if (i >= group.start && i < group.end) kept.add(group.key);
      }
    }
    if (!found) return;
  }
  const current = new Set(toolbarGroups(lines).map(group => group.key));
  if ([...kept].some(key => !current.has(key))) return;
  return kept;
}

function trimToolbars(text, code, action, fullRead = '') {
  const window = windowFromText(text);
  if (!window || !hasFullTree(text) || /…\(\d+\)/.test(text)) return;
  const lines = text.split('\n'), at = lines.findIndex(line => /^Window: /.test(line));
  if (!/^(?:(?:standard|floating|system|dialog) window|window|sheet|dialog)\b/.test(parse(lines[at + 1] ?? '').key)) return;
  // Allow the engine's focus footer, but don't guess around multiline values or diffs.
  let end = at + 1;
  while (end < lines.length && ELEMENT.test(lines[end])) end++;
  if (lines.slice(end).some(line => line.trim() && !/^The focused UI element (?:is|was) \d+ /.test(line))) return;
  if (textlessDocument({ root: parse(lines[at + 1]).key, lines: lines.slice(at, end) })) return;
  const kept = actedToolbars(code, action, lines, window);
  if (!kept) return;
  const groups = toolbarGroups(lines), hidden = new Set(), out = [];
  for (let i = 0; i < lines.length;) {
    const group = groups.find(group => group.start === i);
    const children = group && lines.slice(i + 1, group.end);
    const count = children?.filter(line => control(parse(line).key.trim())).length ?? 0;
    if (!group || count <= 20 || kept.has(group.key)) { out.push(lines[i++]); continue; }
    out.push(lines[i] + /* notice */ ` — sleight: ${count} controls omitted (${children.length} lines).${hidden.size ? '' : fullRead}`);
    for (const line of children) hidden.add(parse(line).num);
    i = group.end;
  }
  return hidden.size ? { text: out.join('\n'), hidden } : undefined;
}

// Numbers in these tree lines that a toolbar fold may hide: the conservative superset of what trimToolbars decides per result.
function foldableNumbers(lines) {
  const out = new Set(), at = lines.findIndex(line => /^Window: /.test(line)), root = parse(lines[at + 1] ?? '').key;
  if (at < 0 || !/^(?:(?:standard|floating|system|dialog) window|window|sheet|dialog)\b/.test(root) ||
      textlessDocument({ root, lines: lines.slice(at) })) return out;
  for (const group of toolbarGroups(lines)) {
    const children = lines.slice(group.start + 1, group.end);
    if (children.filter(line => control(parse(line).key.trim())).length > 20) for (const line of children) out.add(parse(line).num);
  }
  return out;
}

// Copies must match numbered lines in order, including values and indentation.
// Keep differing snapshots, non-tree output and ambiguous windowless copies.
// With folds on, a shorter copy that names controls the longer tree's fold hides stays: Claude asked for those lines.
function dedupeTrees(content, copiesOnly = false, allowCopies = true, sliced = false, folds = false) {
  const blocks = content.flatMap((item, index) => {
    if (item?.type !== 'text' || typeof item.text !== 'string') return [];
    return [...item.text.matchAll(/^(?:Window: [^\n]*\n)?(?:\t*\d+ [^\n]*(?:\n|$))+/gm)].map(match => {
      const text = match[0].replace(/\n+$/, ''), lines = text.split('\n');
      const diff = /^sleight: (?:lines changed|no change since)/.test(item.text.slice(match.index + match[0].length));
      const omitted = item.text.lastIndexOf(GUARD_OMIT_MARK, match.index) > item.text.lastIndexOf(GUARD_END, match.index);
      return { index, at: match.index, length: match[0].length, lines,
        full: !diff && !omitted && hasFullTree(text), diff, omitted,
        marked: item.text.lastIndexOf(GUARD_MARK, match.index) > item.text.lastIndexOf(GUARD_END, match.index),
        window: windowFromText(text) };
    });
  });
  const removed = new Set();
  for (const block of blocks) {
    if (block.diff || block.omitted || copiesOnly && block.marked) continue;
    const matches = blocks.filter(other => {
      if (other === block || !other.full || other.lines.length < block.lines.length ||
          (copiesOnly && other.lines.length === block.lines.length) ||
          (!allowCopies && other.lines.length !== block.lines.length)) return false;
      if (folds && other.lines.length > block.lines.length) {
        const folded = foldableNumbers(other.lines);
        if (block.lines.some(line => folded.has(parse(line).num))) return false;
      }
      let at = 0;
      for (const line of other.lines) if (line === block.lines[at] ||
          sliced && block.window && at === block.lines.length - 1 && line.startsWith(block.lines[at])) at++;
      return at === block.lines.length;
    });
    if (!block.window && new Set(matches.map(other => documentKey(other.window))).size !== 1) continue;
    const keeper = matches.sort((a, b) => b.lines.length - a.lines.length || blocks.indexOf(a) - blocks.indexOf(b))[0];
    if (keeper && (keeper.lines.length > block.lines.length || blocks.indexOf(keeper) < blocks.indexOf(block))) removed.add(block);
  }
  return content.flatMap((item, index) => {
    const spans = blocks.filter(block => block.index === index && removed.has(block)).reverse();
    if (!spans.length) return [item];
    let text = item.text;
    for (const block of spans) text = text.slice(0, block.at) + text.slice(block.at + block.length);
    return text ? [{ ...item, text }] : [];
  });
}

// A call that reads one window more than CALL_TREES times shows only its last read of that window.
// The travel task's 40-read airport search returned 41 full trees, 140,731 characters, which spilled
// to a file Claude couldn't open (Firefox, 2026-10-17); with only the last tree it is 3,620. The code
// still gets every read, the earlier ones become omitted reads (as emit:false makes them), and errors,
// notices, Claude's own output and other windows' trees stay. Incomplete reads are never left out.
// The header names only title, app and URL, so a read is left out only when its root (window, sheet,
// dialog or menu, and the root's ID where it has one) matches the window's last read. Without an ID,
// two same-titled windows look alike, so a call using more than one handle keeps those reads.
const CALL_TREES = 2;
const rootRole = (tree, root) => menuRoot(tree) ? 'menu'
  : /^(?:(?:standard|floating|system|dialog) window|window|sheet|dialog)\b/.exec(parse(root).key)?.[0] ?? 'other';
function omitEarlierReads(content, code, limit = CALL_TREES) {
  if (typeof code !== 'string') return { content, omitted: 0 };
  const masked = maskCode(code);
  const handles = new Set([...masked.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*(?:getAXState|getAXStateAndScreenshot|getScreenshot|waitFor|click|setValue|selectText|performSecondaryAction|scroll|drag|pressKey|typeText|paste)\s*\(/g)]
    .map(match => match[1]));
  const oneHandle = handles.size <= 1 && !/\bcua\s*\.\s*get[A-Z]\w*\s*\(/.test(masked);
  const reads = [];
  content.forEach((item, index) => {
    if (item?.type !== 'text' || typeof item.text !== 'string') return;
    for (let pos = 0; ;) {
      const at = item.text.indexOf(GUARD_MARK, pos);
      if (at < 0) break;
      const end = item.text.indexOf(GUARD_END, at + GUARD_MARK.length);
      if (end < 0) break;
      const tree = item.text.slice(at + GUARD_MARK.length, end), window = windowFromText(tree), root = tree.split('\n')[1] ?? '';
      if (window && ELEMENT.test(root) && !/…\(\d+\)/.test(tree)) {
        const key = documentKey(window), id = /\bID: ([^,]+)/.exec(root)?.[1]?.trim();
        reads.push({ index, at, key, id, root: JSON.stringify([key, rootRole(tree, root), id ?? '']) });
      }
      pos = end + GUARD_END.length;
    }
  });
  const counts = new Map();
  for (const read of reads) counts.set(read.root, (counts.get(read.root) ?? 0) + 1);
  const last = new Map(reads.map(read => [read.key, read]));
  const hidden = reads.filter(read => counts.get(read.root) > limit && last.get(read.key) !== read &&
    last.get(read.key).root === read.root && (read.id !== undefined || oneHandle));
  if (!hidden.length) return { content, omitted: 0 };
  return { omitted: hidden.length, content: content.map((item, index) => {
    const spans = hidden.filter(read => read.index === index).reverse();
    let text = item?.text;
    for (const { at } of spans) text = text.slice(0, at) + GUARD_OMIT_MARK + text.slice(at + GUARD_MARK.length);
    return spans.length ? { ...item, text } : item;
  }) };
}

// Each literal scroll call's first argument (an element number, locator or point) and direction.
const scrollTargets = code => [...maskCode(code).matchAll(/\.\s*scroll\s*\(/g)].map(match => {
  const args = /^\s*(\[[^\]]*\]|\{[^}]*\}|[^,)]*)(?:,\s*(['"])([^'"]*)\2)?/.exec(code.slice(match.index + match[0].length));
  return `${args[1].trim()} ${args[3] ?? ''}`;
});
// Travel's airport search took 15 calls and 88.7 s, 45.7 s of it between calls; one call that scrolled
// and read in a loop found and selected the airport in 33 s (Firefox, 2026-10-17).
// The next call wrote the loop this note described in 2 of 3 Safari form-travel runs (race-1017), so the
// paging helper comes first and the loop only when it stops (not a list, unsorted, or keys that don't page).
export const SCROLL_LOOP_NOTE = /* lean notice */ 'sleight: 3 calls in a row scrolled this list. In one call, click a row, then ' +
  '`await app.pickFromList("<whole row text>")`, which pages by key and clicks that row. If it stops, loop up to a fixed count: ' +
  'scroll, read with getAXState(), and stop when the target shows or the rows stop changing.';

// CC1: the first call that scrolls or pages a sorted list names the helper, once per list (codex-vs-cc-1019: Haiku scrolled
// first in 5 of 6 Firefox travel runs, and the scroll calls cost 19 to 33 s against one pick).
export const listPickNote = (handle, number) => /* lean notice */ `sleight: ${number} is a sorted list. Pick its row in one call: \`await ${handle}.pickFromList(${number}, "<whole row text>")\`.`;

// The guard trees in a call's output that answer Claude's own reads and went out compacted or were left out (omitted). Without
// a read in the code every guard tree is the guard's; a call whose last action comes after its last read ends on the guard's
// own read.
function claudeReads(code, compacted, omitted) {
  const masked = typeof code === 'string' ? maskCode(code) : '';
  const lastRead = Math.max(-1, ...[...masked.matchAll(/\.\s*getAXState(?:AndScreenshot)?\s*\(/g)].map(match => match.index));
  if (lastRead < 0) return 0;
  const lastAction = Math.max(-1, ...[...masked.matchAll(/\.\s*(?:click|drag|scroll|selectText|setValue|performSecondaryAction|paste|pressKey|typeText)\s*\(/g)].map(match => match.index));
  return omitted + (lastAction > lastRead ? compacted.slice(0, -1) : compacted).filter(Boolean).length;
}

export function createReadCompactor({ resultTrim = process.env.SLEIGHT_RESULT_TRIM === '1', leanCalls = false, prompt,
  callTrees = process.env.SLEIGHT_CALL_TREES !== 'all', scrollNote = process.env.SLEIGHT_SCROLL_NOTE !== '0',
  compactAcquisition = process.env.SLEIGHT_COMPACT_ACQUISITION === '1',
  compactReacquire = process.env.SLEIGHT_COMPACT_REACQUIRE === '1',
  screenshotReads = process.env.SLEIGHT_SCREENSHOT_READS !== '0',
  compactToolbars = process.env.SLEIGHT_COMPACT_TOOLBARS === '1', readHints = {},
  // WB1 and WB2, off by default until their held-out A/B: the missed-field note and the changed-Undo note.
  routeSteering = process.env.SLEIGHT_WB1 === '1', undoReceipts = process.env.SLEIGHT_WB2 === '1',
  // SLEIGHT_OUTCOMES=1 (A/B, off by default): one line per action from the guard's records (action-outcomes.mjs).
  outcomes = false,
  // CC6: a call that acted shows renumbered elements Claude knew on + lines with their current numbers, as a call that ends
  // on getAXState() does, so ending on the action loses nothing (the relay sets it with SLEIGHT_WORKFLOW_DOCS).
  actionNumbers = false } = {}) {
  // window key -> { lines, valid }: the last full tree Claude got, and the
  // element numbers in it Claude knows are current (undefined: all of them).
  const seen = new Map(), pendingSwaps = new Map(), pendingClicks = new Map();
  // window key -> { sets, calls }: setValue checks whose call ended in another window, such as an alert.
  const pendingSetValues = new Map();
  // window key -> { title, history }: the Undo item's title in that window's last complete read, and every title it showed (WB2).
  const undoSeen = new Map();
  // window key -> { target, calls }: the current run of calls that scrolled one target in that window.
  const scrolls = new Map();
  // Lists (window key and list line) whose sorted rows a scroll already moved once, with the helper named (CC1).
  const listsNoted = new Set();
  // window key -> the last element Claude aimed input at there (null: unknown), for where typing should go.
  const aims = new Map();
  const omissionHints = readHints.omissionHints ??= new Set();
  const screenshotHints = readHints.screenshotHints ??= new Set();
  const screenshotWindows = readHints.screenshotWindows ??= new Set();
  const openedFiles = readHints.openedFiles ??= new Map();
  let latest, effectBaseline, observedInResult, observationId = 0, textlessNoted = false, resultObservations = [], callCount = 0, listClicks = [], lastOutcomes;
  // Reads the last call got as changed lines or not at all, for the action log's reads-saved count (action-stats.mjs). Only
  // reads Claude's code asked for count: guardTrees is whether each guard tree went out compacted, and the read the guard
  // adds after a call's last action is sleight's own, so it never counts.
  let savedReads = 0, lastSaved = 0, guardTrees = [];
  // document key -> tab list key -> { first, last, clicked, blamed, noted }: each tab strip's order when it
  // first appeared, for the save line, and the tab click a later order change followed.
  const tabOrders = new Map();
  // app -> its last standard-window read of a file document, the save baseline when the read just
  // before a save is a menu or nothing at all.
  const documents = new Map();
  function observe(tree, window, lines) {
    const root = parse(lines[1] ?? '').key;
    const degraded = (ELEMENT.test(lines[1] ?? '') && !windowRoot(root)) ||
      // Only the same window losing its URL: another window or a Save sheet has none of its own.
      !!(latest?.window.app === window.app && latest.window.title === window.title && latest.window.url && !window.url);
    const observation = { id: ++observationId, window, lines, root, degraded,
      incomplete: !ELEMENT.test(lines[1] ?? '') || /…\(\d+\)|sleight: (?:lines changed|no change since)/.test(tree) };
    observedInResult = observation; resultObservations.push(observation);
    if (!degraded) latest = observation;
    if (/^standard window\b/.test(root) && window.url?.startsWith('file://')) documents.set(window.app, observation);
    return observation;
  }

  // The save line: excel-edit-8 (2026-10-18) saved a tab order a click had swapped, after the swap note
  // never came. It needs a confirmed save, an order unlike the strip's first, and that change seen right
  // after a tab click (a save in between keeps the click). A reorder through a menu or keys blames nothing.
  function trackTabOrders(action, own, read, halted, note, moved) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const entries = key => tabOrders.get(key) ?? tabOrders.set(key, new Map()).get(key);
    const entry = (lists, key, labels) => lists.get(key) ?? lists.set(key, { first: labels, last: labels }).get(key);
    if (halted || action && !action.save) for (const lists of tabOrders.values()) for (const item of lists.values()) item.clicked = undefined;
    if (halted) return;
    if (own.length && action.before) {
      const lists = entries(swapDocumentKey(action.before.window));
      for (const [key, list] of tabLists(action.before.lines)) {
        const click = own.findLast(click => click.tabs && list.nums.includes(click.num));
        if (click) entry(lists, key, list.labels).clicked = { label: click.label, call: callCount };
      }
    }
    if (!read) return;
    const lists = entries(swapDocumentKey(read.window)), now = tabLists(read.lines);
    for (const [key, { labels }] of now) {
      const item = entry(lists, key, labels);
      if (!same(labels, item.last)) {
        item.blamed = same(labels, item.first) ? undefined : item.clicked?.label;
        item.last = labels; item.clicked = undefined;
      } else if (item.clicked && item.clicked.call < callCount && !action?.save) item.clicked = undefined;
    }
    if (!action?.save || moved || !/\bsaved: observed\b/.test(note ?? '')) return;
    for (const [key, { labels }] of now) {
      const item = lists.get(key);
      if (!item.blamed || same(labels, item.first) || same(labels, item.noted)) continue;
      item.noted = labels;
      const [is, was] = changedRun(labels, item.first);
      return /* lean notice */ `sleight: tab order changed since you opened it (now: ${is.join(', ')}; was: ${was.join(', ')}) after a click on ${item.blamed}; Cmd+Z restores before saving again.`;
    }
  }

  function compact(tree, prefix, action, refreshNumbers = false) {
    const window = windowFromText(tree);
    const lines = tree.replace(/\n+$/, '').split('\n');
    if (!window) {
      latest = undefined;
      observedInResult = { invalid: tree.includes('Window: ') ? 'ambiguous window read' : 'missing window header' };
      return tree;
    }
    const key = documentKey(window);
    const before = seen.get(key);
    const observation = observe(tree, window, lines);
    seen.set(key, { lines, observation });
    if (!before) return tree;
    const old = before.lines.map(parse), now = lines.map(parse);
    const keys = now.map(line => line.key);
    const degraded = new Set();
    for (let j = 0; j < now.length; j++) {
      const id = bareButtonId(now[j].key);
      if (now[j].num === undefined || id === undefined) continue;
      const matches = old.filter(line => line.num !== undefined && degradedButton(line.key, now[j].key));
      if (matches.length === 1 && [old, now].every(lines =>
        lines.filter(line => line.num !== undefined && buttonHasId(line.key, id)).length === 1)) {
        keys[j] = matches[0].key; degraded.add(j);
      }
    }
    const pairs = alignLines(old.map(line => line.key), keys);
    if (!pairs) return tree;
    // What Claude takes each number to be: the full tree it saw, plus the lines shown since.
    const believed = new Map(before.believed ?? numbered(before.lines));
    const known = refreshNumbers && new Set(believed.values());
    const valid = new Set(), changes = [];
    let renumbered = 0, fewerAttributes = 0, removedAttributes = 0, addedAttributes = 0, changedPanel = false;
    const removedState = [], addedState = [], removedNodes = new Map(), addedNodes = new Map();
    for (const [i, j] of pairs) {
      if (j < 0) {
        const fields = stateFields(old[i].key); removedState.push(...fields); removedAttributes += attributes(old[i].key);
        removedNodes.set(old[i].num ?? withoutValue(old[i].key), { ...old[i], fields });
        changedPanel ||= panel(old[i].key);
        changes.push('- ' + (old[i].num === undefined ? before.lines[i] : old[i].key));
        if (old[i].num !== undefined && believed.get(old[i].num) === old[i].key) believed.delete(old[i].num);
        continue;
      }
      const { num } = now[j];
      if (i < 0) {
        const fields = stateFields(now[j].key); addedState.push(...fields); addedAttributes += attributes(now[j].key); changedPanel ||= panel(now[j].key);
        addedNodes.set(num ?? withoutValue(now[j].key), { ...now[j], fields });
        changes.push('+ ' + lines[j]); if (num !== undefined) { valid.add(num); believed.set(num, now[j].key); } continue;
      }
      if (num === undefined) continue;
      if (degraded.has(j)) fewerAttributes++;
      if (num !== old[i].num) renumbered++;
      else if (!before.valid || before.valid.has(num)) valid.add(num);
      if (refreshNumbers && known.has(now[j].key) && (num !== old[i].num || before.valid && !before.valid.has(num))) {
        changes.push('+ ' + lines[j]); valid.add(num); believed.set(num, now[j].key);
      }
    }
    let clearedFields = 0, element = false;
    for (const [number, was] of removedNodes) {
      const now = addedNodes.get(number);
      if (!now) continue;
      element ||= was.num !== undefined;
      if (/\btext (?:entry area|field)\b/.test(was.key) && withoutValue(was.key) === withoutValue(now.key) &&
          !now.fields.some(field => field.startsWith('value:'))) clearedFields += was.fields.filter(field => field.startsWith('value:')).length;
    }
    observation.delta = { baseline: before.observation.id,
      addedLines: [...addedNodes.values()],
      selectedTabs: [...selectedTabChanges(before.lines, lines), ...focusedDescriptionChange(before.lines, lines)],
      semantic: removedState.length > 0 && addedState.length > 0 && JSON.stringify(removedState.sort()) !== JSON.stringify(addedState.sort()),
      panel: changedPanel, renumbered, element,
      lostState: removedState.length > addedState.length,
      clearedValue: clearedFields > 0 && clearedFields >= removedState.length - addedState.length,
      degraded: fewerAttributes > 0 || removedAttributes > addedAttributes };
    // Numbers Claude saw in this same result, on a line identical to the
    // current tree's, are current too (its own reads, the engine's diff).
    const current = new Map(now.filter(l => l.num !== undefined).map(l => [l.num, l.key]));
    for (const line of prefix.split('\n')) {
      const shown = parse(line.replace(/^[+~] ?/, ''));
      if (shown.num !== undefined && current.get(shown.num) === shown.key) { valid.add(shown.num); believed.set(shown.num, shown.key); }
    }
    const header = lines.slice(0, 2).join('\n');
    const body = changes.length
      ? promptNotice(/* lean notice */ 'sleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):', prompt) + `\n${changes.join('\n')}`
      // Other modules match this exact text, so it has no lean wording.
      : /* notice */ 'sleight: no change since the last full tree you saw for this window' + (renumbered ? ', apart from numbering.' : '.');
    const note = renumbered
      ? promptNotice(/* lean notice */ `\nsleight: ${renumbered} other elements have new numbers. Use numbers from + lines above or from a full read. Read the window again with getAXState() for changed lines with current numbers before acting on any other element; sleight refuses actions on numbers that changed.`, prompt)
      : '';
    const degradedNote = fewerAttributes ? promptNotice(/* lean notice */ `\nsleight: ${fewerAttributes} button lines returned fewer attributes. Their unique IDs still match; missing descriptions and help are unavailable in this read.`, prompt) : '';
    const text = `${header}\n${body}${note}${degradedNote}`;
    if (!(leanCalls && action) && text.length > tree.length * MAX_SHARE) return tree;
    const allValid = [...current.keys()].every(num => valid.has(num));
    seen.set(key, { lines, observation, valid: allValid ? undefined : valid, believed: allValid ? undefined : believed });
    return text;
  }

  // A re-acquisition of a window Claude already saw whole, compacted as a getAXState read would be.
  // Haiku starts nearly every call with getApp, and each returned the same 6K-character tree again
  // (excel-edit, 2026-10-17). Returns undefined to keep the tree whole: more than one header, an
  // incomplete or degraded tree, a new window, or a window whose last tree came before a failure or
  // an engine restart (entry.stale).
  function compactReacquired(text) {
    const starts = [...text.matchAll(/^Window: /gm)];
    if (starts.length !== 1) return;
    const at = starts[0].index, tree = text.slice(at).replace(/\n+$/, ''), window = windowFromText(tree);
    const entry = window && seen.get(documentKey(window)), lines = tree.split('\n');
    if (!entry || entry.stale || !entry.observation || entry.observation.incomplete || entry.observation.degraded) return;
    if (ELEMENT.exec(lines[1] ?? '')?.[2] !== '0' || !/^(?:(?:standard|floating|system|dialog) window|window|sheet|dialog)\b/.test(parse(lines[1]).key) ||
        /…\(\d+\)|sleight: (?:lines changed|no change since)/.test(tree)) return;
    if (latest?.window.app === window.app && latest.window.title === window.title && latest.window.url && !window.url) return;
    const sent = compact(tree, text.slice(0, at), undefined, true);
    return sent === tree ? text : text.slice(0, at) + sent;
  }

  // Remembers every tree in a stretch of output Claude sees: from each line that starts with a Window
  // header to the next (only the last when the headers name different windows). A later block that
  // repeats only lines of an earlier one (a tree the call printed itself, cut or filtered, as in
  // excel-edit #3) or has no window root is a degraded read: it never replaces the real tree.
  function remember(text, action) {
    const starts = [...text.matchAll(/^Window: /gm)];
    if (!starts.length) return;
    const ambiguous = starts.length > 1 && !windowFromText(text);
    const shown = new Set();
    for (const [i, { index }] of (ambiguous ? starts.slice(-1) : starts).entries()) {
      const tree = text.slice(index, ambiguous ? undefined : starts[i + 1]?.index).replace(/\n+$/, '');
      const window = windowFromText(tree);
      if (!window) continue;
      const lines = tree.split('\n');
      if (shown.size && (lines.every(line => shown.has(line)) || ELEMENT.test(lines[1] ?? '') && !windowRoot(parse(lines[1]).key))) continue;
      for (const line of lines) shown.add(line);
      if (!ambiguous && action && observedInResult && !observedInResult.invalid &&
          observedInResult.lines.join('\n') === tree) continue;
      if (action) {
        compact(tree, '', action);
        const entry = seen.get(documentKey(window));
        entry.valid = undefined; entry.believed = undefined;
      } else seen.set(documentKey(window), { lines, observation: observe(tree, window, lines) });
      if (ambiguous) { latest = undefined; observedInResult = { invalid: 'ambiguous window read' }; }
    }
  }

  function filteredTree(tree, visible, shownText) {
    const window = windowFromText(tree), lines = tree.replace(/\n+$/, '').split('\n');
    const entry = window && seen.get(documentKey(window));
    if (!entry || !ELEMENT.test(lines[1] ?? '')) return;
    // The visible baseline stays entry.lines, so the next action's UI-change note compares against
    // the observation that baseline came from, not this filtered one.
    const previous = latest, observation = observe(tree, window, lines);
    if (observation.degraded || observation.incomplete) return;
    latest = previous;
    const current = new Map(numbered(lines));
    const believed = new Map(entry.believed ?? numbered(entry.lines));
    for (const text of [visible].flat()) for (const line of text.split('\n')) {
      const shown = parse(line);
      if (shown.num !== undefined && current.get(shown.num) === shown.key &&
          (shownText.includes(line) || shownText.includes(JSON.stringify(line).slice(1, -1)))) believed.set(shown.num, shown.key);
    }
    entry.believed = believed;
    entry.valid = new Set([...believed].filter(([num, key]) => current.get(num) === key).map(([num]) => num));
    // Keep entry.lines as the visible baseline: hidden changes must appear on the next normal read.
    return lines[0];
  }

  return {
    // Rewrites a result's text items. Everything one js call writes arrives
    // as one item, so marked trees (Claude's reads and the guard's) sit among
    // Claude's other output. Each is compacted against what Claude saw before it.
    process(content, { forceFull = false, explicitFull = false, acquisition = false, action, failed = false, failure, code, screenshotWindow, filterMark = FILTERED_MARK,
      outcomeStart = 0, outcomeContinuing = false } = {}) {
      listClicks = []; savedReads = 0; lastSaved = 0; guardTrees = [];
      if (!Array.isArray(content)) return content;
      let filtered, typed, outcomeRecord;
      // The relay gives each rewritten call its own mark, so window text can't forge or strip one.
      const markPattern = filterMark && new RegExp(filterMark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\r\\n]*)(?:\\r?\\n|$)', 'g');
      if (markPattern) content = content.flatMap(item => {
        if (item?.type !== 'text' || typeof item.text !== 'string') return [item];
        const text = item.text.replace(markPattern, (_, json) => {
          try {
            const record = JSON.parse(json);
            // The guard sends each action record as it changes, then the whole list at the end. In order, the last
            // word on each record wins, so a call Claude's own code broke off still has its records.
            if (Object.hasOwn(record, 'outcomes')) outcomeRecord = { ...record, outcomes: Array.isArray(record.outcomes) ? [...record.outcomes] : [] };
            else if (Object.hasOwn(record, 'part')) {
              if (Number.isSafeInteger(record.part) && record.part >= 0 && record.part < 30 && record.rec && typeof record.rec === 'object') {
                const { part, rec, ...extra } = record;
                outcomeRecord = { ...outcomeRecord, ...extra, outcomes: [...(outcomeRecord?.outcomes ?? [])] };
                outcomeRecord.outcomes[part] = rec;
              }
            } else if (Object.hasOwn(record, 'typed')) typed = record.typed;
            else filtered = record;
          } catch { filtered = { full: true }; }
          return '';
        });
        return text === item.text ? [item] : text ? [{ ...item, text }] : [];
      });
      if (filtered?.full) explicitFull = true;
      let omittedReads = 0;
      // A failed call or a recovery read (forceFull) keeps every tree.
      if (callTrees && !failed && !forceFull && !content.some(item => item?.type === 'text' &&
          /sleight: an action in this call failed|engine's JavaScript session restarted/.test(item.text ?? ''))) {
        ({ content, omitted: omittedReads } = omitEarlierReads(content, code));
      }
      // Anchored to a line start: the first-call rules quote "a result says the user changed the app", and an
      // unanchored match marked every first read as stopped, so AN4's open screenshot never fired (A/B 2, 2026-10-17).
      const stopped = content.some(item => item?.type === 'text' &&
        /sleight: an action in this call failed|engine's JavaScript session restarted|(?:(?:^|\n)(?:sleight: )?the user (?:changed|switched)|(?:Input lease|Document scope|Selected window).*?(?:stopped|changed)|outcome unconfirmed|this call acted on)/i.test(item.text));
      if (compactAcquisition && acquisition && (failed || stopped)) forceFull = true;
      const firstAcquisition = compactAcquisition && acquisition && !forceFull && !explicitFull && !action &&
        windowFromText(content.filter(item => item?.type === 'text').map(item => item.text).join('\n'));
      const priorWindows = firstAcquisition && new Set(seen.keys());
      const reacquire = compactReacquire && acquisition && !forceFull && !explicitFull && !failed && !stopped && !action && !filtered;
      if (filtered && (failed || stopped || action?.overlap)) forceFull = true;
      const visible = filtered?.visible;
      // Only a call that took no input: an action's result needs its tree diff and UI-change note.
      const filter = !forceFull && !failed && !stopped && !action &&
        (typeof visible === 'string' || Array.isArray(visible) && visible.every(line => typeof line === 'string'));
      const sliced = /\.\s*slice\s*\(/.test(maskCode(code ?? ''));
      if (compactToolbars && !filter && !failed && !stopped && !action) content = dedupeTrees(content, true, true, sliced, !forceFull && !explicitFull);
      const shownText = filter ? content.filter(item => item?.type === 'text').map(item => item.text
        .replace(/\[sleight:guard-read(?:-omitted)?\]\n[\s\S]*?(?:\n\[\/sleight:guard-read\]\n|$)/g, '')).join('\n') : '';
      observedInResult = undefined; textlessNoted = false; resultObservations = []; callCount++;
      const full = forceFull || explicitFull && !filter;
      const refreshNumbers = actionNumbers && !!action || typeof code === 'string' && /\.\s*getAXState\s*\(/.test(maskCode(code));
      const shownTrees = new Set();
      if (action && full) for (const item of content) {
        if (item?.type !== 'text') continue;
        const plain = item.text.replace(/\[sleight:guard-read(?:-omitted)?\]\n[\s\S]*?(?:\n\[\/sleight:guard-read\]\n|$)/g, '');
        if (hasFullTree(plain)) shownTrees.add(plain.slice(plain.lastIndexOf('Window: ')).replace(/\n+$/, ''));
      }
      let out = content.flatMap(item => {
        if (item?.type === 'text' && /sleight: an action in this call failed|engine's JavaScript session restarted/.test(item.text ?? '')) failed = true;
        if (item?.type !== 'text' || typeof item.text !== 'string' || (!item.text.includes(GUARD_MARK) && !item.text.includes(GUARD_OMIT_MARK))) {
          const reacquired = reacquire && item?.type === 'text' && typeof item.text === 'string' ? compactReacquired(item.text) : undefined;
          if (reacquired !== undefined && reacquired !== item.text) { savedReads++; return { ...item, text: reacquired }; }
          if (reacquired === undefined && item?.type === 'text' && typeof item.text === 'string') remember(item.text, forceFull ? undefined : action);
          if ((action || compactToolbars) && hasFullTree(item.text)) {
            const at = item.text.lastIndexOf('Window: ');
            shownTrees.add(item.text.slice(at).replace(/\n+$/, ''));
          }
          return item;
        }
        let out = '', seenText = '', pos = 0;
        const add = text => { if (out && text && !out.endsWith('\n')) out += '\n'; out += text; };
        for (;;) {
          const visibleAt = item.text.indexOf(GUARD_MARK, pos), omittedAt = item.text.indexOf(GUARD_OMIT_MARK, pos);
          const omitted = omittedAt >= 0 && (visibleAt < 0 || omittedAt < visibleAt);
          const at = omitted ? omittedAt : visibleAt;
          const plain = item.text.slice(pos, at < 0 ? undefined : at);
          remember(plain, forceFull ? undefined : action); seenText += plain; add(plain);
          if ((action || compactToolbars) && hasFullTree(plain)) shownTrees.add(plain.slice(plain.lastIndexOf('Window: ')).replace(/\n+$/, ''));
          if (at < 0) break;
          const start = at + (omitted ? GUARD_OMIT_MARK : GUARD_MARK).length, end = item.text.indexOf(GUARD_END, start);
          const tree = item.text.slice(start, end < 0 ? undefined : end);
          // Hidden headers serve window checks, but never become Claude's visible baseline.
          if (omitted) {
            if (end < 0) break;
            pos = end + GUARD_END.length;
            continue;
          }
          if (end >= 0 && (compactToolbars || action && full && !forceFull) && !failed && !stopped && !action?.overlap && shownTrees.has(tree.replace(/\n+$/, ''))) {
            if (compactToolbars) {
              if (observedInResult?.lines?.join('\n') !== tree.replace(/\n+$/, '')) compact(tree, seenText, action, refreshNumbers);
            } else remember(tree, action);
            pos = end + GUARD_END.length;
            continue;
          }
          let sent = filter ? filteredTree(tree, visible, shownText) : undefined;
          if (sent === undefined) {
            sent = forceFull ? tree : compact(tree, seenText, action, refreshNumbers);
            if (forceFull) remember(tree);
            if (full) {
              sent = tree;
              const entry = seen.get(documentKey(windowFromText(tree) ?? {}));
              if (entry) { entry.valid = undefined; entry.believed = undefined; }
            }
          }
          // A call that acted and ended on exactly the tree Claude saw before it gets that tree whole:
          // "no change" read as if the actions hadn't run, and Claude read again in 2 of 9 traced
          // calculator-click runs (2026-10-10). Claude's own full read earlier in this result is enough.
          // The whole tree is now what Claude saw, so its numbers become known (a compact acquisition hid some).
          // Only numbers in this tree: one Claude never saw anywhere still stops.
          if (!leanCalls && action && !forceFull && sent !== tree && /sleight: no change since/.test(sent) && !/^Window: /m.test(seenText)) {
            sent = tree;
            const entry = seen.get(documentKey(windowFromText(tree) ?? {}));
            if (entry?.valid) for (const [num, key] of numbered(tree.replace(/\n+$/, '').split('\n'))) { entry.valid.add(num); entry.believed?.set(num, key); }
          }
          if (compactToolbars || sent === tree) shownTrees.add(tree.replace(/\n+$/, ''));
          guardTrees.push(sent !== tree);
          if (end < 0 && observedInResult && !observedInResult.invalid) observedInResult.incomplete = true;
          add(sent); seenText += '\n' + sent;
          if (end < 0) break;
          pos = end + GUARD_END.length;
        }
        return !out && item.text.includes(GUARD_OMIT_MARK) ? [] : { ...item, text: out };
      });
      if (outcomeRecord) outcomeRecord.outcomes = outcomeRecord.outcomes.filter(Boolean);
      if (action) {
        const before = action.before ?? action.effectBefore;
        action.writeEffects = !action.overlap && before && !before.incomplete && !before.degraded &&
          observedInResult && !observedInResult.invalid && !observedInResult.incomplete && !observedInResult.degraded
          ? wrongFieldEffects(action.code, before.lines.join('\n'), observedInResult.lines.join('\n')) : [];
        if (action.writeEffects.length) {
          // A successful engine return does not establish that the requested write happened.
          for (const effect of action.writeEffects) {
            const rec = outcomeRecord?.outcomes?.find(rec => rec.i === effect.index && rec.a === effect.method);
            if (effect.isError && rec) { rec.x = 'failed'; rec.f = []; }
          }
          out.unshift(...action.writeEffects.map(effect => ({ type: 'text', text: promptNotice(effect.notice, prompt) })));
        }
      }
      lastOutcomes = outcomeRecord;
      lastSaved = savedReads + claudeReads(code, guardTrees, omittedReads);
      // A stop note that lists what wasn't sent covers the rest.
      const outcomeLines = outcomes && outcomeRecord && renderOutcomes(outcomeRecord, { start: outcomeStart, continuing: outcomeContinuing,
        notSent: content.some(item => item?.type === 'text' && /\bnot sent\b/.test(item.text ?? '')) });
      if (outcomeLines) out.push({ type: 'text', text: promptNotice(outcomeLines, prompt) });
      const note = action && !action.writeEffects?.length && resultNote(action, observedInResult, failed,
        failure ?? { message: failureReason(content) }, !!outcomeLines);
      if (note) out.push({ type: 'text', text: promptNotice(note, prompt) });
      const omittedNote = /* lean notice */ `sleight: ${omittedReads} earlier reads of the same window in this call left out; the last is shown. Element numbers refer to the last tree.`;
      if (omittedReads) out.push({ type: 'text', text: promptNotice(omittedNote, prompt) });
      // Calls in a row that each return the window's tree and scroll one target the same way. A call that
      // loops already searches in one call, and any other call, or one with no tree of that window, ends the run.
      if (scrollNote) {
        const key = observedInResult && !observedInResult.invalid && documentKey(observedInResult.window), last = key && scrolls.get(key);
        scrolls.clear();
        const targets = key && typeof code === 'string' && !/\b(?:for|while|do)\b/.test(maskCode(code)) ? new Set(scrollTargets(code)) : new Set();
        if (targets.size === 1) {
          const [target] = targets, calls = last?.target === target ? last.calls + 1 : 1;
          scrolls.set(key, { target, calls });
          if (calls === 3) out.push({ type: 'text', text: promptNotice(SCROLL_LOOP_NOTE, prompt) });
        }
      }
      // Keep the reminder only while complete observations still show that order in this document.
      const observation = observedInResult;
      const complete = item => item && !item.invalid && !item.incomplete && !item.degraded && !item.delta?.degraded;
      // A degraded trailing read, such as the first lines of a tree the call printed itself after the engine's whole
      // tree (excel-edit-8, 2026-10-18), leaves the checks to the last complete read of that window in the result.
      const trailingDegraded = observation && !observation.invalid && !observation.incomplete && !complete(observation);
      const checked = complete(observation) ? observation : trailingDegraded ? resultObservations.findLast(item =>
        complete(item) && swapDocumentKey(item.window) === swapDocumentKey(observation.window)) : undefined;
      const clickHalted = failed || stopped || forceFull || action?.overlap;
      const lister = scrollNote && action?.before && !action.before.incomplete && !action.before.degraded && checked &&
        documentKey(action.before.window) === documentKey(checked.window) && typeof code === 'string' && !/\.\s*pickFromList\s*\(/.test(code)
        ? /([A-Za-z_$][\w$]*)\s*\.\s*(?:scroll\s*\(|pressKey\s*\(\s*["']Page_(?:Down|Up)["'])/.exec(code)?.[1] : undefined;
      const shifted = lister && sortedListShift(action.before.lines, checked.lines);
      if (shifted && !listsNoted.has(documentKey(checked.window) + '\n' + shifted.body)) {
        listsNoted.add(documentKey(checked.window) + '\n' + shifted.body);
        out.push({ type: 'text', text: promptNotice(listPickNote(lister, shifted.number), prompt) });
      }
      // List rows a numbered click left unchanged, compared against the tree the call started from.
      listClicks = !clickHalted && action?.before && !action.before.incomplete && !action.before.degraded && complete(observation) &&
        observation.delta?.baseline === action.before.id && documentKey(action.before.window) === documentKey(observation.window)
        ? unchangedListClicks(action.code, action.before.lines, observation.lines).map(click => ({ ...click, window: observation.window })) : [];
      const own = action && !clickHalted ? clickedSiblings(action) : [];
      let moved;
      if (!clickHalted && checked) {
        const key = swapDocumentKey(checked.window), pending = pendingClicks.get(key);
        // A save may expose a delayed move; other new input ends attribution to the earlier clicks.
        const clicks = action ? (own.length ? own : action.save ? pending : undefined) : pending;
        if (action) pendingClicks.clear();
        else pendingClicks.delete(key);
        const here = clicks?.filter(click => click.window === key) ?? [];
        if (here.length) {
          moved = here.map(click => clickMoveNote(click, checked)).find(Boolean);
          if (!moved && action && clicks !== pending) pendingClicks.set(key, here);
        }
      } else if (!clickHalted && trailingDegraded) {
        // Nothing complete to check against: the call's own clicks wait for the next complete read.
        if (action) {
          const kept = own.length ? own : action.save ? [...pendingClicks.values()].flat() : [];
          pendingClicks.clear();
          for (const click of kept) pendingClicks.set(click.window, [...pendingClicks.get(click.window) ?? [], click]);
        }
      } else if (action || observation || failed || stopped) pendingClicks.clear();
      if (failed || stopped || action?.overlap || action && (!observation || observation.invalid)) pendingSwaps.clear();
      let swapReminder;
      if (checked || observation && !observation.invalid && !trailingDegraded) {
        const read = checked ?? observation, key = swapDocumentKey(read.window), pending = pendingSwaps.get(key);
        if (pending) {
          const matches = siblingGroups(read.lines).get(pending.key);
          if (!checked || matches?.length !== 1 ||
              JSON.stringify(matches[0].children.map(node => node.key)) !== JSON.stringify(pending.order)) pendingSwaps.delete(key);
          else if (action?.save && action.before && swapDocumentKey(action.before.window) === key && !failed && !stopped && !action.overlap) {
            swapReminder = { type: 'text', text: promptNotice(`sleight: ${pending.summary}.`, prompt) };
            pendingSwaps.delete(key);
          }
        }
      }
      if (action?.clickAndTyping && !action.writeEffects?.length && !failed && !stopped && !action.overlap &&
          action.before && !action.before.incomplete && !action.before.degraded) {
        if (complete(observedInResult) && observedInResult.delta?.baseline === action.before.id &&
            documentKey(action.before.window) === documentKey(observedInResult.window)) {
          const misplaced = misplacedTextNote(action, observedInResult, typed);
          if (misplaced) out.push({ type: 'text', text: promptNotice(misplaced, prompt) });
        }
        const swap = checked && checked.delta?.baseline === action.before.id &&
          documentKey(action.before.window) === documentKey(checked.window) && swappedSiblings(action.before.lines, checked.lines);
        if (swap) {
          pendingSwaps.set(swapDocumentKey(checked.window), swap);
          out.push({ type: 'text', text: promptNotice(siblingSwapNote(swap), prompt) });
          moved = undefined; // the swap line already names the clicked item
        }
      }
      const saveLine = trackTabOrders(action, own, clickHalted ? undefined : checked, clickHalted, note, moved);
      if (saveLine) out.push({ type: 'text', text: promptNotice(saveLine, prompt) });
      else if (swapReminder) out.push(swapReminder);
      if (action?.typing && action.before && !action.writeEffects?.length) {
        const key = documentKey(action.before.window);
        if (!failed && !stopped && !action.overlap && !action.before.incomplete && observedInResult && !observedInResult.invalid &&
            !observedInResult.incomplete && !observedInResult.degraded && observedInResult.delta?.baseline === action.before.id &&
            key === documentKey(observedInResult.window)) {
          const typing = strayTypingNote(action, observedInResult, aims.get(key)) ?? focuslessTypingNote(action, observedInResult);
          if (typing) out.push({ type: 'text', text: promptNotice(typing, prompt) });
        }
        if (action.typing.lastAim !== undefined) aims.set(key, action.typing.lastAim);
      }
      // "this call acted on" only says the call ended in another window; the other stops mean input may not have run.
      const halted = failed || action?.overlap || content.some(item => item?.type === 'text' && typeof item.text === 'string' &&
        /sleight: an action in this call failed|engine's JavaScript session restarted|(?:^|\n)(?:sleight: )?the user (?:changed|switched)|(?:Input lease|Document scope|Selected window).*?(?:stopped|changed)|outcome unconfirmed/i.test(item.text));
      const settled = !halted && observedInResult && !observedInResult.invalid && !observedInResult.incomplete && !observedInResult.degraded;
      const settledKey = settled && documentKey(observedInResult.window);
      if (halted) pendingSetValues.clear();
      else if (action || settled) for (const [key, pending] of pendingSetValues) {
        // A later call that acts in that window owns its value; an alert's button does not.
        if (action?.before && documentKey(action.before.window) === key) pendingSetValues.delete(key);
        else if (key === settledKey) {
          pendingSetValues.delete(key);
          const note = pending.sets.map(set => setValueNote(set, observedInResult)).find(Boolean);
          if (note) out.push({ type: 'text', text: promptNotice(note, prompt) });
        } else if (++pending.calls > 2) pendingSetValues.delete(key);
      }
      if (action?.setValues?.length && !action.writeEffects?.length && action.before && !halted && !action.before.incomplete && !action.before.degraded) {
        const key = documentKey(action.before.window);
        if (key === settledKey) {
          const note = action.setValues.map(set => setValueNote(set, observedInResult)).find(Boolean);
          if (note) out.push({ type: 'text', text: promptNotice(note, prompt) });
        } else if (settled) pendingSetValues.set(key, { sets: action.setValues, calls: 0 });
      }
      if (action && settled && !(action.before && documentKey(action.before.window) === settledKey && action.before.root === observedInResult.root)) {
        const alert = alertNote(observedInResult);
        if (alert) out.push({ type: 'text', text: promptNotice(alert, prompt) });
      }
      // WB2: the Undo item in the call's last complete read against that window's last read before this call. A call that
      // ends in a dialog or gallery says nothing; the next one that ends in the document compares with the read before it.
      // An undo (Cmd+Z moving "Undo Style" back to "Undo Typing") gives the Redo item the title Undo had; without a Redo item,
      // a title this window already showed proves no new edit. Neither says anything.
      if (undoReceipts && action && !action.writeEffects?.length && !action.overlap && complete(observedInResult)) {
        const was = undoSeen.get(documentKey(observedInResult.window)), now = undoTitle(observedInResult.lines);
        const redo = undoTitle(observedInResult.lines, REDO_TITLE);
        const undid = was && (redo !== undefined ? redo === 'Redo' + was.title.slice(4) : was.history.has(now));
        if (was && now && now !== was.title && /^Undo /.test(now) && !undid) out.push({ type: 'text', text: promptNotice(undoNote(was.title, now), prompt) });
      }
      if (undoReceipts) for (const item of resultObservations) {
        const title = complete(item) && undoTitle(item.lines);
        if (!title) continue;
        const key = documentKey(item.window), entry = undoSeen.get(key) ?? undoSeen.set(key, { history: new Set() }).get(key);
        entry.title = title; entry.history.add(title);
      }
      if (routeSteering && action?.fieldTypings?.length && !action.writeEffects?.length && action.before && !action.overlap && complete(observedInResult) &&
          documentKey(action.before.window) === documentKey(observedInResult.window)) {
        const missed = missedFieldNote(action, observedInResult);
        if (missed) out.push({ type: 'text', text: promptNotice(missed, prompt) });
      }
      if (moved) out.push({ type: 'text', text: promptNotice(moved, prompt) });
      if (failed || observedInResult?.degraded || (action && (!observedInResult || observedInResult.invalid || action.overlap))) latest = undefined;
      // A failed batch can still return a complete observation. Keep that observation for the next
      // effect comparison, without restoring the guard's bindings or its normal success baseline.
      effectBaseline = observedInResult && !observedInResult.invalid && !observedInResult.incomplete &&
        !observedInResult.degraded && !action?.overlap ? observedInResult : undefined;
      if (compactToolbars) out = dedupeTrees(out, false, !action && !failed && !stopped, sliced, !full && !failed && !stopped);
      if ((resultTrim || firstAcquisition || compactToolbars) && !full) for (let i = 0; i < out.length; i++) {
        const item = out[i];
        if (item?.type !== 'text' || typeof item.text !== 'string') continue;
        const key = documentKey(windowFromText(item.text)), hints = hintKeys(item.text);
        const fullRead = hints.some(hint => !omissionHints.has(hint)) ? /* notice */ promptNotice(' A full read includes the omitted lines.', prompt) : '';
        let trimmed = firstAcquisition && key && !priorWindows.has(key) ? trimAcquisition(item.text, fullRead, new Set(omissionHints))
          : resultTrim ? trimSiblingRows(item.text, fullRead) : undefined;
        if (compactToolbars && !failed && !stopped) {
          const toolbar = trimToolbars(trimmed?.text ?? item.text, code ?? action?.code, action, trimmed ? '' : fullRead);
          if (toolbar) trimmed = { text: toolbar.text, hidden: new Set([...(trimmed?.hidden ?? []), ...toolbar.hidden]) };
        }
        if (!trimmed) continue;
        for (const hint of hints) omissionHints.add(hint);
        const entry = seen.get(key);
        if (entry) {
          entry.valid = new Set([...(entry.valid ?? numbered(entry.lines).map(([num]) => num))].filter(num => !trimmed.hidden.has(num)));
          entry.believed = new Map([...(entry.believed ?? numbered(entry.lines))].filter(([num]) => !trimmed.hidden.has(num)));
        }
        out[i] = { ...item, text: trimmed.text };
      }
      const hasScreenshot = content.some(item => item?.type === 'image');
      if (screenshotReads && hasScreenshot && !failed && !stopped) {
        const text = content.filter(item => item?.type === 'text').map(item => item.text).join('\n');
        let window = windowFromText(text) ?? screenshotWindow;
        if (window && !window.url && !hasFullTree(text) && window.app === screenshotWindow?.app &&
            window.title === screenshotWindow.title) window = screenshotWindow;
        // A tree names its window's ID; a header-only image does not, and then covers every window with that header.
        const root = hasFullTree(text) ? parse(text.slice(text.search(/^Window: /m)).split('\n')[1] ?? '').key : '';
        if (window) screenshotWindows.add(hintKey({ title: window.title, app: window.app, url: window.url }, root));
      }
      const screenshotKey = hintKey(observedInResult?.window, observedInResult?.root);
      if (screenshotReads && !failed && !stopped && !action && !hasScreenshot && !screenshotHints.has(screenshotKey) &&
          !screenshotWindows.has(screenshotKey) && !screenshotWindows.has(documentKey(observedInResult?.window)) && textlessDocument(observedInResult, openedFiles)) {
        screenshotHints.add(screenshotKey); textlessNoted = true;
        out.push({ type: 'text', text: promptNotice(TEXTLESS_NOTE, prompt) });
      }
      // After a failure, a stop or a user change, the next acquisition of any window is whole again.
      // Only the notices themselves: the rules shown with the engine docs also say "the user changed
      // the app", and "this call acted on" names a window an action opened.
      if (failed || content.some(item => item?.type === 'text' && typeof item.text === 'string' &&
          /an action in this call failed|JavaScript session restarted|JS restarted|sleight: the user (?:changed|switched)|(?:Input lease|Document scope|Change review)\b[^\n]*?\bstopped|Selected window changed|outcome (?:is )?unconfirmed/.test(item.text))) {
        for (const entry of seen.values()) entry.stale = true;
      }
      return trimBrowserResults(out, code);
    },
    beginAction(code) {
      const kind = actionKind(code, latest);
      if (kind?.save && latest?.window.url?.startsWith('file://')) kind.fileTime = fileTime(latest.window.url);
      // An open menu read leaves no standard-window baseline: textedit-save-4 (2026-10-17) said "saved: not
      // confirmed (no earlier read)" though the file was written, and Haiku spent four turns checking.
      // Each app's last document read, with its file's time now, can still show the file written.
      if (kind?.save && !/^standard window\b/.test(latest?.root ?? '')) {
        kind.saveBases = [...documents.values()].map(observation => ({ window: observation.window, fileTime: fileTime(observation.window.url) }));
      }
      return kind && { ...kind, code, before: latest, effectBefore: effectBaseline };
    },
    // What Claude takes these element numbers to be in this window, from what it was last shown:
    // number -> line text without its number, for the guard to check before the call's first action.
    seenLines(window, numbers, indented = false) {
      const entry = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }));
      if (!entry) return undefined;
      const believed = new Map(entry.believed ?? numbered(entry.lines));
      const out = {};
      for (const n of numbers ?? believed.keys()) if (believed.has(n)) out[n] = indented ? believed.get(n) : believed.get(n).replace(/^\t*/, '');
      return Object.keys(out).length ? out : undefined;
    },
    // number -> the whole line of its parent in that tree (null at the root), by indentation in number order, as the
    // guard's elementParents reads a fresh tree. A line without an ID moving to another parent is another element.
    seenParents(window, numbers) {
      const entry = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }));
      if (!entry) return undefined;
      const rows = [...new Map(entry.believed ?? numbered(entry.lines))].sort(([a], [b]) => a - b);
      const stack = [], parents = new Map();
      for (const [n, key] of rows) {
        const depth = /^\t*/.exec(key)[0].length;
        while (stack.length && stack.at(-1).depth >= depth) stack.pop();
        parents.set(n, stack.at(-1)?.line ?? null);
        stack.push({ depth, line: key.slice(depth) });
      }
      const out = {};
      for (const n of numbers ?? parents.keys()) if (parents.has(n)) out[n] = parents.get(n);
      return Object.keys(out).length ? out : undefined;
    },
    // Each window's last full tree, for numbersMoved to compare a later read against.
    trees() { return new Map([...seen].map(([key, entry]) => [key, entry.lines])); },
    // Whether an element number up to `upTo` may name another element in the last window read in
    // `content` than in that window's tree in `trees`: a structural difference at or below it, which an
    // insertion or deletion before it causes. Values, states and Help change between Office and
    // Calculator reads without moving anything. A run of identical lines through `upTo` is compared to
    // its end, since a row inserted anywhere in it looks the same. False for a window with no earlier tree.
    numbersMoved(trees, content, upTo) {
      const text = (Array.isArray(content) ? content : []).filter(item => item?.type === 'text' && typeof item.text === 'string')
        .map(item => item.text).join('\n');
      const at = text.lastIndexOf('Window: '), window = at >= 0 && windowFromText(text.slice(at));
      const before = window && trees.get(documentKey(window)), now = window && seen.get(documentKey(window))?.lines;
      if (!before || !now) return false;
      const keys = lines => numbered(lines).reduce((out, [num, key]) => { out[num] = structuralKey(key); return out; }, []);
      const a = keys(before), b = keys(now);
      let last = upTo;
      while ((a[last] !== undefined && a[last + 1] === a[last]) || (b[last] !== undefined && b[last + 1] === b[last])) last++;
      for (let n = 0; n <= last; n++) if (a[n] !== b[n]) return true;
      return false;
    },
    // The numbers whose line was on no other element in the tree Claude saw, so the same line
    // elsewhere later can only be that element.
    uniqueSeen(window, numbers) {
      const entry = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }));
      if (!entry) return [];
      const lines = [...new Map(entry.believed ?? numbered(entry.lines)).entries()].map(([n, line]) => [n, line.replace(/^\t*/, '')]);
      return numbers.filter(n => {
        const line = lines.find(([m]) => m === n)?.[1];
        return line !== undefined && lines.filter(([, other]) => other === line).length === 1;
      });
    },
    // The first element number in `code` that Claude can't know is current
    // for this window: { number } for a literal, { computed } for an expression.
    staleIndex(window, code) {
      const valid = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }))?.valid;
      if (!valid || typeof code !== 'string') return undefined;
      for (const [, arg] of code.matchAll(/\.(?:click|setValue|selectText|performSecondaryAction|scroll)\(\s*([^,)\s]+)/g)) {
        // Coordinates aren't element numbers, and an { id } is resolved fresh inside the call.
        if (arg.startsWith('[') || arg.startsWith('{')) continue;
        if (!/^\d+$/.test(arg)) return { computed: arg };
        if (!valid.has(Number(arg))) return { number: Number(arg) };
      }
      return undefined;
    },
    // A literal number Claude took from an older tree names the element it saw there. When that
    // element's text is on exactly one line of the current tree, the action can name it by that
    // line ({ line }), which the guard looks up fresh, instead of costing Claude a read and a turn.
    // { id: "18" } written for element 18: 2 of 3 Safari form-travel runs (race-1017), each stop a call. When the
    // tree Claude last saw has element 18 and no element whose ID or label is "18", the number is the only reading,
    // so the action names it bare and gets the number checks. Two readings, or a number it never saw, stay as written.
    // So does every { id } after an earlier action in the call, or in a loop: a click can open a picker whose day has
    // ID 18, and then Claude's tree no longer settles it. Leading zeros go out in decimal ("010" would be octal 8).
    numberIds(window, code) {
      const entry = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }));
      if (!entry || typeof code !== 'string' || /\b(?:for|while|do)\b|\.(?:forEach|map|reduce|some|every)\(/.test(maskCode(code))) return undefined;
      const believed = new Map(entry.believed ?? numbered(entry.lines));
      const lines = [...believed.values()].map(line => line.replace(/^\t*/, ''));
      // Only a top-level statement (no enclosing bracket, arrow or function, so it runs once and now) with nothing but
      // reads before it: any other call, in any spelling (app["click"](24), a helper, an IIFE), may have acted.
      const masked = maskCode(code), reads = /^(?:getAXState|getAXStateAndScreenshot|getScreenshot|getApp|getState|listApps|write)$/;
      const settled = at => {
        const before = masked.slice(0, at);
        let depth = 0;
        for (const ch of before) depth += '([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0;
        if (depth !== 0 || /=>|\bfunction\b/.test(before)) return false;
        return [...before.matchAll(/([\w$]+|[\])])\s*(?:\?\.\s*)?\(/g)].every(m => /^(?:if|await)$/.test(m[1]) ||
          (reads.test(m[1]) && before.slice(0, m.index).trimEnd().endsWith('.')));
      };
      const sent = [];
      const out = code.replace(/(\.(?:click|setValue|selectText|performSecondaryAction|scroll)\(\s*)\{\s*(?:id|"id"|'id')\s*:\s*(["'])(\d+)\2\s*\}(?=\s*[,)])/g, (whole, head, quote, digits, at) => {
        const number = Number(digits), forms = [...new Set([digits, String(number)])];
        if (!settled(at) || !believed.has(number) ||
            lines.some(line => forms.some(form => hasIdentifier(line, form) || hasLabel(line, form)))) return whole;
        sent.push({ id: digits, number, line: believed.get(number).replace(/^\t*/, '') });
        return head + number;
      });
      return sent.length ? { code: out, sent } : undefined;
    },
    // Undefined unless every stale number in the call can be named that way.
    remapStale(window, code) {
      const entry = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }));
      if (!entry?.valid || !entry.believed || typeof code !== 'string') return undefined;
      const texts = entry.lines.map(parse).filter(l => l.num !== undefined).map(l => l.key.replace(/^\t*/, ''));
      const remapped = [];
      let missing = false;
      const out = code.replace(/(\.(?:click|setValue|selectText|performSecondaryAction|scroll)\(\s*)(\d+)(?=\s*[,)])/g, (whole, head, digits) => {
        const number = Number(digits);
        if (entry.valid.has(number)) return whole;
        const believed = entry.believed.get(number)?.replace(/^\t*/, '');
        const matches = believed === undefined ? [] : texts.filter(t => t === believed || degradedButton(believed, t));
        if (matches.length !== 1) { missing = true; return whole; }
        const text = matches[0];
        if (text !== believed) {
          const id = bareButtonId(text);
          if (id === undefined || [texts, [...entry.believed.values()]].some(lines =>
            lines.filter(line => buttonHasId(line, id)).length !== 1)) { missing = true; return whole; }
        }
        remapped.push({ number, line: text });
        return head + JSON.stringify({ line: text });
      });
      return !missing && remapped.length ? { code: out, remapped } : undefined;
    },
    // Result attribution resets independently of the element history used by the guard.
    // An engine restart or js_reset also makes each window's next acquisition whole.
    reset() { latest = effectBaseline = observedInResult = undefined; documents.clear(); for (const entry of seen.values()) entry.stale = true; },
    // open_file's file and its size on disk, under its given and real paths, for the textless-document hint.
    noteOpenedFile(path, real, size) {
      for (const name of new Set([path, real])) if (typeof name === 'string') openedFiles.set(name, Number(size) || 0);
    },
    // Whether the last process() call added the textless-document note. open_file then adds a screenshot
    // in its place, so the hint switch, a spent hint and an earlier screenshot of the window apply to both.
    lastReadNoted() { return textlessNoted; },
    // The last processed result's unchanged list-row clicks, for the relay's offscreen check.
    listClicks() { return listClicks; },
    // The guard's action records from the last process() call that had them, once, for the action log.
    takeOutcomes() { const record = lastOutcomes; lastOutcomes = undefined; return record; },
    takeSaved() { const count = lastSaved; lastSaved = 0; return count; },
  };
}
