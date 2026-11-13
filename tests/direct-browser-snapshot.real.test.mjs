import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { snapshot, closedRefBinding, acknowledgeSnapshot, snapshotRefBinding } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { censusFixture } from './fixtures/cr3-forms.mjs';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = !live ? 'real-page qualification belongs to sleight-arch host runner'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;

async function fixture(t, html, routes = {}) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(routes[request.url] ?? html);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.on('pageerror', error => console.log('V3 fixture page error ' + error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  return page;
}

test('real snapshot redacts password and iframe card values while retaining actionable refs', { skip }, async t => {
  const page = await fixture(t, `<main><label>Password<input type="password" value="fixture-password"></label>
    <p>echo fixture-password</p><iframe src="/card"></iframe><button>Continue</button></main>`, {
    '/card': '<label>Number<input autocomplete="cc-number" value="4111 1111 1111 1111"></label><label>Expiry<input value="08/30"></label><label>Security code<input value="123"></label>',
  });
  const result = await snapshot(page);
  assert.doesNotMatch(result.text, /fixture-password|4111|08\/30|123/);
  assert.match(result.text, /textbox "Number" \[ref=f\d+e\d+\]/);
  const ref = /button "Continue" \[ref=([^\]]+)\]/.exec(result.text)[1];
  assert.equal(await page.locator('aria-ref=' + ref).count(), 1);
});

test('real native redaction ignores page overrides of protected input getters', { skip }, async t => {
  const page = await fixture(t, `<main><label>Account<input type="password" value="fixture-native-secret"></label>
    <p>echo fixture-native-secret</p></main><script>
    Object.defineProperty(HTMLInputElement.prototype, 'type', {get() {return 'text'}});
    Object.defineProperty(HTMLInputElement.prototype, 'value', {get() {return 'page-decoy'}});
  </script>`);
  const result = await snapshot(page);
  assert.doesNotMatch(result.text, /fixture-native-secret/);
  assert.match(result.text, /redacted/);
});

test('real closed-root refs expose checked state and redact current native values', { skip }, async t => {
  const page = await fixture(t, `<main><custom-control></custom-control></main><script>
    const root = document.querySelector('custom-control').attachShadow({mode:'closed'});
    root.innerHTML = '<button role="switch" aria-checked="true">Secure mode</button><input type="password" aria-label="Password">';
    root.querySelector('input').value = 'fixture-closed-password';
  </script>`);
  const result = await snapshot(page);
  if (!result.text.includes('Secure mode')) {
    const session = await page.context().newCDPSession(page);
    try {
      const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      const hosts = [], controls = [];
      const walk = (node, closed = false) => {
        if (closed && node.localName === 'button') controls.push(node.backendNodeId);
        for (const shadow of node.shadowRoots ?? []) {
          hosts.push({ host: node.backendNodeId, tag: node.localName, type: shadow.shadowRootType,
            children: (shadow.children ?? []).map(child => ({ tag: child.localName, backend: child.backendNodeId })) });
          walk(shadow, closed || shadow.shadowRootType === 'closed');
        }
        for (const child of node.children ?? []) walk(child, closed);
      };
      walk(root);
      console.log('V3 closed-root DOM diagnostic ' + JSON.stringify(hosts));
      const summarize = nodes => nodes.map(node => ({ backend: node.backendDOMNodeId,
        role: node.role?.value, name: node.name?.value, ignored: node.ignored }));
      for (const { host } of hosts) console.log('V3 closed-root query diagnostic ' + JSON.stringify(summarize(
        (await session.send('Accessibility.queryAXTree', { backendNodeId: host })).nodes)));
      console.log('V3 closed-root full diagnostic ' + JSON.stringify(summarize(
        (await session.send('Accessibility.getFullAXTree')).nodes)));
      for (const backendNodeId of controls) console.log('V3 closed-root partial diagnostic ' + JSON.stringify(summarize(
        (await session.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })).nodes)));
    } finally { await session.detach(); }
  }
  assert.match(result.text, /switch "Secure mode" \[checked\] \[ref=s\d+\]/);
  assert.doesNotMatch(result.text, /fixture-closed-password/);
  const ref = /switch.*\[ref=(s\d+)\]/.exec(result.text)[1];
  const { frame, backendNodeId } = closedRefBinding(page, ref);
  const cdp = await page.context().newCDPSession(frame);
  try {
    const { node } = await cdp.send('DOM.describeNode', { backendNodeId });
    assert.equal(node.localName, 'button');
  } finally { await cdp.detach(); }
});

