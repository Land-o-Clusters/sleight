// Clipboard spellings are a union of the native and browser key vocabularies.
// The safety check runs before either grammar, so invalid aliases fail closed too.
export const clipboardModifiers = ['Meta', 'Control', 'ControlOrMeta', 'Cmd', 'Command', 'super',
  'Ctrl', 'Super_L', 'Super_R', 'Meta_L', 'Meta_R', 'Control_L', 'Control_R', 'Ctrl_L', 'Ctrl_R'];
export const clipboardKeys = ['c', 'x', 'v', 'KeyC', 'KeyX', 'KeyV'];
const caseVariants = chord => {
  const parts = chord.split('+');
  return [chord, chord.toLowerCase(), chord.toUpperCase(),
    ...parts.flatMap((part, index) => [part.toLowerCase(), part.toUpperCase()].map(variant =>
      parts.map((value, at) => at === index ? variant : value).join('+')))];
};
export const clipboardChords = [...new Set([
  ...clipboardModifiers.flatMap(mod => clipboardKeys.flatMap(key => [
    `${mod}+${key}`, `${mod}+Shift+${key}`, `Shift+${mod}+${key}`,
    `${mod}+Alt+${key}`, `Alt+${mod}+${key}`,
    `${mod}+Alt+Shift+${key}`, `${mod}+Shift+Alt+${key}`,
    `Alt+${mod}+Shift+${key}`, `Alt+Shift+${mod}+${key}`,
    `Shift+${mod}+Alt+${key}`, `Shift+Alt+${mod}+${key}`,
  ])),
  ...['ControlOrMeta', 'Control', 'Ctrl', 'Control_L', 'Control_R', 'Ctrl_L', 'Ctrl_R'].flatMap(mod => [`${mod}+Insert`, `Shift+${mod}+Insert`]),
  'Shift+Insert', 'Shift_L+Insert', 'Shift_R+Insert', 'Shift+Delete', 'Shift_L+Delete', 'Shift_R+Delete', 'Shift+Del',
].flatMap(caseVariants))];
