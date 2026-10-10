// Fixture bookkeeping uses document IDs; cleanup never matches by title.
ObjC.import('AppKit');
function run(argv) {
  const request = JSON.parse(argv[0]);
  const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.appId ?? 'com.apple.TextEdit');
  if (request.op === 'running') return JSON.stringify({ running: Number(running.count) > 0,
    pids: Array.from({ length: Number(running.count) }, (_, i) => Number(running.objectAtIndex(i).processIdentifier)) });
  if (request.op === 'quit') {
    if (Number(running.count) !== 1) throw new Error('Expected one owned app');
    running.objectAtIndex(0).terminate;
    return JSON.stringify({ requested: true });
  }
  const app = Application('TextEdit');
  if (request.op === 'documents') return JSON.stringify(app.documents().map(doc => String(doc.name())));
  const matches = app.documents().filter(doc => String(doc.name()) === request.id);
  if (matches.length !== 1) throw new Error('Owned document ID missing or ambiguous');
  if (request.op === 'close') { matches[0].close({ saving: 'no' }); return JSON.stringify({ closed: true }); }
  throw new Error('Unknown fixture operation');
}
