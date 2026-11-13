// Offline build-policy scan. No native code or Windows API runs here.
const sequenceBoundary = '    [DllImport("user32.dll", EntryPoint = "GetClipboardSequenceNumber", SetLastError = true)] static extern uint Sequence();';
function assertNoClipboardMessages(source, path) {
  if (/\bWM_(?:COPY|CUT|PASTE|CLEAR)\b|\b0x0*30[0-3](?:u|l|ul|lu)?\b|\b(?:Send|Post)Message\w*\s*\([^,]*,[^,;]*\b(?:768|769|770|771)(?:u|l|ul|lu)?\b/i.test(source) ||
      /\bclip\.exe\b|\b(?:get|set)-clipboard\b/i.test(source)) throw Error('clipboard message or command: ' + path);
}
export function assertWindowsClipboardSources(sources) {
  let boundaries = 0;
  for (const [path, source] of Object.entries(sources)) {
    let checked = source;
    if (path === 'native/win/DriverClipboard.cs') {
      const sequenceReferences = (source.match(/\bSequence\b/g) ?? []).length;
      if (sequenceReferences !== 2) throw Error('clipboard sequence use count');
      if (!source.includes(sequenceBoundary)) throw Error('clipboard sequence boundary missing');
      checked = source.replace(sequenceBoundary, ''); boundaries++;
    }
    if (path !== 'native/win/DriverClipboard.cs' && /\bSequence\b/.test(source)) throw Error('clipboard sequence alias outside boundary');
    if (/\bSystem\s*\.\s*Windows\s*\.\s*Forms\s*\.\s*Clipboard\b|[\"']Clipboard[\"']/.test(checked)) throw Error('managed clipboard class: ' + path);
    const code = checked.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"/g, '');
    if (/\bClipboard\b/.test(code)) throw Error('managed clipboard class: ' + path);
    // Catch clipboard API families, including format/listener APIs and the
    // managed class. Only the exact reviewed declaration above is exempt.
    assertNoClipboardMessages(checked, path);
    if (/\b(?:[A-Za-z_]\w*Clipboard\w*|Clipboard(?=\s*[.(]))\b/i.test(checked.replace(/\b(?:DriverClipboard|DriverClipboardRule|DriverClipboardWatch|RefuseClipboardTarget|ClipboardChangeResult|ClipboardBlocked|RefuseAlternateClipboardKeys)\b/g, '')))
      throw Error('clipboard API outside the sequence boundary: ' + path);
  }
  if (boundaries !== 1) throw Error('expected one clipboard sequence boundary');
}

export function assertWindowsClipboardParentSources(sources) {
  for (const [path, source] of Object.entries(sources)) {
    assertNoClipboardMessages(source, path);
    if (/\b(?:Open|Close|Empty|Get|Set|OleGet|OleSet|Enum|Count|Add|Remove|Register|Change|Is)\w*Clipboard\w*\b/i.test(source) || /\bClipboard\b/.test(source) ||
        /\b(?:clipboardy|pbcopy|pbpaste)\b/.test(source)) throw Error('clipboard API in Windows parent: ' + path);
  }
}
