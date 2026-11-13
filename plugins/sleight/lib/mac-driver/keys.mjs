// Inert keyboard grammar and event planner. No desktop access or engine dependency.
// DriverKeyboard.swift implements the same contract; differential tests pin both.
const order = ['control', 'alt', 'shift', 'meta'];
const modifier = {
  control: { keyCode: 59, flag: 0x40000 }, alt: { keyCode: 58, flag: 0x80000 },
  shift: { keyCode: 56, flag: 0x20000 }, meta: { keyCode: 55, flag: 0x100000 },
};
const aliases = {
  ctrl: 'control', control_l: 'control', control_r: 'control', ctrl_l: 'control', ctrl_r: 'control',
  option: 'alt', alt_l: 'alt', alt_r: 'alt', option_l: 'alt', option_r: 'alt',
  shift_l: 'shift', shift_r: 'shift', super: 'meta', command: 'meta', cmd: 'meta',
  super_l: 'meta', super_r: 'meta', meta_l: 'meta', meta_r: 'meta',
};
const named = {
  Return: 36, Tab: 48, Space: 49, BackSpace: 51, Escape: 53, Delete: 117,
  Home: 115, End: 119, PageUp: 116, PageDown: 121, Left: 123, Right: 124, Down: 125, Up: 126,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101,
  F10: 109, F11: 103, F12: 111, F13: 105, F14: 107, F15: 113, F16: 106, F17: 64, F18: 79, F19: 80, F20: 90,
  KP_Enter: 76, KP_Add: 69, KP_Subtract: 78, KP_Multiply: 67, KP_Divide: 75, KP_Decimal: 65,
  KP_Equal: 81, KP_0: 82, KP_1: 83, KP_2: 84, KP_3: 85, KP_4: 86, KP_5: 87, KP_6: 88, KP_7: 89, KP_8: 91, KP_9: 92,
};
const keyAliases = {
  enter: 'Return', esc: 'Escape', space: 'Space', backspace: 'BackSpace', del: 'Delete',
  page_up: 'PageUp', prior: 'PageUp', page_down: 'PageDown', next: 'PageDown',
  plus: '+', minus: '-', equal: '=', comma: ',', period: '.', slash: '/', backslash: '\\',
  semicolon: ';', apostrophe: "'", quotedbl: '"', grave: '`', asciitilde: '~',
  bracketleft: '[', bracketright: ']', braceleft: '{', braceright: '}',
  exclam: '!', at: '@', numbersign: '#', dollar: '$', percent: '%', asciicircum: '^',
  ampersand: '&', asterisk: '*', parenleft: '(', parenright: ')', underscore: '_',
  colon: ':', less: '<', greater: '>', question: '?', bar: '|',
};
const names = Object.fromEntries(Object.keys(named).map(key => [key.toLowerCase(), key]));
function fault(code = 'INVALID_PARAMS') { return Object.assign(new Error(code), { code }); }
const own = (table, key) => Object.hasOwn(table, key) ? table[key] : undefined;
const canonical = keys => order.filter(key => keys.includes(key));
const flags = keys => keys.reduce((value, key) => value | modifier[key].flag, 0);
const event = (type, keyCode, keys, unicode) => ({ type, keyCode, flags: flags(keys), ...(unicode === undefined ? {} : { unicode }) });

export function parseKeyChord(chord) {
  if (typeof chord !== 'string' || !chord.length || chord.length > 256 || /\s|[\x00-\x1f\x7f]/u.test(chord)) throw fault();
  const parts = chord.split('+'), modifiers = [];
  let key = null;
  for (const part of parts) {
    if (!part || key !== null) throw fault();
    const lower = part.toLowerCase(), mod = own(aliases, lower) ?? (order.includes(lower) ? lower : undefined);
    if (mod) {
      if (modifiers.includes(mod)) throw fault();
      modifiers.push(mod);
    } else {
      const resolved = own(keyAliases, lower) ?? own(names, lower) ?? part;
      if (!Object.hasOwn(named, resolved) && ([...resolved].length !== 1 || !resolved.isWellFormed())) throw fault();
      key = resolved;
    }
  }
  return { modifiers: canonical(modifiers), key };
}

