// Inspect and close only the probe at the runner's exact owned bundle path.
ObjC.import('AppKit');
function run(argv) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if (ObjC.unwrap(app.bundleURL.path) === argv[1]) {
      if (argv[0] === 'quit') app.terminate;
      return 'true';
    }
  }
  return 'false';
}
