// Resolve a local pointer tool's app without activating it or choosing a window.
ObjC.import('AppKit');
function run(argv) {
  try {
    const wanted = JSON.parse(argv[0]).app;
    const matches = [];
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      const appId = ObjC.unwrap(app.bundleIdentifier);
      const name = ObjC.unwrap(app.localizedName);
      const path = app.bundleURL.isNil() ? null : ObjC.unwrap(app.bundleURL.path);
      if ([appId, name, path].includes(wanted)) matches.push({ appId, app: name, title: null, url: null });
    }
    if (matches.length !== 1 || !matches[0].appId) throw new Error('Local pointer tool needs one running app with a bundle ID');
    return JSON.stringify({ ok: true, target: matches[0] });
  } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
}
