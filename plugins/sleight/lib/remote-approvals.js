// Read-only CoreGraphics, Foundation and LaunchServices metadata. No AX API, event tap, Apple event or permission request.
function readPresence(api) {
  var session = api.session(), idle = api.idle();
  if (!session || !isFinite(idle) || idle < 0) return {};
  return { idleSeconds: idle, locked: session.kCGSSessionOnConsoleKey !== true ||
    session.kCGSessionLoginDoneKey !== true || session.CGSSessionScreenIsLocked === true || session.CGSSessionScreenIsLocked === 1 };
}
function readCatalog(api) {
  var apps = api.applications(), defaults = {};
  ['mailto:', '.docx', '.xlsx', '.pptx', '.ics', 'https:'].forEach(function (key) {
    try { var id = api.defaultApp(key); if (typeof id === 'string' && id) defaults[key] = id; } catch (_) {}
  });
  return { apps: apps, defaults: defaults };
}
function nativeMetadata() {
  ObjC.import('AppKit'); ObjC.import('CoreGraphics'); ObjC.import('CoreServices');
  var unwrap = function (value) { return value ? ObjC.deepUnwrap(ObjC.castRefToObject(value)) : null; };
  var fm = $.NSFileManager.defaultManager;
  return {
    idle: function () { return Number($.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF)); },
    session: function () { return unwrap($.CGSessionCopyCurrentDictionary()); },
    applications: function () {
      var result = [], seen = {}, count = 0;
      function visit(path, depth) {
        if (depth > 5 || count > 20000) return;
        var entries = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError($(path), null)) || [];
        entries.forEach(function (entry) {
          count++;
          if (entry[0] === '.') return;
          var full = path + '/' + entry;
          // Do not follow aliases or symlinks out of the ordinary app directories.
          var attrs = fm.attributesOfItemAtPathError($(full), null);
          if (!attrs || ObjC.unwrap(attrs.objectForKey($.NSFileType)) !== 'NSFileTypeDirectory') return;
          if (/\.app$/i.test(entry)) {
            var bundle = $.NSBundle.bundleWithPath($(full)); if (!bundle) return;
            var id = ObjC.unwrap(bundle.bundleIdentifier); if (!id) return;
            var info = ObjC.deepUnwrap(bundle.infoDictionary) || {}, local = ObjC.deepUnwrap(bundle.localizedInfoDictionary) || {};
            var filename = entry.replace(/\.app$/i, ''), display = local.CFBundleDisplayName || info.CFBundleDisplayName ||
              local.CFBundleName || info.CFBundleName || filename;
            // Canonicalize a path, but keep distinct installed copies ambiguous even when their bundle IDs match.
            var real = ObjC.unwrap($(full).stringByResolvingSymlinksInPath);
            if (seen[real]) return; seen[real] = true;
            result.push({ id: id, name: display, names: [display, info.CFBundleName, local.CFBundleName, filename].filter(Boolean), path: real });
          } else visit(full, depth + 1);
        });
      }
      ['/Applications', '/System/Applications', ObjC.unwrap($.NSHomeDirectory()) + '/Applications'].forEach(function (root) { visit(root, 0); });
      return result;
    },
    defaultApp: function (key) {
      if (key.slice(-1) === ':') return unwrap($.LSCopyDefaultHandlerForURLScheme($(key.slice(0, -1))));
      var uti = $.UTTypeCreatePreferredIdentifierForTag($.kUTTagClassFilenameExtension, $(key.slice(1)), null);
      return uti ? unwrap($.LSCopyDefaultRoleHandlerForContentType(uti, $.kLSRolesAll)) : null;
    }
  };
}
function run(argv) {
  try {
    var request = JSON.parse(argv[0] || '{}'), api = nativeMetadata();
    if (request.operation === 'presence') return JSON.stringify(readPresence(api));
    if (request.operation === 'catalog') return JSON.stringify(readCatalog(api));
    return JSON.stringify({ error: 'Unknown metadata operation' });
  } catch (_) { return JSON.stringify({ error: 'Mac presence or app metadata unavailable' }); }
}
