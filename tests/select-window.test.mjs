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
  const workspace = { runningApplications: list(options.ambiguous ? [app, app] : [app]), frontmostApplication: { processIdentifier: 2 } };
  const $ = key => key;
  Object.assign($, { NSWorkspace: { sharedWorkspace: workspace }, NSURL: { URLWithString: value => {
    const url = new URL(value);
    return { isNil: () => false, isFileURL: url.protocol === 'file:', URLByResolvingSymlinksInPath: { path: decodeURIComponent(url.pathname) } };
  } } });
  const uiWindows = windows.map(window => {
    const main = { get value() { return () => options.mainStatus !== -1; }, set value(_) {} };
    return { attributes: { byName: key => {
      if (key === 'AXMain') { events.push({ window, key }); if (options.activates) app.active = true; return main; }
      return { value: () => window[key] ?? null };
    } }, actions: { byName: action => ({ perform: () => {
      events.push({ window, action }); if (options.raiseStatus === -1) throw new Error('AXRaise failed');
    } }) } };
  });
  const result = runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, request,
    Application: () => ({ processes: { whose: query => {
      assert.equal(query.unixId, 1); return () => [{ windows: () => uiWindows }];
    } } }),
    ObjC: { import() {}, unwrap: x => x } });
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
test('window-selection opt-out leaves the other local tools enabled', () => {
  const names = env => localToolDefinitions(env).map(tool => tool.name);
  assert.ok(names({}).includes('select_window'));
  assert.deepEqual(names({ SLEIGHT_SELECT_WINDOW: '0' }), names({}).filter(name => name !== 'select_window'));
  assert.deepEqual(names({ SLEIGHT_SELECT_WINDOW: '0', SLEIGHT_DRAG: '0', SLEIGHT_MENU_BAR: '0', SLEIGHT_HOVER: '0' }), ['blocked_app']);
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
  for (const options of [{ raiseStatus: -1 }, { mainStatus: -1 }, { activates: true }]) {
    assert.equal(select({ app: 'TextEdit', title: 'left.txt' }, [left], options).result.ok, false);
  }
});
test('local selection validates and asks before running its helper', async () => {
  const events = [];
  const args = { app: 'TextEdit', title: 'left.txt' };
  const options = { approve: async key => { events.push(key); return true; },
    runScript: async (script, request) => { events.push([script, request]); return { ok: true, target: left }; } };
  assert.equal((await selectWindow({ app: 'TextEdit' }, options)).isError, true);
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