test('real out-of-process iframe card values are redacted through their own frame', { skip }, async t => {
  const page = await fixture(t, '<main><iframe></iframe></main>');
  await page.route('http://127.0.0.2/card', request => request.fulfill({ contentType: 'text/html',
    body: '<label>Number<input autocomplete="cc-number" value="4111 1111 1111 1111"></label>' }));
  const loaded = page.waitForEvent('framenavigated', frame => frame.url() === 'http://127.0.0.2/card');
  await page.locator('iframe').evaluate(element => { element.src = 'http://127.0.0.2/card'; });
  const frame = await loaded;
  await frame.waitForLoadState();
  const result = await snapshot(page);
  assert.doesNotMatch(result.text, /4111/);
  assert.match(result.text, /textbox "Number" \[ref=f\d+e\d+\]/);
});

test('real diffs preserve reorder context and scoped reads leave other aria refs usable', { skip }, async t => {
  const page = await fixture(t, '<main><ul><li>A</li><li>B</li><li>C</li></ul><button>Continue</button></main>');
  const first = await snapshot(page);
  await page.evaluate(() => { const list = document.querySelector('ul'); list.prepend(list.lastElementChild); });
  const diff = await snapshot(page, { since: first.number });
  assert.match(diff.text, /Changes since/);
  assert.match(diff.text, /\+ .*listitem/);
  const scoped = await snapshot(page, { find: 'C' });
  assert.match(scoped.text, /listitem.*C/);
  const button = /button "Continue" \[ref=([^\]]+)\]/.exec(first.text)[1];
  assert.equal(await page.locator('aria-ref=' + button).count(), 1);
});

test('real fixture size census stays below 15K for open, action diff and find', { skip }, async t => {
  const page = await fixture(t, `<main><h1>Travel</h1><label>City<input value=""></label><ul>${Array.from({ length: 500 }, (_, i) =>
    '<li>Destination ' + i + '</li>').join('')}</ul><button>Save</button></main>`);
  const first = await snapshot(page);
  assert.ok(first.text.length <= 8000);
  assert.match(first.text, /Continue with ref=/);
  await page.locator('input').fill('Portland');
  const action = await snapshot(page, { since: first.number });
  const found = await snapshot(page, { find: 'Destination 499' });
  assert.match(found.text, /Destination 499/);
  const chars = { open: first.text.length, action: action.text.length, find: found.text.length };
  console.log('V3 synthetic size census ' + JSON.stringify(chars));
  // A cut baseline must deliver the unseen rows. Measure the action diff with
  // a fully delivered baseline separately for the round's small-result target.
  const full = await snapshot(page, { maxChars: 40000 });
  await page.locator('input').fill('Seattle');
  const small = await snapshot(page, { since: full.number });
  assert.match(small.text, /Seattle/);
  assert.ok(first.text.length + small.text.length + found.text.length <= 15000);
});

for (const route of ['travel', 'settings', 'checkout']) test(`CR3 authored ${route} form with 40 controls and long-list census`, { skip }, async t => {
  const { html, routes } = censusFixture(route);
  const page = await fixture(t, html, routes);
  await page.waitForLoadState('load');
  assert.ok(await page.locator('input,select,textarea,button').count() >= 40, 'census fixture must have at least 40 controls');
  assert.ok(await page.locator('li').count() >= 60, 'census must include a long list');
  if (route === 'checkout') assert.equal(await page.frames()[1].getByRole('textbox', { name: 'Number', exact: true }).count(), 1);
  const first = await snapshot(page);
  assert.ok(first.text.length >= 2000, 'census must exercise at least 2K snapshot characters');
  assert.doesNotMatch(first.text, /4111|08\/30|: "123"/);
  if (route === 'checkout') assert.match(first.text, /textbox "Number" \[ref=f\d+e\d+\]: "\[redacted\]"/);
  await page.locator('input').first().fill('Fixture census');
  const action = await snapshot(page, { since: first.number });
  const found = await snapshot(page, { find: 'Fixture census' });
  assert.match(found.text, /Fixture census/);
  const chars = { open: first.text.length, act: action.text.length, read: found.text.length,
    total: first.text.length + action.text.length + found.text.length };
  t.diagnostic('CR3 authored fixture census ' + JSON.stringify({ route, ...chars }));
  assert.ok(first.text.length <= 8000 && action.text.length <= 8000 && found.text.length <= 8000);
  assert.ok(chars.total <= 15000);
});

