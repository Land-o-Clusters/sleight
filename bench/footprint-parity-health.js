// Run the repository's own read-only helper queries in batches. No app launch or input.
ObjC.import('AppKit');
function run(argv) {
  const [sourcePath, part, selector, repetitions] = argv;
  const source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(sourcePath, $.NSUTF8StringEncoding, null));
  const queries = eval(`(function () { ${source}; return { probe, spaces, cgWindows }; })()`);
  const before = queries.probe(selector);
  if (!before.pid) throw new Error('Probe requires an identified app');
  let result;
  const start = Date.now();
  for (let i = 0; i < Number(repetitions); i++) {
    if ($.NSFileManager.defaultManager.fileExistsAtPath('/tmp/sleight-hold')) throw new Error('/tmp/sleight-hold exists');
    result = part === 'probe' ? queries.probe(selector) : part === 'spaces' ? queries.spaces(before.pid)
      : queries.cgWindows(part === 'cg-on', before.pid);
  }
  return JSON.stringify({ ms: Date.now() - start, status: before.status, windows: before.windows,
    result: Array.isArray(result) ? { count: result.length } : result });
}
