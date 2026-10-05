// AXRaise/AXMain choose a window without activating its app. No input is sent.
ObjC.import('AppKit');
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    const hasTitle = request.title !== undefined, hasURL = request.url !== undefined;
    if (!request.app || hasTitle === hasURL || (hasTitle && typeof request.title !== 'string')) throw new Error('Supply app and exactly one of title or file URL');
    if (request.url && !request.url.startsWith('file://')) throw new Error('URL must be a file URL');
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications, matches = [];
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      const appId = ObjC.unwrap(app.bundleIdentifier), name = ObjC.unwrap(app.localizedName);
      const path = app.bundleURL.isNil() ? null : ObjC.unwrap(app.bundleURL.path);
      if ([appId, name, path].includes(request.app)) matches.push({ app, appId, name });
    }
    if (matches.length !== 1 || !matches[0].appId) throw new Error('Selection needs one running app with a bundle ID');
    const { app, appId, name } = matches[0];
    if (request.expectedAppId && appId !== request.expectedAppId) throw new Error('The running app changed after its lease was acquired');
    const processes = Application('System Events').processes.whose({ unixId: app.processIdentifier })();
    if (processes.length !== 1) throw new Error('Selection needs one Accessibility process');
    const attribute = (window, key) => {
      try { return window.attributes.byName(key).value(); } catch { return null; }
    };
    const windows = processes[0].windows(), selected = [];
    const canonical = value => {
      try {
        const url = $.NSURL.URLWithString(value);
        return url.isNil() || !url.isFileURL ? null : ObjC.unwrap(url.URLByResolvingSymlinksInPath.path);
      } catch { return null; }
    };
    const wantedURL = hasURL ? canonical(request.url) : null;
    if (hasURL && !wantedURL) throw new Error('URL must be a file URL');
    for (const window of windows) {
      const title = attribute(window, 'AXTitle');
      const document = attribute(window, 'AXDocument');
      const file = document && canonical(document);
      if (document && !file) continue;
      if (hasTitle ? title === request.title : file && file === wantedURL) {
        selected.push({ window, title, url: document || null });
      }
    }
    if (selected.length !== 1) throw new Error(`Expected exactly one matching window, found ${selected.length}`);
    const target = selected[0];
    const active = !!app.active, frontmost = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    target.window.actions.byName('AXRaise').perform();
    target.window.attributes.byName('AXMain').value = true;
    if (!attribute(target.window, 'AXMain')) throw new Error('Window selection unconfirmed: AXMain is false');
    if (!active && (app.active || $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !== frontmost)) {
      throw new Error('Window selection changed the foreground app');
    }
    return JSON.stringify({ ok: true, target: { appId, app: name, title: target.title, url: target.url } });
  } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
}
