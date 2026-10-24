// What each native action did, from sleight's own read before it and the read after it (SLEIGHT_OUTCOMES=1),
// and the opt-in JSON Lines action log (SLEIGHT_ACTION_LOG). Only structure, roles, names and the acted-on
// control's own value line count; typed text, secure values and document text never leave the engine's tree.
import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// A lock file's age. One another session removed meanwhile reads as fresh, so recovery is left to that session (no
// rotation-failure warning for a race two sessions lose fairly).
const age = path => {
  try { return Date.now() - lstatSync(path).mtimeMs; } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
};

// The account's short and full names, as receipts scrub them: once per log, on its first write.
// userInfo() throws for a uid with no passwd entry; the log then scrubs only the home path.
function ownerNames() {
  const names = [];
  try { names.push(userInfo().username); } catch {}
  try { names.push(execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
  return names;
}

// Runs inside the engine: the guard injects its source, so it uses nothing from outside itself. recs are the
// actions one read settles (several when none read in between); the last with a target names the control.
export function actionOutcome(recs, before, after) {
  const ROLES = ['standard window', 'floating window', 'system dialog', 'dialog', 'sheet', 'popover', 'menu bar item', 'menu bar',
    'menu button', 'menu item', 'menu', 'pop up button', 'radio button', 'check box', 'checkbox', 'toggle button', 'switch',
    'disclosure triangle', 'secure text field', 'search text field', 'search field', 'text entry area', 'text area', 'text field',
    'combo box', 'close button', 'full screen button', 'minimize button', 'zoom button', 'button', 'tab group', 'tab', 'scroll area',
    'scroll bar', 'slider', 'stepper', 'incrementor', 'value indicator', 'date field', 'time field', 'link', 'row', 'cell',
    'column header', 'static text', 'text', 'heading', 'image', 'group', 'toolbar', 'list', 'table', 'outline', 'web area', 'window']
    .sort((a, b) => b.length - a.length);
  const FIELDS = 'Description|Value|ID|Help|Secondary Actions|URL|Placeholder|Details|Selected text';
  const FIELD = Object.fromEntries(['Description', 'Value', 'ID'].map(key => [key, new RegExp('(?:^|, )' + key + ': ?(.*?)(?=, (?:' + FIELDS + '): |$)')]));
  const TITLE_END = new RegExp('(?:^|, )(?:' + FIELDS + '):');
  const cap = (text, n = 40) => text.length > n ? text.slice(0, n - 1) + '…' : text;
  // Names show only when they are generic control words. Tab, link, menu item and window names can be titles, page text or
  // file names, so any other name shows as its length, as receipts show titles.
  const GENERIC = new Set(['ok', 'cancel', 'save', 'save as', "don't save", 'close', 'done', 'submit', 'next', 'back', 'previous',
    'continue', 'apply', 'delete', 'remove', 'add', 'open', 'new', 'edit', 'replace', 'replace all', 'find', 'find next', 'search',
    'yes', 'no', 'allow', "don't allow", 'deny', 'accept', 'decline', 'reset', 'clear', 'undo', 'redo', 'copy', 'cut', 'paste',
    'select all', 'print', 'send', 'upload', 'download', 'share', 'settings', 'preferences', 'options', 'more', 'help', 'file',
    'view', 'format', 'insert', 'window', 'tools', 'table', 'bold', 'italic', 'underline', 'minimize', 'zoom', 'full screen',
    'go', 'sign in', 'log in', 'sign out', 'log out', 'name', 'email', 'username', 'password', 'date', 'time', 'title']);
  const generic = name => GENERIC.has(name.replace(/(?:…|\.\.\.)$/, '').trim().toLowerCase());
  const shown = name => !name ? '' : generic(name) ? '"' + name + '"' : '[redacted ' + name.length + ' chars]';
  const describe = body => {
    if (typeof body !== 'string') return;
    const role = ROLES.find(r => body === r || body.startsWith(r + ' ') || body.startsWith(r + ',')) ?? /^[a-z]*/.exec(body)[0];
    let rest = body.slice(role.length).replace(/^,?\s*/, '');
    const flagged = /^\(([^)]*)\)\s*/.exec(rest);
    if (flagged) rest = rest.slice(flagged[0].length);
    const field = key => FIELD[key].exec(rest)?.[1];
    const flags = flagged ? flagged[1].split(/,\s*/) : [];
    const id = field('ID'), name = (field('Description') || rest.split(TITLE_END)[0].trim() || id || '').trim();
    const value = field('Value');
    // The platform's secure role or subrole first, then bullets for a value, then names.
    const secure = /secure/i.test(role) || flags.includes('secure') || flags.includes('protected') || /\bAXSecureTextField\b/.test(body) || /^[•●*]+$/.test(value ?? '') ||
      /password|passcode|passphrase|\bpin\b|recovery (?:key|code|phrase)|secret key|security code|verification code|one-time|\botp\b|\bcv[cv]2?\b|api key|access token|protected|passwort|kennwort|mot de passe|contrase[ñn]a|senha|wachtwoord|l[öo]senord|adgangskode|salasana|has[łl]o|пароль|密码|パスワード|비밀번호|jelsz[óo]/i.test(name + ' ' + (id ?? ''));
    // Only these plain field kinds may expose typed length. A single-line field's label may be absent or
    // held elsewhere in the tree, so its name cannot prove that a length is safe to keep.
    const sensitive = /\bcard|carte|tarjeta|karte|cart[aã]o|\bcarta\b|kaart|\bkort|karta|カード|卡|account|konto|compte|cuenta|\bconta\b|rekening|\bconto\b|\bssn\b|social security|s[ée]curit[ée] sociale|seguridad social|sozialversicherung|national insurance|\bnino\b|\bsin\b|\bbsn\b|\bnir\b|\bnif\b|\bnie\b|\bdni\b|\bcpf\b|codice fiscale|personnummer|pesel|\biban\b|\bbic\b|\bswift\b|routing|sort code|\bblz\b|bankleitzahl|\baba\b|\brib\b|\bnip\b|geheimzahl|\bcid\b|\bcc-|verification|pr[üu]fnummer|cryptogramme|\btax|\btin\b|\bein\b|\bvat\b|steuer|impuesto|fiscal|imposto|passport|reisepass|passeport|pasaporte|passaporto|paspoort|passaporte|expir|\bexp\b|ablauf|vencimiento|scadenza|birth|geburt|\bdob\b|secret|token|\bkey\b|code|national id|\bid no|number|nummer|num[ée]ro|n[úu]mero/i.test(body);
    const plain = !secure && !sensitive && ['text area', 'text entry area'].includes(role);
    return { role, flags, name, id, value, secure, plain };
  };
  const view = text => {
    if (typeof text !== 'string') return;
    const header = /^Window: (.*), App: (.+?)\.?\r?$/m.exec(text);
    if (!header) return;
    const els = new Map();
    let focus;
    for (const line of text.split('\n')) {
      const m = /^\t*(\d+) (.*?)\r?$/.exec(line);
      if (m) { els.set(Number(m[1]), m[2]); continue; }
      const f = /^The focused UI element is (\d+) (.*?)\r?$/.exec(line);
      if (f) focus = { n: Number(f[1]), body: f[2] };
    }
    let title;
    try { title = JSON.parse(header[1]); } catch { title = header[1].replace(/^"|"$/g, ''); }
    return { title: String(title), app: header[2], url: /\bURL: (\S+)/.exec(els.get(0) ?? '')?.[1] ?? '', els, focus };
  };
  const label = d => d.role + (d.name ? ' ' + shown(d.name) : '');
  const key = d => d.role + '|' + (d.id || d.name);
  const targets = recs.map(rec => {
    const d = describe(rec.body);
    // p: the field is not a known plain kind, so its typed length stays in the engine (the guard drops p with it).
    return d && { r: d.role, ...(d.secure ? { s: true } : d.name && generic(d.name) ? { m: d.name } : d.name ? { ml: d.name.length } : {}),
      ...(!d.plain && !d.secure && /field|area|combo box/.test(d.role) ? { p: true } : {}) };
  });
  const b = view(before), a = view(after);
  let rec;
  for (const item of recs) if (item.body !== undefined) rec = item;
  const old = rec && describe(rec.body);
  // What a secure field holds isn't shown, so whether the action took is unknown too.
  if (!b || !a || old?.secure) return { targets };
  const facts = [];
  if (a.app !== b.app) facts.push({ o: 'app', d: cap(a.app) });
  // A menu tree's root has no URL, so only two reads that both show one can say it changed.
  else if (a.title !== b.title || a.url && b.url && a.url !== b.url) facts.push({ o: 'window', d: shown(a.title) || '""' });
  // Word trees run to thousands of lines, so only matching lines get parsed: this runs between actions.
  const bodies = (v, pattern) => [...v.els.values()].filter(body => pattern.test(body));
  // The root is the window itself: Word's turns from standard window to dialog while a pane is open.
  const modal = v => [...v.els].filter(([n, body]) => n !== 0 && /^(?:sheet|dialog|system dialog|popover)(?: |,|$)/.test(body)).map(([, body]) => label(describe(body)));
  const wasModal = modal(b), nowModal = modal(a);
  for (const m of nowModal) if (!wasModal.includes(m)) facts.push({ o: 'opened', d: m });
  for (const m of wasModal) if (!nowModal.includes(m)) facts.push({ o: 'closed', d: m.split(' "')[0] });
  const MENU = /^menu(?:,|$| (?!bar\b|item\b|button\b))/, ITEM = /^menu item(?: |,|$)/;
  // An open menu is a menu element, or a tree whose root is the menu itself (a menu-bar title that Cancel closes).
  const open = v => bodies(v, MENU).length + (/\bSecondary Actions: Cancel\b/.test(v.els.get(0) ?? '') &&
    !/^(?:standard window|floating window|window|dialog|sheet|system dialog)(?: |,|$)/.test(v.els.get(0)) ? 1 : 0);
  const menus = open(a) - open(b);
  if (menus > 0) facts.push({ o: 'menu', d: String(bodies(a, ITEM).length - bodies(b, ITEM).length) });
  else if (menus < 0) facts.push({ o: 'menu-' });
  const number = rec?.n ?? rec?.focus;
  if (old) {
    let now = number !== undefined && describe(a.els.get(number));
    if (!now || now.role !== old.role) {
      const same = [...a.els.values()].filter(body => body.startsWith(old.role)).map(describe).filter(d => key(d) === key(old));
      now = same.length === 1 ? same[0] : undefined;
    }
    // A control that went away with the window or sheet it was in says nothing more.
    if (!now) { if (rec.n !== undefined && !facts.length) facts.push({ o: 'gone' }); }
    else {
      const on = d => ['1', 'true', 'on'].includes(String(d.value).toLowerCase());
      const toggle = /^(?:check box|checkbox|switch|toggle button)$/.test(old.role) ? ['checked', 'unchecked']
        : old.role === 'radio button' ? ['selected', 'unselected'] : old.role === 'disclosure triangle' ? ['expanded', 'collapsed'] : undefined;
      // Only a single-line control's own value, never a text area's or a secure field's, and never typed text.
      const shown = !/^(?:typeText|paste)$/.test(rec.a) && !old.secure && !now.secure &&
        /^(?:text field|search text field|search field|combo box|slider|stepper|incrementor|value indicator|pop up button|date field|time field)$/.test(now.role) &&
        (now.value ?? '').length <= 40;
      // A secure field shows bullets, so whether it holds what was set is unknown.
      const want = typeof rec.want === 'string' && !old.secure && !now.secure ? { m: now.value === rec.want } : {};
      if (toggle && on(old) !== on(now)) facts.push({ o: 'state', d: on(now) ? toggle[0] : toggle[1] });
      else if (old.value !== now.value || want.m) facts.push({ o: 'value', ...want, ...(shown ? { d: now.value ?? '' } : {}) });
      for (const flag of ['selected', 'expanded', 'disabled']) {
        if (!toggle && old.flags.includes(flag) !== now.flags.includes(flag)) facts.push({ o: 'state', d: (now.flags.includes(flag) ? '' : 'not ') + flag });
      }
    }
  }
  const focusOf = v => v.focus && describe(v.focus.body);
  if (a.focus && b.focus && a.focus.n !== b.focus.n && key(focusOf(a)) !== key(focusOf(b)) && a.focus.n !== number) {
    facts.push({ o: 'focus', d: label(focusOf(a)) });
  }
  if (!facts.length) {
    const left = new Map();
    for (const body of b.els.values()) left.set(body, (left.get(body) ?? 0) + 1);
    let changed = 0;
    for (const body of a.els.values()) { const n = left.get(body); if (n) left.set(body, n - 1); else changed++; }
    for (const n of left.values()) changed += n;
    facts.push(changed ? { o: 'lines', d: String(changed) } : { o: 'none' });
  }
  return { targets, facts: facts.slice(0, 2) };
}

// Shared by the engine guard and the offline character analyzer. The guard injects this function's source
// beside actionOutcome, so private target lines and typed values never leave the engine.
export function outcomeRecord({ want, body, focus, ...rec }) {
  const { p, ...t } = body === undefined ? {} : actionOutcome([{ body }]).targets[0] ?? {};
  if (t.s || p || !/^(?:text area|text entry area)$/.test(t.r)) delete rec.c;
  return t.r ? { ...rec, t } : rec;
}

const said = fact => ({
  app: /* lean notice */ `now in ${fact.d}`, window: /* lean notice */ `window now ${fact.d}`, opened: /* lean notice */ `${fact.d} opened`,
  closed: /* lean notice */ `${fact.d} closed`, menu: /* lean notice */ fact.d && fact.d !== '0' ? `menu opened (${fact.d} items)` : 'menu opened',
  'menu-': /* lean notice */ 'menu closed',
  value: /* lean notice */ fact.m === true ? 'holds the value' : fact.d !== undefined ? `value reads "${fact.d}"` : fact.m === false ? 'value differs' : 'value changed',
  state: /* lean notice */ `now ${fact.d}`, gone: /* lean notice */ 'element gone', focus: /* lean notice */ `focus on ${fact.d}`,
  lines: /* lean notice */ `${fact.d} other lines changed`, none: /* lean notice */ 'no visible change',
})[fact?.o];
function actionLabel(rec, i) {
  const typed = /^(?:typeText|paste)$/.test(rec.a) && rec.t?.r;
  return `${i + 1} ${rec.a}` + (rec.l !== undefined ? ' ' + JSON.stringify(rec.l) : rec.n !== undefined ? ' ' + rec.n : '') +
    (rec.k ? ' ' + JSON.stringify(rec.k) : '') + (Number.isSafeInteger(rec.c) ? ` ${rec.c} chars` : '') +
    (typed ? ` into ${rec.t.r}${rec.t.m ? ` "${rec.t.m}"` : Number.isSafeInteger(rec.t.ml) ? ` [redacted ${rec.t.ml} chars]` : ''}` : '');
}
function actionResult(rec) {
  if (rec.x === 'refused') return /* lean notice */ `not run (${rec.r ?? 'stopped'})`;
  if (rec.x === 'failed') return /* lean notice */ 'failed; partial input possible';
  const facts = Array.isArray(rec.f) ? rec.f.map(said).filter(Boolean) : [];
  return facts.length ? facts.join('; ') : /* lean notice */ 'ran, unverified';
}

// One line per action for Claude. Actions that shared one read share its line. notSent: the stop note already lists the
// rest. continuing: sleight sends the rest, the stopped action first, so neither shows here; start: lines shown before.
export function renderOutcomes(record, { notSent = false, continuing = false, start = 0 } = {}) {
  const recs = Array.isArray(record?.outcomes) ? record.outcomes.filter(rec => rec && typeof rec.a === 'string' && !(continuing && rec.x === 'refused')) : [];
  if (!recs.length) return;
  const lines = [];
  let group = [];
  recs.forEach((rec, i) => {
    group.push(actionLabel(rec, start + i));
    if (rec.g && !rec.x && i < recs.length - 1) return;
    lines.push(group.join(', ') + ': ' + actionResult(rec));
    group = [];
  });
  const stopped = recs.findIndex(rec => rec.x), planned = record.planned;
  if (!notSent && !continuing && !start && stopped >= 0 && Number.isSafeInteger(planned) && planned > recs.length) {
    lines.push(`${recs.length + 1}${planned > recs.length + 1 ? '-' + planned : ''}: ` + /* lean notice */ `not run (stopped after ${stopped})`);
  }
  return /* lean notice */ 'sleight outcomes:\n' + lines.join('\n');
}

// The log's words for a fact: structure only, no titles, names or values. A sheet or dialog keeps only its role,
// never its name or that name's length.
const modalRole = label => role(String(label ?? '').split(/ [["]/)[0]) ?? 'window';
const logged = fact => ({
  app: 'app changed', window: 'window changed', opened: `${modalRole(fact.d)} opened`, closed: `${modalRole(fact.d)} closed`,
  menu: 'menu opened', 'menu-': 'menu closed',
  value: fact.m === true ? 'value matches' : fact.m === false ? 'value differs' : 'value changed',
  state: /^(?:not )?(?:checked|unchecked|selected|unselected|expanded|collapsed|disabled)$/.test(fact.d) ? `now ${fact.d}` : 'state changed',
  gone: 'element gone', focus: 'focus moved', lines: 'other lines changed', none: 'no visible change',
})[fact?.o];
// The log keeps a name only from actionOutcome's generic control words, checked again here.
const genericName = name => typeof name === 'string' && name.length <= 20 && actionOutcome([{ body: 'button ' + name }]).targets[0]?.m === name;
const NAMED = 'return|enter|escape|esc|tab|space|backspace|delete|forwarddelete|left|right|up|down|home|end|pageup|pagedown|f\\d{1,2}';
const NAMED_KEY = new RegExp(`^(?:${NAMED})$`, 'i');
// A shortcut with Command or Control, whose last key is a letter, digit or named key: a lone printable key is typed text.
const SHORTCUT = new RegExp(`^(?=(?:\\w+\\+)*(?:super|cmd|command|ctrl|control)\\+)(?:(?:super|cmd|command|ctrl|control|shift|alt|option|opt|fn)\\+)+(?:[a-z0-9]|${NAMED})$`, 'i');
// Claude's code can reach the guard's records and choose tool arguments, and a log line is text another program may read,
// so every word in a row comes from these sets or is cleaned.
const TOOLS = new Set(['js', 'menu_bar', 'notifications', 'document_scope', 'drag', 'flow_exception', 'hover', 'open_file', 'replay',
  'review_changes', 'select_window', 'browser_open', 'browser_act', 'browser_fill', 'browser_read', 'browser_tabs']);
const OPS = { menu_bar: ['apps', 'open', 'choose', 'press', 'close'], notifications: ['list', 'press'], review_changes: ['list', 'review'],
  browser_tabs: ['list', 'close', 'keep', 'handoff'] };
const ACTIONS = new Set(['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']);
const TURBO_STEPS = new Set(['click', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'drag', 'upload', 'dialog', 'wait',
  'navigate', 'back', 'forward', 'reload', 'viewport']);
// refusalReason's categories, the guard's refusalOf kinds, and the log's own.
export const REASONS = new Set(['app changed', 'window changed', 'input lease', 'document scope', 'change review', 'flow rule', 'approval declined',
  'payment confirmation', 'element changed', 'element not found', 'user changed the app', 'stopped by sleight', 'bad locator', 'submenu',
  'menu open', 'no focus target', 'close button', 'native access', 'stopped']);
const role = value => typeof value === 'string' && /^[a-z]+(?: [a-z]+){0,3}$/.test(value) && value.length <= 40 ? value : undefined;
const loggedKey = key => typeof key === 'string' && (NAMED_KEY.test(key) || SHORTCUT.test(key)) ? key : undefined;
// An origin with only host characters: URL keeps $ and backticks in a host name.
const cleanOrigin = origin => typeof origin === 'string' && /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(origin) ? origin : undefined;

// Why a call or action didn't run, as a category: the notice itself can quote titles and element lines.
export function refusalReason(text = '') {
  const reasons = [[/app changed/, 'app changed'], [/window or URL changed|Selected window changed|nothing from this call ran|window changed/i, 'window changed'],
    [/^Input lease|Input lease/, 'input lease'], [/Document scope/, 'document scope'], [/Change review/, 'change review'],
    [/rule '.*' stopped a transfer|flow rule/i, 'flow rule'], [/\b(?:declined|denied|not approved)\b/i, 'approval declined'],
    [/payment|purchase|checkout/i, 'payment confirmation'], [/changed since|changed what element/, 'element changed'],
    [/no element with|elements with/, 'element not found'], [/the user (?:changed|switched)/, 'user changed the app'],
    [/sleight stopped|stopped this call/, 'stopped by sleight']];
  return reasons.find(([pattern]) => pattern.test(text))?.[1];
}

// The engine browser path's input methods (tab handles and their locators). The guard records no per-action outcomes there
// (the relay gives browser calls no outcome mark), so the log counts the call sites in the code: an estimate, where a loop
// counts once and an untaken branch counts. Strings, comments and regular expression literals are left out first.
const BROWSER_ACTIONS = /\.\s*(?:click|dblclick|drag|dragTo|scroll|selectText|setValue|performSecondaryAction|paste|pressKey|typeText|fill|press|type|check|uncheck|selectOption|hover|goto|reload|goBack|goForward)\s*\(/g;
function codeOnly(code) {
  let out = '', last = '';
  for (let i = 0; i < code.length;) {
    const c = code[i], next = code[i + 1];
    let end = i + 1;
    if (c === '/' && next === '/') { end = code.indexOf('\n', i); if (end < 0) end = code.length; }
    else if (c === '/' && next === '*') { end = code.indexOf('*/', i + 2); end = end < 0 ? code.length : end + 2; }
    else if (c === '"' || c === "'" || c === '`' || c === '/' && (!last || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.trimEnd()))) {
      let klass = false;
      for (end = i + 1; end < code.length; end++) {
        const d = code[end];
        if (d === '\\') { end++; continue; }
        if (c === '/' && d === '\n') break;
        if (c === '/' && d === '[') klass = true;
        else if (c === '/' && d === ']') klass = false;
        else if (d === c && !klass) { end++; break; }
      }
    } else { out += c; if (!/\s/.test(c)) last = c; i = end; continue; }
    out += ' '; last = 'x'; i = end;
  }
  return out;
}
export function browserActionCount(code) {
  if (typeof code !== 'string' || code.length > 200000) return 0;
  return Math.min(100, [...codeOnly(code).matchAll(BROWSER_ACTIONS)].length);
}

// A turbo step's outcome as a category: the outcome text quotes addresses and dialogs from the page.
function turboOutcome(text) {
  return [[/^navigated/, 'navigated'], [/^new document/, 'new document'], [/^dialog /, 'dialog opened'], [/opened (?:a |background )?tab/, 'tab opened'],
    [/^tab closed/, 'tab closed'], [/unconfirmed/, 'unconfirmed'], [/^form changed/, 'form changed'], [/lines changed/, 'changed'],
    [/no visible change/, 'no visible change'], [/^set$/, 'set'], [/^request finished/, 'request finished']].find(([pattern]) => pattern.test(text))?.[1] ?? 'sent';
}

// The log lives under ~/Library/Logs/sleight/: SLEIGHT_ACTION_LOG is a file name there, or a path under it.
export const logRoot = (home = homedir()) => join(home, 'Library', 'Logs', 'sleight');
export function actionLogPath(value, home = homedir()) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) return;
  const root = logRoot(home);
  if (!value.includes('/')) return /^[\w.-]+$/.test(value) && !/^\.\.?$/.test(value) ? join(root, value) : undefined;
  const path = value.startsWith('~/') ? join(home, value.slice(2)) : value;
  return isAbsolute(path) && resolve(path).startsWith(root + '/') ? resolve(path) : undefined;
}

export class ActionLog {
  // clock: milliseconds for each call's time (ms): from when the relay sent it on (its request, for sleight's own tools) to
  // its reply, less the approval prompts open meanwhile. pid tells sessions sharing one log apart.
  constructor({ path, root = logRoot(), maxBytes = 5 * 1024 * 1024, keep = 2, now = () => new Date(), clock = () => performance.now(), pid = process.pid,
    home = homedir(), names } = {}) {
    this.path = path; this.root = root; this.maxBytes = maxBytes; this.keep = keep; this.now = now; this.clock = clock; this.pid = pid; this.home = home;
    this.waits = new Map();
    this.names = names; this.calls = new Map(); this.origins = new Map(); this.failures = 0; this.rotationFailures = 0;
  }
  scrub(text) {
    this.names ??= ownerNames().filter(Boolean).sort((a, b) => b.length - a.length);
    // Strip shell characters first: removing one must not reconstruct an owner's name after scrubbing.
    let clean = String(text).replace(/[$`\\]/g, '').replaceAll(this.home, '~');
    for (const name of this.names) clean = clean.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), '[owner]');
    // No $, backtick or backslash: a shell reading a line in double quotes would expand them.
    return clean.slice(0, 60);
  }
  request(msg) {
    if (msg?.method !== 'tools/call' || msg.id === undefined) return;
    const name = msg.params?.name, args = msg.params?.arguments ?? {};
    if (typeof name !== 'string' || name === 'turn_ended' || name === 'js_reset') return;
    // A call the user stopped gets no reply here, so the oldest entries go once 200 wait.
    if (this.calls.size >= 200) this.calls.delete(this.calls.keys().next().value);
    this.calls.set(msg.id, { name, args, outcomes: [], start: this.clock() });
  }
  // The relay sent the call on to the engine or turbo: its time starts here, after sleight's own checks.
  sent(id) {
    const call = this.calls.get(id);
    if (call && call.sent === undefined) call.sent = this.clock();
  }
  // An approval prompt opened or was answered. Its time comes off every call in flight.
  waitStart(key) {
    if (this.waits.size >= 50) this.waits.delete(this.waits.keys().next().value);
    if (!this.waits.has(key)) this.waits.set(key, this.clock());
  }
  waitEnd(key) {
    const start = this.waits.get(key);
    if (start === undefined) return;
    this.waits.delete(key);
    const end = this.clock();
    for (const call of this.calls.values()) if ((call.pauses ??= []).length < 50) call.pauses.push([start, end]);
  }
  // Reads the relay sent this call as changed lines or left out (compact-reads.mjs); a continued call adds the rest's.
  saved(id, count) {
    const call = this.calls.get(id);
    if (call && Number.isSafeInteger(count) && count > 0) call.saved = Math.min(1000, (call.saved ?? 0) + count);
  }
  // A guarded call's records; a continued call adds the rest's.
  outcomes(id, record) {
    const call = this.calls.get(id);
    if (!call || !Array.isArray(record?.outcomes)) return;
    call.outcomes.push(...record.outcomes);
    call.planned = record.planned; call.app = typeof record.app === 'string' ? record.app : call.app;
    if (Number.isSafeInteger(record.dropped) && record.dropped > 0) call.dropped = (call.dropped ?? 0) + record.dropped;
  }
  reply(msg) {
    const call = msg?.method === undefined && this.calls.get(msg?.id);
    if (!call) return;
    this.calls.delete(msg.id);
    const end = this.clock(), start = call.sent ?? call.start;
    // A prompt still open counts only for calls already running when it opened, so one whose answer never came back
    // can't zero every later call. One prompt can show as two waits (the engine's and the client's), so overlaps count once.
    const pauses = [...call.pauses ?? [], ...[...this.waits.values()].filter(opened => opened >= start).map(opened => [opened, end])]
      .map(([a, b]) => [Math.max(a, start), Math.min(b, end)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    let paused = 0, reach = start;
    for (const [a, b] of pauses) { if (b > reach) { paused += b - Math.max(a, reach); reach = b; } }
    const ms = Number.isFinite(end - start - paused) ? Math.max(0, Math.round(end - start - paused)) : undefined;
    const text = (msg.result?.content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
    const tool = TOOLS.has(call.name) ? call.name : 'other';
    const error = !!msg.error || !!msg.result?.isError, base = { call: typeof msg.id === 'string' ? this.scrub(msg.id) : msg.id, tool };
    // A category means sleight or the user refused it; anything else is an error from the engine or the app.
    const refused = row => {
      const reason = refusalReason(msg.error?.message ?? text);
      return { ...row, result: reason ? 'refused' : 'failed', reason: reason ?? 'error' };
    };
    const rows = [];
    if (call.name === 'js') {
      const app = call.app ? { app: this.scrub(call.app) } : {};
      // The engine's browser path, from the engine's own reply; an error reply that lost it counts as native.
      const surface = msg.result?._meta?.['codex/toolSurface']?.kind === 'browserUse' ? { surface: 'browser' } : {};
      call.outcomes.forEach((rec, i) => {
        const targetRole = role(rec.t?.r), key = loggedKey(rec.k);
        const target = targetRole ? { role: targetRole, ...(rec.t.s ? { secure: true } : genericName(rec.t.m) ? { name: rec.t.m } : {}) } : undefined;
        const facts = Array.isArray(rec.f) ? rec.f.map(logged).filter(Boolean) : [];
        rows.push({ ...base, ...app, kind: ACTIONS.has(rec.a) ? rec.a : 'action', ...(target ? { target } : {}), ...(Number.isSafeInteger(rec.c) ? { chars: rec.c } : {}),
          ...(key ? { key } : {}),
          ...(rec.x === 'refused' ? { result: 'refused', reason: REASONS.has(rec.r) ? rec.r : 'stopped by sleight' } : rec.x === 'failed' ? { result: 'failed', reason: 'engine error' }
            : { result: 'ok', outcome: facts.length ? facts.join('; ') : rec.g && call.outcomes[i + 1] ? 'checked with the next action' : 'unverified' }) });
      });
      // Actions past the guard's 30-record cap ran but have no record: one row says how many.
      const dropped = call.dropped ?? 0;
      if (dropped) rows.push({ ...base, ...app, kind: 'rest', count: dropped, result: 'not logged', reason: 'record cap' });
      const stopped = call.outcomes.findIndex(rec => rec.x);
      if (stopped >= 0 && Number.isSafeInteger(call.planned) && call.planned > call.outcomes.length + dropped) {
        rows.push({ ...base, ...app, kind: 'rest', count: call.planned - call.outcomes.length - dropped, result: 'not run', reason: `stopped after ${stopped}` });
      }
      if (!rows.length && error) rows.push(refused({ ...base, ...app, kind: 'call', ...surface }));
      const named = surface.surface && !rows.length ? browserActionCount(call.args.code) : 0;
      if (named) rows.push({ ...base, ...app, kind: 'call', ...surface, actions: named, result: 'ok', outcome: 'unverified' });
      if (!rows.length && call.saved) rows.push({ ...base, ...app, kind: 'read', result: 'ok', outcome: 'compacted' });
    } else if (/^browser_/.test(call.name)) {
      rows.push(...this.turbo(call, text, error, base, refused));
      // A diff since the last snapshot in place of the page: one read saved.
      // Only sleight's own header counts: the first line that starts with "# " comes before any page content.
      const header = text.split('\n').find(line => line.startsWith('# '));
      if (!error && ['browser_act', 'browser_fill', 'browser_read'].includes(call.name) &&
          /^# Changes since snapshot \d+; snapshot \d+ \(untrusted page content\)$/.test(header ?? '')) {
        call.saved = 1;
        if (!rows.length) rows.push({ ...base, ...this.where(call), kind: 'read', result: 'ok', outcome: 'compacted' });
      }
    } else {
      const { args } = call;
      const read = (call.name === 'menu_bar' && args.op === 'apps') || (['notifications', 'review_changes'].includes(call.name) && args.op === 'list');
      // An op outside the tool's own list is dropped, never written as Claude sent it.
      const op = OPS[tool]?.includes(args.op) ? ` ${args.op}` : '';
      if (!read) rows.push({ ...base, ...(typeof args.app === 'string' ? { app: this.scrub(args.app) } : {}), kind: tool + op,
        ...(error ? refused({}) : { result: 'ok', outcome: 'done' }) });
    }
    if (rows.length && call.saved) rows[0] = { ...rows[0], saved: call.saved };
    const pid = Number.isSafeInteger(this.pid) ? { pid: this.pid } : {};
    this.write(rows.map(row => ({ ...row, ...(ms === undefined ? {} : { ms }), ...pid })));
  }
  turbo(call, text, error, base, refused) {
    const { args } = call;
    const opened = /^(t[\w-]+) (https?:\/\/\S+)/m.exec(text);
    const origin = url => { try { return cleanOrigin(new URL(url).origin); } catch { return undefined; } };
    if (opened && origin(opened[2])) this.origins.set(opened[1], origin(opened[2]));
    const tab = args.tab ?? opened?.[1];
    let at = this.origins.get(tab) ?? (call.name === 'browser_open' ? origin(args.url) : undefined);
    call.origin = at;
    let where = at ? { origin: at } : {};
    if (call.name === 'browser_read' || (call.name === 'browser_tabs' && args.do === 'list')) return [];
    if (call.name === 'browser_open') return [{ ...base, ...where, kind: 'open', ...(error ? refused({}) : { result: 'ok', outcome: 'opened' }) }];
    const rows = [];
    for (const line of text.split('\n')) {
      const step = /^(\d+) (\w+)(?: ((?:f\d+)?e\d+|[sx]\d+))?: (.*)$/.exec(line) ?? (call.name === 'browser_fill' && /^()()((?:f\d+)?e\d+|[sx]\d+): (.*)$/.exec(line));
      if (!step) continue;
      const outcome = step[4].trim(), kind = !step[2] ? 'fill' : TURBO_STEPS.has(step[2]) ? step[2] : 'step', target = step[3] ? { target: { ref: step[3] } } : {};
      const row = { ...base, ...where, kind, ...target };
      // Steps after a navigation act on the new page: only its origin is kept, never the path.
      const moved = /^navigated\b/.test(outcome) && origin(/https?:\/\/\S+/.exec(outcome)?.[0]);
      if (moved) { at = moved; where = { origin: at }; if (tab) this.origins.set(tab, at); }
      rows.push({ ...row,
        ...(/^not reached/.test(outcome) ? { result: 'not run', reason: 'earlier step stopped' }
          : /^not run/.test(outcome) ? { result: 'refused', reason: /covered/.test(outcome) ? 'covered' : 'stopped by sleight' }
          : { result: 'ok', outcome: turboOutcome(outcome) }) });
    }
    if (!rows.length && error) rows.push(refused({ ...base, ...where, kind: base.tool === 'other' ? 'other' : base.tool.slice(8) }));
    if (!rows.length && call.name === 'browser_tabs') rows.push({ ...base, ...where, kind: OPS.browser_tabs.includes(args.do) ? `tabs ${args.do}` : 'tabs', result: 'ok', outcome: 'done' });
    return rows;
  }
  where(call) { return call.origin ? { origin: call.origin } : {}; }
  write(rows) {
    if (!rows.length || !this.path) return false;
    const time = this.now().toISOString();
    const text = rows.map(row => JSON.stringify({ time, ...row })).join('\n') + '\n';
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Checked on every write: the root is a real folder of this account that no one else can write, and a symlinked
      // folder under it can't lead the log out.
      const top = lstatSync(this.root);
      if (!top.isDirectory() || top.uid !== process.getuid() || top.mode & 0o022) throw new Error('action log folder is not private');
      const root = realpathSync(this.root);
      if (!(realpathSync(dirname(this.path)) + '/').startsWith(root + '/')) throw new Error('action log outside its folder');
      try {
        const stat = lstatSync(this.path);
        if (!stat.isFile()) throw new Error('action log is not a regular file');
        if (stat.size + text.length > this.maxBytes) try { this.rotate(text.length); } catch {
          // Rotation is optional; report its failure separately and keep appending the row.
          if (++this.rotationFailures === 1) try { process.stderr.write('sleight: could not rotate the action log; check its folder permissions and rotation lock.\n'); } catch {}
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // O_NOFOLLOW: a symlink at the path can't send the log elsewhere. O_NONBLOCK: a FIFO can't hold the open.
      const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      let fd, created = true;
      try { fd = openSync(this.path, flags | constants.O_CREAT | constants.O_EXCL, 0o600); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        created = false;
        fd = openSync(this.path, flags);
      }
      try {
        // One link only: a hard link to a shell startup file would take the rows. A file the log didn't create must
        // already be private.
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw new Error('action log is not a single-link regular file of this account');
        if (created) fchmodSync(fd, 0o600);
        else if ((stat.mode & 0o777) !== 0o600) throw new Error('action log is not 0600');
        writeSync(fd, text);
      } finally { closeSync(fd); }
      return true;
    } catch {
      if (++this.failures === 1) try { process.stderr.write('sleight: could not write the action log; check its folder, file permissions and rotation lock.\n'); } catch {}
      return false;
    }
  }
  // Sessions can share one log, so rotation runs only under a lock file and checks the size again there: a session
  // whose look predates another's rotation would otherwise rotate the fresh file and push the old rows off the end.
  // Without the lock the row goes into the current file, a little over the size, and the next write rotates.
  rotate(adding) {
    const lock = `${this.path}.lock`, flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    let fd;
    try { fd = openSync(lock, flags, 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Only one session may recover a stale lock. Recheck its age after the exclusive claim: a different
      // session may already have replaced the stale file with a fresh lock while we waited.
      if (age(lock) < 30000) return;
      const reclaim = lock + '.reclaim';
      let claim;
      try { claim = openSync(reclaim, flags, 0o600); } catch (error) {
        if (error.code === 'EEXIST') {
          // A recovery holder can die too. Leave live holders alone; retry recovery on the next write.
          if (age(reclaim) >= 30000) {
            // Move first, then check the file we actually took. The old pathname may now name a fresh holder.
            const expired = reclaim + '.' + randomUUID();
            try { renameSync(reclaim, expired); } catch (error) {
              if (error.code === 'ENOENT') return; // another session took it first
              throw error;
            }
            if (Date.now() - lstatSync(expired).mtimeMs >= 30000) unlinkSync(expired);
            else {
              // Never overwrite a new claim. If one won the name, retain the moved holder at its unique path.
              linkSync(expired, reclaim);
              unlinkSync(expired);
            }
          }
          return;
        }
        throw error;
      }
      try {
        if (age(lock) < 30000) return;
        unlinkSync(lock);
        try { fd = openSync(lock, flags, 0o600); } catch (error) {
          if (error.code === 'EEXIST') return;
          throw error;
        }
      } finally {
        try { closeSync(claim); } catch {}
        try { unlinkSync(reclaim); } catch {}
      }
    }
    try {
      let stat;
      try { stat = lstatSync(this.path); } catch { return; }
      if (!stat.isFile() || stat.size + adding <= this.maxBytes) return;
      for (let n = this.keep - 1; n >= 1; n--) try { renameSync(`${this.path}.${n}`, `${this.path}.${n + 1}`); } catch {}
      renameSync(this.path, `${this.path}.1`);
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}
