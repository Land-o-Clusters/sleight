import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createUserFileProvider } from '../plugins/sleight/lib/direct-browser/files.mjs';
import { loadPlaywrightCore } from '../plugins/sleight/lib/direct-browser/worlds.mjs';

const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'real-page action qualification belongs to the host runner';
async function fixture(t, html, runnerOptions = {}) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/next' ? '<button>New document</button>' : html);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
    .browsers.find(b => b.name === 'chromium-headless-shell');
  const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
  const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
    'chrome-headless-shell-' + platform, 'chrome-headless-shell');
  // Missing dependencies fail the opt-in host run. They never turn qualification into a skip.
  const runtime = loadPlaywrightCore({ turbo: true });
  const browser = await runtime.inprocess.playwright.chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto('http://127.0.0.1:' + server.address().port);
  let number = 0; const history = new Map();
  // V3 is a separate parallel lane. This adapter exercises actual Playwright
  // refs and real DOM diffs without requiring that lane's unmerged module.
  const snapshot = async (p, { since, find } = {}) => {
    const raw = await p.ariaSnapshot({ mode: 'ai' }); const previous = history.get(since); history.set(++number, raw);
    let text = raw;
    if (find) text = raw.split('\n').filter(line => line.toLowerCase().includes(find.toLowerCase())).join('\n');
    else if (previous !== undefined) {
      const before = new Set(previous.split('\n')), after = new Set(raw.split('\n'));
      text = [...after].filter(line => !before.has(line)).map(line => '+ ' + line).join('\n') || 'No visible changes.';
    }
    return { text, number };
  };
  const tab = { page, state: { snapshotNo: (await snapshot(page)).number, submitUnconfirmed: false } };
  const checks = [];
  const run = createActionRunner({ snapshot, check: (ctx, kind, target) => {
    checks.push({ kind, target });
    return target.submit && target.state.submitUnconfirmed ? { verdict: 'refuse', message: 'Read before resubmitting' } : { verdict: 'allow' };
  }, ...runnerOptions });
  const ref = async name => {
    const raw = await page.ariaSnapshot({ mode: 'ai' });
    const line = raw.split('\n').find(line => line.includes('"' + name + '"'));
    assert.ok(line, 'missing fixture control ' + name); return /\[ref=((?:f\d+)?e\d+)\]/.exec(line)?.[1];
  };
  return { page, tab, run, ref, checks };
}