test('CR3 real 600 inert closed-root divs do not consume the control probe budget', { skip }, async t => {
  const page = await fixture(t, `<custom-controls></custom-controls><script>
    document.querySelector('custom-controls').attachShadow({mode:'closed'}).innerHTML =
      '<div></div>'.repeat(600) + '<button>Only command</button>';
  </script>`);
  const result = await snapshot(page);
  assert.match(result.text, /button "Only command" \[ref=s\d+\]/);
  t.diagnostic('cleanup: 600-div fixture browser and server closed by fixture teardown');
});

for (const value of [' alpha  beta ', ' alpha\u200B  be\u00ADta ', '\talpha\n\nbeta\t'])
  test('V3R real normalized password with neutral name is masked', {skip}, async t=>{
    const page=await fixture(t,'<main><label>PIN<input type="password"></label><p id="echo"></p><input aria-label="City" value="Portland"></main>');
    await page.locator('input[type=password]').fill(value);
    await page.locator('#echo').evaluate((el,text)=>{el.textContent=text;},'alpha beta');
    const result=await snapshot(page);assert.doesNotMatch(result.text,/alpha beta/);assert.match(result.text,/Portland/);
  });

test('V3R real overlapping secrets cannot leave a suffix', {skip},async t=>{
  const page=await fixture(t,'<main><input type="password" aria-label="One" value="hunter2"><input type="password" aria-label="Two" value="hunter2xyz"><p>hunter2xyz and hunter2</p></main>');
  const result=await snapshot(page);assert.doesNotMatch(result.text,/hunter2|xyz/);
});

test('V3R real Discard dialog keeps its buttons and oversized continuation reaches End', {skip},async t=>{
  const page=await fixture(t,'<main><div role="dialog" aria-label="Discard changes?"><button>Keep editing</button><button>Discard</button></div><p>'+ 'x'.repeat(1300) + '</p><button>End</button></main>');
  let result=await snapshot(page,{maxChars:1000});assert.match(result.text,/Keep editing/);
  for(let n=0;!result.text.includes('"End"');n++){
    assert.ok(n<8,'continuation must advance'); const ref=/Continue with ref="([^"]+)"/.exec(result.text)?.[1];assert.ok(ref);
    result=await snapshot(page,{ref,maxChars:1000});
  }
});

test('V3R real document navigation never retargets the old public Buy ref', {skip},async t=>{
  const page=await fixture(t,'<main><button>Buy</button></main>',{'/next':'<main><button onclick="window.deleted=(window.deleted||0)+1">Delete account</button></main>'});
  const first=await snapshot(page), ref=/button "Buy" \[ref=([^\]]+)\]/.exec(first.text)[1];
  assert.equal(acknowledgeSnapshot(page,first.number),true);assert.equal(await snapshotRefBinding(page,ref).count(),1);
  await page.goto(new URL('/next',page.url()).href);
  assert.throws(()=>snapshotRefBinding(page,ref),/stale|read/i);
  const next=await snapshot(page), current=/button "Delete account" \[ref=([^\]]+)\]/.exec(next.text)[1];
  assert.notEqual(current,ref);assert.throws(()=>snapshotRefBinding(page,current),/delivered|read/i);
  assert.equal(acknowledgeSnapshot(page,next.number),true);assert.throws(()=>snapshotRefBinding(page,ref),/stale|read/i);
  await snapshotRefBinding(page,current).click();assert.equal(await page.evaluate(()=>window.deleted),1);
});

test('CR1 real nested ignored hosts in an in-process frame expose native flags and retire refs', { skip }, async t => {
  const page = await fixture(t, '<main><iframe src="/frame"></iframe></main>', {
    '/frame': `<custom-outer></custom-outer><script>
      const outer = document.querySelector('custom-outer').attachShadow({mode:'closed'});
      outer.innerHTML = '<custom-inner></custom-inner>';
      const inner = outer.querySelector('custom-inner').attachShadow({mode:'closed'});
      inner.innerHTML = '<button role="checkbox" aria-checked="mixed">Nested choice</button><input aria-label="Private field" value="closed-value">';
      window.removeControls = () => outer.replaceChildren();
    </script>`,
  });
  await page.frames()[1].waitForLoadState();
  const first = await snapshot(page);
  assert.match(first.text, /checkbox "Nested choice" \[checked="mixed"\] \[ref=s\d+\]/);
  assert.match(first.text, /textbox "Private field".*redacted/);
  assert.doesNotMatch(first.text, /closed-value/);
  const ref = /checkbox.*\[ref=(s\d+)\]/.exec(first.text)[1];
  assert.equal(closedRefBinding(page, ref).frame, page.mainFrame());
  await page.frames()[1].evaluate(() => window.removeControls());
  await snapshot(page);
  assert.throws(() => closedRefBinding(page, ref), /stale/i);
  t.diagnostic('cleanup: fixture browser and loopback server are closed by fixture teardown');
});

