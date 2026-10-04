// Operations are confined to the unique temporary document created by the runner.
function run(argv) {
  const [op, path] = argv;
  const app = Application('TextEdit');
  if (op === 'open') {
    app.open(Path(path));
    const title = path.split('/').pop();
    const windows = app.windows().filter(window => String(window.name()) === title);
    if (windows.length !== 1) throw new Error('Expected exactly one fixture window at ' + path);
    windows[0].index = 1;
    return;
  }
  const matches = app.documents().filter(doc => {
    try { return String(doc.path()) === path; } catch { return false; }
  });
  if (matches.length !== 1) throw new Error('Expected exactly one fixture at ' + path);
  const doc = matches[0];
  if (op === 'reset') { doc.text = ''; return; }
  if (op === 'read') return JSON.stringify({ text: doc.text() });
  if (op === 'close') {
    doc.close({ saving: 'no' });
    if (app.documents().some(d => { try { return String(d.path()) === path; } catch { return false; } })) {
      throw new Error('Fixture remains open');
    }
    return;
  }
  throw new Error('Unknown fixture operation');
}
