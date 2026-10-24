import { promptNotice } from './prompt-notice.mjs';
import { elementWait } from './element-wait.mjs';
import { listPickerCode } from './native-list-pick.mjs';
import { settleLoading } from './loading-settle.mjs';
import { literalElements } from './literal-elements.mjs';
import { actionOutcome, outcomeRecord } from './action-outcomes.mjs';
import { moneyFigures, moneyConflicts } from './payment-figures.mjs';
import { enginePayment, paymentAction } from './payment-gate.mjs';
import { paymentWords, refundableName } from './direct-browser/rules.mjs';
import { tabChromeRefusal, tabProbeRefusal } from './tab-probe.mjs';
import { verifyWindowIdentity } from './window-identity.mjs';
import { tabFocusRefusal } from './menu-continuation.mjs';
import { nativeArgumentError } from './native-arguments.mjs';
import { withoutTitles } from './dp1-trace.mjs';
// Header identity is a cooperative runtime observation, not an OS capability.
// Mark full trees the guard writes, which the relay compacts (compact-reads.mjs).
export const GUARD_MARK = '[sleight:guard-read]\n';
export const GUARD_OMIT_MARK = '[sleight:guard-read-omitted]\n';
export const GUARD_END = '\n[/sleight:guard-read]\n';
export const GUARD_READY = '[sleight:guard-ready]';

// The engine's window header line: `Window: "<title>", App: <name>.` windowFromText repeats it, as the
// guard runs that function's source in the engine.
export const WINDOW_HEADER = /^Window: (.*), App: (.+)\r?$/m;

export function windowFromText(text) {
  // The title is one JSON string. Safari writes a raw inch mark inside it (bestbuy.com, 2026-10-11:
  // 23.8"), which is not JSON, so take the quotes off when parsing throws. Two headers still disagree.
  const headers = [...text.matchAll(/^Window: (.*), App: (.+)\r?$/gm)];
  const windows = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const section = text.slice(header.index + header[0].length, headers[i + 1]?.index);
    const urls = [...section.matchAll(/^(?:URL: (.+)|0 [^\r\n]*?\bURL: (.*?)(?:, (?:Secondary Actions|ID|Help):.*)?)\r?$/gm)];
    if (urls.length > 1) return undefined;
    let title;
    try {
      const value = JSON.parse(header[1]);
      if (typeof value === 'string') title = value;
    } catch { /* A raw quote in the title is not a JSON string. */ }
    if (title === undefined && header[1].startsWith('"') && header[1].endsWith('"')) title = header[1].slice(1, -1);
    if (title === undefined) return undefined;
    windows.push({ title, app: header[2].trim().replace(/\.$/, ''), url: (urls[0]?.[1] ?? urls[0]?.[2])?.trim() || null });
  }
  if (!windows.length || windows.some(w => !w.app)) return undefined;
  if (windows.some(w => JSON.stringify(w) !== JSON.stringify(windows[0]))) return undefined;
  return windows[0];
}

// The window of the last tree in a result. A call that ends in a read, or whose acquisition shows one window
// and its own read another, has several trees, and windowFromText gives up on differing headers. When every
// header has a standard-window root and the apps agree, the last tree is what Claude saw most recently (all 7
// stale-window refusals in the 2026-10-18 Firefox runs). A header without a root line is a filtered write's
// echo, and a dialog, sheet or panel root has its own lease rules, so those leave the window unknown.
export function lastWindowFromText(text) {
  const whole = windowFromText(text);
  if (whole || typeof text !== 'string') return whole;
  const starts = [...text.matchAll(/^Window: /gm)].map(match => match.index);
  const sections = starts.map((at, i) => text.slice(at, starts[i + 1]));
  const windows = sections.map(section => /^0 standard window(?: |,|$)/m.test(section) ? windowFromText(section) : undefined);
  if (!windows.length || windows.some(window => !window || window.app !== windows[0].app)) return;
  return windows.at(-1);
}

// Element number -> line text without the number, for one tree.
export function elementLines(text) {
  return new Map(text.split('\n').map(line => /^(\t*)(\d+) (.*)$/.exec(line)).filter(Boolean).map(m => [Number(m[2]), m[3]]));
}

// Element number -> its parent's whole line (null at the root), from indentation. Rows that aren't elements are skipped,
// as the relay's seenParents skips them, so both sides name the same parent.
export function elementParents(text) {
  const stack = [], parents = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\t*)(\d+) (.*?)\r?$/.exec(line);
    if (!m) continue;
    while (stack.length && stack.at(-1).depth >= m[1].length) stack.pop();
    parents.set(Number(m[2]), stack.at(-1)?.line ?? null);
    stack.push({ depth: m[1].length, line: m[3] });
  }
  return parents;
}

// Parent and ancestry come from indentation, never words in a control's label.
function elementContexts(text) {
  const stack = [], contexts = new Map();
  for (const line of text.split('\n')) {
    const m = /^(\t*)(\d+) (.*)$/.exec(line);
    if (!m) { stack.length = 0; continue; }
    const depth = m[1].length;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1), bar = /^menu bar(?:$|,| (?!item\b))/.test(m[3]), menu = bar || !!parent?.menu;
    const content = !menu && !!(parent?.content || parent?.window);
    // barItem: a title directly under the menu bar, which opens its menu.
    contexts.set(Number(m[2]), { parent: parent?.line ?? 'unknown (root)', menu, content, barItem: !!parent?.bar });
    const label = m[3].split(/(?:, | )(?=(?:Value|ID|Help|Secondary Actions):)/)[0];
    stack.push({ depth, line: label, menu, bar, content, window: /^(?:standard window|sheet|dialog)(?: |,|$)/.test(m[3]) });
  }
  return contexts;
}

// Whether an element line carries exactly this AX identifier, as `ID: Seven`
// ending the line or followed by a comma. Identifiers can hold colons and
// semicolons ("Mode: scientific; unitConversion: false").
export function hasIdentifier(line, id) {
  for (let at = line.indexOf('ID: ' + id); at >= 0; at = line.indexOf('ID: ' + id, at + 1)) {
    const end = at + 4 + id.length;
    if ((at === 0 || line[at - 1] === ' ') && (end === line.length || line[end] === ',')) return true;
  }
  return false;
}

// Whether an element line is labeled this, by its description
// ("button Description: 7, ID: Seven") or its title after the lowercase role
// ("button Multiply", "toggle button Bold").
export function hasLabel(line, label) {
  const ends = at => at === line.length || line[at] === ',';
  // A menu bar item's line is its name alone ("Edit"), with no role (finder-files, 2026-10-09).
  if (line.startsWith(label) && ends(label.length)) return true;
  const described = line.indexOf('Description: ' + label);
  if (described >= 0 && ends(described + 13 + label.length)) return true;
  // The role is one or more lowercase words, so try each space in that run. States in parentheses
  // can come between the role and the title: "text field (settable) Email" (safari-form).
  const role = /^[a-z][a-z ]*/.exec(line)?.[0] ?? '';
  for (let at = role.indexOf(' '); at >= 0; at = role.indexOf(' ', at + 1)) {
    let start = at + 1;
    for (let state; (state = /^\([^()]*\) /.exec(line.slice(start)));) start += state[0].length;
    if (line.startsWith(label, start) && ends(start + label.length)) return true;
  }
  return false;
}

// A label that only a disabled element carries: which element, and the enabled elements beside it.
// "no element with label" for Finder's disabled Cut and Move Item Here cost four calls before Copy
// (finder-move-2, 2026-10-17). A role-less menu item reads "(disabled) Cut".
export function disabledLabelNote(text, label) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\t*)(\d+) (.*)$/.exec(line);
    rows.push(m ? { depth: m[1].length, number: Number(m[2]), body: m[3] } : undefined);
  }
  const disabled = body => /^(?:[a-z][a-z ]* )?\([^()]*\bdisabled\b[^()]*\)/.test(body);
  const named = body => hasLabel(body, label) || hasLabel(body.replace(/^\([^()]*\) /, ''), label);
  const hits = rows.map((row, at) => [row, at]).filter(([row]) => row && disabled(row.body) && named(row.body));
  if (hits.length !== 1) return undefined;
  const [hit, at] = hits[0], beside = [];
  const name = body => body.replace(/^(?:[a-z][a-z ]* )?(?:\([^()]*\) )*/, '')
    .split(/(?:^|, )(?:Value|ID|Help|Secondary Actions|URL):/)[0].replace(/^Description: /, '');
  for (const step of [-1, 1]) {
    for (let i = at + step; rows[i] && rows[i].depth >= hit.depth; i += step) {
      if (rows[i].depth === hit.depth && !disabled(rows[i].body) && name(rows[i].body)) beside.push({ ...rows[i], distance: Math.abs(i - at) });
    }
  }
  // The eight nearest, in tree order, each name cut to 40 characters.
  const near = [...beside].sort((a, b) => a.distance - b.distance).slice(0, 8).sort((a, b) => a.number - b.number);
  const cut = value => value.length > 40 ? value.slice(0, 37) + '...' : value;
  const shown = near.map(row => row.number + ' ' + cut(name(row.body))).join(', ');
  return /* notice */ JSON.stringify(label) + ' is element ' + hit.number + ', and it is disabled.' +
    (shown ? ' Enabled beside it: ' + shown + (beside.length > near.length ? ' and ' + (beside.length - near.length) + ' more' : '') + '.' : '') +
    ' A disabled item needs a selection or an earlier step, such as Copy before Paste or Move.';
}

// Whether two lines for one element number are the same element. A read on a busy Mac can drop an
// element's attributes and keep only its role and a name: "button Two" for "button Description: 2,
// ID: Two" (5 of 5 batched calls under load, 2026-10-09). A bare line matches a fuller one when the
// role is the same and the name is the fuller line's ID or label.
//
// The role's parenthetical state is not part of the label: after setValue, Firefox's "combo box (settable)
// Search with Google or enter address" is "combo box (settable) Description: Search with Google or enter
// address, Value: https://..." (mdn, 2026-10-18). Only the engine's state words, listed together right after
// the role, are skipped, so "link next (page 2)" is not "link next (page 3)". A line that becomes disabled is
// another element: a click on it does nothing, and Claude should see that instead of a renumbered success.
export function sameElement(was, now) {
  if (was === now) return true;
  if (typeof was !== 'string' || typeof now !== 'string') return false;
  const state = /^([a-z][a-z ]*?) \(((?:settable|selectable|selected|disabled|expanded|float|checked|focused)(?:, (?:settable|selectable|selected|disabled|expanded|float|checked|focused))*)\)(?= |$)/;
  const plain = line => line.replace(state, '$1');
  const disabled = line => /(?:^|, )disabled(?:,|$)/.test(state.exec(line)?.[2] ?? '');
  if (disabled(was) !== disabled(now)) return false;
  const [full, bare] = was.length > now.length ? [plain(was), plain(now)] : [plain(now), plain(was)];
  const role = /^[a-z][a-z ]*/.exec(bare)?.[0] ?? '';
  for (let at = role.indexOf(' '); at >= 0; at = role.indexOf(' ', at + 1)) {
    const name = bare.slice(at + 1);
    if (!name || /,|: /.test(name) || !full.startsWith(bare.slice(0, at + 1))) continue;
    if (hasIdentifier(full, name) || hasLabel(full, name)) return true;
  }
  return false;
}

// Where element `number` of the tree `before` is in the tree `after`, for a line with no ID, description or help that an
// earlier action in the call renumbered: Safari's AutoFill button under a filled name field moved the email field from 22
// to 23 and the guard stopped in 3 of 3 form-travel runs (race-1017). Only one inserted or removed block of rows may explain
// the shift: without it, every row is the same element at the same depth and in the same order as before, and the target's
// number moved by the block's size. A reorder (a sort that swaps two cards) is no such block. The target's whole line must
// also be on exactly one element in each tree, and a bare role says nothing about which element it was. Any doubt returns
// no element, so the caller stops as before.
export function samePlace(before, number, after) {
  const rows = text => String(text ?? '').split('\n').map(line => /^(\t*)(\d+) (.*?)\r?$/.exec(line)).filter(Boolean)
    .map(m => ({ depth: m[1].length, number: Number(m[2]), line: m[3] }));
  const old = rows(before), now = rows(after), at = old.findIndex(row => row.number === number);
  const line = old[at]?.line;
  if (line === undefined || /^[a-z][a-z ]*(?: \([^)]*\))*$/.test(line) || old.filter(row => row.line === line).length !== 1 ||
      now.filter(row => row.line === line).length !== 1) return [];
  // Inserted rows are in `now` (size > 0), removed rows in `old` (size < 0).
  const size = now.length - old.length, [long, short] = size >= 0 ? [now, old] : [old, now], k = Math.abs(size);
  const same = (a, b) => a.depth === b.depth && sameElement(a.line, b.line);
  let start = 0;
  while (start < short.length && same(short[start], long[start])) start++;
  if (!k || short.slice(start).some((row, i) => !same(row, long[start + k + i]))) return [];
  // The target moved with the rows after the block, and was not part of it.
  const to = at < start ? at : size > 0 ? at + k : at - k;
  if (to < 0 || (size < 0 && at < start + k && at >= start)) return [];
  const hit = now[to];
  return hit && hit.line === line && hit.number === number + (at < start ? 0 : size) ? [[hit.number, line]] : [];
}

// Both CK2 recoveries exclude payment and credential targets, including their non-root ancestors.
export function isPaymentTarget(line, parents = []) {
  const watched = /\b(?:pay|card|cc-|credit|debit|cvv|cvc|expir|exp\b|mm\/yy|iban|routing|account|ssn|social security|passw|passcode|pin|otp|secret|security code|billing|bank|secure)/i;
  return [line, ...parents.slice(1)].some(text => paymentWords(text) || watched.test(String(text ?? '')) ||
    /^(?:AXSecureTextField|secure (?:text )?field|password (?:text )?field)(?: |,|$)/i.test(String(text ?? '')));
}

// CK2 keeps the engine read and its integer mapping. Only a plain field may move after setValue.
// Compare the complete settable inventory, not just its count: a removed field plus a new one is not unchanged.
export function plainFieldRemap(before, number, after, seen, parent) {
  const rows = text => {
    const stack = [], result = [];
    for (const line of String(text ?? '').split('\n')) {
      const m = /^(\t*)(\d+) (.*)\r?$/.exec(line);
      if (!m) continue;
      while (stack.length && stack.at(-1).depth >= m[1].length) stack.pop();
      const row = { number: Number(m[2]), line: m[3], depth: m[1].length, parents: stack.map(r => r.line) };
      result.push(row); stack.push(row);
    }
    return result;
  };
  const old = rows(before), current = rows(after), target = old.find(r => r.number === number);
  const plain = /^text field \(settable\) .+/;
  if (!target || target.line !== seen || !plain.test(seen) || /\b(?:ID|Description|Help): /.test(seen) ||
      isPaymentTarget(seen, target.parents) || typeof parent !== 'string' || /^[a-z][a-z ]*(?: \([^)]*\))*$/.test(parent) ||
      target.parents.at(-1) !== parent ||
      [...old, ...current].some(r => /^(?:sheet|dialog|alert|system dialog)(?: |,|$)/.test(r.line))) return [];
  if (old.filter(r => r.line === seen).length !== 1 || old.filter(r => r.line === parent).length !== 1 ||
      current.filter(r => r.line === parent).length !== 1) return [];
  const matches = current.filter(r => r.line === seen);
  if (matches.length !== 1 || JSON.stringify(matches[0].parents) !== JSON.stringify(target.parents)) return [];
  const inventory = all => all.filter(r => /\(settable\)/.test(r.line)).map(r =>
    JSON.stringify([r.line.replace(/, Value: .*?(?=, (?:ID|Description|Help|URL|Secondary Actions): |$)/g, ''), r.parents])).sort();
  if (JSON.stringify(inventory(old)) !== JSON.stringify(inventory(current))) return [];
  return [[matches[0].number, matches[0].line]];
}