function validText(text) {
  if (typeof text !== 'string' || text.length > 16384 || !text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw fault();
  return text;
}
export function keyboardArguments(method, args) {
  if (!Array.isArray(args) || args.length !== 1) throw fault();
  if (method === 'pressKey') return parseKeyChord(args[0]);
  if (method === 'typeText') return { text: validText(args[0]) };
  if (method !== 'modifiers') throw fault();
  const value = args[0];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'keys,state' ||
      !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 4 ||
      Array.from(value.keys).some(key => !order.includes(key)) || new Set(value.keys).size !== value.keys.length || !['down', 'up'].includes(value.state)) throw fault();
  return { keys: canonical(value.keys), state: value.state };
}
function mapping(key, layout) {
  if (Object.hasOwn(named, key)) return { keyCode: named[key], modifiers: [] };
  const value = layout.get(key);
  if (!value || !Number.isInteger(value.keyCode) || value.keyCode < 0 || value.keyCode > 127 ||
      !Array.isArray(value.modifiers) || Array.from(value.modifiers).some(key => !['shift', 'alt'].includes(key)) || new Set(value.modifiers).size !== value.modifiers.length) throw fault('KEY_UNMAPPABLE');
  return value;
}
function safetyKeyCodes(layout, characters, physical) {
  const codes = new Set(physical);
  for (const [character, value] of layout) {
    if ((!value.modifiers.includes('alt') && characters.includes(character)) ||
        value.safetyCharacters?.some(char => characters.includes(char))) codes.add(value.keyCode);
  }
  return codes;
}
export function clipboardKeyCodes(layout) {
  return safetyKeyCodes(layout, ['c', 'C', 'x', 'X'], [8, 7]);
}
export function refuseClipboardKeys(specs, layout) {
  const copy = clipboardKeyCodes(layout), paste = safetyKeyCodes(layout, ['v', 'V'], [9]);
  const quit = safetyKeyCodes(layout, ['q', 'Q'], [12]);
  const modifierCodes = new Set(Object.values(modifier).map(value => value.keyCode));
  for (const spec of specs) {
    if (spec.type !== 'keyDown' || modifierCodes.has(spec.keyCode)) continue;
    const command = !!(spec.flags & 0x100000), control = !!(spec.flags & 0x40000);
    const controlOnly = control && !(spec.flags & 0x180000); // Shift may accompany Control; Command and Option may not.
    if ((command || control) && (copy.has(spec.keyCode) && !controlOnly || paste.has(spec.keyCode)) ||
        command && (spec.flags & 0x20000) && [20, 21, 22, 23].includes(spec.keyCode)) {
      throw Object.assign(fault('ACTION_UNSUPPORTED'), { delivery: 'not-sent', retry: 'safe', clipboard: 'untouched' });
    }
    if (command && (quit.has(spec.keyCode) || spec.keyCode === 53 && (spec.flags & 0x80000))) throw fault('ACTION_UNSUPPORTED');
  }
}
function stroke(keyCode, keys, unicode, strategy = 'flags-changed', held = []) {
  const result = [], active = [...held], added = keys.filter(key => !held.includes(key));
  const all = canonical([...keys, ...held]);
  if (strategy !== 'flags-only') for (const key of added) {
    active.push(key);
    result.push(event(strategy === 'key-events' ? 'keyDown' : 'flagsChanged', modifier[key].keyCode, active));
  }
  if (keyCode !== null) result.push(event('keyDown', keyCode, all, unicode), event('keyUp', keyCode, all, unicode));
  if (strategy !== 'flags-only') for (const key of [...added].reverse()) {
    active.splice(active.indexOf(key), 1);
    result.push(event(strategy === 'key-events' ? 'keyUp' : 'flagsChanged', modifier[key].keyCode, active));
  }
  return result;
}
export function keyPlan(chord, layout, { strategy = 'flags-changed', held = [] } = {}) {
  if (!['flags-changed', 'flags-only', 'key-events'].includes(strategy)) throw fault();
  const parsed = parseKeyChord(chord);
  if (parsed.key === null) return stroke(null, parsed.modifiers, undefined, 'flags-changed', held); // Bare modifiers always change flags.
  const key = mapping(parsed.key, layout);
  const specs = stroke(key.keyCode, canonical([...parsed.modifiers, ...key.modifiers]), undefined, strategy, held);
  refuseClipboardKeys(specs, layout);
  return specs;
}
export function textPlan(text, layout, { unicodeOnly = false } = {}) {
  validText(text);
  if (unicodeOnly && /[\r\n\t]/u.test(text)) throw fault('ACTION_UNSUPPORTED');
  const result = [];
  let chunk = '';
  const flush = () => { if (chunk) result.push(...stroke(0, [], chunk)); chunk = ''; };
  for (const char of text) {
    if (unicodeOnly) {
      if (chunk.length + char.length > 32) flush();
      chunk += char;
      continue;
    }
    let key;
    if (char === '\n' || char === '\r') key = { keyCode: 36, modifiers: [] };
    else if (char === '\t') key = { keyCode: 48, modifiers: [] };
    else if (layout.has(char)) key = mapping(char, layout);
    if (key) { flush(); result.push(...stroke(key.keyCode, canonical(key.modifiers), char)); }
    else {
      if (chunk.length + char.length > 32) flush();
      chunk += char;
    }
  }
  flush();
  return result;
}