test('CR2 HTML-AAM and Chromium native control roles remain reachable inside a closed root', { skip, timeout: 90000 }, async t => {
  // https://www.w3.org/TR/html-aam-1.0/ and Chromium AXNodeObject native role mapping.
  const types = ['button', 'submit', 'reset', 'image', 'text', 'search', 'tel', 'url', 'email', 'password',
    'date', 'datetime-local', 'month', 'week', 'time', 'number', 'range', 'color', 'checkbox', 'radio', 'file'];
  const inputs = types.map(type => `<input type="${type}" aria-label="Native ${type}"${['checkbox', 'radio'].includes(type)
    ? ' value="fixture-choice-value"' : ''}>`).join('');
  const controls = inputs + '<button>Native button element</button><textarea aria-label="Native textarea"></textarea>'
    + '<select aria-label="Native select"><option>One</option></select>'
    + '<select multiple aria-label="Native multiple"><option>Two</option></select>'
    + '<a href="/next">Native link</a><details open><summary>Native summary</summary><p>Details content</p></details>';
  const page = await fixture(t, '<custom-controls></custom-controls><script>'
    + 'document.querySelector("custom-controls").attachShadow({mode:"closed"}).innerHTML = '
    + JSON.stringify(controls) + ';</script>');
  const result = await snapshot(page, { maxChars: 40000 });
  const rows = result.text.split('\n').filter(line => /"Native /.test(line));
  t.diagnostic('CR2 observed native control roles ' + JSON.stringify(rows));
  for (const name of [...types.map(type => 'Native ' + type), 'Native button element', 'Native textarea',
    'Native select', 'Native multiple', 'Native link', 'Native summary'])
    assert.ok(result.text.split('\n').some(line => line.includes(JSON.stringify(name)) && /\[ref=s\d+\]/.test(line)), name);
  t.diagnostic('cleanup: native-role browser and local server closed by fixture teardown');
});

test('CR4 real closed select with 600 options returns the select without exhausting candidate probes', { skip }, async t => {
  const page = await fixture(t, `<custom-controls></custom-controls><script>
    const root = document.querySelector('custom-controls').attachShadow({mode:'closed'});
    root.innerHTML = '<select aria-label="Destination">' + Array.from({length:600}, (_, i) => '<option>Choice ' + i + '</option>').join('') + '</select>';
  </script>`);
  const result = await snapshot(page);
  assert.match(result.text, /combobox "Destination".*\[ref=s\d+\]/);
  t.diagnostic('cleanup: closed-select fixture browser, loopback server and sockets closed by teardown');
});

test('real snapshot marks refs outside the viewport at a phone size and clears the marks after a scroll', { skip }, async t => {
  const page = await fixture(t, `<style>body{margin:0}.gap{height:1500px}</style><main><button id="top">Top button</button>
    <div class="gap"></div><button id="deep">Add to cart</button></main>`);
  await page.setViewportSize({ width: 390, height: 844 });
  const first = await snapshot(page);
  assert.match(first.text, /button "Top button" \[ref=e\d+\]\n/);
  assert.match(first.text, /button "Add to cart" \[ref=e\d+\] \[offscreen\]/);
  await page.evaluate(() => document.querySelector('#deep').scrollIntoView({ block: 'center' }));
  const after = await snapshot(page);
  assert.match(after.text, /button "Add to cart" \[ref=e\d+\]\n?$/m);
  assert.match(after.text, /button "Top button" \[ref=e\d+\] \[offscreen\]/);
  // A tall viewport brings the deep button in, with no marker on either.
  await page.evaluate(() => scrollTo(0, 0));
  await page.setViewportSize({ width: 390, height: 2000 });
  assert.doesNotMatch((await snapshot(page)).text, /offscreen/);
});
