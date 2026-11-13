// The parent owns label policy. Native key admission uses the target's layout.
import { elementLines, hasIdentifier } from '../document-scope.mjs';
import { clipboardLabelWrites, refuseClipboardLabel } from '../action-labels.mjs';
import { MAC_DRIVER_SENTENCES } from '../mac-driver/errors.mjs';
import { formatWindowsDriverError, isWindowsDriverError } from './errors.mjs';
import { parseChord, parseAccelerator } from './actions.mjs';

// WCB1 section 5 defaults. These are policy choices, not model arguments.
export const REFUSE_CONTROL_COPY = true;
export const REFUSE_ALTERNATE_CLIPBOARD_KEYS = true;
export const REFUSE_INACCESSIBLE_SEQUENCE = true;
export const REFUSE_REQUESTED_COPY = true;
export const ALLOW_MENU_MNEMONICS = true;
export const USE_SHARED_LABEL_POLICY = true;
export const EXPOSE_MENU_KEYS_IN_TREE = false;

const fault = (code, fields = {}) => Object.assign(Error(MAC_DRIVER_SENTENCES[code] ?? code), { code, ...fields });
export const refuseWindowsClipboard = () => { throw fault('ACTION_UNSUPPORTED', {
  delivery: 'not-sent', retry: 'safe', clipboard: 'untouched',
}); };

// UIA's closed role vocabulary, longest first. Labels may begin in lowercase.
const roles = ['standard window', 'menu bar', 'menu item', 'text entry area', 'text field', 'combo box', 'radio button',
  'check box', 'list item', 'scroll bar', 'progress indicator', 'tab item', 'tab group', 'split button',
  'button', 'calendar', 'text', 'image', 'link', 'list', 'menu', 'pane', 'group', 'table', 'header item', 'header',
  'tree item', 'tree', 'document', 'toolbar', 'tooltip', 'slider', 'spinner', 'status bar', 'separator', 'splitter',
  'title bar', 'window', 'dialog', 'checkbox', 'incrementor', 'tab', 'help tag', 'outline', 'row', 'cell', 'data item', 'data grid', 'custom', 'thumb'].sort((a, b) => b.length - a.length);
export function windowsActionLabel(line) {
  if (typeof line !== 'string') return null;
  const role = roles.find(r => line === r || line.startsWith(r + ' ') || line.startsWith(r + ','));
  if (!role) return null;
  // UIA appends flags after the name, unlike AX. Attribute values cannot become
  // action names (a field may contain the ordinary text "copy").
  const tail = line.slice(role.length);
  if (tail.startsWith(', ')) return '';
  return tail.replace(/^ /, '').split(/, (?=[A-Za-z][A-Za-z ]*:)/)[0]
    .replace(/(?: \((?:disabled|focused|selected|checked|mixed|collapsed|expanded)\))+$/u, '');
}
export function windowsClipboardBlockedRows(text) {
  if (!USE_SHARED_LABEL_POLICY) return [];
  return [...elementLines(text)].filter(([, line]) => clipboardLabelWrites(windowsActionLabel(line))).map(([id]) => id);
}
export function guardWindowsClipboard({ method, args, text, focusedElement }) {
  if (method === 'pressKey') {
    const chord = parseAccelerator(args[0]);
    const key = /^[a-z0-9]$/.test(chord.key ?? '') ? chord.key.toUpperCase().charCodeAt(0) : chord.virtualKey ?? 0;
    refuseWindowsKey({ key, modifiers: chord.modifiers });
  }
  if (!USE_SHARED_LABEL_POLICY || !REFUSE_REQUESTED_COPY) return;
  const rows = elementLines(text);
  let targets = [];
  if (['click', 'doubleClick', 'rightClick', 'performSecondaryAction', 'drag'].includes(method))
    targets = method === 'drag' ? args.slice(0, 2) : [args[0]];
  if (method === 'pressKey' && [13, 32].includes(parseChord(args[0]).virtualKey)) targets = [focusedElement];
  if (method === 'typeText' && /[\r\n]/.test(args[0])) targets = [focusedElement];
  for (const target of targets) {
    let line;
    if (Number.isSafeInteger(target)) line = rows.get(target);
    else if (target && typeof target === 'object' && !Array.isArray(target)) {
      const matches = [...rows.values()].filter(row => target.id !== undefined ? hasIdentifier(row, target.id)
        : target.label !== undefined ? windowsActionLabel(row) === target.label : row === target.line?.trimStart());
      if (matches.length === 1) [line] = matches;
    }
    if (line !== undefined) refuseClipboardLabel(windowsActionLabel(line));
  }
}