test('real v3 actions fill, press, select, check, uncheck, hover, drag and resize', { skip }, async t => {
  const f = await fixture(t, `<label>Name<input id="name"></label><label>Choice<select id="choice"><option>A</option><option>B</option></select></label>
    <label><input id="toggle" type="checkbox">Enable</label><button id="hover" onmouseover="this.textContent='Hovered'">Hover here</button>
    <div id="from" draggable="true" role="button" style="padding:30px" ondragstart="event.dataTransfer.setData('text/plain','dragged')">Source</div>
    <div id="to" role="button" style="padding:30px" ondragover="event.preventDefault()" ondrop="event.preventDefault();this.textContent=event.dataTransfer.getData('text/plain')">Destination</div>`);
  const result = await f.run(f.tab, [{ do: 'type', ref: await f.ref('Name'), text: 'Example' },
    { do: 'press', ref: await f.ref('Name'), key: 'End' }, { do: 'select', ref: await f.ref('Choice'), values: ['B'] },
    { do: 'check', ref: await f.ref('Enable') }, { do: 'uncheck', ref: await f.ref('Enable') },
    { do: 'hover', ref: await f.ref('Hover here') }, { do: 'drag', ref: await f.ref('Source'), to: await f.ref('Destination') },
    { do: 'viewport', width: 390, height: 844 }, { do: 'wait', ref: await f.ref('Name') }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.equal(await f.page.locator('#name').inputValue(), 'Example');
  assert.equal(await f.page.locator('#choice').inputValue(), 'B'); assert.equal(await f.page.locator('#toggle').isChecked(), false);
  assert.equal(await f.page.locator('#hover').textContent(), 'Hovered'); assert.equal(await f.page.locator('#to').textContent(), 'dragged');
  assert.deepEqual(f.page.viewportSize(), { width: 390, height: 844 }); assert.ok(result.observe.text);
});

test('real v3 navigation stops a batch before touching the next document', { skip }, async t => {
  const f = await fixture(t, '<a href="/next">Next page</a>');
  const result = await f.run(f.tab, [{ do: 'click', ref: await f.ref('Next page') }, { do: 'reload' }], {});
  assert.equal(result.stoppedAt, 1); assert.match(result.lines[0], /navigated|new document/); assert.match(result.lines[1], /not reached/);
  assert.match(f.page.url(), /\/next$/);
  const origin = new URL(f.page.url()).origin;
  for (const [op, url] of [['back', origin + '/'], ['forward', origin + '/next'], ['reload', origin + '/next']]) {
    const navigated = await f.run(f.tab, [{ do: op }], {});
    assert.equal(navigated.stoppedAt, 1, navigated.lines.join('\n')); assert.equal(f.page.url(), url);
  }
});

test('real v3 dialog returns promptly, stops the batch and accepts only an explicit answer', { skip }, async t => {
  const f = await fixture(t, '<button onclick="document.querySelector(\'output\').textContent=confirm(\'Continue?\')">Ask</button><output>waiting</output>');
  const result = await f.run(f.tab, [{ do: 'click', ref: await f.ref('Ask') }, { do: 'reload' }], {});
  assert.equal(result.stoppedAt, 1); assert.match(result.lines[0], /dialog confirm/); assert.ok(f.tab.state.dialog);
  const answer = await f.run(f.tab, [{ do: 'dialog', accept: true }], {});
  assert.equal(answer.stoppedAt, null, answer.lines.join('\n')); assert.equal(await f.page.locator('output').textContent(), 'true');
});

test('real v3 a delayed dialog survives its pending click deadline and is explicitly dismissed once', { skip, timeout: 30000 }, async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, `<button onclick="window.asks=(window.asks||0)+1;setTimeout(()=>{
    document.querySelector('output').textContent=confirm('Continue later?')},150)">Ask later</button>
    <button onclick="window.next=(window.next||0)+1">Next</button><output>waiting</output>`, {
    actionTimeoutMs: 25,
    // Hold only the completion reply after the real input. The native dialog
    // arrives from the page after the call deadline, with no test auto-answer.
    backgroundClick: async (tab, locator, click) => { await click({}); await held; },
  });
  const ask = await f.ref('Ask later'), next = await f.ref('Next');
  const waiting = f.page.waitForEvent('dialog', { timeout: 10000 });
  const first = await f.run(f.tab, [{ do: 'click', ref: ask }], {});
  assert.match(first.lines[0], /still pending/); assert.equal(f.tab.state.actionPending, true);
  const dialog = await waiting;
  assert.equal(f.tab.state.dialog, dialog);
  const answered = await f.run(f.tab, [{ do: 'dialog', accept: false }], {});
  assert.equal(answered.stoppedAt, null, answered.lines.join('\n'));
  assert.equal(f.tab.state.actionPending, true);
  assert.equal(await f.page.locator('output').textContent(), 'false');
  const blocked = await f.run(f.tab, [{ do: 'click', ref: next }], {});
  assert.match(blocked.lines[0], /not run:.*pending/);
  assert.equal(await f.page.evaluate(() => window.asks), 1);
  assert.equal(await f.page.evaluate(() => window.next || 0), 0);
  release();
  const deadline = Date.now() + 5000;
  while (f.tab.state.actionPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.tab.state.actionPending, false);
  for (const event of ['dialog', 'request', 'requestfinished', 'requestfailed', 'framenavigated', 'load', 'popup'])
    assert.equal(f.page.listenerCount(event), 0, event);
  const resumed = await f.run(f.tab, [{ do: 'click', ref: next }], {});
  assert.doesNotMatch(resumed.lines[0], /not run:/);
  await f.page.waitForFunction(() => window.next === 1);
  assert.equal(await f.page.evaluate(() => window.next), 1);
});

test('real v3 cover outcome keeps the blocker\'s page text out of the harness line and includes its dismiss button refs', { skip }, async t => {
  const f = await fixture(t, `<button id="target" style="position:absolute;top:20px">Target</button>
    <div role="dialog" aria-label="Cookie notice" style="position:fixed;inset:0;background:white"><button>Accept cookies</button></div>`);
  const result = await f.run(f.tab, [{ do: 'click', ref: await f.ref('Target') }], {});
  assert.equal(result.stoppedAt, 1); assert.match(result.lines[0], /covering element/); assert.doesNotMatch(result.lines[0], /Cookie notice|Accept cookies/); // page text belongs in the labelled blocker read
  assert.match(result.observe.text, /Accept cookies.*ref=/);
});

