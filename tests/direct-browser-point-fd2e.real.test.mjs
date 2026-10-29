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
  return { ...f, page, act: async (point = { x: 70, y: 50 }) => {
    const read = await snapshot(page);
    assert.equal(acknowledgeSnapshot(page, read.number), true); f.entry.state.snapshotNo = read.number;
    return run(f.entry, [{ do: 'click', view: read.viewSignature, ...point }], ctx, { observe: 'none' });
  } };
}
const style = '<style>#pay,#cover{position:absolute;left:30px;top:30px;width:160px;height:60px;margin:0;border:0;padding:0}#cover{z-index:2}</style>';
const probe = '<script>window.pays=0;window.downs=0;document.addEventListener("pointerdown",()=>downs++,true)</script>';
const cover = '<div id="cover" onclick="pay.click()"></div>';
const fire = 'window.pays++';
const variants = [];
for (const signal of ['onclick', 'tabindex', 'cursor', 'listener', 'role']) {
  const attr = signal === 'onclick' ? `onclick="${fire}"` : signal === 'tabindex' ? 'tabindex="0"' : signal === 'cursor' ? 'style="cursor:pointer"' : signal === 'role' ? 'role="button"' : '';
  const handler = signal === 'onclick' ? '' : `<script>pay.addEventListener('click',()=>{${fire}})</script>`;
  for (const hit of ['padding', 'icon']) variants.push([signal + ' nested words, ' + hit,
    `<div id="pay" ${attr}><span style="position:absolute;left:110px">Pay now</span>${hit === 'icon' ? '<i style="position:absolute;inset:0"></i>' : ''}</div>` + handler]);
}
for (const name of ['textContent', 'aria-label', 'aria-labelledby', 'title']) {
  const attr = name === 'textContent' ? '' : name === 'aria-labelledby' ? 'aria-labelledby="name"' : `${name}="Pay now"`;
  variants.push(['ancestor ' + name, `<div id="pay" onclick="${fire}" ${attr}>${name === 'textContent' ? '<span>Pay now</span>' : ''}<i style="position:absolute;inset:0"></i></div>` +
    (name === 'aria-labelledby' ? '<span id="name" style="position:absolute;left:500px">Pay now</span>' : '')]);
}
for (const kind of ['zero button', 'contents button', 'zero div', 'contents div']) {
  const tag = kind.endsWith('button') ? 'button' : 'div';
  const css = kind.startsWith('zero') ? 'width:0;height:0;overflow:visible' : 'display:contents';
  variants.push([kind, `<${tag} id="pay" style="${css}" onclick="${fire}"><span style="display:block;position:absolute;left:${kind.startsWith('zero') ? 0 : 30}px;top:${kind.startsWith('zero') ? 0 : 30}px;width:160px;height:60px">Go</span><span style="position:absolute;left:500px">Pay now</span></${tag}>` + cover]);
}
for (const shape of ['rect', 'circle', 'poly', 'default']) {
  const coords = { rect: '0,0,160,60', circle: '40,20,18', poly: '0,0,160,0,160,60,0,60', default: '' }[shape];
  variants.push(['area ' + shape, `<img style="position:absolute;left:30px;top:30px;width:160px;height:60px" width="160" height="60" usemap="#paymap" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='60'/%3E"><map name="paymap"><area id="pay" shape="${shape}" coords="${coords}" alt="Pay now" onclick="${fire}"></map>` + cover]);
}
for (const origin of [30, 190]) variants.push(['zero closed host at ' + origin,
  `<div id="host" style="position:absolute;left:${origin}px;top:30px;width:0;height:0"></div><div id="cover"></div><script>
  const root=host.attachShadow({mode:'closed'});root.innerHTML='<button style="position:absolute;left:${30 - origin}px;top:0;width:160px;height:60px">Pay</button>';
  root.firstChild.onclick=()=>{${fire}};cover.onclick=()=>root.firstChild.click();</script>`]);

for (const [width, height] of [[0, 60], [160, 0]]) variants.push(['closed zero-area host ' + width + 'x' + height,
  `<div id="host" style="position:absolute;left:30px;top:30px;width:${width}px;height:${height}px"></div><div id="cover"></div><script>
  const root=host.attachShadow({mode:'closed'});root.innerHTML='<button style="position:absolute;left:0;top:0;width:160px;height:60px">Pay</button>';
  root.firstChild.onclick=()=>{${fire}};cover.onclick=()=>root.firstChild.click();</script>`]);

for (const [name, html] of variants) test('FD2E guards ' + name, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + html);
  await f.page.mouse.click(70, 50); assert.ok(await f.page.evaluate(() => pays) > 0, 'raw fixture input fires pay');
  await f.page.reload();
  const result = await f.act(), state = await f.page.evaluate(() => ({ pays, downs }));
  t.diagnostic(JSON.stringify({ name, line: result.lines[0], ...state }));
  assert.match(result.lines[0], /use (?:its |a (?:control )?)?ref/i);
  assert.deepEqual(state, { pays: 0, downs: 0 });
});