// Where element `number` of the tree `before` is in the tree `after`, for a click the engine refused because an earlier action
// in the call replaced the element: the travel form's date picker rebuilt its day buttons after the check-in click, and the
// check-out click was refused in 10 of 11 sleight form-travel runs, Safari and Firefox (race-1017). The line stays where it was
// when its whole line is on exactly one element in each tree, at the same number and depth, under the same parent and after
// the same row (the nearest row above at its depth or less). A line that moved goes by samePlace's rules. Anything else
// returns no element, and the refusal stops the call as before.
export function refusedPlace(before, number, after) {
  const rows = text => String(text ?? '').split('\n').map(line => /^(\t*)(\d+) (.*?)\r?$/.exec(line)).filter(Boolean)
    .map(m => ({ depth: m[1].length, number: Number(m[2]), line: m[3] }));
  const old = rows(before), now = rows(after), at = old.findIndex(row => row.number === number);
  const line = old[at]?.line;
  if (line === undefined || /^[a-z][a-z ]*(?: \([^)]*\))*$/.test(line) || old.filter(row => row.line === line).length !== 1 ||
      now.filter(row => row.line === line).length !== 1) return [];
  const to = now.findIndex(row => row.line === line);
  if (now[to].number !== number) return samePlace(before, number, after);
  if (now[to].depth !== old[at].depth) return [];
  // The parent (nearest row above with less depth) and the row before (nearest above at its depth or less).
  const near = (list, i, deeper) => { for (let j = i - 1; j >= 0; j--) if (deeper ? list[j].depth < list[i].depth : list[j].depth <= list[i].depth) return list[j]; };
  const same = (a, b) => (a === undefined && b === undefined) || (!!a && !!b && a.number === b.number && a.depth === b.depth && sameElement(a.line, b.line));
  return same(near(old, at, true), near(now, to, true)) && same(near(old, at, false), near(now, to, false)) ? [[number, line]] : [];
}

