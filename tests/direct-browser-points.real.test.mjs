process.env.SLEIGHT_POINT_INPUT = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { capturePointView, assertPointView, resolvePoint } from '../plugins/sleight/lib/direct-browser/points.mjs';
import { trustedRead } from '../plugins/sleight/lib/direct-browser/trusted-dom.mjs';

async function setup(t, html, message = 'Test the fixture controls', routes = {}) {
  const f = await fixture(t, html, routes), page = f.entry.page;
  const ctx = createV3Context({ browser: 'bfixture', binding: createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text: message }, () => !page.isClosed()) });
  t.after(() => ctx.dispose());
  const run = createActionRunner({ check: () => assert.fail('trusted context required'), snapshot, backgroundClick });
  let view;
  const read = async (deliver = true) => {
    const result = await snapshot(page);
    view = result.viewSignature;
    if (deliver) { assert.equal(acknowledgeSnapshot(page, result.number), true); f.entry.state.snapshotNo = result.number; }
    return result;
  };
  const at = async selector => { const box = await page.locator(selector).boundingBox(); return { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) }; };
  const act = step => run(f.entry, [step.x === undefined ? step : { view, ...step }], ctx, { observe: 'none' });
  return { ...f, page, ctx, read, at, act };
}
const pass = result => assert.match(result.lines[0], /input sent/, result.lines.join('\n'));

// Each FD2C refusal must happen before Chromium receives pointer input. These
// pages deliberately forward harmless-looking hits to a guarded control.
const coveredStyle = `<style>
  #pay,#cover,#host{position:absolute;left:30px;top:30px;width:160px;height:60px;margin:0;border:0;padding:0}
  #cover{z-index:2;background:transparent;color:transparent}
</style>`;
const eventProbe = `<script>window.events=[];
  for(const type of ['pointermove','pointerdown','pointerup','click','submit'])
    document.addEventListener(type,e=>{e.preventDefault();events.push(type)},true);
</script>`;

for (const [name, cover] of [
  ['button', '<button id="cover" type="button" onclick="pay.click()"></button>'],
  ['anchor', '<a id="cover" href="#" onclick="pay.click()"></a>'],
  ['role button', '<div id="cover" role="button" onclick="pay.click()"></div>'],
  ['summary', '<details open><summary id="cover" onclick="pay.click()"></summary></details>'],
]) test('FD2C actionable cover refuses before input: ' + name, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, coveredStyle + '<button id="pay" type="button">Pay now</button>' + cover + eventProbe);
  await f.read();
  assert.match((await f.act({ do: 'click', x: 70, y: 50 })).lines[0], /covered by button; use its ref/);
  assert.deepEqual(await f.page.evaluate(() => events), []);
});

test('FD2C drag refuses an anchor without href over Pay before pressing', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, coveredStyle + '<canvas style="position:absolute;left:300px;top:30px" width="100" height="100"></canvas><button id="pay" type="button">Pay now</button><a id="cover" onpointerup="pay.click()"></a>' + eventProbe);
  await f.read();
  assert.match((await f.act({ do: 'drag', x: 350, y: 50, to: { x: 70, y: 50 } })).lines[0], /covered by button; use its ref/);
  assert.deepEqual(await f.page.evaluate(() => events), []);
});

for (const mode of ['open', 'closed', 'nested-open', 'nested-closed'])
  test('FD2C covered shadow control refuses before input: ' + mode, { skip, timeout: 60000 }, async t => {
    const f = await setup(t, coveredStyle + '<div id="host"></div><div id="cover"></div>' + `<script>
      let root=host.attachShadow({mode:'${mode.startsWith('nested') ? 'open' : mode}'});
      ${mode.startsWith('nested') ? `root.innerHTML='<div id="nested" style="width:160px;height:60px"></div>';root=root.querySelector('div').attachShadow({mode:'${mode.slice(7)}'});` : ''}
      root.innerHTML='<button type="button" style="width:160px;height:60px">Pay now</button>';
      cover.onclick=()=>root.querySelector('button').click();
      // Page prototype poisoning must not change the utility-world stack.
      Document.prototype.elementsFromPoint=()=>[];ShadowRoot.prototype.elementsFromPoint=()=>[];
    </script>` + eventProbe);
    await f.read();
    assert.match((await f.act({ do: 'click', x: 70, y: 50 })).lines[0], /covered by (?:button|element); use its ref/);
    assert.deepEqual(await f.page.evaluate(() => events), []);
  });

