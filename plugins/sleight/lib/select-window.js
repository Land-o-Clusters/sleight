// AXRaise/AXMain choose a window without activating its app. No input is sent.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
// sleight's own consent host (its menu bar glove, approval and payment cards) is the binary sleight builds in its helper
// cache. Only the person's click answers it, so no local tool acts on that process (own-host.mjs).
const OWN_HOST_LINE = "That is sleight's own confirmation window; only you can answer it.";
function ownHost(app) {
  const read = fn => { try { return String(ObjC.unwrap(fn()) ?? ''); } catch (e) { return ''; } };
  return /\/Library\/Caches\/sleight\/turbo-host\//i.test(read(() => app.executableURL.path)) || /^consent-host$/i.test(read(() => app.localizedName).trim());
}
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    const hasTitle = request.title !== undefined, hasURL = request.url !== undefined;
    if (!request.app || hasTitle === hasURL || (hasTitle && typeof request.title !== 'string')) throw new Error('Supply app and exactly one of title or file URL');
    if (request.url && !request.url.startsWith('file://')) throw new Error('URL must be a file URL');
    if (request.windowNumber !== undefined && (!Number.isSafeInteger(request.windowNumber) || request.windowNumber <= 0)) throw new Error('Invalid window number');
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications, matches = [];
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      const appId = ObjC.unwrap(app.bundleIdentifier), name = ObjC.unwrap(app.localizedName);
      const path = app.bundleURL.isNil() ? null : ObjC.unwrap(app.bundleURL.path);
      if ([appId, name, path].includes(request.app)) {
        if (ownHost(app)) throw new Error(OWN_HOST_LINE);
        matches.push({ app, appId, name });
      }
    }
    if (matches.length !== 1 || !matches[0].appId) throw new Error('Selection needs one running app with a bundle ID');
    const { app, appId, name } = matches[0];
    if (request.expectedAppId && appId !== request.expectedAppId) throw new Error('The running app changed after its lease was acquired');
    const processes = Application('System Events').processes.whose({ unixId: app.processIdentifier })();
    if (processes.length !== 1) throw new Error('Selection needs one Accessibility process');
    const attribute = (window, key) => {
      try { return window.attributes.byName(key).value(); } catch { return null; }
    };
    const windows = processes[0].windows(), selected = [], suffixes = [];
    let exactTitle = false, matchedEnding = false;
    let cg;
    const windowNumber = window => {
      const direct = attribute(window, 'AXWindowNumber');
      if (Number.isSafeInteger(direct) && direct > 0) return direct;
      try {
        if (!cg) {
          const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0));
          cg = Array.from({ length: Number(list.count) }, (_, i) => ObjC.deepUnwrap(list.objectAtIndex(i)));
        }
        const p = window.position(), s = window.size();
        if (![...p, ...s].every(Number.isFinite)) return null;
        const matches = cg.filter(info => Number(info.kCGWindowOwnerPID) === Number(app.processIdentifier) && info.kCGWindowLayer === 0 &&
          ['X', 'Y', 'Width', 'Height'].every((key, i) => Math.abs(info.kCGWindowBounds?.[key] - [...p, ...s][i]) < 0.5));
        return matches.length === 1 ? matches[0].kCGWindowNumber : null;
      } catch { return null; }
    };
    const canonical = value => {
      try {
        const url = $.NSURL.URLWithString(value);
        return url.isNil() || !url.isFileURL ? null : ObjC.unwrap(url.URLByResolvingSymlinksInPath.path);
      } catch { return null; }
    };
    const wantedURL = hasURL ? canonical(request.url) : null;
    if (hasURL && !wantedURL) throw new Error('URL must be a file URL');
    const allowEnding = hasTitle && Array.from(request.title.trim().replace(/[\p{Cf}\p{M}]/gu, '')).length >= 12;
    for (const window of windows) {
      const title = attribute(window, 'AXTitle');
      if (hasTitle && title === request.title) exactTitle = true;
      const document = attribute(window, 'AXDocument');
      const file = document && canonical(document);
      if (allowEnding && typeof title === 'string' && title.endsWith(request.title) &&
          (title.length === request.title.length || /\s/.test(title[title.length - request.title.length - 1]))) {
        suffixes.push({ window, title, url: document || null, validDocument: !document || !!file });
      }
      if (document && !file) continue;
      if ((hasTitle ? title === request.title : file && file === wantedURL) &&
          (request.windowNumber === undefined || windowNumber(window) === request.windowNumber)) {
        selected.push({ window, title, url: document || null });
      }
    }
    if (hasTitle && !exactTitle) {
      if (suffixes.length > 1) {
        const shown = suffixes.slice(0, 5);
        const titles = shown.map(target => {
          const chars = Array.from(target.title);
          return chars.length > 200 ? chars.slice(0, 197).join('') + '...' : target.title;
        });
        throw new Error(/* notice */ `Title ending found ${suffixes.length} windows: ${JSON.stringify(titles)}${suffixes.length > 5 ? ` and ${suffixes.length - 5} more` : ''}. Window numbers: ${JSON.stringify(shown.map(target => windowNumber(target.window)))}`);
      }
      if (suffixes.length === 1 && suffixes[0].validDocument &&
          (request.windowNumber === undefined || windowNumber(suffixes[0].window) === request.windowNumber)) {
        selected.push(suffixes[0]);
        matchedEnding = true;
      }
    }
    // A Finder window that navigated took its folder's title, and "found 0" alone sent Claude back
    // to reading (finder-move-2, 2026-10-17). Name what the app's windows are titled now, whole up to 120 characters:
    // a 60-character cut left a Safari profile window as "sleight benchmark — Sleight Gate 35290af9-80bf-414f-a32c-..."
    // (69 characters whole), a title nobody can copy (Safari demoid, Codex b12-r3, 2026-10-19).
    if (!selected.length) {
      const titles = windows.map(window => attribute(window, 'AXTitle')).filter(title => typeof title === 'string');
      const cut = title => JSON.stringify(title.length > 120 ? title.slice(0, 117) + '...' : title);
      throw new Error(`Expected exactly one matching window, found 0. ${name} has ${titles.length} window${titles.length === 1 ? '' : 's'} now` +
        (titles.length ? ': ' + titles.slice(0, 5).map(cut).join(', ') + (titles.length > 5 ? ` and ${titles.length - 5} more` : '') : '') +
        '. A window that navigated or was renamed is still the same window: select it by the title it has now, or act on it through the handle you have.');
    }
    if (selected.length !== 1) throw new Error(`Expected exactly one matching window, found ${selected.length}. Window numbers: ${JSON.stringify(selected.map(target => windowNumber(target.window)))}`);
    const target = selected[0];
    const active = !!app.active, frontmost = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    target.window.actions.byName('AXRaise').perform();
    target.window.attributes.byName('AXMain').value = true;
    if (!attribute(target.window, 'AXMain')) throw new Error('Window selection unconfirmed: AXMain is false');
    if (attribute(target.window, 'AXTitle') !== target.title || (attribute(target.window, 'AXDocument') || null) !== target.url) {
      throw new Error('Window selection unconfirmed: identity changed during selection');
    }
    if (!active && (app.active || $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !== frontmost)) {
      throw new Error('Window selection changed the foreground app');
    }
    // AXWindowNumber is optional on macOS; title and AXDocument alone cannot resolve duplicates.
    const number = windowNumber(target.window);
    return JSON.stringify({ ok: true, ...(matchedEnding ? { note: /* notice */ `matched by its title ending: ${target.title}` } : {}),
      target: { appId, app: name, title: target.title, url: target.url },
      identity: { pid: Number(app.processIdentifier), windowNumber: typeof number === 'number' ? number : null } });
  } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
}