// Only a resolved focus outside the clicked field's subtree proves a mismatch. Focus on the settable
// field that holds the clicked element counts as inside: a click on a field's inner text node focuses
// the field itself (Firefox address bar, 3 of 9 runs, 2026-10-18). Missing rows or focus leave the
// existing misplaced-text observation to report it.
export function differentFocusTarget(text, before) {
  const focus = /^The focused UI element is (\d+) (.+)\r?$/m.exec(text ?? '');
  if (!focus) return;
  const rows = (text ?? '').split('\n').map(line => /^(\t*)(\d+) (.*)\r?$/.exec(line)).filter(Boolean)
    .map(m => ({ depth: m[1].length, number: Number(m[2]), line: m[3] }));
  const resolve = (number, line) => {
    const numbered = rows.find(row => row.number === number && sameElement(line, row.line));
    if (numbered) return numbered;
    const matches = rows.filter(row => sameElement(line, row.line));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const clicked = resolve(before.number, before.line), focused = resolve(Number(focus[1]), focus[2]);
  if (!clicked || !focused) return;
  const start = rows.indexOf(clicked);
  for (let i = start; i < rows.length; i++) {
    if (i > start && rows[i].depth <= clicked.depth) break;
    if (rows[i] === focused) return;
  }
  // The nearest field above the clicked node: its text child is the clicked node.
  const isField = line => /^(?:text field|text area|text entry area|search (?:text )?field|combo box)(?: |$)/i.test(line) || /^[a-z][a-z ]*\(settable\)/i.test(line);
  let holder;
  for (let depth = clicked.depth, i = start - 1; i >= 0 && depth > 0; i--) {
    if (rows[i].depth >= depth) continue;
    depth = rows[i].depth;
    if (isField(rows[i].line)) { holder = rows[i]; break; }
  }
  if (holder && holder === focused) return;
  // Focus on the window's root container is the engine reporting no specific focus (Firefox's address bar after a
  // background click, 3 of 3 mdn, wikipedia and size-guide runs), and typing there lands in the field on this engine.
  // It counts only for an editable click (or text inside one), when that container is the window's only child and
  // carries its title, and when focus before the click was not on a specific element. Focus on the window row itself
  // stays a stop: the guard's "keyboard focus is on the window itself" check treats that as keys with no target.
  // The root container is row 1, which that check reads as an element, so the two never overlap.
  const root = rows[0], title = root?.line.replace(/^(?:standard )?window /, '').split(', ')[0];
  const container = rows[1];
  if ((isField(clicked.line) || holder) && root?.depth === 0 && /^(?:standard )?window(?: |,|$)/.test(root.line) &&
      focused === container && container.depth === 1 && title !== '' && container.line === 'container ' + title &&
      rows.filter(row => row.depth === 1).length === 1 &&
      (before.focus === undefined || before.focus === container.number + ' ' + container.line)) return;
  return clicked.number;
}

export const documentKey = window => window && JSON.stringify(window);
export const documentLabel = window => `${JSON.stringify(window.title)} in ${window.app}${window.url ? ` (${window.url})` : ''}`;

// A menu open in front of a window: its header has the window's title and app but no URL, and the root is
// the menu ("0 menu …") or its named parent with an unnamed menu below ("0 Format, Secondary Actions:
// Cancel, Pick" then "\t1 menu").
// The selected item under the menu bar, as its number and its title.
export function selectedMenuEntry(text) {
  if (typeof text !== 'string' || /^\d+ menu(?: |$)(?!bar\b)/m.test(text)) return;
  let bar;
  for (const line of text.split('\n')) {
    const item = /^(\t*)(\d+) (.*)$/.exec(line);
    if (!item) { bar = undefined; continue; }
    if (bar !== undefined && item[1].length <= bar) bar = undefined;
    if (/^menu bar(?: |$)/.test(item[3]) && !/^menu bar item\b/.test(item[3])) bar = item[1].length;
    else if (bar !== undefined && item[1].length === bar + 1 && /\([^)]*\bselected\b[^)]*\)/.test(item[3])) {
      return { number: item[2], title: item[3].replace(/^menu bar item /, '').replace(/\([^)]*\)\s*/g, '').replace(/,.*$/, '') };
    }
  }
}
// A menu-bar title marked selected and no menu in the tree: the menu is in tracking and takes every key. Word's
// Table menu stayed so while 13 and 8 calls typed into it (word-edit-1, 22-03-44 and 23-58-39, 2026-10-17).
function trappingMenu(text) {
  if (typeof text !== 'string' || /^\t*\d+ menu(?:$|,| (?!bar\b))/m.test(text)) return;
  return selectedMenuEntry(text);
}
// A menu item with a menu right below it heads a submenu: its title and its first three enabled items. Clicking
// Word's Table > Insert alone left the menu-bar title selected and typing reached nothing (word-edit-1, 2026-10-18).
export function submenuHeader(text, number) {
  const rows = String(text ?? '').split('\n').map(line => /^(\t*)(\d+) (.*)$/.exec(line))
    .map(m => m ? { depth: m[1].length, number: Number(m[2]), body: m[3] } : undefined);
  const at = rows.findIndex(row => row?.number === number), row = rows[at], menu = body => /^menu(?:$|,| (?!bar\b))/.test(body ?? '');
  if (!row || rows[at + 1]?.depth !== row.depth + 1 || !menu(rows[at + 1].body)) return;
  let parent;
  for (let i = at - 1; rows[i] && !parent; i--) if (rows[i].depth < row.depth) parent = rows[i];
  if (!menu(parent?.body)) return;
  const name = body => body.replace(/^(?:[a-z][a-z ]* )?(?:\([^()]*\) )*/, '').split(/(?:^|, )(?:Value|ID|Help|Secondary Actions|Description):/)[0].slice(0, 40);
  const items = [];
  for (let i = at + 2; rows[i] && rows[i].depth > row.depth + 1 && items.length < 3; i++) {
    if (rows[i].depth === row.depth + 2 && !/^(?:[a-z][a-z ]* )?\([^()]*\bdisabled\b/.test(rows[i].body) && name(rows[i].body)) items.push(rows[i].number + ' ' + name(rows[i].body));
  }
  return { title: name(row.body), items };
}
// Whether focus is on the window itself ('window'), another root ('root') or an element inside ('element').
function focusOn(text) {
  const focus = /^The focused UI element is (\d+) /m.exec(text ?? ''), root = /^(\d+) (.*)$/m.exec(text ?? '');
  if (!focus || !root) return;
  return focus[1] !== root[1] ? 'element' : /^(?:standard )?window(?: |,|$)/.test(root[2]) ? 'window' : 'root';
}

export function menuRoot(text) {
  const lines = String(text ?? '').split('\n'), at = lines.findIndex(line => /^0 /.test(line));
  if (at < 0) return false;
  return /^0 menu(?: (?!bar\b)|,|$)/.test(lines[at]) ||
    (/(?:^0 |, )Secondary Actions: (?:[^,]*, )*Cancel(?:,|$)/.test(lines[at]) && /^\t1 menu(?: |,|$)/.test(lines[at + 1] ?? ''));
}

// Title always; URL only when the expected window named one.
export function windowMatches(expected, observed) {
  if (!expected || !observed || expected.title !== observed.title) return false;
  return !expected.url || expected.url === observed.url;
}

export function isCancelAction(name, args, text = '') {
  if (name === 'pressKey') return /^(?:Escape|esc)$/i.test(args[0]);
  if (name !== 'click' || !Number.isInteger(Number(args[0]))) return false;
  return text.split('\n').some(line => {
    const button = /^\s*(\d+) button(?: \(.*?\))? Cancel(?:,|$)/.exec(line);
    return button && Number(button[1]) === Number(args[0]);
  });
}

// Only a standalone acquisition or inventory read can cross a closed gate.
// No comments, arbitrary acquisition arguments or extra statements.
// An acquisition followed only by printing its own handle (`let app = await cua.getApp("X"); app`,
// or console.log(app)) is still just a read: 42 of 101 guard reads after a call followed one of
// these, though the engine's output already had the window header (2026-10-10 study).
export function withoutEcho(code = '') {
  const text = String(code).trim();
  const m = /^((?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\([^;]*\))\s*;\s*(?:console\.log\(\s*([A-Za-z_$][\w$]*)\s*\)|nodeRepl\.write\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*;?$/.exec(text);
  return m && [m[3], m[4], m[5]].includes(m[2]) ? m[1] : text;
}

export function isDocumentRead(code = '') {
  code = withoutEcho(code);
  return /^(?:(?:(?:let|const|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*)?await\s+cua\.getApp\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{\s*(?:windowId|"windowId")\s*:\s*\d+\s*\})\s*\)\s*;?$/.test(code.trim()) ||
    /^await\s+cua\.(?:getState|listApps|listWindows)\(\s*\)\s*;?$/.test(code.trim());
}

// Marks the window inventory an acquisition writes, which the relay keeps and strips.
export const WINDOWS_MARK = '[sleight:windows]';
const ACQUISITION = /^(?:(?:let|const|var)\s+)?(?:[A-Za-z_$][\w$]*\s*=\s*)?await\s+cua\.getApp\([^;]*\)\s*;?$/;

export function readCode(code, options = {}) {
  // Every acquired handle, including const bindings, must receive the proxy
  // before it escapes. A bare acquisition also restores the conventional handle.
  const read = /^await\s+cua\.getApp\(/.test(code.trim()) ? 'globalThis.app = ' + code.trim() : code;
  // Before an acquisition, the windows of every app as the inventory lists them (about 11 ms), so
  // the next call's guard can reuse this read if they haven't changed. It goes first: listApps after
  // getApp drops the app from the result's metadata, where the relay finds its bundle ID.
  const inventory = ACQUISITION.test(withoutEcho(code)) ? `try { nodeRepl.write(${JSON.stringify(WINDOWS_MARK)} + JSON.stringify((await cua.listApps({ emit: false })).filter(a => a.windows?.length).map(a => ({ id: a.id, windows: a.windows }))) + '\\n'); } catch {}\n` : '';
  return guardSetup(undefined, options) + '\n' + inventory + read;
}

// Advisory only: all of this runs in the same mutable JS realm as Claude's code.
async function closedLastWindow(state, record, stopMessage) {
  const active = state.activeApp, version = state.actionVersion;
  const previous = state.previous.get(active), action = state.lastAction;
  const identity = state.expected?.nativeIdentity;
  const pid = identity?.pid ?? state.expected?.pid, processStart = identity?.processStart;
  let native = {};
  const decide = (reason, skip = false) => {
    try { record({ decision: skip ? 'skipped-read' : 'kept-read', reason, ...native,
      ...(skip ? { match: 'native-ax+leased-pid' } : {}) }); } catch {}
    return skip;
  };
  if (action?.kind !== 'key' || !/^(?:super|cmd|command|meta)\+(?:shift\+w|w|q)$/i.test(action.value)) return decide('not a close shortcut');
  if (!previous?.done || state.failures?.length || previous.key !== action.value) return decide('action not completed');
  let blocked = false;
  const block = reason => {
    blocked = true;
    try { record({ decision: 'blocked-read', reason, ...native }); } catch {}
    throw new Error(stopMessage(reason));
  };
  if (!state.guardStopMark) return decide('no mark');
  if (typeof setTimeout !== 'function' || typeof clearTimeout !== 'function') return decide('timers unavailable');
  if (!Number.isSafeInteger(pid) || pid <= 0) return decide('leased pid missing');
  if (!Number.isFinite(processStart)) return decide('leased process start missing');
  if (!state.expected?.appId) return decide('leased bundle id missing');
  const header = state.callHeaders.get(active);
  if (!header?.app) return decide('app header missing');
  if (typeof header.appId === 'string' && header.appId) {
    if (header.appId !== state.expected.appId) return block('app header mismatch');
  } else if (header.app !== state.expected.app) return decide('app header name differs');
  if (!state.closeRead?.path) return decide('native observer unavailable');
  let timer, pollTimer, wakePoll, ended = false, pendingReason = 'timeout';
  const poll = () => new Promise(resolve => {
    wakePoll = resolve;
    pollTimer = setTimeout(() => { pollTimer = undefined; wakePoll = undefined; resolve(); }, 25);
  });
  try {
    const timeout = {}, deadline = Date.now() + 1500, path = state.closeRead.path;
    const changed = () => state.activeApp !== active || state.actionVersion !== version || state.lastAction !== action;
    const sample = async () => {
      const fs = await import('node:fs/promises');
      while (!ended && Date.now() < deadline) {
        if (changed()) return { reason: 'action changed' };
        let data;
        try {
          data = JSON.parse(await fs.readFile(path, 'utf8'));
          if (!Array.isArray(data.observations)) throw Error('Missing native samples');
        } catch {
          if (ended || Date.now() >= deadline) break;
          pendingReason = 'error';
          await poll();
          continue;
        }
        if (ended || Date.now() >= deadline) break;
        if (changed()) return { reason: 'action changed' };
        // A sample that began before pressKey completed cannot prove its result.
        const observations = data.observations.filter(o => typeof o?.start === 'number' && o.start > previous.done);
        const newest = observations.at(-1), prior = observations.at(-2);
        if (newest) {
          const { status, unknownReason, appId, pid: actualPid, processStart: actualStart, running, windowCount, modalCount, closedWindowPresent } = newest;
          native = { status, pid: actualPid, processStart: actualStart, running, windowCount, modalCount, closedWindowPresent,
            ...(status === 'unknown' ? { unknownReason } : {}), keyDone: previous.done, sampleStart: newest.start, sampleEnd: newest.end };
          // A dead leased process is a completed close. A replacement process or
          // bundle is a conflict, including when the helper found it during AX.
          if ((Number.isSafeInteger(actualPid) && actualPid > 0 && actualPid !== pid) ||
              (Number.isFinite(actualStart) && actualStart !== processStart) ||
              (typeof appId === 'string' && appId && appId !== state.expected.appId)) return { blocked: true, reason: 'process mismatch' };
          const identityMatches = actualPid === pid && actualStart === processStart && appId === state.expected.appId;
          const fresh = (o = newest) => Number.isFinite(o?.end) && o.end >= o.start && o.end <= Date.now() && Date.now() - o.end <= 200;
          const consecutive = prior && newest.start > prior.start && Number.isFinite(prior.end) &&
            prior.end >= prior.start && newest.end > prior.end && newest.end - prior.end <= 200;
          const exited = o => o?.status === 'ok' && o.pid === pid && o.processStart === processStart &&
            o.appId === state.expected.appId && o.running === false && fresh(o);
          const modalOnTarget = o => o?.status === 'ok' && o.pid === pid && o.processStart === processStart &&
            o.appId === state.expected.appId && o.running === true && Number.isSafeInteger(o.windowCount) && o.windowCount > 0 &&
            o.closedWindowPresent === true && Number.isSafeInteger(o.modalCount) && o.modalCount > 0;
          if (status !== 'ok') pendingReason = 'native unavailable';
          else if (!identityMatches || typeof running !== 'boolean') pendingReason = 'native identity missing';
          else if (running === false) {
            if (consecutive && exited(newest) && exited(prior)) return { reason: 'process exited', skip: true };
            pendingReason = fresh() ? 'timeout' : 'stale native sample';
          } else if (!Number.isSafeInteger(windowCount) || windowCount < 0 || !Number.isSafeInteger(modalCount) || modalCount < 0) pendingReason = 'native counts missing';
          else if (windowCount > 0 && closedWindowPresent === false) return { reason: 'windows non-empty' };
          else if (modalCount > 0) {
            // The newest observation must be fresh; its predecessor must have
            // ended within 200 ms of it, even when the helper itself takes time.
            if (consecutive && fresh() && modalOnTarget(newest) && modalOnTarget(prior)) return { reason: 'modal child' };
            pendingReason = 'modal child';
          } else if (windowCount === 0) {
            // Check age at the skip itself. Stale or incomplete observations keep
            // polling so a transient helper failure cannot reopen a closing app.
            if (fresh()) return { reason: 'no windows', skip: true };
            pendingReason = 'stale native sample';
          } else pendingReason = 'timeout';
        }
        await poll();
      }
      return timeout;
    };
    const observed = await Promise.race([sample(), new Promise(resolve => { timer = setTimeout(() => resolve(timeout), 1500); })]);
    if (changed()) return decide('action changed');
    if (observed === timeout) return decide(pendingReason);
    if (observed.blocked) return block(observed.reason);
    return decide(observed.reason, observed.skip);
  } catch (error) { if (blocked) throw error; return decide('error'); }
  finally { ended = true; clearTimeout(timer); clearTimeout(pollTimer); wakePoll?.(); }
}

export function guardedCode(code, window, reason = /* notice */ 'Document scope stopped this action: window or URL changed. Read the window and ask the user with document_scope.', lease, options = {}) {
  // The lease needs a full header after the call. A read Claude made after its
  // last action already wrote one, so the guard reads again only without it.
  const { reuseSetup, acknowledge, prompt, outcomes, completeness, kernel, dp1 = false, ...checks } = options;
  const ck = ((checks.ck1 ?? process.env.SLEIGHT_CK1 !== '0') ? 1 : 0) |
    ((checks.ck2 ?? process.env.SLEIGHT_CK2 !== '0') ? 2 : 0);
  delete checks.ck1; delete checks.ck2;
  // On is the runtime default. The two off bits share six bytes in warm calls, within the 2,500-byte setup budget.
  if (ck !== 3) checks.c = ck;
  const quoted = text => JSON.stringify(promptNotice(text, prompt));
  // The tail first waits (guard.settle, which resolves to undefined) for an action or pick the code left unawaited, as its
  // last statement may be, so the call's read can't run beside it and return the window from before it (CC6 review).
  // An empty literal order is left out (the guard reads it as []), which keeps the per-call setup under 2,500 bytes.
  const literalOrder = checks.literalOrder ?? literalElements(code);
  // Keep the pre-DP1 tail comment only on the off path for byte parity. The DP1
  // tail omits it to keep compact calls within the existing byte budget.
  return guardSetup({ window, reason, lease, ...checks, ...(dp1 ? { dp1: true } : {}), literalOrder: literalOrder.length ? literalOrder : undefined }, { reuseSetup, acknowledge, prompt, outcomes, completeness, kernel, dp1 }) +
    (options.browserCandidate ? '\nglobalThis.__sleightDocumentGuard.activeApp = undefined;' : '') + /* generated code */ `\n${code}
{
  const guard = globalThis.__sleightDocumentGuard, last = await guard.settle?.() ?? (guard.activeApp && guard.reads.get(guard.activeApp));
${dp1 ? '' : "  // The call finished, so any failed action was one it didn't await or caught itself.\n"}  if (guard.failures?.length) nodeRepl.write('sleight: an action in this call failed' + ${quoted(/* lean notice */ ', and the call went on without it: ')} + guard.failures.join('; ') + '. Read the window, then redo it with await.\\n');
  // A caught getApp failure sent no input, so it isn't a failed action; a later getApp that worked cleared it.
  if (guard.getAppFailures?.length) {
    const caught = guard.getAppFailures.join('; ');
    nodeRepl.write('sleight: ' + caught + (caught.endsWith('.') ? '' : '.') + '\\n');
  }
  if (guard.activeApp && !last?.emitted && !last?.omit) {
    const split = !guard.acted && guard.activeApp === guard.startApp && guard.prior?.split;
    const text = last?.text ?? (split ? guard.prior.text : await guard.readAfter(guard.activeApp${dp1 ? ', true' : ''}));
    guard.noteFocus?.(text);
    nodeRepl.write(${JSON.stringify(GUARD_MARK)} + text + ${JSON.stringify(GUARD_END)});
  }
  if (guard.resultMark && guard.typed.length) nodeRepl.write(guard.resultMark + JSON.stringify({ typed: guard.typed }) + '\\n');${checks.outcomeMark ? '\n  ' + 'guard.flushOutcomes?.();' : ''}
}`;
}

// outcomes: the session records action outcomes (SLEIGHT_OUTCOMES or SLEIGHT_ACTION_LOG); without it the guard is unchanged.
function guardSetup(update, { reuseSetup = false, acknowledge = false, prompt, outcomes = false, completeness = false, kernel, dp1 = process.env.SLEIGHT_DP1 !== '0' } = {}) {
  const O = outcomes;
  // Notice text the guard throws or writes, in its SLEIGHT_PROMPT wording.
  const quoted = text => JSON.stringify(promptNotice(text, prompt));
  // Keep executable code in the runtime, never observations. The relay selects the small form
  // only after a completed installation, and a missing setup stops before the caller's code.
  const install = reuseSetup ? '' : /* generated code */ `globalThis.__sleightDocumentGuardSetup = update => {
    const parse = ${windowFromText.toString()};
    const isCancel = ${isCancelAction.toString()};
    const argumentError = ${nativeArgumentError.toString()};
    ${kernel === undefined ? `const state = globalThis.__sleightDocumentGuard ||= {
      getApp: typeof cua.getApp === 'function' ? cua.getApp.bind(cua) : undefined, proxies: new WeakSet(), wrapped: new WeakMap()
    };` : /* A host whose calls reach more than one kernel (Codex's sandbox states): state from another epoch is stale, so
      start clean, keeping the raw getApp rather than binding a wrapper an earlier setup installed. */ `const __sleightGuardKernel = ${Number(kernel)};
    const prior = globalThis.__sleightDocumentGuard;
    const state = prior && prior.kernel === __sleightGuardKernel ? prior : (globalThis.__sleightDocumentGuard = { kernel: __sleightGuardKernel,
      getApp: prior?.getApp ?? (typeof cua.getApp === 'function' ? cua.getApp.bind(cua) : undefined), proxies: new WeakSet(), wrapped: new WeakMap() });`}
    if (update) {
      state.guarded = true; state.expected = update.window; state.reason = update.reason;
      state.lease = update.lease;
      state.fileOnly = !!update.fileOnly; state.cancelOnly = !!update.cancelOnly;
      state.adoptUrl = !!update.adoptUrl;
    }
    state.nativeDenied = update?.nativeDenied;
    // The payment gate's setting and the relay's copy of the user's message (payment-gate.mjs); without it the gate is off.
    state.payment = update?.payment;
    state.timing = !!update?.timing;
    state.handBindingMark = update?.handBindingMark;
    state.careful = !!update?.careful;
    state.firstOff = !!update?.firstOff && !!update?.focused && !state.careful && !state.fileOnly && !state.cancelOnly;
    state.quietEdits = !!update?.quietEdits && !state.careful;
    state.bind = !!update?.bind && !state.careful && !state.fileOnly && !state.cancelOnly;
    state.ck1 = !!((update?.c ?? 3) & 1);
    state.ck2 = !!((update?.c ?? 3) & 2);
    state.tabProbe = !state.fileOnly && !state.cancelOnly ? update?.tabProbe : undefined;
    state.tabTarget = state.tabProbe?.target; state.tabStep = state.tabProbe?.mode === 'new-tab' ? 0 : 1; state.tabSerial = 0;
    // The relay's native observations after a key press (light-return.mjs), for the light check below.
    state.light = update?.lightReturn?.path && !state.careful && !state.fileOnly && !state.cancelOnly ? { ...update.lightReturn } : undefined;
    state.binding = undefined;
    state.boundNumbers = new WeakMap();
    // The previous call's read, when the relay judged it reusable for this call's first action.
    state.prior = update?.prior;
    // The previous call's final tree of this window, for the menu-trap check when the first key skips its read.
    state.lastTree = update?.lastTree;
    // The action names in the call's code, in order, so a click knows whether more follow it.
    state.actions = update?.actions;
    // Whether this call has acted, and the handle it started on. A call that took no action after the
    // relay split off its acquisition takes that read as its header instead of reading again: 53
    // such reads cost 27 s across the benchmark runs of 2026-10-09.
    state.acted = false; state.startApp = state.activeApp;
    state.actionVersion ??= 0;
    state.actionIndex = 0; state.completedActions = 0; state.ran = []; state.unknown = []; state.lastAction = null; state.guardStopMark = update?.guardStopMark;
    ${dp1 ? 'state.dp1 = !!update?.dp1; state.closeRead = update?.closeRead;\n    ' : ''}state.inputSent = false;
    // This call's actions and picks still running, for the read that ends the call.
    state.inflight = new Set();
    const track = promise => { const done = () => state.inflight.delete(promise); state.inflight.add(promise); promise.then(done, done); return promise; };
    // Until none is left: an unawaited chain (click(1).then(() => app.click(2))) starts its next action as one settles.
    state.settle = async () => { while (state.inflight.size) await Promise.allSettled([...state.inflight]); };
    // Text this call typed, pasted or set, so a window it named (a saved or opened file) is its own.
    state.typed = [];
    state.resultMark = update?.resultMark;
    // What Claude was last shown for the numbers this call acts on (number -> line).
    state.seenLines = update?.seenLines;
    // The parent line Claude saw for each of those numbers (null at the root), from the same tree.
    state.seenParents = update?.seenParents;
    // Numbers written as literals in this call's code. Any other number was computed, usually from a
    // read the code made itself, and refers to that read (codeReads: handle -> its latest element lines).
    // Without the list (a caller other than the relay), every number counts as a literal, as before.
    state.literals = update?.literals ? new Set(update.literals) : undefined;
    state.pendingLiterals = update?.literalOrder ?? [];
    // Batch recovery needs the caller's observed lines. A direct caller without
    // them keeps the positional checks against this call's first capture.
    state.numberBatch = state.seenLines !== undefined && new Set(state.pendingLiterals).size > 1;
    state.literalBaselines = new WeakMap();
    state.loadingBaselines = new WeakMap();
    const settle = ${settleLoading.toString()};
    // At most 3 s of settling per call, however many actions start a load.
    state.settleLeft = 3000;
    state.settleRead = async (raw, text) => {
      const before = state.loadingBaselines.get(raw);
      state.loadingBaselines.delete(raw);
      if (before === undefined) return text;
      const start = clock();
      try { return await settle(() => raw.getAXState({ disableDiffing: true, emit: false }), before, text, parse, clock, state.settleLeft); }
      finally { state.settleLeft -= clock() - start; }
    };
    state.codeReads = new WeakMap();
    // Literal numbers whose line was unique in the tree Claude saw (the relay's view of it).
    state.uniqueSeen = new Set(update?.uniqueSeen ?? []);
    const clock = () => globalThis.performance?.now() ?? Date.now();
    const timedRead = async (raw, phase) => {
      const start = clock();
      let text;
      ${O ? `try {
        text = await state.settleRead(raw, await raw.getAXState({ disableDiffing: true, emit: false }));
        if (phase !== 'wait') state.noteRead(raw, text, !['list', 'after-refusal'].includes(phase));
        return text;
      } finally {` : `try { return text = await state.settleRead(raw, await raw.getAXState({ disableDiffing: true, emit: false })); }
      finally {`}
        if (state.timing) nodeRepl.write('[sleight:guard-timing]' + JSON.stringify({ phase,
          ms: clock() - start, chars: typeof text === 'string' ? text.length : 0, failed: text === undefined }) + '\\n');
      }
    };
    ${dp1 ? `const closedLast = ${closedLastWindow.toString()}, withoutTitles = ${withoutTitles.toString()};
    const recordDP1 = event => nodeRepl.write('[sleight:dp1]' + JSON.stringify(withoutTitles(event)) + '\\n');
    const closeStop = reason => ${quoted(/* lean notice */ 'sleight stopped the read after Close: ')} + reason + ${quoted(/* lean notice */ '. Native metadata could not confirm a window. No engine read was sent.')};
    const closeDecision = record => state.lastAction
      ? state.lastAction.closeReadDecision ??= closedLast(state, record, closeStop)
      : closedLast(state, record, closeStop);
    state.readAfter = async (proxy, tail) => tail && await closeDecision(recordDP1)
      ? state.guardStopMark + ':closed'
      : timedRead(state.raws.get(proxy), 'after-call');
    // A caller's final observation can satisfy the tail or throw before it runs.
    // Confirm the close here too. Stop instead of inventing a screenshot or state.
    state.beforeRead = async proxy => {
      if (!state.dp1 || proxy !== state.activeApp || state.lastAction?.kind !== 'key' ||
          !/^(?:super|cmd|command|meta)\\+(?:shift\\+w|w|q)$/i.test(state.lastAction.value)) return;
      if (await closeDecision(event => recordDP1({ ...event, source: 'caller-read' }))) {
        nodeRepl.write(state.guardStopMark + ':closed-read\\n');
        throw new Error('[sleight:closed-read]');
      }
    };` : "state.readAfter = proxy => timedRead(state.raws.get(proxy), 'after-call');"}
    state.raws ||= new WeakMap();
    // Windows whose bound capture lost an element, by app and URL or title, to the clean actions left before
    // they bind again: each reads before a numbered or named action until STALE_PASSES of those pass (see the
    // refusal below). The refused read is bounded by REFUSAL_READ_MS.
    if (!(state.staleCaptures instanceof Map)) state.staleCaptures = new Map();
    const STALE_PASSES = 3, REFUSAL_READ_MS = 5000;
    const captureKey = header => header ? JSON.stringify([header.app, header.url ?? header.title]) : undefined;
    // Full reads taken in this call since the handle's last action. A new call
    // always reads again, because the user may have changed the window between.
    state.reads = new WeakMap();
    // Each handle's latest window header in this call. It survives actions, so a later key, text
    // or coordinate action can go ahead on it without a read.
    state.callHeaders = new WeakMap();
    // Each handle's previous action in this call, which decides whether the next may skip its read.
    state.previous = new WeakMap();
    const hasModal = text => /^\\s*\\d+ (?:sheet|dialog)\\b/m.test(text ?? '');
    const clickOpenedModal = (proxy, text) => {
      const before = state.previous.get(proxy);
      if (!before) return false;
      const current = parse(text);
      if (before.observed) return !!before.opened && !!current && hasModal(text) &&
        ['title', 'app', 'url'].every(key => current[key] === before.opened[key]);
      // Only the first tree after the click can establish its sheet. Later reads may retain
      // that same identity, but cannot attribute a newly appearing sheet to an old click.
      before.observed = true;
      if (before.name === 'click' && before.modal === false && hasModal(text)) before.opened = current;
      return !!before.opened;
    };
    state.failures = []; state.getAppFailures = [];
    // Element lines at this call's first action, which Claude's numbers refer to, and the tree they came from.
    state.callElements = new WeakMap(); state.callTrees = new WeakMap();
    const elements = ${elementLines.toString()};
    const contexts = ${elementContexts.toString()};
    const parentsOf = ${elementParents.toString()};
    const hasIdentifier = ${hasIdentifier.toString()};
    const hasLabel = ${hasLabel.toString()};
    const disabledLabelNote = ${disabledLabelNote.toString()};
    const sameElement = ${sameElement.toString()};
    const samePlace = ${samePlace.toString()};
    const isPaymentTarget = ${isPaymentTarget.toString()};
    const plainFieldRemap = ${plainFieldRemap.toString()};
    const refusedPlace = ${refusedPlace.toString()};
    const differentFocusTarget = ${differentFocusTarget.toString()};
    const selectedMenuEntry = ${selectedMenuEntry.toString()};
    const trappingMenu = ${trappingMenu.toString()};
    const submenuHeader = ${submenuHeader.toString()};
    const focusOn = ${focusOn.toString()};
${O ? `    // What each action did (action-outcomes.mjs), for SLEIGHT_OUTCOMES and the action log: the first read of a handle
    // after a run of its actions settles them, and the records go out under the relay's mark for this call.
    const actionOutcome = ${actionOutcome.toString()};
    state.outcomeMark = update?.outcomeMark;
    state.outcomes = []; state.outcomeDropped = 0; state.outcomePending = new WeakMap();
    // Only the engine input promise, excluding this guard's reads, checks and approval cards.
    state.runOutcome = async (attempt, run) => {
      if (!state.outcomeMark) return run();
      const start = clock();
      try { return await run(); }
      finally { if (attempt.rec) attempt.rec.ms = (attempt.rec.ms ?? 0) + Math.max(0, clock() - start); }
    };
    // settled: the engine waited for the UI before this read. A read that didn't can't show "no visible change".
    state.noteRead = (raw, text, settled = true) => {
      const pending = state.outcomeMark ? state.outcomePending.get(raw) : undefined;
      if (!pending || typeof text !== 'string' || !parse(text)) return;
      state.outcomePending.delete(raw);
      const last = pending.recs[pending.recs.length - 1], facts = actionOutcome(pending.recs, pending.before, text).facts;
      last.f = !settled && facts?.length === 1 && facts[0].o === 'none' ? undefined : facts;
      for (const rec of pending.recs) if (rec !== last) rec.g = true;
      for (const rec of pending.recs) state.outcomePart(rec);
    };
    // Typed and set text shows only as its length, and a single printable key not at all.
    state.outcomeRec = (name, asked, args, text, before) => {
      const rec = { a: name }, first = args[0];
      if (typeof asked === 'string' && !['pressKey', 'typeText', 'paste'].includes(name)) rec.l = asked.slice(0, 40);
      else if (asked && typeof asked === 'object' && !Array.isArray(asked)) rec.l = String(asked.label ?? asked.id ?? asked.line ?? '').slice(0, 40);
      if (typeof first === 'number') rec.n = first;
      if (name === 'pressKey' && typeof first === 'string' && (/^(?:return|enter|escape|esc|tab|space|backspace|delete|forwarddelete|left|right|up|down|home|end|pageup|pagedown|f\\d{1,2})$/i.test(first) ||
        /(?:^|\\+)(?:super|cmd|command|ctrl|control)\\+/i.test(first))) rec.k = first;
      const typed = name === 'setValue' ? args[1] : ['typeText', 'paste'].includes(name) ? first : undefined;
      if (typeof typed === 'string') { rec.c = typed.length; if (name === 'setValue') rec.want = typed; }
      if (rec.n !== undefined) rec.body = elements(text ?? '').get(rec.n);
      else if (['typeText', 'paste'].includes(name)) {
        const focus = /^The focused UI element is (\\d+) (.*?)\\r?$/m.exec(text ?? '');
        if (focus) { rec.focus = Number(focus[1]); rec.body = focus[2]; }
        else if (before?.editable && typeof before.number === 'number') { rec.focus = before.number; rec.body = before.line; }
      }
      return rec;
    };
    state.keepOutcome = (raw, rec, text) => {
      if (!state.outcomeMark || !rec) return;
      const pending = state.outcomePending.get(raw);
      if (pending) pending.recs.push(rec); else state.outcomePending.set(raw, { before: text, recs: [rec] });
      state.outcomeAdd(rec);
      // Dropped actions only update the count; flushOutcomes sends the cap summary once.
      if (state.outcomes.includes(rec)) state.outcomePart(rec);
    };
    // At most 30 records a call; the rest are counted, so the log can say how many it lacks.
    state.outcomeAdd = rec => {
      if (state.outcomes.includes(rec)) return;
      if (state.outcomes.length < 30) state.outcomes.push(rec); else state.outcomeDropped++;
    };
    // A guard stop's message names elements and titles, so the record carries only its kind.
    state.refusalOf = message => /: app changed\\./.test(message) ? 'app changed'
      : / Observed \\{|window(?: or URL)? changed/.test(message) ? 'window changed'
      : /^Input lease/.test(message) ? 'input lease' : /^Document scope/.test(message) ? 'document scope' : /^Change review/.test(message) ? 'change review'
      : /changed since|changed what element/.test(message) ? 'element changed' : /no element with|elements with/.test(message) ? 'element not found'
      : /names no element/.test(message) ? 'bad locator' : /opens a submenu/.test(message) ? 'submenu' : /its menu takes the keys/.test(message) ? 'menu open'
      : /focus/.test(message) ? 'no focus target' : /close button/.test(message) ? 'close button' : /^Native access/.test(message) ? 'native access' : 'stopped';
    // A record as it leaves the engine: no set value, element line or focus number.
    const outcomeOut = ${outcomeRecord.toString()};
    const outcomeExtra = () => ({ ...(state.actions ? { planned: state.actions.length } : {}), ...(state.expected?.app ? { app: state.expected.app } : {}),
      ...(state.outcomeDropped ? { dropped: state.outcomeDropped } : {}) });
    // Each record goes out as it changes, so a throw in Claude's own code after an action can't lose it. The call's
    // code is spliced in as text whose declarations must stay top level, so a try/finally around it isn't possible.
    state.outcomePart = rec => {
      const part = state.outcomeMark ? state.outcomes.indexOf(rec) : -1;
      if (part >= 0) nodeRepl.write(state.outcomeMark + JSON.stringify({ part, rec: outcomeOut(rec), ...outcomeExtra() }) + '\\n');
    };
    state.flushOutcomes = () => {
      if (!state.outcomeMark || !state.outcomes.length) return;
      nodeRepl.write(state.outcomeMark + JSON.stringify({ outcomes: state.outcomes.map(outcomeOut), ...outcomeExtra() }) + '\\n');
    };
` : ''}    // Windows (app and URL or title) whose focus was on an element inside them in a read this session: window-root
    // focus right after opening a file is normal, but after the document had focus it means keys reach nothing.
    state.docFocus ||= new Set();
    state.noteFocus = text => { if (focusOn(text) === 'element' && captureKey(parse(text))) state.docFocus.add(captureKey(parse(text))); };
    state.noteFocus(state.prior?.text);
    const wait = ${elementWait.toString()};
    const pickList = ${listPickerCode(completeness)};
    const moneyFigures = ${moneyFigures.toString()};
    const moneyConflicts = ${moneyConflicts.toString()};
    const paymentWords = ${paymentWords.toString()};
    const refundableName = ${refundableName.toString()};
    const paymentAction = ${paymentAction.toString()};
    const enginePayment = ${enginePayment.toString()};
    const checkNative = () => { if (state.nativeDenied) throw new Error(state.nativeDenied); };
    // After Return, Enter, Tab, Escape or Space, typeText or paste goes ahead without the settled tree
    // read (about 470 ms in Excel, 2026-10-17) when two native observations that began at least waitMs
    // after the key, and gapMs apart, show the expected title and URL in the app's focused window (and
    // its certified number, which the relay asks for), no sheet on it, and focus on a text or cell
    // element inside it that isn't a password field. The newest must have ended within freshMs, and the
    // key must be less than windowMs old (the observer stops then), so a wait or a slow call between the
    // key and the typing reads. So does any other call on an app handle in between. Any other
    // observation, or none before deadlineMs, reads the whole tree as before. A call stops trying after
    // a wait that got no observation at all, or after two refusals.
    const lightRole = /^AX(?:TextField|TextArea|ComboBox|SearchField|Cell|Table|Grid|LayoutArea)$/;
    const verifyWindowIdentity = ${verifyWindowIdentity.toString()};
    const tabFocusRefusal = ${tabFocusRefusal.toString()};
    const tabChromeRefusal = ${tabChromeRefusal.toString()};
    const tabProbeRefusal = ${tabProbeRefusal.toString()};
    const tabCheck = async (before, transition = false) => {
      const probe = state.tabProbe, started = clock(), entered = Date.now(), ready = Math.max(entered, (before?.done ?? entered - 250) + 250);
      let reason = 'probe-timeout', sample, first, pending, requestHandle, failed = probe.failure, step = 'filesystem-import';
      try {
        if (failed) throw Object.assign(Error('tab probe setup failed'), { code: failed.errno });
        const fs = await import('node:fs');
        do {
          const now = Date.now();
          if (!pending && now >= ready && (!first || now >= first.start + 50)) {
            step = 'request-open';
            pending = ++state.tabSerial;
            if (pending > 8) throw Object.assign(Error('tab sample limit'), { code: 'EOVERFLOW' });
            requestHandle = await fs.promises.open(probe.request + '-' + (pending - 1), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
            step = 'request-stat';
            if (!(await requestHandle.stat()).isFIFO()) throw Object.assign(Error('tab request is not a FIFO'), { code: 'EINVAL', syscall: 'fstat' });
          }
          let readStep = 'observation-read';
          try {
            const text = await fs.promises.readFile(probe.path, 'utf8');
            readStep = 'observation-parse'; sample = JSON.parse(text); failed = undefined;
          } catch (error) {
            if (error?.code !== 'ENOENT') failed = { failureStep: readStep, errno: error?.code ?? null, syscall: error?.syscall ?? null };
          }
          if (now < entered || now < probe.since) { reason = 'clock-reversed'; break; }
          if (pending && sample?.request === pending && Number.isFinite(sample?.start) && sample.start >= entered && sample.start >= ready && Number.isFinite(sample.end) &&
              sample.end >= sample.start && sample.end <= now && now - sample.end <= probe.freshMs) {
            step = 'request-close';
            await requestHandle.close(); requestHandle = undefined;
            failed = sample.failure;
            if (failed) { reason = 'probe-failed'; break; }
            step = 'certificate-check';
            // The engine's own input can reset HID idle. Require no input since that action finished,
            // earlier than the original continuation's post-read stop boundary.
            reason = tabProbeRefusal(state.tabTarget, sample.observed, Math.max(probe.since, before?.done ?? probe.since), sample.end, transition);
            if (reason) break;
            const { walkMs, ...chrome } = sample.observed.chrome;
            const signature = JSON.stringify([sample.observed.title, sample.observed.url, chrome]);
            if (first && first.signature !== signature) { reason = 'unstable-chrome'; break; }
            first ??= { start: sample.start, signature };
            if (sample.start - first.start >= 50) break;
            reason = 'readiness-unconfirmed';
            pending = undefined;
          }
          if (clock() - started >= probe.deadlineMs) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        } while (true);
      } catch (error) {
        reason = 'probe-failed';
        if (!probe.failure) failed = { failureStep: step, errno: error?.code ?? null, syscall: error?.syscall ?? null };
      } finally {
        if (requestHandle) try { await requestHandle.close(); }
        catch (error) { reason = 'probe-failed'; failed = { failureStep: 'request-close', errno: error?.code ?? null, syscall: error?.syscall ?? null }; }
      }
      const chromeDiagnostic = c => ({ refusal: tabChromeRefusal(c) ?? null, complete: c?.complete === true,
        nativeReason: c?.reason ?? null, check: c?.check ?? null, details: c?.details ?? null, walkMs: c?.walkMs ?? null });
      if (state.guardStopMark) nodeRepl.write(state.guardStopMark + JSON.stringify({ tabProbe: { decision: reason ? 'read' : 'probe', reason: reason ?? 'address-field',
        waitMs: clock() - started, sampleMs: sample?.end - sample?.start, ageMs: Date.now() - sample?.end,
        transition, tabCount: sample?.observed?.chrome?.tabCount, channel: probe.channel,
        chrome: { baseline: chromeDiagnostic(state.tabTarget?.nativeIdentity?.chrome), observed: chromeDiagnostic(sample?.observed?.chrome) },
        failureStep: failed?.failureStep ?? null, errno: failed?.errno ?? null, syscall: failed?.syscall ?? null,
        exitCode: failed?.exitCode ?? null } }) + '\\n');
      if (reason) { state.tabProbe = undefined; return; }
      return { ...sample.observed, sampledEnd: sample.end };
    };
    const lightCheck = async before => {
      const light = state.light, start = clock(), entered = Date.now();
      const windowMs = light.windowMs ?? 700, gap = light.gapMs ?? 50, freshMs = light.freshMs ?? 150;
      const since = before.done + (light.waitMs ?? 250), deadline = before.done + Math.min(light.deadlineMs ?? 600, windowMs);
      const good = o => o?.status === 'ok' && o.matches === 1 && o.window > 0 && o.title === state.expected?.title &&
        (o.url ?? null) === (state.expected?.url ?? null) && o.focus?.sheets === 0 && o.focus.inWindow === true &&
        lightRole.test(o.focus.role ?? '') && o.focus.subrole !== 'AXSecureTextField' && typeof o.end === 'number';
      let passed = false, seen = false, polled = false;
      // One touch since the key: this typeText or paste. A read, wait, screenshot or other handle in
      // between is another.
      if (state.touches === before.touches + 1) try {
        const fs = await import('node:fs/promises');
        for (;;) {
          if (Date.now() - before.done >= windowMs) break;
          polled = true;
          let observations = [];
          try { observations = JSON.parse(await fs.readFile(light.path, 'utf8')).observations ?? []; } catch {}
          const late = observations.filter(o => typeof o?.start === 'number' && o.start >= since);
          if (late.length) seen = true;
          if (observations.some(o => typeof o?.end === 'number' && o.end >= since && !good(o))) { seen = true; break; }
          const newest = late.at(-1), now = Date.now();
          if (late.length >= 2 && newest.start - late[0].start >= gap && now - newest.end <= freshMs && now - before.done < windowMs) { passed = true; break; }
          if (now >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, light.pollMs ?? 10));
        }
      } catch {}
      if (polled && !seen && entered < deadline) light.off = true;
      if (!passed && (light.refusals = (light.refusals ?? 0) + 1) >= 2) light.off = true;
      if (state.timing) nodeRepl.write('[sleight:guard-timing]' + JSON.stringify({ phase: passed ? 'light' : 'light-refused',
        ms: clock() - start, chars: 0, failed: false }) + '\\n');
      return passed;
    };
    const input = () => {
      if (!state.inputSent && state.guardStopMark) nodeRepl.write(state.guardStopMark + JSON.stringify({ input: true }) + '\\n');
      state.inputSent = true;
    };
    const checkLease = async () => {
      if (!state.lease) return;
      const fs = await import('node:fs/promises');
      let record;
      try { record = JSON.parse(await fs.readFile(state.lease.path, 'utf8')); }
      catch { throw new Error(${quoted(/* lean notice */ 'Input lease stopped this action: the lease file is unavailable. End the turn and read the window again.')}); }
      if (record.token !== state.lease.token || record.expires <= Date.now()) {
        throw new Error(${quoted(/* lean notice */ 'Input lease stopped this action: ownership lost or expired. End the turn and read the window again.')});
      }
    };
    const wrap = target => {
      if (state.proxies.has(target)) return target;
      if (state.wrapped.has(target)) return state.wrapped.get(target);
      const proxy = new Proxy(target, { get(raw, name) {
        // Every use of a handle, for the light check's "nothing between the key and the typing".
        state.touches = (state.touches ?? 0) + 1;
        if (name === 'waitFor') return (() => {
          let pending;
          const checkCurrent = () => {
            if (state.reads !== pending.reads || pending.reads.get(proxy) !== pending.reading) {
              throw new Error(${quoted(/* lean notice */ 'waitFor stopped: another action or read superseded this poll. Read the window again.')});
            }
          };
          return wait({
          read: async () => {
            checkNative();
            state.binding = undefined;
            const reads = state.reads, reading = {};
            reads.set(proxy, reading); pending = { reads, reading };
            const text = await timedRead(raw, 'wait');
            checkCurrent();
            pending.modalOpened = clickOpenedModal(proxy, text);
            return text;
          },
          parse, elements, hasIdentifier, hasLabel, expected: state.guarded ? state.expected : undefined,
          acceptWindow: (current, text) => {
            checkCurrent();
            const before = state.previous.get(proxy);
            const shortcut = before?.name === 'pressKey' && typeof before.key === 'string' &&
              (before.key.includes('+') || /^(?:return|enter)$/i.test(before.key));
            const opener = before?.name === 'click' || shortcut;
            if (!state.adoptUrl || current.app !== state.expected?.app) return false;
            const adoptedUrl = state.expected.url == null && current.url && current.title === state.expected.title;
            const panel = current.title === '' && !current.url && !hasModal(text);
            const modal = !current.url && hasModal(text) && (shortcut || pending.modalOpened);
            const named = state.typed.some(typed => {
              const base = typed.trim().split('/').pop();
              if (base.length < 3) return false;
              let file;
              try { file = current.url?.startsWith('file://') ? decodeURIComponent(new URL(current.url).pathname).split('/').pop() : undefined; } catch {}
              return current.title === base || file === base;
            });
            if (!adoptedUrl && !panel && !(opener && (hasModal(text) ? modal :
                /^0 [^\\n]*\\bID: (?:save|open)-panel\\b/m.test(text) ||
                (!current.url && /^Untitled(?: \\d+)?$/.test(current.title)) || named))) return false;
            state.expected = current;
            return true;
          },
          observe: text => {
            checkCurrent();${O ? '\n            ' + 'state.noteRead(raw, text);' : ''}
            state.activeApp = proxy;
            state.reads.set(proxy, { text, emitted: true, modalOpened: pending.modalOpened });
          }
        }); })();
        // app.pickFromList([list,] "<row label>"): pages a sorted list by key or wheel, then clicks the row. Every key, wheel
        // step and the click run through this handle's own checks, so a window change, a lost lease or a renumbered row stops it.
        if (name === 'pickFromList') return (...args) => track((async () => {
          checkNative();
          const superseded = () => { throw new Error('pickFromList stopped: another action or read ran during the search. Read the window again.'); };
          // A click on this handle that was the call's last action: after it, the read can name the selected row in
          // place of the focused list (race-1017 b7, Safari and Firefox), and the helper accepts that list only then.
          const before = state.previous.get(proxy);
          const clicked = before?.name === 'click' && before.version === state.actionVersion && before.done !== undefined &&
            Number.isInteger(before.at) && typeof before.line === 'string' ? { number: before.at, line: before.line } : undefined;
          const result = await pickList({
            read: async () => {
              checkNative();
              state.binding = undefined;
              const version = state.actionVersion;
              const text = await timedRead(raw, 'list');
              if (state.actionVersion !== version) superseded();
              return text;
            },
            // Left unemitted, so a stop ends the call with the tree it stopped on.
            observe: text => {
              state.activeApp = proxy;
              state.noteFocus(text);
              state.reads.set(proxy, { text, emitted: false });
            },
            press: async key => {
              const version = state.actionVersion;
              const result = await proxy.pressKey(key);
              if (state.actionVersion !== version + 1) superseded();
              return result;
            },
            // The wheel over the list, named by its whole line in the newest tree.
            scroll: async (line, direction, ticks) => {
              const version = state.actionVersion;
              const result = await proxy.scroll({ line }, direction, ticks);
              if (state.actionVersion !== version + 1) superseded();
              return result;
            },
            click: line => proxy.click({ line }),
            // A list number Claude wrote names the line it saw for that number, when the relay passed it.
            lineSeen: number => state.seenLines?.[number],
            uniqueSeen: number => state.uniqueSeen.has(number),
            // The same note scroll's goTo writes, so the prompt budget counts it once.
            rebound: (from, to, line, name = 'pickFromList', why = 'the window renumbered since you read it') =>
              nodeRepl.write('sleight: ' + name + '(' + from + ') went to element ' + to + ', the same ' + JSON.stringify(line) + ': ' + why + '.\\n'),
            parse, sameElement, clicked, expected: state.guarded ? state.expected : undefined
          })(...args);
          // A search that did not click ends the call, so later actions in it don't run past the failure.
          if (!result.clicked) throw new Error('pickFromList stopped (' + result.reason + '): ' + result.note + ' [' + result.reads + ' reads, ' + result.keys + ' keys]');
          return result;
        })().catch(error => {
          // Listed for the call's result, as a failed action is, in case the code didn't await the pick.
          state.failures.push('pickFromList: ' + (error?.message ?? error));
          throw error;
        }));
        const value = Reflect.get(raw, name);
        if (typeof value !== 'function') return value;
        // Claude's tree reads are full reads the relay turns into changed lines,
        // and they double as the guard's own read until the next action.
        if (name === 'getAXState') return async (options = {}) => {
          checkNative();${dp1 ? '\n          await state.beforeRead(proxy);' : ''}
          state.binding = undefined;
          const reads = state.reads, reading = {}, version = state.actionVersion;
          reads.set(proxy, reading);
          const text = await state.settleRead(raw, await raw.getAXState({ ...options, disableDiffing: true, emit: false }));${O ? '\n          ' + 'state.noteRead(raw, text);' : ''}
          const emitted = options?.emit !== false;
          if (emitted) nodeRepl.write(${JSON.stringify(GUARD_MARK)} + text + ${JSON.stringify(GUARD_END)});
          else nodeRepl.write(${JSON.stringify(GUARD_OMIT_MARK)} + text + ${JSON.stringify(GUARD_END)});
          // Input replaces the map; a newer observation replaces this entry.
          if (state.reads === reads && reads.get(proxy) === reading) reads.set(proxy, { text, emitted, omit: !emitted, version, modalOpened: clickOpenedModal(proxy, text) });
          if (typeof text === 'string' && parse(text)) { state.codeReads.set(proxy, elements(text)); state.noteFocus(text); }
          state.activeApp = proxy;
          return text;
        };
        if (name === 'getAXStateAndScreenshot') return async (options = {}) => {
          checkNative();${dp1 ? '\n          await state.beforeRead(proxy);' : ''}
          state.binding = undefined;
          // The combined observation already paid for a full AX walk. Keep its
          // state just as we keep getAXState, until the next action or call.
          const reads = state.reads, reading = {};
          reads.set(proxy, reading);
          const result = await value.call(raw, { ...options, disableDiffing: true });${O ? '\n          ' + 'state.noteRead(raw, result?.state);' : ''}
          if (options?.emit === false && typeof result?.state === 'string') {
            nodeRepl.write(${JSON.stringify(GUARD_OMIT_MARK)} + result.state + ${JSON.stringify(GUARD_END)});
          }
          if (state.reads === reads && reads.get(proxy) === reading) {
            const modalOpened = clickOpenedModal(proxy, result?.state);
            if (typeof result?.state === 'string' && parse(result.state)) reads.set(proxy, { text: result.state, emitted: options?.emit !== false, omit: options?.emit === false, modalOpened });
          }
          if (typeof result?.state === 'string' && parse(result.state)) { state.codeReads.set(proxy, elements(result.state)); state.noteFocus(result.state); }
          state.activeApp = proxy;
          return result;
        };
        if (name === 'getScreenshot') return async (options = {}) => {
          checkNative();${dp1 ? '\n          await state.beforeRead(proxy);' : ''}
          state.binding = undefined;
          const reads = state.reads, reading = {};
          reads.set(proxy, reading);
          // macOS captures AX and pixels together even for a screenshot. Ask
          // for both so that capture can also supply the guard's fresh header
          // and selectors, while returning/emitting only the requested image.
          if (typeof raw.getAXStateAndScreenshot === 'function') {
            const result = await raw.getAXStateAndScreenshot({ ...options, disableDiffing: true, emit: false });
            if (!result?.screenshot) throw new Error('Screenshot unavailable for this window.');${O ? '\n            ' + 'state.noteRead(raw, result.state);' : ''}
            if (options?.emit !== false) await nodeRepl.emitImage(result.screenshot);
            else if (typeof result.state === 'string') nodeRepl.write(${JSON.stringify(GUARD_OMIT_MARK)} + result.state + ${JSON.stringify(GUARD_END)});
            if (state.reads === reads && reads.get(proxy) === reading) {
              const modalOpened = clickOpenedModal(proxy, result.state);
              if (typeof result.state === 'string' && parse(result.state)) reads.set(proxy, { text: result.state, emitted: false, omit: options?.emit === false, modalOpened });
              state.noteFocus(result.state);
            }
            state.activeApp = proxy;
            return result.screenshot;
          }
          const result = await value.call(raw, options);
          if (options?.emit === false) {
            const text = await state.readAfter(proxy);
            nodeRepl.write(${JSON.stringify(GUARD_OMIT_MARK)} + text + ${JSON.stringify(GUARD_END)});
            if (state.reads === reads && reads.get(proxy) === reading) reads.set(proxy, { text, emitted: false, omit: true });
          }
          state.activeApp = proxy;
          return result;
        };
        // Every input method an engine handle may take goes through the checks below (doubleClick, rightClick, press and
        // performAction included, review F3), so none of them reaches the app unchecked.
        if (!['click', 'doubleClick', 'rightClick', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'performAction',
          'paste', 'press', 'pressKey', 'typeText'].includes(name)) return (...args) => { checkNative(); return value.apply(raw, args); };
        const act = async (attempt, ...args) => {
          checkNative();${O ? '\n          ' + 'const asked = args[0]; if (state.outcomeMark) attempt.rec = state.outcomeRec(name, asked, args);' : ''}
          // The action as Claude wrote it, for a stop that lists what ran.
          // Typed, pasted, set or selected text shows as its length only.
          // typeText's text is masked wherever it sits, as in a tab-style typeText(1, "<text>").
          const textAt = ['typeText', 'paste'].includes(name) ? 0 : ['setValue', 'selectText'].includes(name) ? 1 : -1;
          const shown = attempt.shown = name + '(' + args.slice(0, 2).map((arg, at) => {
            if ((at === textAt || textAt === 0) && typeof arg === 'string') return '<' + arg.length + ' characters>';
            let text; try { text = JSON.stringify(arg); } catch {}
            text ??= String(arg);
            return text.length > 40 ? text.slice(0, 37) + '...' : text;
          }).join(', ') + ')';
          // click({ ref: 45 }) reached the engine as "elementIndex must be an integer" (finder-move-2, 2026-10-17).
          const locator = args[0];
          if (['click', 'scroll', 'selectText', 'setValue', 'performSecondaryAction'].includes(name) && locator && typeof locator === 'object' &&
              !Array.isArray(locator) && !['id', 'label', 'line'].some(key => typeof locator[key] === 'string')) {
            const number = Object.values(locator).find(value => Number.isInteger(value));
            throw new Error('sleight stopped before ' + shown + ': that object names no element. Pass an element number' +
              (number === undefined ? '' : ', as in ' + name + '(' + number + ')') + ${quoted(/* lean notice */ ', an [x, y] point, a label or ID string, or { id: "<ID>" }, { label: "<label>" }, both together, or { line: "<whole line after the number>" }.')});
          }
          const problem = argumentError(name, args);
          if (problem) {
            attempt.refused = true;
            throw new Error(problem + ' for this action' + (state.completedActions || state.unknown.length ? '; earlier actions in this call may have run.' : '.'));
          }
          const firstAction = !state.acted;
          state.acted = true;
          state.actionVersion++;
          await checkLease();
          if (state.fileOnly && name === 'pressKey' && isCancel(name, args)) {
            state.activeApp = proxy;
            state.reads = new WeakMap();
            input();${O ? '\n            ' + 'attempt.sent = true;' : ''}
            let result;
            try { result = await ${O ? 'state.runOutcome(attempt, () => value.apply(raw, args))' : 'value.apply(raw, args)'}; } catch (error) { state.unknown.push(shown); throw error; }${O ? '\n            ' + 'attempt.completed = true;' : ''}
            state.completedActions++;
            state.ran.push(shown);${O ? '\n            ' + 'state.keepOutcome(raw, attempt.rec);' : ''}
            return result;
          }
          const cached = state.reads.get(proxy);
          let text = cached?.text, modalOpened = cached?.modalOpened ?? false;
          const treeFree = ['pressKey', 'typeText', 'paste'].includes(name) ||
            (['click', 'drag', 'scroll'].includes(name) && Array.isArray(args[0]));
          const skipFirst = firstAction && state.firstOff && proxy === state.startApp && treeFree &&
            typeof args[0] !== 'number' && !(args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]));
          // The call's own acquisition read, for the keyboard checks below when the first action skips its read.
          const priorText = skipFirst ? state.prior?.text : undefined;
          const lastTree = skipFirst ? state.lastTree : undefined;
          if (skipFirst) state.prior = undefined;
          if (firstAction) state.lastTree = undefined;
          // The acquisition just before this call read the whole tree. A launching app can take 15 s
          // per read under load (2026-10-09), so reuse it when the app's windows, as the inventory
          // lists them, are exactly what they were then.
          if (text === undefined && !skipFirst && state.prior && proxy === state.startApp) {
            const prior = state.prior; state.prior = undefined;
            const start = clock();
            // A read Claude made in the call just before, less than 10 s ago (the relay checks), is
            // used as it is: Claude chose this action from it. One that came with an inventory is
            // reused only while the app's windows match it: unchanged windows, or an app the
            // acquisition launched whose one window is the read's. Engine 26.1002.52244 lists no
            // windows at all, and two empty lists prove nothing, so then the guard reads.
            const now = prior.windows === null ? null
              : await cua.listApps({ emit: false }).then(apps => apps.filter(a => a.id === prior.id).map(a => a.windows ?? []), () => null);
            const same = prior.windows === null || (now?.length === 1 && now[0].length > 0 && (JSON.stringify(now[0]) === JSON.stringify(prior.windows) ||
              (prior.windows.length === 0 && now[0].length === 1 && now[0][0].title === prior.title)));
            if (state.timing) nodeRepl.write('[sleight:guard-timing]' + JSON.stringify({ phase: same ? 'reused' : 'reuse-refused', ms: clock() - start, chars: same ? prior.text.length : 0, failed: false }) + '\\n');
            if (same) text = prior.text;
          }
          // A read right after an action waits for the UI to settle: about 400 ms against 50 ms
          // for one before it, and tens of seconds on a loaded Mac (load-cost, 2026-10-09). Codex
          // makes no such read, and the owner chose speed (2026-10-09): keys, text and coordinates
          // after the call's first action go ahead on the header that action was checked against.
          // Numbered and named actions still read, since that is what catches renumbering, and
          // SLEIGHT_GUARD=careful reads before every action.
          // The read also waits for the UI to settle. After a click, a shortcut, Return, Escape, Tab or
          // Space, which can open a panel or sheet, the next action needs that wait: Cmd+O, then
          // Cmd+Shift+G, then typing a path outran the Open panel without it (textedit-drag, 2026-10-09).
          // Typing, pasting and plain keys change no window, so the action after them goes ahead.
          const before = state.previous.get(proxy);
          const checkFocus = ['typeText', 'paste'].includes(name) && before?.editable && before.completed;
          const spec = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : undefined;
          const bare = name === 'click' && typeof args[0] === 'string' && !/^\\d+$/.test(args[0]) ? args[0] : undefined;
          const byId = typeof spec?.id === 'string' || typeof spec?.label === 'string' || typeof spec?.line === 'string' || bare !== undefined;
          // { id, label } together: the elements with both (excel-edit-5, 2026-10-17: ten menu items shared the ID).
          const [kind, target, match] = bare !== undefined ? ['label or ID', bare, hasLabel]
            : typeof spec?.id === 'string' && typeof spec?.label === 'string' ? ['ID ' + JSON.stringify(spec.id) + ' and label', spec.label, (line, value) => hasIdentifier(line, spec.id) && hasLabel(line, value)]
            : typeof spec?.id === 'string' ? ['ID', spec.id, hasIdentifier]
            : typeof spec?.label === 'string' ? ['label', spec.label, hasLabel] : ['line', spec?.line, (line, value) => line === value];
          // An element number written as an ID ({ id: "18" }) matches no label or bare line: it may mean element 18 or an
          // element labeled 18 (a date picker's days), and the guard doesn't choose. The relay sends it as a number when
          // the tree Claude saw allows only that reading (FT1c, form-travel, race-1017).
          const numeric = kind === 'ID' && /^\\d+$/.test(target);
          const bareLine = line => /^[a-z][a-z ]* /.test(line) &&
            !/,|: /.test(line) && line.slice(/^[a-z][a-z ]*? (?=[^a-z ]|$)/.exec(line)?.[0].length ?? line.length) === target;
          const findTarget = lines => {
            let found = [...lines].filter(([, line]) => match(line, target));
            if (bare !== undefined && !found.length) found = [...lines].filter(([, line]) => hasIdentifier(line, target));
            // An { id } that no element carries is taken as a label, as { label } would be: { id: "Reference code" } reached
            // only the field's text label by the bare-line match below, which the engine can't set (form-travel r2, race-1017).
            if (!found.length && kind === 'ID' && !numeric) return [...lines].filter(([, line]) => hasLabel(line, target) || bareLine(line));
            // A bare line carries no ID, so it can't satisfy { id, label }.
            if (!found.length && kind !== 'line' && !kind.endsWith(' and label') && !numeric) found = [...lines].filter(([, line]) => bareLine(line));
            return found;
          };
          const codeRead = typeof args[0] === 'number' && !byId && state.literals && !state.literals.has(args[0]) ? state.codeReads.get(proxy) : undefined;
          const literal = typeof args[0] === 'number' && !byId && !codeRead ? args[0] : undefined;
          if (state.bind && literal !== undefined && state.boundNumbers.get(proxy)?.has(literal)) {
            args = [state.boundNumbers.get(proxy).get(literal).number, ...args.slice(1)];
          }
          // Keep the engine's capture until an opener or the caller's own read replaces it. Unknown
          // selectors still read; unique selectors use the numbers of the last capture we took.
          const firstTree = state.callElements.get(proxy);
          const bindable = state.bind && !state.literalBaselines.get(proxy)?.moved && !treeFree && firstTree && state.binding?.proxy === proxy && !before?.opens && !codeRead &&
            (byId ? findTarget(firstTree).length === 1 : literal !== undefined && firstTree.has(literal));
          // A flagged window reads instead, and binds again after STALE_PASSES such actions pass.
          const staleKey = captureKey(state.callHeaders.get(proxy));
          const unbound = bindable && state.staleCaptures.has(staleKey);
          const bind = bindable && !unbound;
          // setValue changes a field and no window, like typing: Return after setValue({ id }) in a
          // Save sheet skipped its 54,000-character read (owner, 2026-10-10, 1.85 s a save).
          const quiet = before && (['typeText', 'paste', 'setValue'].includes(before.name) || (before.name === 'pressKey' &&
            typeof before.key === 'string' && !before.key.includes('+') && !/^(?:return|enter|escape|esc|tab|space)$/i.test(before.key)) ||
            state.quietEdits && (before.editKey || before.editable && ['typeText', 'paste'].includes(name)));
          let observed;
          if (text === undefined && bind) { text = state.binding.text; attempt.bound = true; }
          const header = state.callHeaders.get(proxy);
          const light = text === undefined && !checkFocus && !skipFirst && state.light && !state.light.off && !state.careful && state.guarded &&
            ['typeText', 'paste'].includes(name) && before?.name === 'pressKey' && typeof before.key === 'string' &&
            /^(?:return|enter|escape|esc|tab|space)$/i.test(before.key) && typeof before.done === 'number' &&
            header && state.expected && state.expected.app === state.light.app && ['title', 'app', 'url'].every(key => header[key] === state.expected[key]);
          const tabKey = name === 'pressKey' && /^(?:super|cmd|command|meta)\\+t$/i.test(String(args[0]));
          const tabStart = state.tabProbe?.mode === 'new-tab' && state.tabStep === 0 && firstAction && tabKey;
          // The ordinary first-action read (or its admitted acquisition read) already checks the baseline.
          if (tabStart) state.tabStep = 1;
          const urlText = name === 'typeText' && typeof args[0] === 'string' && /^https?:\\/\\/[^\\s\\u0000-\\u001f]+$/i.test(args[0]);
          const tabAction = state.tabProbe && state.guarded && !checkFocus && (state.tabStep === 1 && urlText ||
            state.tabStep === 2 && name === 'pressKey' && /^(?:return|enter)$/i.test(String(args[0])));
          const tabEligible = tabAction && (state.tabProbe.mode === 'remainder' && firstAction || before && Number.isFinite(before.done) &&
            state.touches === before.touches + 1 && (state.tabStep === 1 ? before.name === 'pressKey' &&
              /^(?:super|cmd|command|meta)\\+t$/i.test(String(before.key)) : before.name === 'typeText'));
          const transition = tabEligible && state.tabProbe.mode === 'new-tab' && state.tabStep === 1;
          const tabExpected = state.expected, tabTouches = state.touches;
          let nativeTab;
          if (tabEligible && text === undefined) nativeTab = await tabCheck(before, transition);
          if (!tabStart && !nativeTab && state.tabProbe) state.tabProbe = undefined;
          if (nativeTab) {
            // This action-specific metadata never enters the engine-tree/binding cache or claims an engine element number.
            observed = { app: state.expected.app, title: nativeTab.title, url: nativeTab.url };
            if (transition) state.expected = observed;
            state.tabTarget = { ...state.tabTarget, ...observed, nativeIdentity: nativeTab };
            state.tabStep++;
          } else if (!tabAction && text === undefined && !checkFocus && (skipFirst || treeFree && quiet && !state.careful && state.callHeaders.has(proxy))) {
            observed = skipFirst ? state.expected : state.callHeaders.get(proxy);
            if (state.timing) nodeRepl.write('[sleight:guard-timing]' + JSON.stringify({ phase: 'skipped', ms: 0, chars: 0, failed: false }) + '\\n');
          } else if (light && await lightCheck(before)) {
            observed = header;
          } else {
            text ??= await timedRead(raw, 'before-action');
            if (cached?.text === undefined) modalOpened = clickOpenedModal(proxy, text);
            observed = parse(text);
          }
          if (state.ck1 && state.guardStopMark && name === 'setValue') {
            const line = byId && firstTree ? findTarget(firstTree).filter((_, i, all) => all.length === 1)[0]?.[1]
              : literal === undefined ? undefined : firstTree?.get(literal);
            const uniqueField = typeof line === 'string' && /\\(settable\\)/.test(line) &&
              /^(?:text field|email field|text area|text entry area|search (?:text )?field|combo box)(?: |$)/i.test(line) &&
              [...firstTree.values()].filter(other => other === line).length === 1;
            const reason = !state.bind ? 'binding-off' : !firstTree ? 'first-capture' : before?.opens ? 'previous-opens'
              : codeRead ? 'code-read' : unbound ? 'stale-capture' : bind ? 'existing-binding'
              : !uniqueField ? 'not-unique-settable-field' : 'capture-unavailable';
            nodeRepl.write(state.guardStopMark + JSON.stringify({ binding: { index: attempt.index,
              decision: attempt.bound ? 'bound' : 'read', reason: attempt.bound ? 'existing-binding' : reason === 'existing-binding' ? 'fresh-capture' : reason } }) + '\\n');
          }
          if (observed) state.callHeaders.set(proxy, observed);
          attempt.text = text;
          // A stop carries this fresh read, header and tree, so the relay keeps the lease and Claude
          // can retry with current numbers. With only the header, each stop cost Claude a turn to
          // read again (2 of safari-form's 13, 2026-10-09). The relay's compactor shows it as a diff.
          const stop = (message, tree = text) => new Error(message + (tree === undefined ? '' : '\\n' + tree.slice(Math.max(0, tree.indexOf('Window: ')))));
          // A window change is the stop to report, ahead of element checks against the window the call left: Word's OK
          // closed its alert and the next numbered click stopped as a renumbering no continuation reads (word-edit,
          // 2026-10-17). Change review keeps the late check alone: its Cancel test needs the resolved element.
          const checkWindow = cancel => {
            const dialog = state.fileOnly && observed?.app === state.expected?.app && !observed.url?.startsWith('file://');
            // An untitled document that autosave gives a URL mid-call is the same
            // window. Document scope and change review stay strict about URLs.
            if (state.adoptUrl && observed && state.expected && state.expected.url == null && observed.url &&
              observed.app === state.expected.app && observed.title === state.expected.title) state.expected = observed;
            // A sheet or panel this call opened in the same app has no title (Go to Folder
            // in a Save panel: 18 stopped calls in two benchmark passes, 2026-10-07). It
            // isn't another document, so the lease alone lets it through.
            const panel = state.adoptUrl && observed?.app === state.expected?.app && observed.title === '' && !observed.url && !hasModal(text);
            // A window this call's own shortcut, Return or click just opened or renamed in the same app
            // becomes the expected one (owner's call, 2026-10-09): the Save or Open panel, a new untitled
            // window, or a document titled or saved with a name this call typed. Stopping there cost
            // TextEdit save and edit about three calls a run. A window the user opens in that app at that
            // moment would pass too. Document scope and change review stay strict.
            const shortcut = before?.name === 'pressKey' && typeof before.key === 'string' &&
              (before.key.includes('+') || /^(?:return|enter)$/i.test(before.key));
            const opener = before?.name === 'click' || shortcut;
            const modal = observed && !observed.url && hasModal(text) && (shortcut || modalOpened);
            const named = observed && state.typed.some(typed => {
              const base = typed.trim().split('/').pop();
              if (base.length < 3) return false;
              let file;
              try { file = observed.url?.startsWith('file://') ? decodeURIComponent(new URL(observed.url).pathname).split('/').pop() : undefined; } catch {}
              return observed.title === base || file === base;
            });
            if (state.adoptUrl && opener && observed && state.expected && observed.app === state.expected.app &&
              (hasModal(text) ? modal : /^0 [^\\n]*\\bID: (?:save|open)-panel\\b/m.test(text ?? '') || (!observed.url && /^Untitled(?: \\d+)?$/.test(observed.title)) || named)) {
              state.expected = observed;
            }
            // A relay without a lease, document scope or change review forwards actions
            // unguarded, yet handles a read acquired are still proxies. No guarded call
            // has configured the guard then, so there is nothing to compare. A guarded
            // call with no expected window still stops.
            if (state.guarded && !cancel && !dialog && !panel && (!observed || ['title', 'app', 'url'].some(key => observed[key] !== state.expected?.[key]))) {
              // Without document scope or change review, the stop carries the window it saw, so the
              // relay can lease that window for Claude's retry (Chess retitles itself on each move).
              attempt.windowStop = true;
              const reason = /* notice */ state.adoptUrl && observed && state.expected && observed.app !== state.expected.app
                // Which actions ran and which didn't, by name, and the call that switches without a stop:
                // two app-switch stops cost textedit-calculator-2 two calls (2026-10-17).
                ? 'Input lease stopped this action: app changed. ' + state.completedActions + ' earlier action' + (state.completedActions === 1 ? '' : 's') + ${quoted(/* lean notice */ ' in this call ran')} +
                  (state.ran.length ? ', in ' + state.expected.app + ': ' + state.ran.slice(0, 10).join(', ') + (state.ran.length > 10 ? ' and ' + (state.ran.length - 10) + ' more' : '') : '') +
                  (state.unknown.length ? '; sent to ' + state.expected.app + ${quoted(/* lean notice */ ' with the result unknown: ')} + state.unknown.slice(0, 10).join(', ') : '') +
                  '. Not run: this ' + shown + ${quoted(/* lean notice */ ' and every action after it; nothing was sent to ')} + observed.app + '. The lease moves to ' + observed.app +
                  ${quoted(/* lean notice */ ". Send the actions that didn't run in a new call that starts with let <handle> = await cua.getApp(")} + JSON.stringify(observed.app) +
                  ${quoted(/* lean notice */ ") and acts through that handle, without select_window. One call acts in one app: to switch apps, end the call and start the next with that app's getApp.")}
                : state.reason;
              throw (state.adoptUrl ? stop : message => new Error(message))(reason + ' Observed ' + JSON.stringify(observed));
            }
          };
          if (!state.fileOnly) checkWindow(false);
          // app.click({ id: "Seven" }) or ({ label: "Multiply" }): the one element with
          // that AX identifier or label in this read, so numbers an earlier action in
          // the call shifted don't matter.
          // ({ line: "Scientific, ID: menuAction:" }) is the element whose whole line, after its number,
          // is exactly that: a replayed step names an element this way when no ID or label is unique.
          // click("Multiply"): the engine takes only numbers or points, and a bare name failed there, so
          // Claude redid the batch over two calls (calculator-click, 2026-10-10). It is the one element
          // with that label, else with that ID.
          if (byId) {
            // A read on a busy Mac can drop attributes: "button One" for "button Description: 1,
            // ID: One" (2026-10-09). With no match at all, one bare line named exactly that is it.
            let found = findTarget(elements(text));
            // An { id } that matched by label is looked up as { label } is from here on.
            const asLabel = kind === 'ID' && found.length > 0 && !found.some(([, line]) => hasIdentifier(line, target));
            const ancestry = found.length > 1 ? contexts(text) : undefined;
            // A control and its static text share the label ("text Country" above "pop up button (collapsed) Country"), and a
            // click on the text does nothing: of several matches with static text among them, the one control, or the one
            // enabled control, is the target (race-1017 b7: Country, City and Dates stopped 2 of 3 Safari form-travel runs, 2.2
            // to 3.8 s each). This runs before the enabled preference, which would keep the text beside a disabled control.
            // Two enabled controls still stop.
            if (name === 'click' && found.length > 1 && (kind === 'label' || asLabel || bare !== undefined)) {
              const controls = found.filter(([, line]) => !/^text(?: \\([^()]*\\))*(?: |$)/.test(line) || /^text (?:field|area|entry area)(?: |$)/.test(line));
              const enabled = controls.filter(([, line]) => !/^[a-z][a-z ]* \\([^()]*\\bdisabled\\b[^()]*\\)/.test(line));
              if (controls.length < found.length) found = controls.length === 1 ? controls : enabled.length === 1 ? enabled : found;
            }
            let barItems = [], outside = [];
            if (found.length > 1 && (kind === 'label' || asLabel || bare !== undefined && found.every(([, line]) => hasLabel(line, target)))) {
              // A menu-bar title sharing its label with one element outside the menu bar means that element: { label: "Table" }
              // opened Word's Table menu, which then trapped typing (word-edit-1 and -2, 2026-10-17).
              // A window root named like the title isn't a control, and a disabled one leaves the enabled preference below to choose.
              const disabled = line => /^[a-z][a-z ]* \\([^()]*\\bdisabled\\b[^()]*\\)/.test(line);
              barItems = found.filter(([number]) => ancestry.get(number)?.barItem);
              outside = found.filter(([number, line]) => !ancestry.get(number)?.menu && !/^(?:standard window|sheet|dialog)(?: |,|$)/.test(line));
              if (barItems.length && outside.length === 1 && !disabled(outside[0][1])) found = outside;
              const enabled = found.filter(([, line]) => !disabled(line));
              if (enabled.length === 1) found = enabled;
              const content = found.filter(([number]) => ancestry.get(number)?.content);
              if (content.length === 1 && found.every(([number]) => number === content[0][0] || ancestry.get(number)?.menu)) found = content;
            }
            // A field and its text label share the label, and setValue on the text fails (-10005, not settable): of several
            // matches, the one settable element is the field (form-travel, race-1017: Reference code, Full name, Email).
            if (name === 'setValue' && found.length > 1) {
              const settable = found.filter(([, line]) => /^[a-z][a-z ]* \\([^()]*\\bsettable\\b[^()]*\\)/.test(line));
              if (settable.length === 1) found = settable;
            }
            const disabledNote = !found.length && (kind === 'label' || kind === 'label or ID') ? disabledLabelNote(text, target) : undefined;
            if (disabledNote) throw stop('sleight stopped before ' + name + ': ' + disabledNote);
            if (found.length !== 1) {
              const split = barItems.length && outside.length > 1 && found.length > 1;
              const candidates = split ? 'menu-bar item ' + barItems.map(([number]) => number).join(', ') + '; other elements ' + outside.map(([number]) => number + ' (parent ' + ancestry.get(number).parent + ')').join(', ')
                : found.map(([number]) => 'candidate ' + number + ': parent ' + ancestry.get(number).parent).join('; ');
              throw stop('sleight stopped before ' + name + ': ' + (found.length ? found.length + ' elements' : 'no element') + ' with ' + (asLabel ? 'label' : kind) + ' ' + JSON.stringify(target) + ' in this window.' + (candidates ? ' ' + candidates + '.' : '') + ${quoted(/* lean notice */ ' Use an element number or another ID from the window below.')} +
                (numeric ? ${quoted(/* lean notice */ ' An element number goes bare: ')} + name + '(' + target + ').' : ''));
            }
            args = [found[0][0], ...args.slice(1)];
          }
          // An earlier action in this call can renumber the window (Calculator closes
          // its history and every button shifts), so a batch of numbers goes stale.
          // The one element whose whole line is exactly this, unless the line is a bare role
          // ("container"), which says nothing about which element it was.
          const sameLine = line => typeof line === 'string' && !/^[a-z][a-z ]*(?: \\([^)]*\\))*$/.test(line)
            ? [...elements(text ?? '')].filter(([, other]) => other === line) : [];
          // A line without an ID, description or help says little about which element it is: "button 15" under another
          // month is another day (review of X5). Such a line also needs the parent Claude saw it under, and a parent that is a
          // bare role ("row", "group") names no month either: the month can sit in a heading beside the table, or twin groups
          // can swap their children, so that line stops.
          const sameParent = (n, number, tree) => {
            if (/\\b(?:ID|Description|Help): /.test(state.seenLines?.[n] ?? '')) return true;
            const was = state.seenParents?.[n], now = parentsOf(tree ?? '').get(number);
            if (typeof was === 'string' && /^[a-z][a-z ]*(?: \\([^)]*\\))*$/.test(was)) return false;
            return was === null ? now === null : was !== undefined && sameElement(was, now);
          };
          const goTo = (to, line, why) => {
            nodeRepl.write('sleight: ' + name + '(' + args[0] + ') went to element ' + to + ', the same ' + JSON.stringify(line) + ': ' + why + '.\\n');
            if (state.bind && literal !== undefined) {
              if (!state.boundNumbers.has(proxy)) state.boundNumbers.set(proxy, new Map());
              state.boundNumbers.get(proxy).set(literal, { number: to, line });
            }
            args = [to, ...args.slice(1)];
          };
          const renumbered = (to, was, from = args[0]) => nodeRepl.write('sleight: ' + name + '(' + from + ') went to element ' + to + ', the same ' + JSON.stringify(was) + ${quoted(/* lean notice */ ': an earlier action in this call renumbered the window.')} + '\\n');
          // A number the code computed from its own read in this call (a match over getAXState) means
          // that read's element. Checked against the tree from before the call, correct clicks stopped,
          // and Claude fell back to one action per call in ZCode (2026-10-12).
          if (state.numberBatch && literal !== undefined && state.pendingLiterals.includes(literal)) {
            if (!state.callElements.has(proxy)) { state.callElements.set(proxy, elements(text ?? '')); state.callTrees.set(proxy, text); }
            let baseline = state.literalBaselines.get(proxy);
            if (!baseline) {
              const lines = new Map([...new Set(state.pendingLiterals)].map(n => [n, state.seenLines[n]]));
              const unique = state.uniqueSeen;
              baseline = { lines, unique, moved: false };
              state.literalBaselines.set(proxy, baseline);
            }
            const current = elements(text ?? '');
            const remaining = [...new Set(state.pendingLiterals)];
            const shifted = !sameElement(baseline.lines.get(literal), current.get(args[0]));
            if (baseline.moved || shifted) {
              const resolved = new Map();
              for (const n of remaining) {
                const line = baseline.lines.get(n), matches = baseline.unique.has(n) ? sameLine(line) : [];
                if (matches.length !== 1 || !sameParent(n, matches[0][0], text)) throw stop('sleight stopped before ' + name + '(' + literal + '): element ' + n +
                  ${quoted(/* lean notice */ ' changed since you read the window (was ')} + JSON.stringify(line ?? 'missing') + ', now ' + JSON.stringify(current.get(n) ?? 'missing') + ')' +
                  ${quoted(/* lean notice */ '. Use the current numbers in the window below.')});
                resolved.set(n, matches[0][0]);
              }
              baseline.moved = true;
              const to = resolved.get(literal);
              if (to !== args[0]) goTo(to, baseline.lines.get(literal), 'the window renumbered since you read it');
            }
          }
          else if (codeRead) {
            if (!state.callElements.has(proxy)) { state.callElements.set(proxy, elements(text ?? '')); state.callTrees.set(proxy, text); }
            const was = codeRead.get(args[0]), now = elements(text ?? '').get(args[0]);
            if (!sameElement(was, now)) {
              const moved = [...codeRead.values()].filter(line => line === was).length === 1 ? sameLine(was) : [];
              if (moved.length === 1) goTo(moved[0][0], was, 'the window renumbered after this call read it');
              else throw stop('sleight stopped before ' + name + '(' + args[0] + '): element ' + args[0] + ${quoted(/* lean notice */ ' changed since this call read the window (was ')} + JSON.stringify(was ?? 'missing') + ', now ' + JSON.stringify(now ?? 'missing') + ')' + ${quoted(/* lean notice */ '. Use the current numbers in the window below.')});
            }
          }
          else if (!state.callElements.has(proxy)) {
            if (text !== undefined || !state.firstOff) { state.callElements.set(proxy, elements(text ?? '')); state.callTrees.set(proxy, text); }
            // The window can renumber between Claude's read and this call: TextEdit gave a saved
            // document a URL and 14 became File (textedit-save, 2026-10-09). When the line Claude saw
            // is now on exactly one element, act there, as the relay's remap does between calls: a
            // one-line shift in ZCode's sidebar cost a turn (2026-10-12).
            const seen = typeof args[0] === 'number' && !byId ? state.seenLines?.[args[0]] : undefined;
            const now = seen !== undefined && text !== undefined ? elements(text).get(args[0]) : undefined;
            if (seen !== undefined && text !== undefined && !sameElement(seen, now)) {
              // Only for a call with one literal number: the call's other numbers shifted too, and
              // nothing after this action would catch them.
              const moved = state.literals?.size === 1 && state.uniqueSeen.has(args[0]) ? sameLine(seen) : [];
              if (moved.length === 1) goTo(moved[0][0], seen, 'the window renumbered since you read it');
              else throw stop('sleight stopped before ' + name + '(' + args[0] + '): element ' + args[0] + ${quoted(/* lean notice */ ' changed since you read the window (was ')} + JSON.stringify(seen) + ', now ' + JSON.stringify(now ?? 'missing') + ')' + ${quoted(/* lean notice */ '. Use the current numbers in the window below.')});
            }
          }
          else if (typeof args[0] === 'number' && !byId) {
            const bound = state.bind ? state.boundNumbers.get(proxy)?.get(literal)?.line : undefined;
            const was = bound ?? state.callElements.get(proxy).get(args[0]), now = elements(text).get(args[0]);
            // Calculator renumbers every button when its first click closes the history, so a batch
            // of numbers from one read went stale and Claude rewrote it as an ID lookup over four calls
            // (calculator-click, 2026-10-10). The element Claude meant is the line it saw: when that
            // line, with an ID, description or help, is in the new tree exactly once, act on it there.
            // A line without them must also keep its place in the call's first tree (samePlace).
            let moved = sameElement(was, now) || typeof was !== 'string' ? []
              : /\\b(?:ID|Description|Help): /.test(was) ? [...elements(text)].filter(([, line]) => sameElement(was, line))
              : bound === undefined ? samePlace(state.callTrees.get(proxy), args[0], text) : [];
            // Both CK2 paths use the same plain-field, ancestor, payment and inventory checks.
            if (!moved.length && state.ck2 && typeof was === 'string' && !sameElement(was, now) &&
                (before?.name === 'setValue' && Number.isFinite(before.done) && name === 'setValue' || !before?.opens)) {
              moved = plainFieldRemap(state.callTrees.get(proxy), literal, text, state.seenLines?.[literal], state.seenParents?.[literal]);
            }
            if (moved.length === 1) {
              renumbered(moved[0][0], was);
              args = [moved[0][0], ...args.slice(1)];
              if (state.bind && literal !== undefined) {
                if (!state.boundNumbers.has(proxy)) state.boundNumbers.set(proxy, new Map());
                state.boundNumbers.get(proxy).set(literal, { number: moved[0][0], line: was });
              }
            } else if (!sameElement(was, now)) throw stop('sleight stopped before ' + name + '(' + args[0] + ${quoted(/* lean notice */ '): an earlier action in this call changed what element ')} + args[0] + ' is (was ' + JSON.stringify(was ?? 'missing') + ', now ' + JSON.stringify(now ?? 'missing') + ')' + ${quoted(/* lean notice */ '. Use the current numbers in the window below.')});
          }
          const cancel = state.fileOnly && isCancel(name, args, text ?? '');
          if (state.cancelOnly && !cancel) throw new Error('Change review: Cancel target changed. Read the current window before retrying.');
          checkWindow(cancel);
          // A submenu header clicked as the call's last click, key or secondary action opens nothing anyone acts on.
          const later = state.actions?.[attempt.index] === name && state.actions.slice(attempt.index + 1);
          const submenu = name === 'click' && typeof args[0] === 'number' && later && !later.some(next => ['click', 'pressKey', 'performSecondaryAction'].includes(next)) ? submenuHeader(text, args[0]) : undefined;
          if (submenu) throw stop('sleight stopped before ' + shown + ': element ' + args[0] + ' (' + submenu.title + ')' + ${quoted(/* lean notice */ ' opens a submenu; click the item you want inside it in the same call')} + (submenu.items.length ? ' (e.g. ' + submenu.items.join(', ') + ')' : '') + '.');
          // Keys while a menu is in tracking or while the window itself has focus reach nothing: positive evidence
          // from this call's read, or for the menu the previous call's last tree. Escape and paste go ahead.
          const evidence = nativeTab ? undefined : text ?? priorText;
          const trapEvidence = nativeTab ? undefined : evidence ?? lastTree;
          const plainKey = name === 'typeText' || name === 'pressKey' && typeof args[0] === 'string' && !args[0].includes('+') && !/^(?:escape|esc)$/i.test(args[0]);
          if (trapEvidence !== undefined && (name === 'typeText' || name === 'pressKey' && !/^(?:escape|esc)$/i.test(String(args[0])))) {
            // Keys go to a dialog or sheet even while the menu bar shows a title selected (word-edit-1, 2026-10-18).
            const trap = !hasModal(trapEvidence) && trappingMenu(trapEvidence);
            if (trap) throw stop('sleight stopped before ' + shown + ': menu-bar item ' + trap.number + ' (' + trap.title + ')' + ${quoted(/* lean notice */ ' is selected and its menu takes the keys. Click it to open its menu, then close that menu with `await app.performSecondaryAction(<its menu>, "Cancel")`; Cancel on the menu-bar item alone does nothing.')});
          }
          if (evidence !== undefined && (name === 'typeText' || name === 'pressKey' && !/^(?:escape|esc)$/i.test(String(args[0])))) {
            if (plainKey && focusOn(evidence) === 'window' && state.docFocus.has(captureKey(parse(evidence)))) {
              throw stop('sleight stopped before ' + shown + ${quoted(/* lean notice */ ': keyboard focus is on the window itself, so keys have no target. Click the document or the target field first.')});
            }
          }
          if (text !== undefined) state.noteFocus(text);
          // The engine names focus after the tree. Reuse the guard's fresh read; a field's inner
          // node can hold focus too. Only positive evidence of focus elsewhere stops the text.
          if (checkFocus) {
            const number = differentFocusTarget(text, before);
            if (number !== undefined) {
              throw new Error("sleight stopped before " + name + ": another element has focus. Use app.setValue(" + number + ", <text>) instead.");
            }
          }
          // The payment gate's decision on one tree, for the action's own check and for a resend after a refusal: a
          // resend goes to an element of a fresh tree, which may be a payment page the action's tree was not (review, X5).
          const payGate = (tree, at) => {
            const paid = enginePayment(name, args, tree, state.payment);
            // A payment that goes through spends this request's one payment (an allowance from the card goes with it), and
            // the relay hears of it under the private mark.
            if (paid?.allowed) {
              const spent = state.payment.spent;
              state.payment = { ...state.payment, allow: paid.allowed === 'card' ? null : state.payment.allow,
                spent: !paid.payment ? spent : paid.allowed === 'dialog' && spent ? { ...spent, dialog: true }
                  : { site: paid.site, shown: paid.shown, control: paid.control, modal: paid.modal, at: state.payment.now ?? Date.now() } };
              if (state.guardStopMark) nodeRepl.write(state.guardStopMark + JSON.stringify({ paid }) + '\\n');
            } else if (paid?.why === 'point') {
              throw stop(${quoted(/* lean notice */ "sleight stopped this click: the page shows a payment, and a click at a point can't be checked. Use the element number.")}, at);
            } else if (paid) {
              attempt.payment = { why: paid.why, site: paid.site, shown: paid.shown, control: paid.control };
              const head = /* notice */ 'sleight stopped this payment: the page shows ' + (paid.shown ?? ${quoted(/* lean notice */ 'no amount')});
              if (paid.why === 'nocopy') throw stop(head + ${quoted(/* lean notice */ " and sleight has no copy of the user's message to check it against. Ask the user to pay themselves.")}, at);
              const why = paid.why === 'none' ? ${quoted(/* lean notice */ "the user's message named no amount")}
                : paid.why === 'several' ? ${quoted(/* lean notice */ "the user's message named more than one amount")}
                : paid.why === 'always' ? ${quoted(/* lean notice */ 'SLEIGHT_CONFIRM_PAYMENTS=always asks every time')}
                : paid.why === 'second' ? ${quoted(/* lean notice */ 'a payment already went through for this request')}
                : ${quoted(/* lean notice */ "the user's message named ")} + paid.named;
              throw stop(head + ' and ' + why + ${quoted(/* lean notice */ '. Ask the user to confirm, naming the amount.')}, at);
            }
          };
          // The payment gate: a submit-shaped action on a page that shows a payment stops unless the user's own message named
          // an amount no figure on the page exceeds. A submit-shaped key, text or point action that skipped its read reads now
          // when the newest tree it has shows a payment page (focus in it may be stale), or when there is none.
          // A refused attempt sent nothing, so a resend's gate starts from the payment state before this action's gate.
          const paymentBefore = state.payment;
          if (state.payment && !nativeTab) {
            const newest = text ?? priorText ?? state.callTrees.get(proxy) ?? lastTree;
            // After this call has acted, the page may have changed step under the same window (review N4): a submit-shaped action
            // on a web page or dialog reads again rather than trusting the call's first tree.
            if (text === undefined && paymentAction(name, args) && (newest === undefined ||
                !firstAction && /^\\t*\\d+ (?:HTML content|sheet|dialog|alert)\\b/im.test(newest) ||
                enginePayment(name, args, newest.replace(/^The focused UI element is .*$/m, ''), state.payment, true))) {
              text = await timedRead(raw, 'payment');
            }
            payGate(text);
          }
          await checkLease();
          if (nativeTab && (state.touches !== tabTouches || Date.now() < nativeTab.sampledEnd ||
              Date.now() - nativeTab.sampledEnd > state.tabProbe.freshMs)) {
            // Recheck age after the asynchronous lease read. Earlier keyboard checks used the certificate;
            // a delayed dispatch reads and stops so changed focus or a newly tracking menu cannot receive input.
            if (transition) state.expected = tabExpected;
            nativeTab = undefined; state.tabProbe = undefined;
            text = await timedRead(raw, 'before-action'); observed = parse(text); checkWindow(false);
            throw stop('sleight stopped before ' + shown + ${quoted(/* lean notice */ ': native tab certificate expired. Read the current window before retrying.')});
          }
          state.activeApp = proxy;
          // Only the resolved target's role makes a field click quiet; coordinates and words in a
          // button's description say nothing about whether it takes text input.
          const line = name === 'click' && typeof args[0] === 'number' ? elements(text ?? '').get(args[0]) : undefined;
          if (!byId && /^close button(?: |,|$)/i.test(line ?? '')) {
            throw stop('element ' + args[0] + " is the window's close button; close a window by label or with Cmd+W");
          }
          const editable = typeof line === 'string' && /^(?:text field|text area|text entry area|search (?:text )?field|combo box)(?: |$)/i.test(line);
          const keys = name === 'pressKey' && typeof args[0] === 'string' ? args[0].toLowerCase().split('+') : [];
          const key = keys.pop(), modifiers = keys.every(k => ['super', 'cmd', 'command', 'meta', 'shift', 'alt', 'option', 'ctrl', 'control'].includes(k));
          const textEditing = editable || before?.textEditing || ['typeText', 'paste'].includes(name);
          const command = keys.some(k => ['super', 'cmd', 'command', 'meta', 'ctrl', 'control'].includes(k));
          const editKey = modifiers && (/^(?:arrow)?(?:left|right|up|down)$/.test(key ?? '') && (!command || textEditing) ||
            keys.length === 1 && ['super', 'cmd', 'command', 'meta'].includes(keys[0]) && (['a', 'c', 'x', 'z'].includes(key) || textEditing && ['b', 'i', 'u'].includes(key)) ||
            keys.length === 2 && keys.includes('shift') && keys.some(k => ['super', 'cmd', 'command', 'meta'].includes(k)) && key === 'z');
          // Description is the displayed name in field rows; Help, IDs and secondary actions
          // cannot turn an ordinary button into a confirming control.
          const button = /^button(?: \\([^)]*\\))* (.*)$/i.exec(line ?? '')?.[1];
          const label = /(?:^|, )Description: (.*?)(?=, (?:Value|ID|Help|Secondary Actions): |$)/.exec(button ?? '')?.[1] ??
            button?.split(/(?:^|, )(?:Description|Value|ID|Help|Secondary Actions): /)[0];
          const opens = name === 'click' && (line === undefined || /^(?:menu button|pop up button|menu bar item|menu item|link|tab|disclosure triangle|close button)(?: |,|$)/i.test(line) ||
            /(?:…|\\.\\.\\.)$/.test(label ?? '') || /^(?:Delete|Remove|Revert|Discard|Erase|Empty|Close|Quit|Exit|Sign Out|Log Out|Reset|Clear|Replace|Don't Save|Do Not Save|Save|OK|Done|Apply|Continue|Proceed|Next|Back|Finish|Confirm|Accept|Cancel|Dismiss)\\b/i.test(label ?? '')) ||
            ['performSecondaryAction', 'setValue', 'scroll'].includes(name) || name === 'pressKey' &&
            (keys.length > 0 || /^(?:return|enter|escape|esc|tab|space)$/i.test(key ?? ''));
          const previous = { name, key: name === 'pressKey' ? args[0] : undefined, editable, editKey, number: editable ? args[0] : undefined, line, focus: /^The focused UI element is (.+?)\\r?$/m.exec(text ?? '')?.[1],
            at: name === 'click' && typeof args[0] === 'number' ? args[0] : undefined, version: state.actionVersion,
            textEditing: textEditing && (editable || ['typeText', 'paste'].includes(name) || editKey), opens, modal: text === undefined ? undefined : hasModal(text),
            touches: state.touches };
          state.previous.set(proxy, previous);
          if (text !== undefined && !bind) state.binding = { proxy, text };
          else if (state.binding?.proxy !== proxy) state.binding = undefined;
          const typed = name === 'setValue' ? args[1] : ['typeText', 'paste'].includes(name) ? args[0] : undefined;
          if (typeof typed === 'string') state.typed.push(typed);
          // A second handle may refer to this same app/window. Every input
          // invalidates the call's observations, including reads on that alias.
          state.reads = new WeakMap();
          if (text !== undefined) state.loadingBaselines.set(raw, text);
          // No Shift settle after setValue here, as drag.js does after its own text writes: the
          // engine refuses a key press with only modifiers (-10005, 2/2 live, 2026-10-11).
          input();${O ? '\n          ' + 'if (state.outcomeMark) attempt.rec = state.outcomeRec(name, asked, args, text ?? priorText, before); attempt.sent = true;' : ''}
          // Input went out before the engine answered, so a rejected action may have acted.
          let result;
          try { result = await ${O ? 'state.runOutcome(attempt, () => value.apply(raw, args))' : 'value.apply(raw, args)'}; } catch (error) {
            let fresh, resent = false;
            const keep = () => {
              nodeRepl.write(${JSON.stringify(GUARD_MARK)} + fresh + ${JSON.stringify(GUARD_END)});
              state.reads.set(proxy, { text: fresh, emitted: true, version: state.actionVersion });
              attempt.fresh = true;
            };
            // "75 is an invalid element ID" (-10005): the engine's capture no longer holds that element. A date
            // picker re-rendered its days after the first date's click, so the bound capture's next date was gone
            // (Firefox travel, 2026-10-17: a diff read, a full read and a lone click followed, 9.4 s). A click after an
            // earlier action in the call goes once more when the fresh read has its whole line in the same place
            // (refusedPlace; the refusal itself sent nothing). Otherwise the stop stays and nothing is resent. It carries
            // a fresh tree for the relay's note, when one comes within REFUSAL_READ_MS, and the window reads before
            // each numbered or named action for a while, so the rest can go in one call. The macOS accessibility error "AXError.invalidUIElement" is the same loss seen
            // from the native side (Firefox travel, 2026-10-18: 6.3 s of reads before the retry). It recovers the same
            // way. "elementHasNoFrame" does not: an element scrolled out of view has no frame either (a virtual list's
            // overscan row, same race), so nothing in that text says the element is gone.
            if (/\\bis an invalid element ID\\b|\\bAXError\\.invalidUIElement\\b/.test(String(error?.message ?? error))) {
              attempt.refused = true;
              if (attempt.bound) state.staleCaptures.set(captureKey(observed), STALE_PASSES);
              state.binding = undefined;
              let timer;
              try {
                const read = await Promise.race([timedRead(raw, 'after-refusal'),
                  new Promise(resolve => { timer = globalThis.setTimeout?.(resolve, REFUSAL_READ_MS); })]);
                if (typeof read === 'string' && parse(read)) fresh = read;
              } catch {} finally { globalThis.clearTimeout?.(timer); }
              const header = fresh === undefined ? undefined : parse(fresh);
              // Not for a control that opens or confirms (a lone "button Remove" in a re-rendered cart is another item's),
              // nor after an action that opens, nor when a sheet or dialog came up over the page since the tree it used.
              const batch = state.numberBatch && state.literalBaselines.get(proxy);
              const batchTargets = new Map();
              if (batch && fresh !== undefined) for (const n of new Set(state.pendingLiterals)) {
                const was = batch.lines.get(n);
                const matches = batch.unique.has(n) && typeof was === 'string' && !/^[a-z][a-z ]*(?: \\([^)]*\\))*$/.test(was)
                  ? [...elements(fresh)].filter(([, row]) => row === was) : [];
                if (matches.length !== 1 || !sameParent(n, matches[0][0], fresh)) { batchTargets.clear(); break; }
                batchTargets.set(n, matches[0]);
              }
              const to = fresh !== undefined && name === 'click' && typeof args[0] === 'number' && state.completedActions > 0 && text !== undefined &&
                !opens && !before?.opens && !(hasModal(fresh) && !hasModal(text)) &&
                observed && ['title', 'app', 'url'].every(key => header[key] === observed[key])
                  ? batch ? batchTargets.has(literal) ? [batchTargets.get(literal)] : [] : refusedPlace(text, args[0], fresh) : [];
              if (to.length === 1) {
                if (batch) batch.moved = true;
                // The read after the refusal can take REFUSAL_READ_MS: the lease is checked again before anything goes.
                try { await checkLease(); } catch (lost) { state.unknown.push(shown); keep(); throw lost; }
                const from = args[0];
                args = [to[0][0], ...args.slice(1)];
                // The resend's element is in the fresh tree, so the payment gate decides on that tree (a stale "Add gift
                // wrap" resent as "Pay now" went through ungated, review of X5). The refusal sent nothing, so a stop here is
                // a payment stop, not a refusal, and a spend the refused attempt recorded doesn't count.
                if (state.payment && paymentAction(name, args)) {
                  attempt.text = fresh;
                  attempt.refused = false;${O ? ' attempt.sent = false;' : ''}
                  state.payment = paymentBefore;
                  payGate(fresh, fresh);
                  attempt.refused = true;${O ? ' attempt.sent = true;' : ''}
                }
                if (to[0][0] !== from) renumbered(to[0][0], to[0][1], from);
                // The call's last click is this element now, for a pickFromList right after it, and for a bound literal.
                previous.at = to[0][0]; previous.line = to[0][1];
                if (state.bind && literal !== undefined) {
                  if (!state.boundNumbers.has(proxy)) state.boundNumbers.set(proxy, new Map());
                  state.boundNumbers.get(proxy).set(literal, { number: to[0][0], line: to[0][1] });
                }
                try { result = await ${O ? 'state.runOutcome(attempt, () => value.apply(raw, args))' : 'value.apply(raw, args)'}; resent = true; } catch (again) {
                  state.unknown.push(shown);
                  keep();
                  throw again;
                }
              } else if (fresh !== undefined) keep();
            }
            if (!resent) {
              state.unknown.push(shown);
              throw error;
            }
          }
          if (unbound) {
            const left = state.staleCaptures.get(staleKey) - 1;
            if (left > 0) state.staleCaptures.set(staleKey, left); else state.staleCaptures.delete(staleKey);
          }
          previous.done = Date.now();
          if (editable) previous.completed = true;${O ? '\n          ' + 'attempt.completed = true;' : ''}
          state.completedActions++;
          if (literal !== undefined) {
            const at = state.pendingLiterals.indexOf(literal);
            if (at !== -1) state.pendingLiterals.splice(at, 1);
          }
          state.ran.push(shown);${O ? '\n          ' + 'state.keepOutcome(raw, attempt.rec, text ?? priorText);' : ''}
          state.lastAction = name === 'click' && byId && kind !== 'line'
            ? { kind: kind === 'ID' || bare !== undefined && !hasLabel(line ?? '', target) ? 'id' : 'label', value: target, line }
            : name === 'pressKey' && typeof args[0] === 'string' ? { kind: 'key', value: args[0] }
            : name === 'click' && typeof args[0] === 'number' ? { kind: 'number', value: literal ?? args[0] }
            : name === 'click' && Array.isArray(args[0]) ? { kind: 'point', value: args[0] } : null;
          return result;
        };
        // An action Claude didn't await that fails would reject with no handler, and that ends the
        // engine's JavaScript session with every handle (3/3, 2026-10-07). Handle every action's
        // promise here, still returning it, so an await sees the error and nothing is unhandled.
        return (...args) => {
          const attempt = { index: state.actionIndex++ };
          const pending = track(act(attempt, ...args));
          if (state.handBindingMark) {
            const mark = state.handBindingMark;
            const report = () => { try { nodeRepl.write(mark + JSON.stringify({ index: attempt.index, bound: !!attempt.bound }) + '\\n'); } catch {} };
            pending.then(report, report);
          }
          pending.catch(error => {${O ? '\n            ' + `// Ahead of the stop mark: a continued call keeps only the output before it. An action that completed
            // keeps its outcome when a later check throws.
            if (state.outcomeMark) {
              const rec = attempt.rec ?? { a: name };
              if (!attempt.completed) {
                rec.x = attempt.sent ? 'failed' : 'refused';
                if (!attempt.sent) rec.r = state.refusalOf(String(error?.message ?? error));
              }
              state.outcomeAdd(rec);
              state.flushOutcomes();
            }` : ''}
            if (state.guardStopMark) nodeRepl.write(state.guardStopMark + JSON.stringify({ index: attempt.index,
              prev: state.lastAction, root: /^\\d+ .*$/m.exec(attempt.text ?? '')?.[0] ?? null,
              attempts: state.actionIndex, windowStop: !!attempt.windowStop, name, completed: state.completedActions,
              shown: attempt.shown ?? null, ran: state.ran.slice(0, 10),
              ...(attempt.refused ? { refused: true, bound: !!attempt.bound, fresh: !!attempt.fresh } : {}),
              ...(attempt.payment ? { payment: attempt.payment } : {}),
              error: String(error?.message ?? error).split('\\n')[0] }) + '\\n');
            state.failures.push(name + ': ' + (error?.message ?? error));
          });
          return pending;
        };
      } });
      state.proxies.add(proxy); state.wrapped.set(target, proxy); state.raws.set(proxy, target);
      return proxy;
    };
    // A failed acquisition the code caught itself still shows in the result: getApp({ windowId: 0 })
    // inside .catch(() => null) left Claude reading the wrong window (finder-move-2, 2026-10-17).
    if (state.getApp) cua.getApp = async (...args) => {
      checkNative(); state.touches = (state.touches ?? 0) + 1;
      const windowId = args[0] && typeof args[0] === 'object' ? args[0].windowId : undefined;
      try {
        if (windowId !== undefined && !(Number.isSafeInteger(windowId) && windowId > 0)) {
          throw new Error('cua.getApp({ windowId: ' + JSON.stringify(windowId) + ' }) names no window: a window ID is a positive number. ' +
            ${quoted(/* lean notice */ 'For one window of an app, call select_window with the app and its exact title or file URL, then let <handle> = await cua.getApp("<app>").')});
        }
        const handle = wrap(await state.getApp(...args));
        state.getAppFailures = [];
        return state.activeApp = handle;
      } catch (error) {
        let shown; try { shown = JSON.stringify(args[0]); } catch {}
        state.getAppFailures?.push('getApp(' + (shown ?? String(args[0])) + ') failed (your code caught it): ' + (error?.message ?? error));
        throw error;
      }
    };
    state.wrap = wrap;
  };`;
  return install + /* generated code */ `
{
  if (typeof globalThis.__sleightDocumentGuardSetup !== 'function'${reuseSetup ? ' || !globalThis.__sleightDocumentGuard' : ''}) {
    throw new Error(${quoted(/* lean notice */ 'Sleight guard setup is missing. Send a standalone app acquisition before acting.')});
  }
  globalThis.__sleightDocumentGuardSetup(${JSON.stringify(update) ?? 'undefined'});
  ${/* A call that declares app itself (let app = await cua.getApp(…)) has it in its temporal dead zone
     here, and even typeof throws: "Cannot access 'app' before initialization" cost turns in h2h-3
     (2026-10-10). That app comes from cua.getApp, which is already wrapped, so skip it. */
    update && !update.skipAppWrap ? "const state = globalThis.__sleightDocumentGuard; try { if (typeof app !== 'undefined' && app && typeof app.getAXState === 'function' && !state.proxies.has(app)) { app = state.wrap(app); state.activeApp ||= app; state.startApp ||= app; } } catch (error) { if (!(error instanceof ReferenceError)) throw error; }" : ''}
  ${acknowledge && !reuseSetup ? `nodeRepl.write(${JSON.stringify(GUARD_READY + '\n')});` : ''}
}`;
}

export const DOCUMENT_TOOL = {
  name: 'document_scope',
  description: 'Ask the user to approve the last observed document or window for this session. ' +
    'First use js with only let app = await cua.getApp("App") or let app = await cua.getApp({ windowId: 123 }). ' +
    'Actions require an approved matching Window and URL. Window changes stop further actions. ' +
    'This is a mistake guard, not isolation from arbitrary JavaScript.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