test('real v3 scroll until finds a newly rendered virtual-list row', { skip }, async t => {
  const f = await fixture(t, `<div id="list" role="listbox" aria-label="Items" style="height:160px;overflow:auto">
    <div style="height:20000px;position:relative"></div></div><script>
    const list=document.querySelector('#list'), content=list.firstElementChild;
    function render(){const start=Math.floor(list.scrollTop/20);content.replaceChildren();for(let i=start;i<Math.min(start+9,1000);i++){
      const row=document.createElement('div');row.role='option';row.textContent='Item '+i;
      row.style='position:absolute;top:'+i*20+'px;height:20px';content.append(row);}}
    list.addEventListener('scroll',render);render();</script>`);
  const result = await f.run(f.tab, [{ do: 'scroll', ref: await f.ref('Items'), until: 'Item 80', dy: 200 }], {});
  assert.match(result.lines[0], /found .*Item 80.*ref=/, result.lines.join('\n'));
  assert.ok(await f.page.locator('#list').evaluate(el => el.scrollTop) > 0);
});

test('real v3 upload consumes exact user-file bytes and unknown submit never repeats', { skip }, async t => {
  const f = await fixture(t, `<label>Resume<input type="file" id="file"></label><form onsubmit="event.preventDefault();window.sends=(window.sends||0)+1">
    <button>Submit</button></form>`);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'v4-file-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'resume.txt'); writeFileSync(path, 'user-owned example bytes');
  const fileRef = await f.ref('Resume'), event = {};
  const identity = { browserIncarnation: 'fixture', brokerEpoch: 1, clientSession: 'fixture', turn: 'turn', leaseGeneration: 1,
    target: 'fixture', frame: 'main', document: 1, origin: new URL(f.page.url()).origin };
  const provider = createUserFileProvider({ readUserMessage: e => e === event ? { session: 'fixture', text: `Upload "${path}" to Resume` } : null,
    current: () => identity, resolveInput: ref => ref === fileRef ? { ...identity, ref, name: 'Resume' } : null });
  t.after(() => { assert.equal(provider.dispose().retained, 0); });
  const uploaded = await f.run(f.tab, [{ do: 'upload', ref: fileRef, paths: [path] }],
    { files: { provider, event, binding: { ...identity, operation: 'upload', ref: fileRef } } });
  assert.equal(uploaded.stoppedAt, null, uploaded.lines.join('\n'));
  assert.equal(await f.page.locator('#file').evaluate(async el => el.files[0].text()), 'user-owned example bytes');
  const submitRef = await f.ref('Submit');
  const result = await f.run(f.tab, [{ do: 'click', ref: submitRef }, { do: 'click', ref: submitRef }], {});
  assert.equal(result.stoppedAt, 2, result.lines.join('\n')); assert.match(result.lines[0], /unconfirmed/);
  assert.equal(await f.page.evaluate(() => window.sends), 1); assert.ok(f.tab.state.submitUnconfirmed.settledAt >= f.tab.state.submitUnconfirmed.startedAt + 1000);
});

test('real v3 viewport step resizes the page, reports the old size, and gives the original size back', { skip }, async t => {
  const f = await fixture(t, '<button>Only button</button>');
  const size = () => f.page.evaluate(() => [innerWidth, innerHeight]);
  assert.deepEqual(await size(), [1000, 800]);
  const set = await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }], {});
  assert.equal(set.stoppedAt, null, set.lines.join('\n'));
  assert.match(set.lines[0], process.env.SLEIGHT_MT === '0' ? /viewport 390x844 \(was 1000x800\); a viewport step with no size restores 1000x800/ : /viewport 390x844 \(was 1000x800; a viewport step with no size restores it\)\. \[offscreen\] means outside this viewport; \[partly offscreen\] means cut off by it\./);
  assert.deepEqual(await size(), [390, 844]);
  const second = await f.run(f.tab, [{ do: 'viewport', width: 768, height: 1024 }], {});
  assert.match(second.lines[0], /viewport 768x1024 \(was 390x844[;)]/);
  const restored = await f.run(f.tab, [{ do: 'viewport' }], {});
  assert.match(restored.lines[0], /viewport restored to 1000x800/);
  assert.deepEqual(await size(), [1000, 800]);
  assert.match((await f.run(f.tab, [{ do: 'viewport' }], {})).lines[0], /unchanged/);
});

