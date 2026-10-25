process.env.SLEIGHT_POINT_INPUT = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';

async function setup(t, html, routes = {}) {
  const f = await fixture(t, html, routes), page = f.entry.page;
  const ctx = createV3Context({ browser: 'bfixture', binding: createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text: 'Test the plain target' }, () => !page.isClosed()) });
  t.after(() => ctx.dispose());
  const run = createActionRunner({ check: () => assert.fail('trusted context required'), snapshot, backgroundClick });
  const act = async step => {
    const read = await snapshot(page);
    assert.equal(acknowledgeSnapshot(page, read.number), true); f.entry.state.snapshotNo = read.number;
    return run(f.entry, [{ view: read.viewSignature, ...step }], ctx, { observe: 'none' });
  };
  return { ...f, page, act };
}
const style = `<style>
  #pay,#cover,#host,iframe{position:absolute;left:30px;top:30px;width:160px;height:60px;margin:0;border:0;padding:0}
  #cover{z-index:2;background:transparent}#source{position:absolute;left:300px;top:30px}
</style>`;
const probe = `<script>window.pays=0;window.inputs=[];
  document.addEventListener('pointerdown',()=>inputs.push('down'),true);
  document.addEventListener('pointermove',()=>inputs.push('move'),true);
  document.addEventListener('click',()=>inputs.push('click'),true);
  document.addEventListener('fixture-pay',()=>pays++);
</script>`;
const fire = "document.dispatchEvent(new Event('fixture-pay'))";
const plainCover = '<div id="cover" onclick="pay.click()" onpointerup="pay.click()"></div>';
const buttonPay = `<button id="pay" type="button" onclick="${fire}">Pay now</button>`;
const variants = [
  ['div onclick Pay', `<div id="pay" onclick="${fire}">Pay now</div>`, plainCover],
  ['tabindex span Buy', `<span id="pay" tabindex="0" onclick="${fire}">Buy</span>`, plainCover],
  ['pointer-events none Pay', `<button id="pay" type="button" style="pointer-events:none" onclick="${fire}">Pay now</button>`, '<button id="cover" type="button" onclick="pay.click()" onpointerup="pay.click()"></button>'],
  ['own text without role', `<div id="pay">Pay now</div>`, `<div id="cover" onclick="${fire}" onpointerup="${fire}"></div>`],
  ['button overlay', buttonPay, '<button id="cover" type="button" onclick="pay.click()"></button>'],
  ['anchor overlay', buttonPay, '<a id="cover" href="#" onclick="pay.click()"></a>'],
  ['role button overlay', buttonPay, '<div id="cover" role="button" onclick="pay.click()"></div>'],
  ['summary overlay', buttonPay, '<details open><summary id="cover" onclick="pay.click()"></summary></details>'],
  ['href-less drag overlay', buttonPay, '<a id="cover" onpointerup="pay.click()"></a>'],
  ['localized payment', `<div id="pay" onclick="${fire}">Payer</div>`, plainCover],
  ['accessible labelledby', `<div id="pay" aria-labelledby="payname" onclick="${fire}"></div><span id="payname" style="position:absolute;left:600px">Confirm purchase</span>`, plainCover],
  ['consent accept', `<div id="pay" onclick="${fire}">Accept all cookies</div>`, plainCover],
  ['submit role', `<div id="pay" role="button" onclick="${fire}">Submit</div>`, plainCover],
  ['payment form', `<form><input autocomplete="cc-number" style="position:absolute;left:600px"><div id="pay" onclick="${fire}">Continue</div></form>`, plainCover],
  ['listener only', '<div id="pay"></div>', `<div id="cover" onclick="pay.click()"></div><script>pay.addEventListener('click',()=>{${fire}})</script>`],
  ['tabindex only', `<span id="pay" tabindex="0"></span>`, `<div id="cover" onclick="${fire}"></div>`],
  ['pointer cursor only', `<div id="pay" style="cursor:pointer"></div>`, `<div id="cover" onclick="${fire}"></div>`],
];

