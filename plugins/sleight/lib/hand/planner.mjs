// The ghost hand's frames for one admitted js call: where and when the hand shows each action, in
// global screen points with a top-left origin (kCGWindowBounds and AX frames). Pure: the relay's hand
// session (relay-hand.mjs) gathers the geometry with locate.js beside the engine call and never awaits it.
//
// Frames are { kind, pid, windowId, at, path, delayMs, beats }. kind is click, double, right, key,
// type, drag or scroll. delayMs counts from the call's start on the design's schedule (coordinate,
// key and text actions at once, an element action after the guard's read, each later action one warm
// write after the last). beats is how many flourish pulses the host plays: 2 for a double click, a
// peck per typed character up to 8, else 1. Frames hold kinds and points only, never typed text.

// The guard's read before an element action (about 470 ms) and one warm engine write (72 ms), from the
// design's local traces (fable-1018-ghost-hand, section 1). H6 measures the drift against approvals.
export const GUARD_READ_MS = 470, WRITE_MS = 72;
const MAX_TYPE_BEATS = 8;

const KINDS = { click: 'click', doubleClick: 'double', rightClick: 'right', scroll: 'scroll', drag: 'drag',
  pressKey: 'key', typeText: 'type', paste: 'type', setValue: 'type' };
const ACTION = /\.\s*(click|doubleClick|rightClick|scroll|drag|pressKey|typeText|paste|setValue)\s*\(/y;
// As guardActions in relay.mjs: code that may run an action more than once has no fixed schedule.
const REPEATS = /\b(?:for|while|do)\b|\.(?:forEach|map|reduce|some|every|pickFromList)\(|\bsleight\s*\./;

// Tree role names to AX roles, as drag.js's elementIdentity, with the menu and pop-up controls a click names.
const ROLES = { button: 'AXButton', checkbox: 'AXCheckBox', 'radio button': 'AXRadioButton', image: 'AXImage',
  row: 'AXRow', cell: 'AXCell', group: 'AXGroup', 'text entry area': 'AXTextArea', 'text field': 'AXTextField', 'secure text field': 'AXSecureTextField',
  text: 'AXStaticText', link: 'AXLink', table: 'AXTable', outline: 'AXOutline', 'scroll area': 'AXScrollArea',
  'pop up button': 'AXPopUpButton', 'menu button': 'AXMenuButton', 'combo box': 'AXComboBox', slider: 'AXSlider' };
const ROLE_NAMES = Object.keys(ROLES).sort((a, b) => b.length - a.length);
const FIELDS = 'Description|Value|Secondary Actions|ID|Help|Details|URL';
const attributeOf = key => new RegExp('(?:^|, )' + key + ': (.*?)(?=, (?:' + FIELDS + '):|$)');
const ID_FIELD = attributeOf('ID'), DESCRIPTION_FIELD = attributeOf('Description');
const FIRST_FIELD = new RegExp('(?:^|, )(?:' + FIELDS + '): ');

// The identity drag.js matches an element by, from its tree line: AX role, AXIdentifier, AXDescription
// and title. Undefined for a line with no known role or no name.
export function handIdentity(line) {
  if (typeof line !== 'string') return undefined;
  const name = ROLE_NAMES.find(role => line === role || line.startsWith(role + ' '));
  if (!name) return undefined;
  const body = line.slice(name.length).trim().replace(/^(?:\([^()]*\)\s*)+/, '').replace(/^Selected, /, '');
  const title = body.split(FIRST_FIELD)[0] || undefined;
  const id = ID_FIELD.exec(body)?.[1], description = DESCRIPTION_FIELD.exec(body)?.[1];
  return id || description || title ? { role: ROLES[name], id, description, title } : undefined;
}
const identityKey = identity => JSON.stringify([identity.role, identity.id, identity.description, identity.title]);

// Each line's identity, parsed once per plan and only when an action names an element.
function treeIndex(lines) {
  const identities = new Map(), counts = new Map();
  for (const [number, line] of Object.entries(lines)) {
    const identity = handIdentity(line);
    if (!identity) continue;
    identities.set(Number(number), identity);
    const key = identityKey(identity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { identities, counts };
}

// Tree text or { number: line } to { number: line without indent }.
function lineMap(lines) {
  if (lines && typeof lines === 'object') return lines;
  const out = {};
  for (const m of String(lines ?? '').matchAll(/^\t*(\d+) (.+?)\r?$/gm)) out[m[1]] = m[2];
  return out;
}

// The index just past the string, template or comment starting at i, or i when none starts there.
function skipQuoted(code, i) {
  const c = code[i];
  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < code.length; j++) {
      if (code[j] === '\\') j++;
      else if (code[j] === c) return j + 1;
    }
    return code.length;
  }
  if (c === '/' && code[i + 1] === '/') { const end = code.indexOf('\n', i); return end < 0 ? code.length : end; }
  if (c === '/' && code[i + 1] === '*') { const end = code.indexOf('*/', i + 2); return end < 0 ? code.length : end + 2; }
  return i;
}

// Top-level arguments of the call whose `(` is at open, as source text, and the index past its `)`.
function callArguments(code, open) {
  const args = [];
  let depth = 0, start = open + 1;
  for (let i = open; i < code.length;) {
    const skipped = skipQuoted(code, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = code[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) {
      if (code.slice(start, i).trim()) args.push(code.slice(start, i).trim());
      return { args, end: i + 1 };
    } else if (c === ',' && depth === 1) { args.push(code.slice(start, i).trim()); start = i + 1; }
    i++;
  }
  return { args, end: code.length };
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;
function literalString(text) {
  const m = /^(["'])((?:[^\\]|\\.)*)\1$/s.exec(text ?? '');
  if (!m) return undefined;
  const body = m[1] === '"' ? m[2] : m[2].replace(/\\.|"/g, s => s === '"' ? '\\"' : s === "\\'" ? "'" : s);
  try { return JSON.parse('"' + body + '"'); } catch { return undefined; }
}
// The code with strings and comments blanked, so their text never reads as code.
function codeOnly(code) {
  let out = '';
  for (let i = 0; i < code.length;) {
    const skipped = skipQuoted(code, i);
    if (skipped !== i) { out += ' '; i = skipped; } else out += code[i++];
  }
  return out;
}
// A point, an element number, { id } or { label }, or a label string; undefined when computed in the call.
function literalTarget(text) {
  if (text === undefined) return undefined;
  if (NUMBER.test(text)) return Number.isSafeInteger(Number(text)) && Number(text) >= 0 ? { number: Number(text) } : undefined;
  const point = /^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]$/.exec(text);
  if (point) return { point: [Number(point[1]), Number(point[2])] };
  const object = /^\{\s*["']?(id|label)["']?\s*:\s*((["'])(?:[^\\]|\\.)*?\3)\s*\}$/s.exec(text);
  if (object) { const value = literalString(object[2]); return value === undefined ? undefined : { [object[1]]: value }; }
  const label = literalString(text);
  return label === undefined ? undefined : { label };
}

// The call's actions in order, outside strings and comments: { method, kind, receiver, target, to?, beats }.
function parseActions(code) {
  const actions = [];
  for (let i = 0; i < code.length;) {
    const skipped = skipQuoted(code, i);
    if (skipped !== i) { i = skipped; continue; }
    ACTION.lastIndex = i;
    const m = code[i] === '.' && ACTION.exec(code);
    if (!m) { i++; continue; }
    const receiver = /([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(Math.max(0, i - 64), i))?.[1];
    const { args, end } = callArguments(code, i + m[0].length - 1);
    const method = m[1], kind = KINDS[method];
    const action = { method, kind, receiver };
    action.target = ['pressKey', 'typeText', 'paste'].includes(method) ? { focus: true } : literalTarget(args[0]);
    if (method === 'drag') action.to = literalTarget(args[1]);
    const text = method === 'typeText' ? literalString(args[0]) : undefined;
    action.beats = kind === 'double' ? 2 : method === 'typeText' ? Math.max(1, Math.min(MAX_TYPE_BEATS, text?.length ?? 3))
      : method === 'setValue' ? Math.max(1, Math.min(MAX_TYPE_BEATS, literalString(args[1])?.length ?? 3)) : 1;
    actions.push(action);
    i = end;
  }
  return actions;
}

// A target's element number in the read, or why it has none.
function resolveNumber(target, lines, index) {
  if (target?.number !== undefined) {
    if (lines[target.number] === undefined) return { reason: 'unresolved' };
    const identity = index().identities.get(target.number);
    if (!identity) return { reason: 'no-identity' };
    return index().counts.get(identityKey(identity)) > 1 ? { reason: 'ambiguous' } : { number: target.number, identity };
  }
  if (target?.id === undefined && target?.label === undefined) return { reason: 'unresolved' };
  const found = [];
  for (const [number, identity] of index().identities) {
    if (target.id !== undefined ? identity.id === target.id : identity.title === target.label || identity.description === target.label) found.push(number);
  }
  if (found.length !== 1) return { reason: found.length ? 'ambiguous' : 'unresolved' };
  return { number: found[0], identity: index().identities.get(found[0]) };
}

// The call's actions with element numbers resolved through the read, the identities the frame helper
// looks up, and whether any action needs the focused element. { skip } for a call with no fixed plan.
export function handTargets({ code, lines, target } = {}) {
  if (typeof code !== 'string') return { actions: [], identities: {}, focus: false };
  if (REPEATS.test(codeOnly(code))) return { skip: 'loop', actions: [], identities: {}, focus: false };
  const actions = parseActions(code);
  if (!actions.length) return { actions, identities: {}, focus: false };
  if (new Set(actions.map(a => a.receiver)).size > 1) return { skip: 'several-handles', actions: [], identities: {}, focus: false };
  // A call that acquires another app acts in a window the relay hasn't leased yet.
  const acquired = [...code.matchAll(/\bcua\.getApp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')?/g)].map(m => literalString(m[1]));
  const names = [target?.app, target?.appId].filter(Boolean).map(name => name.toLowerCase());
  if (acquired.some(name => !name || !names.includes(name.toLowerCase()))) return { skip: 'acquisition', actions: [], identities: {}, focus: false };
  const map = lineMap(lines), identities = {};
  let built;
  const index = () => built ??= treeIndex(map);
  let focus = false, pointed = false;
  for (const action of actions) {
    // The guard reads the window before an element action, whatever the element turns out to be.
    action.element = !action.target?.focus && !action.target?.point;
    for (const key of ['target', 'to']) {
      const t = action[key];
      if (!t || t.point || t.focus) continue;
      const resolved = resolveNumber(t, map, index);
      action[key] = resolved.number === undefined ? { reason: resolved.reason } : { number: resolved.number };
      if (resolved.identity) identities[resolved.number] = resolved.identity;
    }
    // Keys and text go where the call last clicked or set a value, else to the focused element.
    if (action.target?.focus && pointed) action.target = { previous: true };
    else if (action.target?.focus) focus = true;
    if (['click', 'double', 'right'].includes(action.kind) || action.method === 'setValue') pointed = true;
  }
  return { actions, identities, focus };
}

const inside = (b, p) => p[0] >= b.X && p[0] < b.X + b.Width && p[1] >= b.Y && p[1] < b.Y + b.Height;
const center = r => [r.X + r.Width / 2, r.Y + r.Height / 2];
const round = p => p.map(n => Math.round(n * 100) / 100);
// drag.js's screenshotScale: pixels per point when the screenshot has this window's shape, else null.
export function screenshotScale(size, bounds) {
  if (!Array.isArray(size) || size.length !== 2 || !size.every(n => Number.isFinite(n) && n > 0) || !bounds?.Width || !bounds?.Height) return null;
  const x = size[0] / bounds.Width, y = size[1] / bounds.Height;
  return Math.abs(x - y) <= 0.03 * Math.max(x, y) && x >= 0.25 && x <= 4 ? { x, y } : null;
}

// Why the hand can't show at p over the window, or undefined. As drag.js's exposedEndpoints, any layer
// on top counts as cover, except the engine's own overlay and the hand host.
export function exposure(p, window, windows, displays, ignorePids = []) {
  if (!inside(window.bounds, p) || (Array.isArray(displays) && !displays.some(d => inside(d, p)))) return 'offscreen';
  if (!Array.isArray(windows)) return 'no-geometry';
  const top = windows.find(w => w?.bounds && inside(w.bounds, p) && !/Computer Use$/.test(w.owner ?? '') && !ignorePids.includes(w.pid));
  return top && top.id === window.windowId && top.pid === window.pid ? undefined : 'covered';
}

// lines is the last read Claude saw (tree text or { number: line }), screenshotSize that window's latest engine
// screenshot in pixels, target the leased window's header ({ app, appId }). The rest is locate.js's answer: window
// { pid, windowId, bounds }, AX element frames by number, the focused element, on-screen windows front to back,
// display frames and a window state (minimized, hidden, other-space, side-stage). Returns the frames, the skipped
// actions with their reasons, and each frame's action index (actions), which approval beats count by.
// targets is handTargets' answer for the same code and lines, when the caller already has it.
export function planHandFrames({ code, lines, screenshotSize, window, elements = {}, focused, windows, displays, state,
  target, ignorePids = [], targets, bindings = [] } = {}) {
  const plan = targets ?? handTargets({ code, lines, target });
  if (plan.skip) return { frames: [], skipped: [{ reason: plan.skip }], actions: [] };
  const frames = [], skipped = [], actions = [];
  const scale = window && screenshotScale(screenshotSize, window.bounds);
  let t = 0, last;
  plan.actions.forEach((action, index) => {
    if (action.element && !bindings.some(b => b.index === index && b.bound === true)) t += GUARD_READ_MS;
    const delayMs = t;
    t += WRITE_MS;
    const skip = reason => skipped.push({ action: index, method: action.method, reason });
    const point = x => {
      if (x?.reason) return { reason: x.reason };
      if (x?.previous) return last ? { at: last } : { reason: 'no-focus' };
      if (x?.point) return scale ? { at: [window.bounds.X + x.point[0] / scale.x, window.bounds.Y + x.point[1] / scale.y] } : { reason: 'scale' };
      if (x?.number !== undefined) {
        const frame = elements[x.number];
        return frame && [frame.X, frame.Y, frame.Width, frame.Height].every(Number.isFinite) ? { at: center(frame) } : { reason: 'element-not-found' };
      }
      if (x?.focus) {
        if (!focused) return { reason: 'no-focus' };
        if (focused.window) return { reason: 'window-focused' };
        if (!focused.inWindow || !focused.frame) return { reason: 'focus-elsewhere' };
        return { at: center(focused.frame) };
      }
      return { reason: 'unresolved' };
    };
    if (state) return skip(state);
    if (!window?.bounds) return skip('no-geometry');
    const from = point(action.target), to = action.kind === 'drag' ? point(action.to) : undefined;
    const reason = from.reason ?? to?.reason ?? exposure(from.at, window, windows, displays, ignorePids) ??
      (to ? exposure(to.at, window, windows, displays, ignorePids) : undefined);
    if (reason) return skip(reason);
    const at = round(from.at);
    if (action.kind !== 'scroll' && action.kind !== 'drag') last = at;
    frames.push({ kind: action.kind, pid: window.pid, windowId: window.windowId, at,
      path: to ? [at, round(to.at)] : [at], delayMs, beats: action.beats });
    actions.push(index);
  });
  return { frames, skipped, actions };
}