for (const mode of ['srcdoc', 'same-origin', 'nested', 'cross-origin'])
  test('FD2C child frame scans ancestor stacks before input: ' + mode, { skip, timeout: 60000 }, async t => {
    const child = '<style>html,body{margin:0;background:transparent}canvas{display:block}</style><canvas width="160" height="60"></canvas><script>window.events=[];for(const type of ["pointermove","pointerdown","click"])document.addEventListener(type,()=>events.push(type));document.onclick=()=>parent.document.querySelector("#pay").click()</script>';
    const f = await setup(t, coveredStyle + '<button id="pay" type="button">Pay now</button><iframe id="cover"></iframe>' + eventProbe,
      'Test the fixture controls', { '/child': child });
    const cover = f.page.locator('#cover');
    await cover.evaluate((el, { mode, child }) => {
      if (mode === 'srcdoc') el.srcdoc = child;
      else if (mode === 'nested') el.srcdoc = '<iframe style="position:absolute;left:0;top:0;width:160px;height:60px;border:0" src="/child"></iframe>';
      else el.src = location.origin.replace('127.0.0.1', mode === 'cross-origin' ? 'localhost' : '127.0.0.1') + '/child';
    }, { mode, child });
    const canvas = mode === 'nested' ? f.page.frameLocator('#cover').frameLocator('iframe').locator('canvas') : f.page.frameLocator('#cover').locator('canvas');
    await canvas.waitFor();
    const read = await f.read();
    // srcdoc has an additional action-layer fence. Exercise point acquisition
    // itself so that fence cannot hide a missing ancestor-stack classification.
    await assert.rejects(async () => {
      const handle = await resolvePoint(f.page, { x: 70, y: 50, view: read.viewSignature });
      await handle.dispose();
    }, mode === 'cross-origin' ? /Use a ref for the child-frame control|covered by (?:button|iframe)/ : /covered by button; use its ref/);
    const result = await f.act({ do: 'click', x: 70, y: 50 });
    assert.match(result.lines[0], mode === 'cross-origin' ? /not run: (?:Use a ref for the child-frame control|covered by (?:button|iframe))/ : /covered by button; use its ref/);
    assert.deepEqual(await f.page.evaluate(() => events), []);
    assert.deepEqual(await canvas.evaluate(el => el.ownerDocument.defaultView.events), []);
  });

test('FD2C covered refusal sanitizes custom element tags', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, coveredStyle + '<x-private-fixture-tag-that-is-longer-than-forty-characters id="pay" role="button">Pay now</x-private-fixture-tag-that-is-longer-than-forty-characters><div id="cover"></div>' + eventProbe);
  await f.read();
  const result = await f.act({ do: 'click', x: 70, y: 50 });
  assert.match(result.lines[0], /covered by element; use its ref/);
  assert.doesNotMatch(result.lines.join('\n'), /x-private-fixture/);
  assert.deepEqual(await f.page.evaluate(() => events), []);
});

test('FD2C payment words on a below-stack container do not guard its blank area', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, coveredStyle + '<div style="position:absolute;left:30px;top:30px;width:400px;height:200px"><button type="button" style="position:absolute;left:220px">Pay now</button></div><div id="cover"></div><script>window.clicks=0;cover.onclick=()=>clicks++</script>');
  await f.read(); pass(await f.act({ do: 'click', x: 70, y: 50 }));
  assert.equal(await f.page.evaluate(() => clicks), 1);
});

test('FD2C bound label and its plain control are one point target', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, coveredStyle + '<button id="pay" type="button">Plain</button><label id="cover" for="pay"></label><script>window.clicks=0;pay.onclick=()=>clicks++</script>');
  const read = await f.read();
  const handle = await resolvePoint(f.page, { x: 70, y: 50, view: read.viewSignature });
  try { assert.equal(await trustedRead(handle, (el, unused, read) => read(el, 'id')), 'pay'); }
  finally { await handle.dispose(); }
  assert.equal(await f.page.evaluate(() => clicks), 0);
});