for (const [name, under, over] of variants) test('FD2D geometry refuses ' + name, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + under + over + '<canvas id="source" width="100" height="100"></canvas>');
  // Calibrate on the starting revision: the fixture really forwards raw input.
  if (name === 'href-less drag overlay') {
    await f.page.mouse.move(350, 50); await f.page.mouse.down(); await f.page.mouse.move(70, 50); await f.page.mouse.up();
  } else await f.page.mouse.click(70, 50);
  assert.ok(await f.page.evaluate(() => pays) > 0, 'raw fixture input must fire payment');
  await f.page.reload();
  const result = await f.act(name === 'href-less drag overlay' ? { do: 'drag', x: 350, y: 50, to: { x: 70, y: 50 } } : { do: 'click', x: 70, y: 50 });
  const outcome = await f.page.evaluate(() => ({ pays, inputs }));
  t.diagnostic(JSON.stringify({ name, result: result.lines[0], ...outcome }));
  assert.match(result.lines[0], /use (?:its |a (?:control )?)?ref/i);
  assert.deepEqual(outcome, { pays: 0, inputs: [] });
});

for (const mode of ['open', 'closed', 'nested-open', 'nested-closed']) test('FD2D geometry finds covered shadow Pay: ' + mode, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + '<div id="host"></div><div id="cover"></div>' + `<script>
    let root=host.attachShadow({mode:'${mode.startsWith('nested') ? 'open' : mode}'});
    ${mode.startsWith('nested') ? `root.innerHTML='<div style="width:160px;height:60px"></div>';root=root.firstChild.attachShadow({mode:'${mode.slice(7)}'});` : ''}
    root.innerHTML='<div style="width:160px;height:60px;pointer-events:none">Pay now</div>';
    root.firstChild.onclick=()=>{${fire}};cover.onclick=()=>root.firstChild.click();
    Document.prototype.elementsFromPoint=()=>[];ShadowRoot.prototype.elementsFromPoint=()=>[];
    Element.prototype.getBoundingClientRect=()=>({left:900,top:900,right:901,bottom:901,width:1,height:1});
  </script>`);
  await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload(); const result = await f.act({ do: 'click', x: 70, y: 50 });
  t.diagnostic(result.lines[0]); assert.match(result.lines[0], /use (?:its |a (?:control )?)?ref/i);
  assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

