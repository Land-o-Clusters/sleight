import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { macCommandSkip } from './requirements.mjs';
import { localBackendSkip, localBackends, nativeLocal } from './fixtures/mac-driver-tools.mjs';

for (const backend of localBackends) test(`${backend}: native filters preserve exact case-insensitive app matching and document-window exclusions`, { skip: localBackendSkip(backend) || backend === 'script' && macCommandSkip('osascript') }, () => {
  const result = backend === 'driver' ? JSON.stringify(nativeFilters()) : execFileSync('/usr/bin/osascript', ['-l', 'JavaScript',
    fileURLToPath(new URL('../bench/footprint-parity-filters.js', import.meta.url)),
    fileURLToPath(new URL('../plugins/sleight/lib/app-health.js', import.meta.url))], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  const { unicodeMatches, ...counts } = JSON.parse(result);
  assert.deepEqual(counts, { matches: [1, 1, 1, 0, 1], targetWindows: 3, otherWindows: 1, absentWindows: 0 });
  for (const row of unicodeMatches) assert.equal(row.native, row.original, row.selector);
});

function nativeFilters() {
  const apps = [{ name: 'TextEdit', appId: 'com.apple.TextEdit', path: '/System/Applications/TextEdit.app' },
    { name: 'Other', appId: 'org.example.other', path: '/tmp/Other.app' },
    { name: 'a" OR TRUEPREDICATE OR "b', appId: 'org.example.quote' }];
  const match = (apps, selector) => nativeLocal('matching-apps', { selector }, { apps }).result.count;
  const matches = ['textedit', 'COM.APPLE.TEXTEDIT', '/system/applications/textedit.app', 'absent', 'a" OR TRUEPREDICATE OR "b']
    .map(selector => match(apps, selector));
  const names = ['Straße', 'STRASSE', 'İ', 'i', 'ı', 'Σ', 'ς', 'σ', 'TextEdit', 'TextEdit'];
  const unicodeMatches = names.map(selector => ({ selector, native: match(names.map(name => ({ name })), selector),
    original: names.filter(name => name.toLowerCase() === selector.toLowerCase()).length }));
  const base = { kCGWindowOwnerPID: 42, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { Width: 600, Height: 400 } };
  const cg = [base, { ...base, kCGWindowAlpha: 0.1 }, { ...base, kCGWindowBounds: { Width: 100, Height: 100 } },
    { ...base, kCGWindowOwnerPID: 7 }, { ...base, kCGWindowLayer: 3 }, { ...base, kCGWindowAlpha: 0 },
    { ...base, kCGWindowBounds: { Width: 99, Height: 400 } }, { ...base, kCGWindowBounds: { Width: 600, Height: 99 } }];
  const count = pid => nativeLocal('app-health.js', { app: 'Fixture' }, { cg,
    apps: [{ name: 'Fixture', pid, tree: { AXWindows: [] } }] }).result.allWindows;
  return { matches, unicodeMatches, targetWindows: count(42), otherWindows: count(7), absentWindows: count(9) };
}
