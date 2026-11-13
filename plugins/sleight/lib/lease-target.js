// Resolve a local pointer tool's app (drag, hover) without
// activating it or choosing a window.
ObjC.import('AppKit');
// sleight's own consent host (its menu bar glove, approval and payment cards) is the binary sleight builds in its helper
// cache. Only the person's click answers it, so no local tool acts on that process (own-host.mjs).
const OWN_HOST_LINE = "That is sleight's own confirmation window; only you can answer it.";
const GLIDE_ENGINE_LINE = "That is sleight's Glide engine; tools never act on it.";
// Refusal classification only. C wins for an old driver still named consent-host.
function ownHostLine(values) {
  const names = values.map(value => String(value ?? '').trim().replace(/^.*\//, '').replace(/\.app$/i, '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const cache = /\/Library\/Caches\/sleight\/turbo-host\//i;
  const driver = /\/Library\/Caches\/sleight\/turbo-host\/mac-driver\//i;
  const prebuilt = /\/lib\/mac-driver\/prebuilt\/darwin-arm64\/glide-engine(?:\/|$)/i;
  if (names.includes('consenthost') || values.some(value => cache.test(value) && !driver.test(value))) return OWN_HOST_LINE;
  if (names.includes('glideengine') || values.some(value => driver.test(value) || prebuilt.test(value))) return GLIDE_ENGINE_LINE;
  return undefined;
}
function ownHost(app) {
  const read = fn => { try { return String(ObjC.unwrap(fn()) ?? ''); } catch (e) { return ''; } };
  return ownHostLine([read(() => app.localizedName), read(() => app.executableURL.path), read(() => app.bundleURL.path)]);
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
        const own = ownHost(app);
        if (own) return JSON.stringify({ ok: false, error: own, ownHost: true });
        matches.push({ appId, app: name, pid: Number(app.processIdentifier), title: null, url: null });
      }
    }
    if (matches.length !== 1 || !matches[0].appId) throw new Error('the local tool needs one running app with a bundle ID; launch it first');
    return JSON.stringify({ ok: true, target: matches[0] });
  } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
}