for (const mode of ['same-origin', 'srcdoc', 'nested']) test('FD2D geometry checks parent Pay behind ' + mode + ' frame', { skip, timeout: 60000 }, async t => {
  const child = '<style>html,body{margin:0}</style><canvas width="160" height="60"></canvas><script>document.onclick=()=>top.document.querySelector("#pay").click()</script>';
  const f = await setup(t, style + probe + `<div id="pay" style="pointer-events:none" onclick="${fire}">Pay now</div><iframe id="cover"></iframe>`, { '/child': child });
  const load = async () => {
    await f.page.locator('iframe').evaluate((el, { mode, child }) => {
      if (mode === 'srcdoc') el.srcdoc = child;
      else if (mode === 'nested') el.srcdoc = '<iframe style="position:absolute;left:0;top:0;width:160px;height:60px;border:0" src="/child"></iframe>';
      else el.src = '/child';
    }, { mode, child });
    await (mode === 'nested' ? f.page.frameLocator('#cover').frameLocator('iframe') : f.page.frameLocator('#cover')).locator('canvas').waitFor();
  };
  await load(); await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload(); await load(); const result = await f.act({ do: 'click', x: 70, y: 50 });
  t.diagnostic(result.lines[0]); assert.match(result.lines[0], /use (?:its |a (?:control )?)?ref/i);
  assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

for (const action of ['hover', 'drag-start', 'drag-end']) test('FD2D geometry guards ' + action + ' before pointer input', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + `<span id="pay" style="pointer-events:none">Buy</span><div id="cover"></div><canvas id="source" width="100" height="100"></canvas><script>cover.onpointerover=()=>{${fire}};cover.onpointerdown=()=>{${fire}};cover.onpointerup=()=>{${fire}}</script>`);
  await f.page.mouse.move(70, 50); assert.ok(await f.page.evaluate(() => pays) > 0);
  await f.page.reload();
  const result = await f.act(action === 'hover' ? { do: 'hover', x: 70, y: 50 } : action === 'drag-start' ?
    { do: 'drag', x: 70, y: 50, to: { x: 350, y: 50 } } : { do: 'drag', x: 350, y: 50, to: { x: 70, y: 50 } });
  t.diagnostic(result.lines[0]); assert.match(result.lines[0], /use (?:its |a (?:control )?)?ref/i);
  assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

for (const [name, point, refused] of [
  ['backdrop over Subscribe', { x: 70, y: 50 }, true],
  ['backdrop away from Subscribe', { x: 250, y: 50 }, false],
  ['Close X over Upgrade', { x: 70, y: 50 }, true],
  ['Close X away from Upgrade', { x: 250, y: 50 }, false],
]) test('FD2D measures false refusals: ' + name, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + `<button id="pay" type="button">${name.startsWith('backdrop') ? 'Subscribe' : 'Upgrade'}</button>` +
    (name.startsWith('backdrop') ? '<div id="cover" style="width:300px"></div>' : `<button id="cover" type="button" style="left:${point.x - 10}px;width:20px">X</button>`) +
    '<script>window.clicks=0;cover.onclick=()=>clicks++</script>');
  const result = await f.act({ do: 'click', ...point }); t.diagnostic(JSON.stringify({ name, refused, line: result.lines[0] }));
  assert.match(result.lines[0], refused ? /use its ref/ : /input sent/);
  assert.equal(await f.page.evaluate(() => clicks), refused ? 0 : 1);
});

test('FD2D scans covered same-origin child geometry even when parent receives the hit', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + '<iframe src="/child"></iframe><div id="cover"></div><script>cover.onclick=()=>document.querySelector("iframe").contentDocument.querySelector("div").click()</script>',
    { '/child': '<div style="position:absolute;inset:0;pointer-events:none" onclick="top.document.dispatchEvent(new Event(\'fixture-pay\'))">Pay</div>' });
  await f.page.frameLocator('iframe').locator('div').waitFor();
  await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload(); await f.page.frameLocator('iframe').locator('div').waitFor();
  assert.match((await f.act({ do: 'click', x: 70, y: 50 })).lines[0], /use its ref/);
  assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

test('FD2D refuses a document above the geometry node budget', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="400" height="200"></canvas>' + '<i></i>'.repeat(20001) + '<script>window.inputs=0;document.onpointerdown=()=>inputs++</script>');
  const result = await f.act({ do: 'click', x: 70, y: 50 }); t.diagnostic(result.lines[0]);
  assert.match(result.lines[0], /scan.*use a (?:control )?ref/i); assert.equal(await f.page.evaluate(() => inputs), 0);
});

