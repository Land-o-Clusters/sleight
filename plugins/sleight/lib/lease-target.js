// Resolve a local pointer tool's app (drag, hover) without
// activating it or choosing a window.
ObjC.import('AppKit');
// sleight's own consent host (its menu bar glove, approval and payment cards) is the binary sleight builds in its helper
// cache. Only the person's click answers it, so no local tool acts on that process (own-host.mjs).
const OWN_HOST_LINE = "That is sleight's own confirmation window; only you can answer it.";
function ownHost(app) {
  const read = fn => { try { return String(ObjC.unwrap(fn()) ?? ''); } catch (e) { return ''; } };
  return /\/Library\/Caches\/sleight\/turbo-host\//i.test(read(() => app.executableURL.path)) || /^consent-host$/i.test(read(() => app.localizedName).trim());
}
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
      const fold = value => (value ?? '').toString().trim().toLowerCase();
      if ([appId, name, path].some(v => v !== undefined && v !== null && [wanted, fold(wanted)].includes(fold(v)))) {
        if (ownHost(app)) return JSON.stringify({ ok: false, error: OWN_HOST_LINE, ownHost: true });
        matches.push({ appId, app: name, pid: Number(app.processIdentifier), title: null, url: null });
      }
    }
    if (matches.length !== 1 || !matches[0].appId) throw new Error('the local tool needs one running app with a bundle ID; launch it first');
    return JSON.stringify({ ok: true, target: matches[0] });
  } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
}