for (const words of ['Save', 'Complete', 'Book', 'Send', 'Accept', 'Charge', 'Save the Children', 'Submit', 'Confirm', 'Agree', 'Allow all', 'Finish', 'A book about how to save and send work.'])
  test('FD2E plain wording passes: ' + words, { skip, timeout: 60000 }, async t => {
    const tag = words === 'Save the Children' ? 'a' : 'p';
    const f = await setup(t, style + `<${tag} id="pay">${words}</${tag}><script>window.clicks=0;pay.onclick=()=>clicks++</script>`);
    const result = await f.act(); t.diagnostic(result.lines[0]);
    assert.match(result.lines[0], /input sent/); assert.equal(await f.page.evaluate(() => clicks), 1);
  });

for (const kind of ['ordinary iframe', 'ordinary cross-origin iframe', 'payment fields', 'provider iframe', 'form without iframe'])
  test('FD2E form classification: ' + kind, { skip, timeout: 60000 }, async t => {
    const plain = kind === 'form without iframe';
    const f = await setup(t, style + '<form><button type="button" id="pay" onclick="window.clicks++">Continue</button>' +
      (kind === 'payment fields' ? '<input autocomplete="cc-number" style="position:absolute;left:500px">' : '') +
      (plain ? '' : `<iframe style="position:absolute;left:500px" srcdoc="<p>Help</p>" src="${kind === 'provider iframe' ? 'https://js.stripe.com/fixture' : kind === 'ordinary cross-origin iframe' ? 'https://docs.example.invalid/help' : '/child'}"></iframe>`) +
      '</form><script>window.clicks=0;window.downs=0;document.addEventListener("pointerdown",()=>downs++,true)</script>', { '/child': '<p>Help</p>' });
    if (kind === 'ordinary cross-origin iframe') {
      const url = new URL('/child', f.page.url()); url.hostname = 'localhost';
      await f.page.locator('iframe').evaluate((el, src) => { el.removeAttribute('srcdoc'); el.src = src; }, url.href);
    }
    if (!plain) await f.page.frameLocator('iframe').locator('p').waitFor();
    const result = await f.act(); t.diagnostic(result.lines[0]);
    // Point geometry distinguishes provider frames, while the existing action
    // classifier conservatively asks for any iframe in a form.
    assert.match(result.lines[0], plain ? /input sent/ : kind.startsWith('ordinary') ? /confirmation required through the trusted consent UI/ : /use its ref/);
    assert.deepEqual(await f.page.evaluate(() => ({ clicks, downs })), plain ? { clicks: 1, downs: 1 } : { clicks: 0, downs: 0 });
  });

for (const kind of ['plain forwarding listener', 'document forwarding listener'])
  test('FD2E records inherent limit: ' + kind, { skip, timeout: 60000 }, async t => {
    const f = await setup(t, style + '<div id="cover"></div><button id="pay" style="left:500px" type="button" onclick="window.pays++">Pay</button>' + probe +
      `<script>${kind.startsWith('plain') ? 'cover' : 'document'}.addEventListener('click',e=>{if(e.target===cover)pay.click()})</script>`);
    const result = await f.act(); t.diagnostic(result.lines[0]);
    assert.match(result.lines[0], /input sent/); assert.equal(await f.page.evaluate(() => pays), 1);
  });

for (const [name, transform, coords, point, refused] of [
  ['scaled area', 'scale(2)', '0,0,40,30', { x: 70, y: 50 }, true],
  ['outside area', 'none', '100,0,150,60', { x: 70, y: 50 }, false],
  ['rotated area', 'rotate(5deg)', '0,0,160,60', { x: 70, y: 50 }, true],
]) test('FD2E maps image coordinates: ' + name, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + probe + `<img style="position:absolute;left:30px;top:30px;width:160px;height:60px;transform-origin:0 0;transform:${transform}" width="160" height="60" usemap="#m" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='60'/%3E"><map name="m"><area id="pay" shape="rect" coords="${coords}" alt="Pay" onclick="window.pays++"></map><div id="cover" onclick="window.clicks++"></div><script>window.clicks=0</script>`);
  const result = await f.act(point); t.diagnostic(result.lines[0]);
  assert.match(result.lines[0], refused ? /use (?:its |a (?:control )?)?ref/ : /input sent/);
  assert.deepEqual(await f.page.evaluate(() => [clicks, pays]), [refused ? 0 : 1, 0]);
});

for (const signal of ['', 'onclick="window.other++"']) test('FD2E zero-box plain host stays usable: ' + signal, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, style + `<div style="position:absolute;left:190px;top:30px;width:0;height:0" ${signal}></div><div id="cover" onclick="window.clicks++"></div><script>window.clicks=0;window.other=0</script>`);
  assert.match((await f.act()).lines[0], /input sent/);
  assert.deepEqual(await f.page.evaluate(() => [clicks, other]), [1, 0]);
});

test('FD2E zero closed host refuses even when the native hit reached its plain child', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, probe + '<div id="host" style="position:absolute;left:30px;top:30px;width:0;height:0"></div><script>const root=host.attachShadow({mode:"closed"});root.innerHTML=`<canvas width="160" height="60"></canvas>`;root.firstChild.onclick=()=>window.pays++</script>');
  await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload();
  assert.match((await f.act()).lines[0], /use its ref/);
  assert.deepEqual(await f.page.evaluate(() => [pays, downs]), [0, 0]);
});