for (const signal of ['own text', 'aria-label', 'aria-labelledby']) test('FD2D refuses oversized ' + signal + ' instead of truncating away Pay', { skip, timeout: 60000 }, async t => {
  const long = 'x'.repeat(4100) + ' Pay';
  const under = signal === 'own text' ? '<div id="pay">' + long + '</div>' : signal === 'aria-label' ?
    '<div id="pay" aria-label="' + long + '"></div>' : '<div id="pay" aria-labelledby="name"></div><span id="name" style="position:absolute;left:600px">' + long + '</span>';
  const f = await setup(t, style + probe + under + `<div id="cover" onclick="${fire}"></div>`);
  const result = await f.act({ do: 'click', x: 70, y: 50 });
  assert.match(result.lines[0], /use (?:its |a (?:control )?)?ref/i);
  assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

test('FD2D refuses a no-role Pay ancestor behind its plain-looking child', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + `<div id="pay" onclick="${fire}">Pay<span style="display:block;position:absolute;inset:0">Go</span></div>`);
  await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload();
  const result = await f.act({ do: 'click', x: 70, y: 50 }); t.diagnostic(result.lines[0]);
  assert.match(result.lines[0], /use (?:its |a (?:control )?)?ref/i);
  assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

test('FD2D plain area stays usable beside a distant listener in its below-point container', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + '<section style="position:absolute;left:0;top:0;width:600px;height:200px"><button type="button" style="position:absolute;left:450px" onclick="window.pays++">Pay</button></section><div id="cover"></div><script>window.clicks=0;window.pays=0;cover.onclick=()=>clicks++</script>');
  const result = await f.act({ do: 'click', x: 70, y: 50 }); t.diagnostic(result.lines[0]);
  assert.match(result.lines[0], /input sent/); assert.deepEqual(await f.page.evaluate(() => [clicks, pays]), [1, 0]);
});

test('FD2D walks open shadow roots even when their host box misses the point', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + '<div id="host" style="width:0;height:0"></div><div id="cover"></div>' + `<script>
    const root=host.attachShadow({mode:'open'});root.innerHTML='<span style="display:block;width:160px;height:60px;pointer-events:none">Buy</span>';
    cover.onclick=()=>{${fire}};
  </script>`);
  const result = await f.act({ do: 'click', x: 70, y: 50 });
  assert.match(result.lines[0], /use its ref/); assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

for (const method of ['DOM.describeNode', 'DOM.resolveNode', 'DOMDebugger.getEventListeners', 'Accessibility.getPartialAXTree'])
  test('FD2D refuses unavailable native evidence: ' + method, { skip, timeout: 60000 }, async t => {
    const f = await setup(t, style + probe + '<div id="pay"></div><div id="cover"></div>');
    const impl = f.page.mainFrame()._connection.toImpl(f.page.mainFrame()), client = impl._page.delegate._sessionForFrame(impl)._client;
    const send = client._sendMayFail;
    client._sendMayFail = function(name, params) { return name === method && (method !== 'DOM.resolveNode' || params.executionContextId === undefined) ? Promise.resolve(undefined) : send.call(this, name, params); };
    t.after(() => { client._sendMayFail = send; });
    const result = await f.act({ do: 'click', x: 70, y: 50 });
    assert.match(result.lines[0], /use a control ref/); assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
  });

test('FD2D reads a payment input live value rather than its old attribute', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + '<input id="pay" type="button" value="Plain"><div id="cover" onclick="pay.click()"></div>' + `<script>
    pay.value='Pay now';document.addEventListener('click',e=>{if(e.target===pay){${fire}}});
  </script>`);
  await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload();
  assert.match((await f.act({ do: 'click', x: 70, y: 50 })).lines[0], /use its ref/);
  assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