test('FD2 real delivered read enables exact canvas clicks and hover without scrolling or changing tabs', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<canvas width="500" height="300"></canvas><script>
    window.events=[]; for(const type of ['pointerdown','pointermove','click']) document.querySelector('canvas').addEventListener(type,e=>events.push([type,e.clientX,e.clientY,e.isTrusted]));
  </script>`);
  await f.read(false);
  assert.match((await f.act({ do: 'click', x: 30, y: 40 })).lines[0], /stale or unavailable/);
  await f.read();
  assert.ok(await capturePointView(f.page)); await assertPointView(f.page);
  pass(await f.act({ do: 'click', x: 30, y: 40 }));
  assert.deepEqual(await f.page.evaluate(() => events.find(e => e[0] === 'click')), ['click', 30, 40, true]);
  await f.read(); pass(await f.act({ do: 'hover', x: 45, y: 60 }));
  assert.deepEqual(await f.page.evaluate(() => [scrollX,scrollY]), [0,0]);
  assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
  assert.equal(f.context.pages().length, 2);
});

for (const change of [
  "document.querySelector('button').textContent='Changed'",
  "document.querySelector('button').textContent='Changed'; document.querySelector('button').textContent='Plain'",
  "scrollTo(0,100)", "document.querySelector('input').value='new'",
  "document.querySelector('button').style.transform='translateX(30px)'",
  "document.querySelector('style').sheet.insertRule('button{margin-left:30px}')",
]) test('FD2 real stale point refuses after ' + change, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<style></style><button type="button">Plain</button><input><div style="height:3000px"></div><script>window.count=0;document.querySelector("button").onclick=()=>count++</script>');
  const point = await f.at('button'); await f.read(); await f.page.evaluate(change);
  const result = await f.act({ do: 'click', ...point });
  assert.match(result.lines[0], /not run: Point coordinates are stale/);
  assert.equal(await f.page.evaluate(() => count), 0);
});

test('FD2 real hit testing classifies button descendants, payment controls and picker labels', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<button type="button"><span draggable="true" contenteditable="false">Pay now fixture-secret</span></button><label for="file">Pick a file</label><input id="file" type="file">
    <input type="color"><select><option>One</option></select><input type="password" value="fixture-secret">
    <script>window.count=0;document.addEventListener('click',()=>count++)</script>`, 'Read this page');
  for (const [selector, reason] of [['span', /covered by button; use its ref/], ['label', /native picker/], ['input[type=color]', /native picker/],
    ['select', /native picker/], ['input[type=password]', /Protected controls/]]) {
    const point = await f.at(selector); await f.read();
    const result = await f.act({ do: 'click', ...point });
    assert.match(result.lines[0], /not run:/); assert.match(result.lines[0], reason);
    assert.doesNotMatch(result.lines.join('\n'), /fixture-secret/);
  }
  assert.equal(await f.page.evaluate(() => count), 0);
});

test('FD2 real point submit requires its ref before the unconfirmed-submit fence', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<form><button><span>Send</span></button></form><script>window.count=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();count++}</script>', 'Submit this form');
  const point = await f.at('span'); await f.read();
  f.entry.state.submitUnconfirmed = { startedAt: Date.now() };
  const result = await f.act({ do: 'click', ...point });
  assert.match(result.lines[0], /not run: covered by button; use its ref/);
  assert.equal(await f.page.evaluate(() => count), 0);
});

test('FD2 real a link point follows the checked background navigation path', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<a href="/landed" target="_blank"><span>Next page</span></a>', 'Open the next page');
  const point = await f.at('span'); await f.read(); const result = await f.act({ do: 'click', ...point });
  assert.match(result.lines[0], /at \d+,\d+ \(a\).*opened background tab/);
  assert.match(f.page.url(), /\/start$/);
  assert.equal((await f.registry.list()).length, 2);
});

test('FD2 real point drag sends intermediate trusted pointer moves and suppresses a click', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<canvas width="600" height="300"></canvas><script>
    window.events=[];for(const type of ['pointerdown','pointermove','pointerup','click'])document.querySelector('canvas').addEventListener(type,e=>events.push([type,e.clientX,e.clientY,e.buttons,e.isTrusted]));
  </script>`, 'Drag across the canvas');
  await f.read();
  const result = await f.act({ do: 'drag', x: 40, y: 80, to: { x: 190, y: 80 } }); pass(result);
  const events = await f.page.evaluate(() => events), down = events.findIndex(e => e[0] === 'pointerdown');
  const motion = events.slice(down + 1).filter(e => e[0] === 'pointermove');
  assert.equal(motion.length, 10); assert.ok(motion.every(e => e[3] === 1 && e[4]));
  assert.deepEqual(motion.map(e => e[1]), [55,70,85,100,115,130,145,160,175,190]);
  assert.equal(events.filter(e => e[0] === 'click').length, 0);
  assert.equal(events.filter(e => e[0] === 'pointerup').length, 1);
});

test('FD2 real point drag classifies its destination before any press', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="100" height="100"></canvas><button>Pay now</button><div role="checkbox" style="width:100px;height:60px"><span>Toggle</span></div><script>window.count=0;document.onpointerdown=()=>count++</script>');
  for (const selector of ['button','[role=checkbox] span']) {
    const to = await f.at(selector); await f.read();
    assert.match((await f.act({ do: 'drag', x: 30, y: 30, to })).lines[0], selector === 'button' ? /not run: covered by button; use its ref/ : /not run: Point drag endpoints/);
  }
  assert.equal(await f.page.evaluate(() => count), 0);
});

test('FD2 real a target swapped on pointer arrival is refused before pressing', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<button type="button">Plain</button><script>window.count=0;const b=document.querySelector('button');b.onpointerenter=()=>b.textContent='Pay now';b.onpointerdown=()=>count++</script>`);
  const point = await f.at('button'); await f.read();
  assert.match((await f.act({ do: 'click', ...point })).lines[0], /not run: Point coordinates are stale/);
  assert.equal(await f.page.evaluate(() => count), 0);
});

