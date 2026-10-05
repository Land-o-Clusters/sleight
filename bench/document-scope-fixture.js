// Only opens, selects, reads and closes the two paths made by the live check.
function run(argv) {
  const [operation, first, second] = argv;
  const app = Application('TextEdit');
  const name = path => path.split('/').pop();
  if (operation === 'open') {
    app.open(Path(second));
    app.open(Path(first));
  } else if (operation === 'select') {
    app.windows.byName(name(first)).index = 1;
  } else if (operation === 'read') {
    return JSON.stringify({ first: app.documents.byName(name(first)).text(), second: app.documents.byName(name(second)).text() });
  } else if (operation === 'close') {
    for (const path of [first, second]) {
      const doc = app.documents.byName(name(path));
      if (doc.exists()) doc.close({ saving: 'no' });
      if (doc.exists()) throw new Error('fixture document is still open: ' + name(path));
    }
  } else throw new Error('unknown fixture operation');
}
