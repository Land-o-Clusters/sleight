// JXA changes only the probe's unique document. Never close the app itself.
function run(argv) {
  const [op, path, foreground] = argv;
  const app = Application('TextEdit');
  if (op === 'open') app.open(Path(path));
  const matches = app.documents().filter(doc => {
    try { return String(doc.path()) === path; } catch { return false; }
  });
  if (matches.length !== 1) throw new Error('Expected one owned document at ' + path);
  const doc = matches[0];
  if (op === 'open' || op === 'reset') {
    if (op === 'reset') doc.text = '';
    const windows = app.windows().filter(window => String(window.name()) === path.split('/').pop());
    if (windows.length !== 1) throw new Error('Expected one owned window');
    windows[0].index = 1;
    if (foreground) Application(foreground).activate();
    return;
  }
  if (op === 'read') return JSON.stringify({ text: String(doc.text()) });
  if (op === 'close') {
    doc.close({ saving: 'no' });
    if (app.documents().some(d => { try { return String(d.path()) === path; } catch { return false; } })) {
      throw new Error('Owned document remains open');
    }
    return;
  }
  throw new Error('Unknown fixture operation');
}
