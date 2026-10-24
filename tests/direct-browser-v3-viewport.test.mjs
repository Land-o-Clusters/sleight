import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { setViewport, restoreViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';
import { browserTools, validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';

// Native CSS layout metrics report the size; setViewportSize changes it.
function sizedPage(initial = { width: 1280, height: 720 }, { readable = true } = {}) {
  const page = new EventEmitter(), calls = []; let size = { ...initial };
  page.url = () => 'https://example.invalid/';
  page.mainFrame = () => page;
  page.evaluate = async () => {};
  page.context = () => ({ newCDPSession: async () => ({
    send: async (method, params) => {
      calls.push(method);
      if (method === 'Emulation.clearDeviceMetricsOverride') { size = { ...initial }; return {}; }
      assert.equal(method, 'Page.getLayoutMetrics');
      if (!readable) throw Error('no session');
      return { cssLayoutViewport: { clientWidth: size.width, clientHeight: size.height } };
    },
    detach: async () => { calls.push('detach'); },
  }) });
  page.setViewportSize = async next => { calls.push(['setViewportSize', next]); size = { ...next }; };
  return { page, calls, size: () => size };
}
function runner(page) {
  let time = 0;
  const run = createActionRunner({ check: async () => ({ kind: 'allow' }), now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  return steps => run({ page, state: { snapshotNo: 1, submitUnconfirmed: false } }, steps, {});
}

test('a viewport step reports the new and the old size and says how to restore', async () => {
  const { page, size } = sizedPage();
  const result = await runner(page)([{ do: 'viewport', width: 390, height: 844 }]);
  assert.deepEqual(size(), { width: 390, height: 844 });
  assert.equal(result.lines[0], process.env.SLEIGHT_MT === '0'
    ? '1 viewport: viewport 390x844 (was 1280x720); a viewport step with no size restores 1280x720'
    : '1 viewport: viewport 390x844 (was 1280x720; a viewport step with no size restores it). [offscreen] means outside this viewport; [partly offscreen] means cut off by it.');
});

test('a viewport step with no size gives the original size back, once', async () => {
  const { page, size } = sizedPage({ width: 1000, height: 800 });
  const run = runner(page);
  await run([{ do: 'viewport', width: 390, height: 844 }]);
  const restored = await run([{ do: 'viewport' }]);
  assert.deepEqual(size(), { width: 1000, height: 800 });
  assert.match(restored.lines[0], /viewport restored to 1000x800$/);
  const again = await run([{ do: 'viewport' }]);
  assert.match(again.lines[0], /viewport unchanged: no size was set on this tab$/);
  assert.deepEqual(size(), { width: 1000, height: 800 });
});

test('several resizes still restore the size the tab had before the first one', async () => {
  const { page, size } = sizedPage({ width: 1000, height: 800 });
  const run = runner(page);
  await run([{ do: 'viewport', width: 390, height: 844 }]);
  const second = await run([{ do: 'viewport', width: 768, height: 1024 }]);
  assert.match(second.lines[0], process.env.SLEIGHT_MT === '0' ? /viewport 768x1024 \(was 390x844\); a viewport step with no size restores 1000x800$/ : /viewport 768x1024 \(was 390x844; a viewport step with no size restores it\)\. \[offscreen\] means outside this viewport; \[partly offscreen\] means cut off by it\.$/);
  await run([{ do: 'viewport' }]);
  assert.deepEqual(size(), { width: 1000, height: 800 });
});

test('two tabs keep their own original sizes', async () => {
  const a = sizedPage({ width: 1000, height: 800 }), b = sizedPage({ width: 1440, height: 900 });
  await runner(a.page)([{ do: 'viewport', width: 390, height: 844 }]);
  await runner(b.page)([{ do: 'viewport', width: 390, height: 844 }]);
  await runner(a.page)([{ do: 'viewport' }]); await runner(b.page)([{ do: 'viewport' }]);
  assert.deepEqual([a.size(), b.size()], [{ width: 1000, height: 800 }, { width: 1440, height: 900 }]);
});

test('an unreadable page size still sets the viewport and says the old size is unknown', async () => {
  const { page, size } = sizedPage({ width: 1000, height: 800 }, { readable: false });
  const run = runner(page);
  const result = await run([{ do: 'viewport', width: 390, height: 844 }]);
  assert.deepEqual(size(), { width: 390, height: 844 });
  assert.match(result.lines[0], /viewport 390x844; previous size unknown$/);
  await assert.rejects(restoreViewport(page), /previous size unknown/);
  assert.match(await restoreViewport(page, { release: true }), /previous size unknown/);
  assert.deepEqual(size(), { width: 1000, height: 800 });
});

test('FD5B a failed first size read stays unknown after a later readable resize', async () => {
  const { page } = sizedPage({ width: 1000, height: 800 }, { readable: false });
  await setViewport(page, { width: 390, height: 844 });
  const readable = sizedPage({ width: 390, height: 844 });
  page.context = readable.page.context;
  assert.match(await setViewport(page, { width: 390, height: 844 }), /previous size unknown/);
  await assert.rejects(restoreViewport(page), /previous size unknown/);
});

test('FD5B clears metrics on the Playwright session that installed the override', async () => {
  const { page, calls } = sizedPage();
  const impl = { delegate: { _mainFrameSession: { _metricsOverride: { width: 390 },
    _client: { send: async method => calls.push(['owner', method]) } } },
    _setEmulatedSize: () => {} };
  page._connection = { toImpl: () => impl };
  await setViewport(page, { width: 390, height: 844 });
  calls.length = 0;
  await restoreViewport(page, { release: true });
  assert.deepEqual(calls, [['owner', 'Emulation.clearDeviceMetricsOverride']]);
  assert.equal(impl.delegate._mainFrameSession._metricsOverride, undefined);
});

for (const reset of [false, true]) test(`FD5B release clears metrics and changed media after reset=${reset}`, async () => {
  const { page, calls } = sizedPage();
  const impl = { emulatedMedia: () => ({ colorScheme: 'light', reducedMotion: 'no-preference' }),
    _setEmulatedSize: size => { calls.push(['implSize', size]); } };
  page._connection = { toImpl: () => impl };
  page.emulateMedia = async media => calls.push(['media', media]);
  await setViewport(page, { width: 390, height: 844, color_scheme: 'dark', reduced_motion: true });
  if (reset) await restoreViewport(page);
  calls.length = 0;
  await restoreViewport(page, { release: true });
  assert.ok(calls.includes('Emulation.clearDeviceMetricsOverride'));
  assert.ok(calls.some(call => call[0] === 'implSize' && call[1] === undefined));
  assert.deepEqual(calls.find(call => call[0] === 'media'), ['media', { colorScheme: null, reducedMotion: null }]);
  assert.equal(page.viewportSize?.() ?? page._viewportSize, null);
  assert.equal(calls.some(call => call[0] === 'setViewportSize'), false);
});

test('FD5B failed metrics clearing stays retryable, including after a reset', async () => {
  const { page } = sizedPage();
  await setViewport(page, { width: 390, height: 844 });
  await restoreViewport(page);
  const context = page.context(); let fail = true;
  page.context = () => ({ newCDPSession: async () => {
    const session = await context.newCDPSession(); const send = session.send;
    session.send = async (...args) => { if (fail && args[0] === 'Emulation.clearDeviceMetricsOverride') throw Error('clear failed'); return send(...args); };
    return session;
  } });
  await assert.rejects(restoreViewport(page, { release: true }), /clear failed/);
  fail = false;
  assert.match(await restoreViewport(page, { release: true }), /cleared/);
});

test('half a size or an out-of-range size is refused before any input', async () => {
  const { page, calls } = sizedPage();
  for (const step of [{ do: 'viewport', width: 390 }, { do: 'viewport', height: 844 }, { do: 'viewport', width: 50, height: 844 },
    { do: 'viewport', width: 390, height: 20000 }, { do: 'viewport', width: 390.5, height: 844 }]) {
    await assert.rejects(runner(page)([step]), /width and height between 100 and 10000, or neither to restore/);
  }
  assert.deepEqual(calls, []);
});

test('the tool boundary takes both sizes or neither, and the descriptions name the viewport step and the markers', () => {
  const call = step => validateToolCall({ name: 'browser_act', arguments: { tab: 'tabc', steps: [step] } }, 'bbench');
  call({ do: 'viewport', width: 390, height: 844 });
  call({ do: 'viewport' });
  assert.throws(() => call({ do: 'viewport', width: 390 }), /width and height, or neither/);
  assert.throws(() => call({ do: 'viewport', height: 844 }), /width and height, or neither/);
  const text = Object.fromEntries(browserTools('bbench').map(tool => [tool.name, tool.description]));
  assert.match(text.browser_act, /viewport takes width\/height, color_scheme:light\/dark and reduced_motion:boolean for user-asked tests; an empty viewport resets size and media/);
  assert.match(text.browser_read, /Refs outside the viewport carry \[offscreen\] or \[partly offscreen\]/);
});

test('FD5 media-only steps preserve size and restore both original media values', async () => {
  const { page, size, calls } = sizedPage();
  let media = { colorScheme: 'light', reducedMotion: 'reduce' };
  page._connection = { toImpl: () => ({ emulatedMedia: () => ({ ...media }) }) };
  page.emulateMedia = async next => { calls.push(['media', next]); media = { ...media, ...next }; };
  const run = runner(page);
  assert.match((await run([{ do: 'viewport', color_scheme: 'dark', reduced_motion: false }])).lines[0], /color_scheme dark; reduced_motion false/);
  assert.deepEqual(size(), { width: 1280, height: 720 });
  assert.deepEqual(media, { colorScheme: 'dark', reducedMotion: 'no-preference' });
  await run([{ do: 'viewport', color_scheme: 'light' }]);
  assert.match((await run([{ do: 'viewport' }])).lines[0], /media restored/);
  assert.deepEqual(media, { colorScheme: 'light', reducedMotion: 'reduce' });
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'setViewportSize').length, 0);
});

test('FD5 combined resize and media reset preserve the first size and each media baseline', async () => {
  const { page, size } = sizedPage();
  let media = { colorScheme: 'light', reducedMotion: 'no-preference' };
  page._connection = { toImpl: () => ({ emulatedMedia: () => ({ ...media }) }) };
  page.emulateMedia = async next => { media = { ...media, ...next }; };
  await setViewport(page, { width: 390, height: 844, color_scheme: 'dark' });
  await setViewport(page, { reduced_motion: true });
  await setViewport(page, { width: 768, height: 1024 });
  assert.deepEqual(media, { colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.match(await restoreViewport(page), /restored to 1280x720; media restored/);
  assert.deepEqual(size(), { width: 1280, height: 720 });
  assert.deepEqual(media, { colorScheme: 'light', reducedMotion: 'no-preference' });
});

test('FD5 zoom compensation measures native CSS dimensions and restores the CSS baseline', async () => {
  const { page, calls } = sizedPage();
  let physical = { width: 1600, height: 1000 };
  page.context = () => ({ newCDPSession: async () => ({ send: async method => {
    assert.equal(method, 'Page.getLayoutMetrics');
    return { cssLayoutViewport: { clientWidth: Math.round(physical.width / 1.25), clientHeight: Math.round(physical.height / 1.25) } };
  }, detach: async () => {} }) });
  page.setViewportSize = async next => { physical = next; calls.push(next); };
  await setViewport(page, { width: 390, height: 844 });
  assert.ok(Math.abs(physical.width / 1.25 - 390) <= 1);
  assert.equal(physical.height / 1.25, 844);
  await restoreViewport(page);
  assert.deepEqual(physical, { width: 1600, height: 1000 });
});

test('FD5 a failed media restore remains retryable and does not forget the original settings', async () => {
  const { page } = sizedPage(); let fail = false;
  page.emulateMedia = async () => { if (fail) throw Error('restore failed'); };
  await setViewport(page, { color_scheme: 'dark' }); fail = true;
  await assert.rejects(restoreViewport(page), /restore failed/); fail = false;
  assert.match(await restoreViewport(page), /media restored/);
});

test('FD5 a size that cannot converge within three corrections never claims a successful restore', async () => {
  const { page } = sizedPage();
  await setViewport(page, { width: 390, height: 844 });
  page.setViewportSize = async () => {};
  await assert.rejects(restoreViewport(page), /could not reach the requested CSS size/);
});

test('FD5 malformed media is refused by the runner before any input', async () => {
  const { page, calls } = sizedPage();
  for (const step of [{ do: 'viewport', reduced_motion: 1 }, { do: 'viewport', color_scheme: 'auto' },
    { do: 'wait', color_scheme: 'dark' }]) await assert.rejects(runner(page)([step]), /needs viewport/);
  assert.deepEqual(calls, []);
});


import { withMT } from './fixtures/mt-env.mjs';
for (const mode of [undefined, '0']) test(`MT6 viewport guidance preserves restore behavior, switch=${mode}`, async () => withMT(mode, async () => {
  const { page, size } = sizedPage(), run = runner(page);
  const result = await run([{ do: 'viewport', width: 390, height: 844 }]);
  assert.equal(result.lines[0], mode === '0'
    ? '1 viewport: viewport 390x844 (was 1280x720); a viewport step with no size restores 1280x720'
    : '1 viewport: viewport 390x844 (was 1280x720; a viewport step with no size restores it). [offscreen] means outside this viewport; [partly offscreen] means cut off by it.');
  await run([{ do: 'viewport' }]); assert.deepEqual(size(), { width: 1280, height: 720 });
}));