test('FD2 real point drag between separate surfaces seals the endpoint and permits pointer capture', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<div id="source" style="position:absolute;left:20px;top:20px;width:100px;height:100px">Card</div>
    <div id="dest" style="position:absolute;left:200px;top:20px;width:100px;height:100px">Lane</div>
    <script>window.releases=0;window.clicks=0;const s=document.querySelector('#source');s.onpointerdown=e=>s.setPointerCapture(e.pointerId);s.onpointerup=()=>releases++;document.onclick=()=>clicks++</script>`, 'Drag the card');
  await f.read(); pass(await f.act({ do: 'drag', x: 50, y: 50, to: { x: 250, y: 50 } }));
  assert.deepEqual(await f.page.evaluate(() => [releases,clicks]), [1,0]);
});

test('FD2 real drag release cannot reach a destination changed into a payment control', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<canvas width="100" height="100"></canvas><div id="dest" style="position:absolute;left:200px;top:20px;width:100px;height:100px">Lane</div>
    <script>window.releases=0;window.clicks=0;const d=document.querySelector('#dest');document.querySelector('canvas').onpointerdown=()=>{d.setAttribute('role','button');d.textContent='Pay now'};d.onpointerup=()=>releases++;d.onclick=()=>clicks++</script>`, 'Drag across the canvas');
  await f.read(); const result = await f.act({ do: 'drag', x: 40, y: 50, to: { x: 250, y: 50 } });
  assert.match(result.lines[0], /effect unconfirmed/);
  assert.deepEqual(await f.page.evaluate(() => [releases,clicks]), [0,0]);
  assert.equal(f.entry.state.actionPending, false);
});

for (const mode of ['open','closed']) test('FD2 real native hit testing keeps payment classification inside the ' + mode + ' shadow root', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<div id="host" style="position:absolute;left:20px;top:20px;width:200px;height:50px"></div><script>
    window.count=0;const r=document.querySelector('#host').attachShadow({mode:'${mode}'});r.innerHTML='<button style="width:200px;height:50px"><span>Pay now</span></button>';r.querySelector('button').onclick=()=>count++;
    Document.prototype.elementFromPoint=()=>document.body;Element.prototype.closest=()=>null;
  </script>`, 'Read this page');
  await f.read(); const result = await f.act({ do: 'click', x: 70, y: 40 });
  assert.match(result.lines[0], /not run: covered by button; use its ref/);
  assert.doesNotMatch(result.lines[0], /Pay now/);
  assert.equal(await f.page.evaluate(() => count), 0);
});

for (const cross of [false,true]) test('FD2 real viewport point resolves an actual child-frame control, cross-origin=' + cross, { skip, timeout: 60000 }, async t => {
  const child = '<button type="button" style="width:100px;height:50px">Plain</button><script>window.count=0;document.querySelector("button").onclick=()=>count++</script>';
  const f = await setup(t, '<iframe style="position:absolute;left:100px;top:100px;width:300px;height:200px"></iframe>', 'Click Plain', { '/child': child });
  await f.page.locator('iframe').evaluate((el, cross) => { el.src = location.origin.replace('127.0.0.1', cross ? 'localhost' : '127.0.0.1') + '/child'; }, cross);
  const button = f.page.frameLocator('iframe').locator('button'); await button.waitFor();
  const box = await button.boundingBox(), point = { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) };
  await f.read(); const result = await f.act({ do: 'click', ...point });
  if (cross) {
    assert.match(result.lines[0], /not run: (?:Use a ref for the child-frame control|covered by iframe)/);
    assert.equal(await button.evaluate(el => el.ownerDocument.defaultView.count), 0);
  } else {
    pass(result); assert.equal(await button.evaluate(el => el.ownerDocument.defaultView.count), 1);
  }
});

test('FD2 real handoff removes the utility observer and retires point authority', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="100" height="100"></canvas>');
  await f.read(); await assertPointView(f.page);
  await f.registry.handoff(f.entry.tab);
  await assert.rejects(assertPointView(f.page), /stale or unavailable/);
  const impl = f.page.mainFrame()._connection.toImpl(f.page.mainFrame());
  assert.equal(await (await impl.utilityContext()).evaluateExpression('() => !!globalThis.__sleightPointEpoch', { isFunction: true }), false);
});

test('FD2 real HTML drag-and-drop moves a card to a different lane', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<div id="card" draggable="true" style="position:absolute;left:20px;top:20px;width:100px;height:100px">Card</div>
    <div id="lane" style="position:absolute;left:200px;top:20px;width:100px;height:100px">Lane</div><script>
    window.drops=0;const card=document.querySelector('#card'),lane=document.querySelector('#lane');card.ondragstart=e=>e.dataTransfer.setData('text/plain','card');lane.ondragover=e=>e.preventDefault();lane.ondrop=e=>{e.preventDefault();drops++;lane.append(card)};
  </script>`, 'Drag the card into the lane');
  await f.read(); const result = await f.act({ do: 'drag', x: 50, y: 50, to: { x: 250, y: 50 } });
  assert.doesNotMatch(result.lines[0], /not run:|effect unconfirmed/);
  assert.deepEqual(await f.page.evaluate(() => [drops,document.querySelector('#card').parentElement.id]), [1,'lane']);
});