test('real v3 twelve repeated key presses settle once at the end and every press reaches the slider', { skip }, async t => {
  const f = await fixture(t, '<label>Volume<input id="v" type="range" min="0" max="100" step="1" value="0"></label>');
  const key = 'ArrowRight', started = Date.now();
  const result = await f.run(f.tab, [{ do: 'click', ref: await f.ref('Volume') }, ...Array.from({ length: 11 }, () => ({ do: 'press', key }))], {});
  const took = Date.now() - started;
  assert.equal(result.stoppedAt, null, result.lines.join('\n')); assert.equal(await f.page.locator('#v').inputValue(), '61', 'the click lands on 50 and 11 presses add 11');
  assert.equal(f.checks.length, 12); t.diagnostic('12-step key batch took ' + took + ' ms');
  assert.ok(took < 3000, 'took ' + took + ' ms');
});

test('real v3 a submit that only opens a confirm dialog settles in about a second, and a silent submit keeps the full wait', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<form onsubmit="event.preventDefault();document.querySelector('#confirm').showModal()"><input aria-label="Note"><button type="submit">Save</button></form>
    <dialog id="confirm"><p>Save these settings?</p><button type="button" onclick="document.querySelector('#confirm').close()">Save settings</button></dialog>`);
  let started = Date.now();
  const result = await f.run(f.tab, [{ do: 'click', ref: await f.ref('Save') }], {});
  const took = Date.now() - started; t.diagnostic('dialog submit settled in ' + took + ' ms');
  assert.match(result.lines[0], /the page answered with a dialog or panel \(below\) and no request has started/);
  assert.ok(took >= 1000 && took < 2500, 'took ' + took + ' ms');
  assert.ok(f.tab.state.submitUnconfirmed, 'the submit stays unconfirmed until a read is delivered');
  const quiet = await fixture(t, '<form onsubmit="event.preventDefault()"><input aria-label="Note"><button type="submit">Save</button></form>');
  started = Date.now();
  const silent = await quiet.run(quiet.tab, [{ do: 'click', ref: await quiet.ref('Save') }], {});
  assert.match(silent.lines[0], /unconfirmed after 5 s/); assert.ok(Date.now() - started >= 5000);
});

// A visually hidden radio or checkbox sits under its own label, so Playwright's hit test always lands on the label (form-checkout,
// gate round 2026-10-16). check acts at the control's own point, which placeClear proved is the label, and a sticky bar is moved off.
const hidden = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
test('real v3 check reaches a visually hidden radio under its own label, clear of a sticky bottom bar', { skip }, async t => {
  const f = await fixture(t, `<div style="height:900px">Top</div><fieldset><legend>Delivery</legend>
    <label style="display:block;padding:12px"><input type="radio" name="d" id="std" style="${hidden}" checked>Standard</label>
    <label style="display:block;padding:12px"><input type="radio" name="d" id="ovn" style="${hidden}">Overnight</label></fieldset>
    <div style="height:900px">Bottom</div><div style="position:sticky;bottom:0;height:120px;background:#eee"><button>Pay now</button></div>`);
  const result = await f.run(f.tab, [{ do: 'check', ref: await f.ref('Overnight') }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.equal(await f.page.locator('#ovn').isChecked(), true);
});

test('real v3 check through an own label never presses a link nested in that label', { skip }, async t => {
  const f = await fixture(t, `<label style="display:inline-block;padding:4px"><input type="checkbox" id="agree" style="${hidden}">I agree to
    the <a href="/next">terms of service and the privacy policy of this shop</a></label>`);
  const line = (await f.page.ariaSnapshot({ mode: 'ai' })).split('\n').find(row => row.includes('checkbox'));
  const result = await f.run(f.tab, [{ do: 'check', ref: /\[ref=(e\d+)\]/.exec(line ?? '')?.[1] }], {});
  assert.doesNotMatch(f.page.url(), /\/next$/, 'the nested link was pressed');
  if (result.stoppedAt === null) assert.equal(await f.page.locator('#agree').isChecked(), true);
});

test('real v3 click reaches a visually hidden radio under its own label, clear of a sticky bottom bar', { skip }, async t => {
  const f = await fixture(t, `<div style="height:900px">Top</div><fieldset><legend>Delivery</legend>
    <label style="display:block;padding:12px"><input type="radio" name="d" id="std" style="${hidden}" checked>Standard</label>
    <label style="display:block;padding:12px"><input type="radio" name="d" id="ovn" style="${hidden}">Overnight</label></fieldset>
    <div style="height:900px">Bottom</div><div style="position:sticky;bottom:0;height:120px;background:#eee"><button>Pay now</button></div>`);
  const result = await f.run(f.tab, [{ do: 'click', ref: await f.ref('Overnight') }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.equal(await f.page.locator('#ovn').isChecked(), true);
});
