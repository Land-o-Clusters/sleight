import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/fd1-filtered-real.mjs';

test('MT1 HTTP-to-mailto is vetoed at the response and reported in browser_act', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<h1>Owned redirect fixture with enough text for a full read</h1><a href="/http-to-mailto">Open fixture mail link</a>', {
    routes: { '/http-to-mailto': (_request, response) => {
      response.writeHead(302, { location: 'mailto:fixture@example.invalid?subject=MT1' }); response.end();
    } },
  });
  const read = await f.call('browser_read', {});
  const ref = /link "Open fixture mail link"[^\n]*\[ref=(\w+)\]/.exec(read.text)?.[1];
  assert.ok(ref, read.text);
  const result = await f.call('browser_act', { steps: [{ do: 'click', ref }] });
  assert.match(result.text, /Native navigation attempted/);
  const redirect = f.responses.find(event => event.responseStatusCode === 302 && event.request.url.endsWith('/http-to-mailto'));
  assert.ok(redirect, 'the real server redirect must pause before Chrome follows Location');
  const commands = f.wire.filter(command => command.requestId === redirect.requestId);
  assert.deepEqual(commands.map(command => command.method), ['Fetch.failRequest']);
  assert.equal(f.navigations.some(url => url.startsWith('mailto:')), false, 'this path has no renderer native-navigation event');
  assert.equal(f.responses.some(event => event.request.url.startsWith('mailto:')), false);
  assert.ok(!f.wire.some(command => ['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds'].includes(command.method)));
  assert.equal(f.entry.state.nativeNavigationNo, 1);
  t.diagnostic('Headless proof: HTTP 302 paused and failed before following its mailto Location. Installed-browser app/focus behavior remains for sleight-arch.');
});

test('MT1 real HTTP redirects continue normally and a later native hop is blocked', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<h1>Owned redirect fixture with enough visible text</h1>', {
    routes: {
      '/web-redirect': (_request, response) => { response.writeHead(302, { location: '/landed' }); response.end(); },
      '/landed': '<h1>Web redirect landed with enough visible text</h1>',
      '/chain': (_request, response) => { response.writeHead(303, { location: '/native' }); response.end(); },
      '/native': (_request, response) => { response.writeHead(307, { Location: 'zoommtg://fixture.invalid' }); response.end(); },
    },
  });
  const origin = new URL(f.entry.page.url()).origin;
  await f.entry.page.goto(origin + '/web-redirect');
  assert.equal(f.entry.page.url(), origin + '/landed');
  assert.equal(f.entry.state.nativeNavigationNo ?? 0, 0);
  await assert.rejects(f.entry.page.goto(origin + '/chain'), /ERR_BLOCKED_BY_CLIENT/);
  const result = await f.call('browser_read', {});
  assert.match(result.text, /Native navigation attempted/);
  const blocked = f.responses.find(event => event.responseStatusCode === 307);
  assert.ok(blocked);
  assert.deepEqual(f.wire.filter(command => command.requestId === blocked.requestId).map(command => command.method), ['Fetch.failRequest']);
});

test('MT1 an owned out-of-process iframe reports and vetoes its HTTP-to-native response', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<h1>Parent fixture with enough visible text for a full read</h1>', {
    routes: {
      '/child': '<h2>Child fixture</h2><a href="/native-child">Open child mail link</a>',
      '/native-child': (_request, response) => { response.writeHead(308, { location: 'mailto:fixture@example.invalid' }); response.end(); },
    },
  });
  await f.entry.page.evaluate(origin => {
    const child = document.createElement('iframe'); child.src = origin.replace('127.0.0.1', 'localhost') + '/child'; document.body.append(child);
  }, new URL(f.entry.page.url()).origin);
  await f.entry.page.frameLocator('iframe').getByText('Open child mail link').waitFor();
  const read = await f.call('browser_read', {});
  const ref = /link "Open child mail link"[^\n]*\[ref=(\w+)\]/.exec(read.text)?.[1];
  assert.ok(ref, read.text);
  const result = await f.call('browser_act', { steps: [{ do: 'click', ref }] });
  assert.match(result.text, /Native navigation attempted/);
  const blocked = f.responses.find(event => event.responseStatusCode === 308);
  assert.ok(blocked);
  assert.deepEqual(f.wire.filter(command => command.requestId === blocked.requestId).map(command => command.method), ['Fetch.failRequest']);
  const { frameTree } = await f.entry.cdp.send('Page.getFrameTree');
  assert.notEqual(blocked.frameId, frameTree.frame.id, 'the blocked response belongs to the child frame');
  assert.ok(f.entry.page.url().endsWith('/start'));
  assert.equal(f.entry.page.frames().some(frame => frame.url().startsWith('mailto:')), false);
  assert.equal(f.entry.state.nativeNavigationNo, 1);
});

test('MT1 keeping a tab removes response interception before returning it to the user', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<h1>Owned document with enough text for the release fixture</h1>');
  const url = f.entry.page.url();
  const kept = await f.registry.keep(f.tab);
  assert.equal(kept.kept, true);
  const raw = f.context.pages().find(page => page.url() === url);
  assert.ok(raw, 'the kept fixture remains open in the disposable headless browser');
  const before = f.responses.length;
  await raw.goto(new URL('/after-keep', url).href);
  assert.equal(f.responses.length, before, 'the released tab has no response-stage fence');
});