test('FD2 real drag holds page-script popups and reports them', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<canvas width="500" height="200"></canvas><script>
    document.querySelector('canvas').onpointerdown=()=>window.open('/landed','_blank');
  </script>`, 'Drag across the canvas');
  await f.read(); const result = await f.act({ do: 'drag', x: 40, y: 50, to: { x: 190, y: 50 } });
  assert.match(result.lines[0], /Page script tried to open a tab.*held, nothing opened/);
  assert.equal(f.context.pages().length, 2);
});

test('FD2 real point selection modifiers keep the requested page semantics', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<div role="option" tabindex="0" style="width:200px;height:80px">Option</div><script>
    window.clicks=[];document.querySelector('[role=option]').onclick=e=>clicks.push([e.ctrlKey,e.metaKey,e.clientX,e.clientY]);
  </script>`, 'Select the option with Command and Control');
  const point = await f.at('[role=option]');
  for (const modifier of ['cmd','ctrl']) { await f.read(); pass(await f.act({ do: 'click', ...point, modifier })); }
  assert.deepEqual(await f.page.evaluate(() => clicks), [[false,true,point.x,point.y],[true,false,point.x,point.y]]);
});

test('FD2 real viewport and navigation changes retire the point view', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<button type="button">Plain</button>');
  await f.read();
  assert.match((await f.act({ do: 'click', x: 10000, y: 10000 })).lines[0], /outside the tab viewport/);
  await f.page.setViewportSize({ width: 900, height: 500 });
  assert.match((await f.act({ do: 'hover', x: 20, y: 20 })).lines[0], /Point coordinates are stale/);
  await f.read(); await f.page.goto(f.page.url() + '?new');
  assert.match((await f.act({ do: 'click', x: 20, y: 20 })).lines[0], /Point coordinates are stale/);
});