for (const signal of ['listener', 'tabindex', 'cursor']) test('FD2D checks a named custom ancestor with ' + signal, { skip, timeout: 60000 }, async t => {
  const attr = signal === 'tabindex' ? 'tabindex="0"' : signal === 'cursor' ? 'style="cursor:pointer"' : '';
  const f = await setup(t, style + probe + `<div id="pay" ${attr}>Pay<span style="display:block;position:absolute;inset:0">Go</span></div>` +
    (signal === 'listener' ? `<script>pay.addEventListener('click',()=>{${fire}})</script>` : ''));
  const result = await f.act({ do: 'click', x: 70, y: 50 });
  assert.match(result.lines[0], /use its ref/); assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

for (const actionAncestor of [false, true]) test('FD2E dialog descendant words require an action signal, ancestor=' + actionAncestor, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<div role="dialog" style="width:600px;height:200px"><canvas width="300" height="150"></canvas><button type="button" style="position:absolute;left:450px">Pay</button></div><script>window.clicks=0;document.querySelector("' + (actionAncestor ? '[role=dialog]' : 'canvas') + '").onclick=()=>clicks++</script>');
  const result = await f.act({ do: 'click', x: 70, y: 50 }); t.diagnostic(result.lines[0]);
  assert.match(result.lines[0], actionAncestor ? /use its ref/ : /input sent/);
  assert.equal(await f.page.evaluate(() => clicks), actionAncestor ? 0 : 1);
});

for (const word of ['Plain', 'Unrecognized purchase name']) test('FD2D unknown covered button requires a ref by tag: ' + word, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + `<button id="pay" type="button">${word}</button><div id="cover" onclick="pay.click()"></div><script>
    document.addEventListener('click',e=>{if(e.target===pay){${fire}}});
  </script>`);
  await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload();
  assert.match((await f.act({ do: 'click', x: 70, y: 50 })).lines[0], /use its ref/);
  assert.deepEqual(await f.page.evaluate(() => [pays, inputs]), [0, []]);
});

test('FD2D known pointerover race can run page code before the stale-view refusal', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + '<button id="cover" type="button">Plain</button>' + probe + `<script>
    cover.onpointerover=()=>{cover.textContent='Pay';${fire}};
  </script>`);
  const result = await f.act({ do: 'click', x: 70, y: 50 });
  assert.match(result.lines[0], /not run: Point coordinates are stale/);
  const paid = await f.page.evaluate(() => pays);
  t.diagnostic(JSON.stringify({ pointeroverPayments: paid, refusal: result.lines[0] }));
  assert.ok(paid > 0, 'arrival handler runs before the final stale-view check');
  assert.equal(await f.page.evaluate(() => inputs.includes('down')), false);
});

for (const kind of ['closed shell', 'same-origin frame', 'cross-origin frame']) for (const inside of [true, false])
  test('FD2D measures opaque-cover refusals: ' + kind + ', inside=' + inside, { skip, timeout: 60000 }, async t => {
    const opaque = kind === 'closed shell' ? '<div id="host"></div><script>host.attachShadow({mode:"closed"}).innerHTML="<canvas width=160 height=60></canvas>"</script>' : '<iframe id="host"></iframe>';
    const f = await setup(t, style + opaque + '<div id="cover" style="width:300px"></div><script>window.clicks=0;cover.onclick=()=>clicks++</script>', { '/child': '<canvas width="160" height="60"></canvas>' });
    if (kind !== 'closed shell') {
      await f.page.locator('iframe').evaluate((el, cross) => { el.src = location.origin.replace('127.0.0.1', cross ? 'localhost' : '127.0.0.1') + '/child'; }, kind === 'cross-origin frame');
      await f.page.frameLocator('iframe').locator('canvas').waitFor();
    }
    const refused = inside && kind !== 'same-origin frame';
    const result = await f.act({ do: 'click', x: inside ? 70 : 250, y: 50 });
    t.diagnostic(JSON.stringify({ kind, inside, refused, line: result.lines[0] }));
    assert.match(result.lines[0], refused ? /use its ref/ : /input sent/);
    assert.equal(await f.page.evaluate(() => clicks), refused ? 0 : 1);
  });

for (const inside of [true, false]) test('FD2D bounds intersecting native candidates, inside=' + inside, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<canvas width="400" height="200"></canvas>' + `<i style="position:absolute;left:${inside ? 30 : 500}px;top:30px;width:160px;height:60px;pointer-events:none"></i>`.repeat(129) +
    '<script>window.clicks=0;document.querySelector("canvas").onclick=()=>clicks++</script>');
  const result = await f.act({ do: 'click', x: 70, y: 50 });
  assert.match(result.lines[0], inside ? /scan.*use a control ref/ : /input sent/);
  assert.equal(await f.page.evaluate(() => clicks), inside ? 0 : 1);
});