// Portable mirror of DriverInput.ResolveKeys and DriverClipboardRule. The injected
// mapping is a VkKeyScanExW result, including its layout-supplied modifier bits.
export function resolveWindowsKey(chord, map) {
  const parsed = typeof chord === 'string' ? parseChord(chord) : chord;
  const modifiers = [...parsed.modifiers];
  let key = parsed.virtualKey ?? 0;
  if (parsed.key !== undefined && key === 0) {
    const mapped = map(parsed.key);
    if (!Number.isInteger(mapped) || mapped < 0 || mapped > 0x7ff) throw fault('KEY_LAYOUT_UNAVAILABLE');
    key = mapped & 255;
    for (const [bit, modifier] of [[0x100, 16], [0x200, 17], [0x400, 18]])
      if ((mapped & bit) && !modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { key, modifiers };
}
export function clipboardKeyRefused({ key, modifiers }, target = false) {
  const control = modifiers.includes(17), win = modifiers.includes(91), shift = modifiers.includes(16);
  return (REFUSE_CONTROL_COPY && (control || win) && [0x43, 0x58].includes(key)) ||
    (REFUSE_ALTERNATE_CLIPBOARD_KEYS && (key === 0x2d && control || key === 0x2e && shift || key === 0x2c || key === 0x53 && win && shift)) ||
    (!target && (key === 0x56 && control || key === 0x2d && shift));
}
export function refuseWindowsKey(resolved) { if (clipboardKeyRefused(resolved)) refuseWindowsClipboard(); }
export function resolveWindowsAccelerator(text, map) {
  const chord = parseAccelerator(text);
  if (/^[a-z0-9]$/.test(chord.key ?? ''))
    return { key: chord.key.toUpperCase().charCodeAt(0), modifiers: chord.modifiers };
  // UIA's US punctuation names identify OEM virtual keys, just like A-Z.
  const oem = { ';': 0xba, ':': 0xba, '=': 0xbb, ',': 0xbc, '<': 0xbc, '-': 0xbd, '_': 0xbd,
    '.': 0xbe, '>': 0xbe, '/': 0xbf, '?': 0xbf, '`': 0xc0, '~': 0xc0,
    '[': 0xdb, '{': 0xdb, '\\': 0xdc, '|': 0xdc, ']': 0xdd, '}': 0xdd, "'": 0xde, '"': 0xde };
  if (Object.hasOwn(oem, chord.key)) return { key: oem[chord.key], modifiers: chord.modifiers };
  return resolveWindowsKey(chord, map);
}
export function clipboardTargetRefused(node, map) {
  if (!node) return false;
  if (node.clipboardBlocked) return true;
  try { return !!node.accelerator && clipboardKeyRefused(resolveWindowsAccelerator(node.accelerator, map), true); }
  catch (error) { if (error.code !== 'INVALID_PARAMS') throw error; return false; }
}
export function menuAccessMatches(access, chord) {
  const parsed = typeof chord === 'string' ? parseChord(chord) : chord;
  if (!parsed.key || parsed.key.length !== 1 || parsed.modifiers.some(m => ![16, 18].includes(m))) return false;
  const tips = typeof access === 'string' ? access.toLowerCase().split(',').map(s => s.trim()) : [];
  if (tips.length > 1 && tips[0] === 'alt' && tips.slice(1).every(s => s.length === 1)) return tips.slice(1).includes(parsed.key);
  try { return parseChord(access).key === parsed.key; }
  catch { return typeof access === 'string' && access.replace(/^&/, '').toLowerCase() === parsed.key; }
}

// The same two reads as the native watcher, supplied only by fake counters here.
export class WindowsClipboardWatch {
  constructor(sample, personInput = () => 0) { this.sample = sample; this.personInput = personInput; this.seenNonzero = false; }
  read(admitted = false) {
    let sample;
    try {
      sample = this.sample();
      if (!sample || typeof sample !== 'object' || Array.isArray(sample) || Object.keys(sample).length !== 2 ||
        !Object.hasOwn(sample, 'value') || !Object.hasOwn(sample, 'error') ||
        !Number.isInteger(sample.value) || sample.value < 0 || sample.value > 0xffffffff ||
        !Number.isInteger(sample.error) || sample.error < 0 || sample.error > 0xffffffff ||
        REFUSE_INACCESSIBLE_SEQUENCE && sample.value === 0 && (sample.error !== 0 || this.seenNonzero))
        throw Error('invalid counter sample');
      if (sample.value !== 0) this.seenNonzero = true;
      return sample.value;
    } catch { throw fault('ACTION_UNSUPPORTED', { delivery: admitted ? 'unknown' : 'not-sent',
      retry: admitted ? 'read-first' : 'safe', ...!admitted ? { clipboard: 'untouched' } : {}, reason: 'clipboard-count-unavailable' }); }
  }
  person(admitted = false) {
    try { return this.personInput(); }
    catch { throw fault('ACTION_UNSUPPORTED', { delivery: admitted ? 'unknown' : 'not-sent',
      retry: admitted ? 'read-first' : 'safe', reason: 'person-input-unavailable' }); }
  }
  admit() {
    const current = this.read();
    if (this.last !== undefined && current !== this.last && this.person() === this.lastPerson) {
      this.last = current;
      throw fault('CLIPBOARD_CHANGED', { clipboardChanged: true, delivery: 'not-sent', retry: 'read-first',
        next: 'stop-tell-user', reason: 'since-last-action' });
    }
    return current;
  }
  finish(baseline) {
    const current = this.read(true);
    this.last = current; this.lastPerson = this.person(true);
    return current !== baseline;
  }
}

// Keep the frozen Windows transport. Interpret its typed result in this adapter;
// no provider sentence is needed to select the recovery policy.
export function windowsClipboardResult(result) {
  if (!result || typeof result !== 'object') return result;
  if ('clipboardChanged' in result && (typeof result.clipboardChanged !== 'boolean' || result.clipboardChanged &&
      (!['not-sent', 'sent-unverified', 'sent-verified', 'unknown'].includes(result.delivery) ||
        result.retry !== (result.delivery === 'not-sent' ? 'safe' : 'read-first')))) throw fault('DRIVER_PROTOCOL', { unhealthy: true });
  if (result.clipboardChanged) throw fault('CLIPBOARD_CHANGED', {
    clipboardChanged: true, delivery: result.delivery, retry: 'read-first', next: 'stop-tell-user',
    ...Object.fromEntries(['escapeStops', 'counters'].filter(k => Object.hasOwn(result, k)).map(k => [k, result[k]])),
    ...result.reason === 'since-last-action' ? { reason: result.reason } : {},
  });
  if ('clipboardRefused' in result && typeof result.clipboardRefused !== 'boolean') throw fault('DRIVER_PROTOCOL', { unhealthy: true });
  if (result.clipboardRefused === true) {
    if (!['not-sent', 'unknown'].includes(result.delivery) || result.retry !== (result.delivery === 'not-sent' ? 'safe' : 'read-first'))
      throw fault('DRIVER_PROTOCOL', { unhealthy: true });
    throw fault('ACTION_UNSUPPORTED', { delivery: result.delivery, retry: result.retry,
      ...Object.fromEntries(['escapeStops', 'counters'].filter(k => Object.hasOwn(result, k)).map(k => [k, result[k]])),
      ...result.delivery === 'not-sent' ? { clipboard: 'untouched' } : {},
      ...result.reason === 'clipboard-count-unavailable' ? { reason: result.reason } : {},
    });
  }
  return result;
}

// Executable mirror of RunAction's admission boundary. Native fixtures inject
// the same synthetic layouts and menu metadata, without calling a Windows API.
export function admitWindowsClipboardAction({ method, args, nodes, resolveTarget, map }) {
  const chord = method === 'pressKey' ? parseChord(args[0]) : undefined;
  const focused = nodes.filter(n => n.focused);
  if (['typeText', 'paste', 'pressKey'].includes(method) && focused.length !== 1) throw fault('NO_BACKGROUND_FOCUS');
  const node = ['typeText', 'paste', 'pressKey'].includes(method) ? focused.length === 1 ? focused[0] : undefined : resolveTarget(args[0]);
  const resolved = chord ? resolveWindowsKey(chord, map) : undefined;
  if (resolved) refuseWindowsKey(resolved);
  const check = target => { if (clipboardTargetRefused(target, map)) refuseWindowsClipboard(); };
  const textActivates = method === 'typeText' && /[\r\n]/.test(args[0]);
  if (!['typeText', 'paste', 'pressKey'].includes(method) || [13, 32].includes(resolved?.key) || textActivates) check(node);
  if (method === 'drag') check(resolveTarget(args[1]));
  let accelerator;
  if (chord) {
    // A standalone Alt starts an opaque ribbon sequence. There is no letter to
    // bind to UIA yet, so refuse before its first post rather than track guesses.
    if (chord.key === undefined && chord.modifiers.includes(18)) throw fault('ACTION_UNSUPPORTED', {
      delivery: 'not-sent', retry: 'safe', clipboard: 'untouched', reason: 'key-tip-target-unresolved',
    });
    const matches = nodes.filter(n => {
      try { return n.accelerator && parseAccelerator(n.accelerator).canonical === chord.canonical; } catch { return false; }
    });
    if (matches.length === 1) { [accelerator] = matches; check(accelerator); }
    if (chord.modifiers.includes(18) || nodes.some(n => n.role === 'menu' || n.className === '#32768')) {
      const targets = nodes.filter(n => menuAccessMatches(n.access, chord));
      if (chord.key?.length === 1 && chord.modifiers.includes(18) && targets.length === 0) throw fault('ACTION_UNSUPPORTED', {
        delivery: 'not-sent', retry: 'safe', clipboard: 'untouched', reason: 'key-tip-target-unresolved',
      });
      for (const item of targets) {
        if (!ALLOW_MENU_MNEMONICS) refuseWindowsClipboard();
        check(item);
      }
    }
  }
  return { node, accelerator, resolved };
}

export function runWindowsClipboardTransaction(watch, send, settle, read, requireSession = () => {}) {
  requireSession();
  const baseline = watch.admit();
  let value;
  try {
    value = send();
    settle(); read();
  } catch (error) {
    // Also compare on a partial input, failed settle or failed result read.
    const changed = watch.finish(baseline);
    windowsClipboardResult({ clipboardChanged: changed, delivery: 'sent-unverified', retry: 'read-first' });
    throw error;
  }
  const changed = watch.finish(baseline);
  windowsClipboardResult({ clipboardChanged: changed, delivery: 'sent-unverified', retry: 'read-first' });
  return value;
}

// The shared Windows REPL projects message, delivery and retry. Carry the Mac's
// existing stop directive in that message, without expanding shared IPC fields.
export function windowsClipboardError(error) {
  if (error?.code === 'CLIPBOARD_CHANGED' || isWindowsDriverError(error)) error.message = formatWindowsDriverError(error, { action: true });
  return error;
}