for (const [name, under, over] of [
  ['payment overlay', '<button id="pay">Pay now</button>', '<div onclick="pay.click()"></div>'],
  ['draggable payment overlay', '<button id="pay">Pay now</button>', '<div draggable="true" onclick="pay.click()"></div>'],
  ['editable payment overlay', '<button id="pay">Pay now</button>', '<div contenteditable="false" onclick="pay.click()"></div>'],
  ['unbound label payment overlay', '<button id="pay">Pay now</button>', '<label onclick="pay.click()"></label>'],
  ['submit overlay', '<form id="send"><button>Send</button></form>', '<div onclick="send.requestSubmit()"></div>'],
  ['submit label', '<form id="send"><button id="pay">Send</button></form>', '<label for="pay"></label>'],
]) test('FD2B refuses ' + name + ' before a page handler can forward input', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<style>button,body>div,body>label{position:absolute;left:30px;top:30px;width:160px;height:60px}body>div,body>label{z-index:2}</style>${under}${over}
    <script>window.events=[];document.addEventListener('click',e=>events.push('click'));document.addEventListener('submit',e=>{e.preventDefault();events.push('submit')})</script>`, 'Read this page');
  await f.read();
  const result = await f.act({ do: 'click', x: 70, y: 50 });
  assert.match(result.lines[0], /covered by (?:button|input).*use its ref/);
  assert.deepEqual(await f.page.evaluate(() => events), []);
});

test('FD2B hover rechecks its target after the rule check and before pointer input', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="400" height="200"></canvas><script>window.moves=0;document.onpointermove=()=>moves++</script>');
  const read = await f.read();
  const run = createActionRunner({ snapshot, check: async () => {
    await f.page.locator('canvas').evaluate(el => el.style.transform = 'translateX(200px)');
    return { verdict: 'allow' };
  } });
  const result = await run(f.entry, [{ do: 'hover', x: 50, y: 50, view: read.viewSignature }], {}, { observe: 'none' });
  assert.match(result.lines[0], /not run: Point coordinates are stale/);
  assert.equal(await f.page.evaluate(() => moves), 0);
});

test('FD2B coordinates from an older view cannot borrow a newer delivered read', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="400" height="200"></canvas><script>window.clicks=0;document.onclick=()=>clicks++</script>');
  const old = await f.read();
  assert.match(old.viewSignature, /^[a-f0-9]{16}$/);
  await f.page.locator('canvas').evaluate(el => el.style.transform = 'translateX(100px)');
  const fresh = await f.read();
  assert.notEqual(fresh.viewSignature, old.viewSignature);
  assert.match(fresh.text, new RegExp('view=' + fresh.viewSignature));
  assert.match((await f.act({ do: 'click', x: 130, y: 50, view: old.viewSignature })).lines[0], /Point coordinates are stale/);
  assert.equal(await f.page.evaluate(() => clicks), 0);
  await f.read(); pass(await f.act({ do: 'click', x: 130, y: 50 }));
});

test('FD2B unchanged point actions use one native layout capture per renderer', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="500" height="200"></canvas>');
  const impl = f.page.mainFrame()._connection.toImpl(f.page.mainFrame());
  const client = impl._page.delegate._sessionForFrame(impl)._client, send = client._sendMayFail;
  let captures = 0, captureMs = 0;
  client._sendMayFail = async function(method, ...args) {
    const start = performance.now();
    try { return await send.call(this, method, ...args); }
    finally { if (method === 'DOMSnapshot.captureSnapshot') { captures++; captureMs += performance.now() - start; } }
  };
  t.after(() => { client._sendMayFail = send; });
  const counts = [];
  for (const step of [{ do: 'click', x: 40, y: 50 }, { do: 'hover', x: 60, y: 50 }, { do: 'drag', x: 40, y: 50, to: { x: 190, y: 50 } }]) {
    await f.read(); captures = 0; captureMs = 0;
    const start = performance.now(); pass(await f.act(step));
    t.diagnostic(JSON.stringify({ action: step.do, captures, captureMs, actionMs: performance.now() - start }));
    counts.push(captures);
  }
  assert.deepEqual(counts, [1, 1, 1], 'each step owns a fresh cache and reuses only its unchanged layout');
});

test('FD2B delivered act diffs acknowledge their view, suppressed observations do not', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<button type="button">Plain</button><canvas width="400" height="150"></canvas><script>document.querySelector("button").onclick=()=>document.querySelector("button").textContent="Changed"</script>');
  const run = createActionRunner({ check: () => assert.fail('trusted context required'), snapshot, backgroundClick });
  const dispatcher = createToolDispatcher({ browser: 'bfixture', pages: f.registry, snapshot, runSteps: run, ctx: f.ctx,
    fillFields: () => assert.fail('no fill'), deliverSnapshot: (state, capture) => {
      if (!acknowledgeSnapshot(capture.page, capture.number)) return false;
      state.snapshotNo = Math.max(state.snapshotNo, capture.number); return true;
    } });
  const request = (name, args) => dispatcher.call({ name, arguments: { tab: f.entry.tab, ...args } });
  const initial = await request('browser_read', {}); assert.equal(dispatcher.delivered(initial), true);
  const first = initial.text.match(/view=([a-f0-9]{16})/)[1], point = await f.at('button');
  const action = await request('browser_act', { steps: [{ do: 'click', ...point, view: first }] });
  const next = action.text.match(/view=([a-f0-9]{16})/)[1]; assert.notEqual(next, first);
  await assert.rejects(assertPointView(f.page, next), /stale or unavailable/);
  assert.equal(dispatcher.delivered(action), true); await assertPointView(f.page, next);
  const hidden = await request('browser_act', { steps: [{ do: 'hover', x: 100, y: 70, view: next }], observe: 'none' });
  assert.doesNotMatch(hidden.text, /view=/); assert.equal(dispatcher.delivered(hidden), false);
});

for (const [name, html, point] of [
  ['nested scroll offsets', `<style>#outer{position:absolute;left:30px;top:30px;width:400px;height:250px;overflow:auto}#inner{margin-top:180px;width:350px;height:200px;overflow:auto}canvas{display:block;margin:180px 0 0 100px}section{width:800px;height:700px}</style><div id="outer"><section><div id="inner"><section><canvas width="300" height="150"></canvas></section></div></section></div><script>outer.scrollTop=100;inner.scrollTop=130;inner.scrollLeft=50</script>`, null],
  ['pointer-events none cover', '<canvas width="400" height="200"></canvas><div style="position:absolute;inset:0;pointer-events:none"></div>', {x:70,y:50}],
]) test('FD2B CSS pixel hit and input agree with ' + name, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, html + '<script>window.events=[];document.querySelector("canvas").onclick=e=>events.push([e.clientX,e.clientY,e.isTrusted])</script>');
  const at = point ?? await f.at('canvas'); await f.read(); pass(await f.act({do:'click',...at}));
  assert.deepEqual(await f.page.evaluate(() => events), [[at.x, at.y, true]]);
});

