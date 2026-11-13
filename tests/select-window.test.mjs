import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { selectWindow } from '../plugins/sleight/lib/select-window.mjs';
import { callLocalTool, localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
const source = readFileSync(new URL('../plugins/sleight/lib/select-window.js', import.meta.url), 'utf8');
function select(request, windows, options = {}) {
  const events = [], list = entries => ({ count: entries.length, objectAtIndex: i => entries[i] });
  const app = { bundleIdentifier: 'com.apple.TextEdit', localizedName: 'TextEdit',
    bundleURL: { isNil: () => false, path: '/Applications/TextEdit.app' }, processIdentifier: 1, active: false };
  const otherApps = (options.otherApps ?? []).map(other => ({ ...app, ...other }));
  const workspace = { runningApplications: list(options.ambiguous ? [app, app] : [app, ...otherApps]), frontmostApplication: { processIdentifier: 2 } };
  const $ = key => key;
  Object.assign($, { NSWorkspace: { sharedWorkspace: workspace }, NSURL: { URLWithString: value => {
    const url = new URL(value);
    return { isNil: () => false, isFileURL: url.protocol === 'file:', URLByResolvingSymlinksInPath: { path: decodeURIComponent(url.pathname) } };
  } }, CGWindowListCopyWindowInfo: () => list(options.cgWindows ?? []) });
  const uiWindows = windows => windows.map(window => {
    const main = { get value() { return () => options.mainStatus !== -1; }, set value(_) {} };
    return { position: () => window.position, size: () => window.size, attributes: { byName: key => {
      if (key === 'AXMain') { events.push({ window, key }); if (options.activates) app.active = true; return main; }
      return { value: () => window[key] ?? null };
    } }, actions: { byName: action => ({ perform: () => {
      events.push({ window, action }); if (options.raiseStatus === -1) throw new Error('AXRaise failed');
      if (options.renames) window.AXTitle = 'Renamed during selection';
    } }) } };
  });
  const result = runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, request,
    Application: () => ({ processes: { whose: query => {
      const owner = [app, ...otherApps].find(app => app.processIdentifier === query.unixId);
      return () => owner ? [{ windows: () => uiWindows(owner === app ? windows : owner.windows ?? []) }] : [];
    } } }),
    ObjC: { import() {}, unwrap: x => x, deepUnwrap: x => x, castRefToObject: x => x } });
  return { result: JSON.parse(result), events };
}
const left = { AXTitle: 'left.txt', AXDocument: 'file:///tmp/left.txt' };
test('recorded unsaved TextEdit headers with equal titles refuse selection without AX input', () => {
  const recorded = JSON.parse(readFileSync(new URL('../docs/benchmarks/2026-10-04-input-lease-window-attempt.json', import.meta.url), 'utf8'));
  const tree = recorded.trials[0].error.slice(recorded.trials[0].error.indexOf('Window: '));
  // Project the same recorded header onto two native windows. The engine tree cannot separate them.
  const trees = [tree, tree];
  const windows = trees.map(tree => ({ AXTitle: JSON.parse(/^Window: ("[^"]*")/.exec(tree)[1]), AXDocument: null }));
  const { result, events } = select({ app: 'TextEdit', title: windows[0].AXTitle }, windows);
  assert.equal(result.ok, false); assert.match(result.error, /found 2/); assert.deepEqual(events, []);
});
const right = { AXTitle: 'right.txt', AXDocument: 'file:///tmp/right.txt' };
const suffix = 'Project page'; // Exactly 12 characters.
test('an exact title takes precedence over longer titles ending with it', () => {
  const exact = { AXTitle: suffix };
  const { result, events } = select({ app: 'TextEdit', title: suffix }, [
    { AXTitle: 'Work: ' + suffix }, exact, { AXTitle: 'Personal: ' + suffix },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.target.title, suffix);
  assert.equal(result.note, undefined);
  assert.equal(events[0].window, exact);
});
test('a unique title suffix selects the full title and reports the match', async () => {
  const window = { AXTitle: 'Work: Project page', AXWindowNumber: 42 };
  const { result, events } = select({ app: 'TextEdit', title: suffix }, [{ AXTitle: 'Other page' }, window]);
  assert.equal(result.ok, true);
  assert.equal(result.target.title, 'Work: Project page');
  assert.equal(result.identity.windowNumber, 42);
  assert.equal(result.note, 'matched by its title ending: Work: Project page');
  assert.deepEqual(events, [{ window, action: 'AXRaise' }, { window, key: 'AXMain' }, { window, key: 'AXMain' }]);
  const response = await selectWindow({ app: 'TextEdit', title: suffix }, {
    approve: async () => true, runScript: async () => result,
  });
  assert.equal(response.isError, undefined);
  assert.equal(JSON.parse(response.content[0].text).note, result.note);
});
test('two suffix candidates refuse and list both full titles, even with a window number', () => {
  const windows = [
    { AXTitle: 'Draft: Project page', AXWindowNumber: 11 },
    { AXTitle: 'Review: Project page', AXWindowNumber: 22 },
  ];
  for (const windowNumber of [undefined, 22]) {
    const { result, events } = select({ app: 'TextEdit', title: suffix, windowNumber }, windows);
    assert.equal(result.ok, false);
    assert.match(result.error, /found 2/);
    for (const window of windows) assert.ok(result.error.includes(window.AXTitle));
    assert.deepEqual(events, []);
  }
});
test('another profile with the same suffix counts as a second candidate', () => {
  const windows = [{ AXTitle: 'Work: Project page' }, { AXTitle: 'Personal: Project page' }];
  const { result, events } = select({ app: 'TextEdit', title: suffix }, windows);
  assert.equal(result.ok, false);
  assert.match(result.error, /found 2/);
  for (const window of windows) assert.ok(result.error.includes(window.AXTitle));
  assert.deepEqual(events, []);
});
test('an 11-character suffix refuses while its exact title still selects', () => {
  const title = '12345678901';
  const { result, events } = select({ app: 'TextEdit', title }, [{ AXTitle: 'Work: ' + title }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /found 0/);
  assert.deepEqual(events, []);
  assert.equal(select({ app: 'TextEdit', title }, [{ AXTitle: title }]).result.ok, true);
});
test('11 Unicode characters never qualify as a suffix through surrogate pairs', () => {
  const title = '\u{1F4C4}1234567890';
  const { result, events } = select({ app: 'TextEdit', title }, [{ AXTitle: 'Work: ' + title }]);
  assert.equal(result.ok, false);
  assert.deepEqual(events, []);
});
for (const [label, title] of [
  ['12 spaces', ' '.repeat(12)],
  ['outer whitespace padding', ' 12345678901 '],
  ['zero-width padding', '12345678901\u200B'],
  ['combining padding', '12345678901\u0301'],
  ['an emoji sequence', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}\uFE0F'.repeat(2)],
]) {
  test(`${label} cannot inflate a suffix to 12 characters`, () => {
    const { result, events } = select({ app: 'TextEdit', title }, [{ AXTitle: 'Work: ' + title }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /found 0/);
    assert.deepEqual(events, []);
    assert.equal(select({ app: 'TextEdit', title }, [{ AXTitle: title }]).result.ok, true);
  });
}
test('12 dots and 12 base characters with marks still qualify as suffixes', () => {
  for (const title of ['............', '123456789012\u0301\u200B']) {
    const { result } = select({ app: 'TextEdit', title }, [{ AXTitle: 'Work: ' + title }]);
    assert.equal(result.ok, true);
    assert.equal(result.target.title, 'Work: ' + title);
  }
});
test('a suffix must start after whitespace rather than inside a word', () => {
  const title = 'report-final.docx';
  for (const prefix of ['my-', 'my', '.']) {
    const { result, events } = select({ app: 'TextEdit', title }, [{ AXTitle: prefix + title }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /found 0/);
    assert.deepEqual(events, []);
  }
  for (const prefix of ['', 'Work: ', 'Work:\t', 'Work:\u2003']) {
    assert.equal(select({ app: 'TextEdit', title }, [{ AXTitle: prefix + title }]).result.ok, true);
  }
});
test('seven suffix candidates list only five titles and the omitted count', () => {
  const windows = Array.from({ length: 7 }, (_, i) => ({ AXTitle: `Profile ${i}: ${suffix}`, AXWindowNumber: i + 1 }));
  const { result, events } = select({ app: 'TextEdit', title: suffix }, windows);
  assert.equal(result.ok, false);
  assert.match(result.error, /found 7/);
  assert.match(result.error, /and 2 more/);
  for (const window of windows.slice(0, 5)) assert.ok(result.error.includes(window.AXTitle));
  for (const window of windows.slice(5)) assert.ok(!result.error.includes(window.AXTitle));
  assert.match(result.error, /Window numbers: \[1,2,3,4,5\]$/);
  assert.deepEqual(events, []);
});
test('ambiguous title previews stop at 200 characters without splitting emoji', () => {
  const long = 'A'.repeat(196) + '\u{1F4C4}'.repeat(10) + ' ' + suffix;
  const windows = [{ AXTitle: 'B'.repeat(200) + ' ' + suffix }, { AXTitle: long },
    { AXTitle: 'C'.repeat(187) + ' ' + suffix }];
  const { result, events } = select({ app: 'TextEdit', title: suffix }, windows);
  assert.equal(result.ok, false);
  const titles = JSON.parse(/windows: (\[[^\n]*?\])/.exec(result.error)[1]);
  assert.equal(titles[0], 'B'.repeat(197) + '...');
  assert.equal(titles[1], 'A'.repeat(196) + '\u{1F4C4}...');
  assert.equal(titles[2], 'C'.repeat(187) + ' Project page');
  assert.deepEqual(events, []);
});
test('an ineligible document window still makes a same-app suffix ambiguous', () => {
  const windows = [{ AXTitle: 'Work: Project page' },
    { AXTitle: 'Personal: Project page', AXDocument: 'https://example.com' }];
  const { result, events } = select({ app: 'TextEdit', title: suffix }, windows);
  assert.equal(result.ok, false);
  assert.match(result.error, /found 2/);
  for (const window of windows) assert.ok(result.error.includes(window.AXTitle));
  assert.deepEqual(events, []);
});
test('suffix matching never considers windows belonging to another app', () => {
  const otherApps = [{ bundleIdentifier: 'other.app', localizedName: 'Other', processIdentifier: 9,
    windows: [{ AXTitle: 'Other: Project page' }] }];
  const missing = select({ app: 'TextEdit', title: suffix }, [{ AXTitle: 'Unrelated' }], { otherApps });
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.error, /found 0/);
  assert.deepEqual(missing.events, []);
  const own = select({ app: 'TextEdit', title: suffix }, [{ AXTitle: 'Work: Project page' }], { otherApps });
  assert.equal(own.result.ok, true);
  assert.equal(own.result.target.appId, 'com.apple.TextEdit');
});
test('suffix matching preserves expected app, document and window-number checks', () => {
  const window = { AXTitle: 'Work: Project page', AXWindowNumber: 22 };
  for (const [request, windows] of [
    [{ expectedAppId: 'other.app' }, [window]],
    [{ windowNumber: 11 }, [window]],
    [{}, [{ ...window, AXDocument: 'https://example.com' }]],
    [{ windowNumber: 22 }, [{ AXTitle: suffix, AXWindowNumber: 11 }, window]],
  ]) {
    const { result, events } = select({ app: 'TextEdit', title: suffix, ...request }, windows);
    assert.equal(result.ok, false);
    assert.deepEqual(events, []);
  }
});
test('window numbers select one of two equal-title windows without activation', () => {
  const windows = [11, 22].map(AXWindowNumber => ({ AXTitle: 'Untitled', AXWindowNumber }));
  const { result, events } = select({ app: 'TextEdit', title: 'Untitled', windowNumber: 22 }, windows);
  assert.equal(result.ok, true);
  assert.equal(result.identity.windowNumber, 22);
  assert.equal(events[0].window, windows[1]);
  assert.equal(select({ app: 'TextEdit', title: 'Untitled', windowNumber: 33 }, windows).events.length, 0);
});
test('equal-title selection resolves a CG number when AXWindowNumber is unsupported', () => {
  const windows = [10, 400].map(x => ({ AXTitle: 'Untitled', position: [x, 20], size: [300, 200] }));
  const cgWindows = windows.map((window, i) => ({ kCGWindowOwnerPID: 1, kCGWindowLayer: 0, kCGWindowNumber: 11 + i,
    kCGWindowBounds: { X: window.position[0], Y: 20, Width: 300, Height: 200 } }));
  const { result, events } = select({ app: 'TextEdit', title: 'Untitled', windowNumber: 12 }, windows, { cgWindows });
  assert.equal(result.ok, true); assert.equal(result.identity.windowNumber, 12); assert.equal(events[0].window, windows[1]);
  assert.equal(select({ app: 'TextEdit', title: 'Untitled', windowNumber: 12 }, windows, { cgWindows: [...cgWindows, cgWindows[1]] }).events.length, 0);
});
test('window-selection opt-out leaves the other local tools enabled', () => {
  const names = env => localToolDefinitions(env).map(tool => tool.name);
  assert.ok(names({}).includes('select_window'));
  assert.deepEqual(names({ SLEIGHT_SELECT_WINDOW: '0' }), names({}).filter(name => name !== 'select_window'));
  assert.deepEqual(names({ SLEIGHT_SELECT_WINDOW: '0', SLEIGHT_DRAG: '0', SLEIGHT_MENU_BAR: '0', SLEIGHT_HOVER: '0', SLEIGHT_OPEN_FILE: '0' }), []);
});
test('window selection raises exactly one title or AXDocument without activation', () => {
  for (const selector of [{ title: 'left.txt' }, { url: left.AXDocument }]) {
    const { result, events } = select({ app: 'TextEdit', ...selector }, [right, left]);
    assert.equal(result.ok, true); assert.equal(result.target.title, 'left.txt');
    assert.deepEqual(events, [{ window: left, action: 'AXRaise' }, { window: left, key: 'AXMain' }, { window: left, key: 'AXMain' }]);
  }
  assert.equal(select({ app: 'TextEdit', title: '' }, [{ AXTitle: '' }]).result.ok, true);
  assert.equal(select({ app: 'TextEdit', url: left.AXDocument }, [{ ...left, AXTitle: '' }]).result.ok, true);
});
test('invalid, absent or ambiguous selection sends no AX actions', () => {
  for (const [request, windows, options] of [
    [{ app: 'TextEdit' }, [left]], [{ app: 'TextEdit', title: 'left.txt', url: left.AXDocument }, [left]],
    [{ app: 'TextEdit', url: 'https://example.com' }, [left]], [{ app: 'TextEdit', title: 'lef' }, [left]],
    [{ app: 'TextEdit', title: 'left.txt' }, [left, left]], [{ app: 'TextEdit', title: 'left.txt' }, [left], { ambiguous: true }],
    [{ app: 'TextEdit', title: 'left.txt', expectedAppId: 'other.app' }, [left]],
  ]) {
    const { result, events } = select(request, windows, options);
    assert.equal(result.ok, false); assert.equal(events.length, 0);
  }
});
test('non-file AXDocument values do not prevent selecting a different file window', () => {
  for (const document of ['https://example.com/a', 'custom:document', 'not a URL']) {
    const { result, events } = select({ app: 'TextEdit', url: left.AXDocument }, [{ AXTitle: 'web', AXDocument: document }, left]);
    assert.equal(result.ok, true); assert.equal(events[0].window, left);
  }
});
test('AX errors or foreground changes return an unconfirmed selection', () => {
  for (const options of [{ raiseStatus: -1 }, { mainStatus: -1 }, { activates: true }, { renames: true }]) {
    for (const title of ['left.txt', suffix]) {
      const window = title === suffix ? { AXTitle: 'Work: Project page' } : { ...left };
      assert.equal(select({ app: 'TextEdit', title }, [window], options).result.ok, false);
    }
  }
});
test('local selection validates and asks before running its helper', async () => {
  const events = [];
  const args = { app: 'TextEdit', title: 'left.txt' };
  const options = { approve: async key => { events.push(key); return true; },
    runScript: async (script, request) => { events.push([script, request]); return { ok: true, target: left }; } };
  const invalid = await selectWindow({ app: 'TextEdit' }, options);
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /title or file URL/);
  assert.match(invalid.content[0].text, /unique.*ending/);
  assert.match(invalid.content[0].text, /12/);
  assert.match(invalid.content[0].text, /trim/);
  assert.match(invalid.content[0].text, /Cf.*M/);
  assert.match(invalid.content[0].text, /whitespace/);
  assert.equal(events.length, 0);
  assert.equal((await selectWindow(args, { ...options, approve: async () => false })).isError, true);
  assert.equal(events.length, 0);
  assert.equal((await selectWindow(args, options)).isError, undefined);
  assert.deepEqual(events, [['select_window', 'TextEdit'], ['select-window.js', args]]);
  assert.equal((await selectWindow(args, { ...options, runScript: async () => ({ ok: false, error: 'AXMain failed' }) })).isError, true);
});
test('benchmark window-selection approval remains confined to the app allowlist', () => {
  for (const [app, allowed] of [['TextEdit', true], ['Calculator', true], ['Chess', true], ['Terminal', false], ['ChatGPT', false]]) {
    const result = spawnSync(process.execPath, ['bench/approve.mjs'], { encoding: 'utf8',
      input: JSON.stringify({ message: `Allow Claude to select a window in ${app}? Explanation.`, mcp_server_name: 'plugin:sleight:computer' }) });
    assert.equal(result.status, 0);
    assert.equal(!!result.stdout, allowed);
  }
});

test('merged local dispatcher uses the supplied selection helper runner', async () => {
  const events = [];
  const args = { app: 'TextEdit', title: 'left.txt', expectedAppId: 'com.apple.TextEdit' };
  const result = await callLocalTool('select_window', args, async (parts, message) => {
    events.push({ parts, message }); return true;
  }, async (script, request) => {
    events.push({ script, request }); return { ok: true, target: left };
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(events[0].parts, ['select_window', 'TextEdit']);
  assert.deepEqual(events[1], { script: 'select-window.js', request: args });
});
