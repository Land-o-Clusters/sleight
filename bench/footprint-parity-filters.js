// Synthetic Foundation arrays only. No real app, Accessibility or Window Server query.
ObjC.import('Foundation');
function run(argv) {
  const source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null));
  const filters = eval(`(function () { ${source}; return { matchingApps, documentWindows }; })()`);
  const count = result => Array.isArray(result) ? result.length : Number(result.count);
  const apps = $([
    { localizedName: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit', bundleURL: { path: '/System/Applications/TextEdit.app' } },
    { localizedName: 'Other', bundleIdentifier: 'org.example.other', bundleURL: { path: '/tmp/Other.app' } },
    { localizedName: 'a" OR TRUEPREDICATE OR "b', bundleIdentifier: 'org.example.quote' },
  ]);
  const matches = ['textedit', 'COM.APPLE.TEXTEDIT', '/system/applications/textedit.app', 'absent', 'a" OR TRUEPREDICATE OR "b']
    .map(selector => count(filters.matchingApps(apps, selector)));
  const base = { kCGWindowOwnerPID: 42, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { Width: 600, Height: 400 } };
  const windows = $([base, { ...base, kCGWindowAlpha: 0.1 }, { ...base, kCGWindowBounds: { Width: 100, Height: 100 } },
    { ...base, kCGWindowOwnerPID: 7 }, { ...base, kCGWindowLayer: 3 }, { ...base, kCGWindowAlpha: 0 },
    { ...base, kCGWindowBounds: { Width: 99, Height: 400 } }, { ...base, kCGWindowBounds: { Width: 600, Height: 99 } }]);
  const names = ['Straße', 'STRASSE', 'İ', 'i', 'ı', 'Σ', 'ς', 'σ', 'TextEdit', 'TextEdit'];
  const unicodeApps = $(names.map(localizedName => ({ localizedName })));
  const unicodeMatches = names.map(selector => ({ selector, native: count(filters.matchingApps(unicodeApps, selector)),
    original: names.filter(name => name.toLowerCase() === selector.toLowerCase()).length }));
  return JSON.stringify({ matches, unicodeMatches, targetWindows: count(filters.documentWindows(windows, 42)),
    otherWindows: count(filters.documentWindows(windows, 7)), absentWindows: count(filters.documentWindows(windows, 9)) });
}