for (const tag of ['button', 'input', 'select', 'iframe']) test('FD2B transformed overlay refuses covered ' + tag, { skip, timeout:60000 }, async t => {
  const under = tag === 'button' ? '<button>Pay now</button>' : tag === 'input' ? '<input type="file">' : tag === 'select' ? '<select><option>One</option></select>' : '<iframe src="/child"></iframe>';
  const f = await setup(t, `<style>main{transform:translate(80px,40px) scale(1.2);transform-origin:0 0}main>*{position:absolute;left:20px;top:20px;width:150px;height:60px}main>div{z-index:2}</style><main>${under}<div></div></main><script>window.events=0;document.onpointerdown=()=>events++;</script>`, 'Read this page', {'/child':'<button>Pay now</button>'});
  const point = await f.at('main>div'); await f.read();
  assert.match((await f.act({do:'click',...point})).lines[0], new RegExp('covered by ' + (tag === 'iframe' ? 'button' : tag) + '; use its ref'));
  assert.equal(await f.page.evaluate(()=>events),0);
});

for (const overlay of [false, true, 'mirror']) test('FD2B same-process frame scroll offsets preserve local hit testing, overlay=' + overlay, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<iframe style="position:absolute;left:80px;top:100px;width:350px;height:220px;border:5px solid"></iframe>', 'Click Plain', {
    '/child': `<style>button,body>div{position:absolute;left:30px;top:400px;width:160px;height:60px}body>div{z-index:2}body{height:2000px}</style><button id="pay" type="button">${overlay ? 'Pay now' : 'Plain'}</button>${overlay ? '<div onclick="document.getElementById(&quot;pay&quot;).click()"></div>' : ''}<script>window.count=0;document.querySelector('button').onclick=()=>count++</script>` });
  await f.page.locator('iframe').evaluate((el, mirror) => {
    el.src = '/child'; if (mirror) el.style.transform = 'scaleX(-1)';
  }, overlay === 'mirror');
  const button = f.page.frameLocator('iframe').locator('button'); await button.waitFor();
  await button.evaluate(el => el.ownerDocument.defaultView.scrollTo(0, 350));
  await button.evaluate(el => new Promise(resolve => {
    const view = el.ownerDocument.defaultView;
    view.requestAnimationFrame(() => view.requestAnimationFrame(resolve));
  }));
  const box = await button.boundingBox(), point = { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) };
  await f.read(); const result = await f.act({ do: 'click', ...point });
  if (overlay === 'mirror') assert.match(result.lines[0], /Use a ref for the transformed child-frame control/);
  else if (overlay) assert.match(result.lines[0], /covered by button; use its ref/);
  else pass(result);
  assert.equal(await button.evaluate(el => el.ownerDocument.defaultView.count), overlay ? 0 : 1);
});

test('FD2B DPR 2 and emulated viewport use CSS pixels for native hits and mouse dispatch', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="600" height="300"></canvas><script>window.events=[];document.querySelector("canvas").onclick=e=>events.push([e.clientX,e.clientY,e.isTrusted])</script>');
  const cdp = await f.context.newCDPSession(f.page); t.after(() => cdp.detach().catch(() => {}));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 360, deviceScaleFactor: 2, mobile: false });
  assert.deepEqual(await f.page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]), [640, 360, 2]);
  const impl = f.page.mainFrame()._connection.toImpl(f.page.mainFrame()), client = impl._page.delegate._sessionForFrame(impl)._client;
  const send = client.send, calls = [];
  client.send = async function(method, params, ...rest) {
    if (['DOM.getNodeForLocation', 'Input.dispatchMouseEvent'].includes(method)) calls.push({ method, ...params });
    return send.call(this, method, params, ...rest);
  };
  t.after(() => { client.send = send; });
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await f.read(); pass(await f.act({ do: 'click', x: 123, y: 91 }));
  assert.deepEqual(await f.page.evaluate(() => events), [[123, 91, true]]);
  const hits = calls.filter(c => c.method === 'DOM.getNodeForLocation'), input = calls.filter(c => c.method === 'Input.dispatchMouseEvent');
  assert.ok(hits.length); assert.ok(input.some(c => c.type === 'mousePressed')); assert.ok(input.some(c => c.type === 'mouseReleased'));
  for (const call of [...hits, ...input]) assert.deepEqual([call.x, call.y], [123, 91]);
  const resize = await f.act({ do: 'viewport', width: 480, height: 320 }); assert.match(resize.lines[0], /viewport 480x320/);
  const read = await f.read(); assert.match(read.text, /Viewport 480x320 CSS px/);
  pass(await f.act({ do: 'click', x: 101, y: 81 }));
  assert.deepEqual(await f.page.evaluate(() => events.at(-1)), [101, 81, true]);
});

test('FD2B closed-root changes between gate and hover invalidate cached native layout', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<div id="host"></div><script>window.root=host.attachShadow({mode:'closed'});root.innerHTML='<canvas width="400" height="200"></canvas>';window.moves=0;document.onpointermove=()=>moves++</script>`);
  const read = await f.read();
  const run = createActionRunner({ snapshot, check: async () => {
    await f.page.evaluate(() => root.querySelector('canvas').style.transform = 'translateX(10px)');
    return { verdict: 'allow' };
  } });
  const result = await run(f.entry, [{ do: 'hover', x: 50, y: 50, view: read.viewSignature }], {}, { observe: 'none' });
  assert.match(result.lines[0], /not run: Point coordinates are stale/);
  assert.equal(await f.page.evaluate(() => moves), 0);
});

for (const change of ["document.querySelector('style').sheet.insertRule('canvas{transform:translateX(10px)}')", "document.querySelector('input').value='changed'"])
  test('FD2B cache rechecks native state without DOM mutations: ' + change, { skip, timeout: 60000 }, async t => {
    const f = await setup(t, '<style></style><canvas width="400" height="200"></canvas><input><script>window.moves=0;document.onpointermove=()=>moves++</script>');
    const read = await f.read();
    const run = createActionRunner({ snapshot, check: async () => { await f.page.evaluate(change); return { verdict: 'allow' }; } });
    const result = await run(f.entry, [{ do: 'hover', x: 50, y: 50, view: read.viewSignature }], {}, { observe: 'none' });
    assert.match(result.lines[0], /not run: Point coordinates are stale/);
    assert.equal(await f.page.evaluate(() => moves), 0);
  });

test('FD2B cached and uncached freshness check latency on 1000 nodes', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="500" height="200"></canvas>' + '<div>Fixture row</div>'.repeat(1000));
  const read = await f.read();
  const impl = f.page.mainFrame()._connection.toImpl(f.page.mainFrame()), client = impl._page.delegate._sessionForFrame(impl)._client;
  const send = client._sendMayFail; let captures = 0;
  client._sendMayFail = async function(method, ...args) { if (method === 'DOMSnapshot.captureSnapshot') captures++; return send.call(this, method, ...args); };
  t.after(() => { client._sendMayFail = send; });
  const counts = [], times = { uncached: [], cached: [] };
  for (let round = 0; round < 5; round++) for (const kind of round % 2 ? ['cached', 'uncached'] : ['uncached', 'cached']) {
    const cache = kind === 'cached' ? {} : undefined, start = performance.now(); captures = 0;
    for (let i = 0; i < 5; i++) await assertPointView(f.page, read.viewSignature, cache);
    times[kind].push(performance.now() - start); counts.push([kind, captures]);
  }
  t.diagnostic(JSON.stringify({ nodes: 1000, checksPerSample: 5, samplesMs: times }));
  for (const [kind, count] of counts) assert.equal(count, kind === 'cached' ? 1 : 5);
});

for (const mode of ['open', 'closed']) test('FD2F shadow surface allows open text and refuses closed action hosts, mode=' + mode, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<div id="host"></div><button>Pay now</button><script>
    host.attachShadow({mode:'${mode}'}).innerHTML='<canvas width="400" height="200"></canvas>';
    window.clicks=0;host.onclick=()=>clicks++;
  </script>`);
  await f.read(); const result = await f.act({ do: 'click', x: 50, y: 50 });
  if (mode === 'closed') assert.match(result.lines[0], /use its ref/);
  else pass(result);
  assert.equal(await f.page.evaluate(() => clicks), mode === 'closed' ? 0 : 1);
});
