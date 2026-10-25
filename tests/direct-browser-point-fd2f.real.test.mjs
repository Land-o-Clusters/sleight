import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { resolvePoint } from '../plugins/sleight/lib/direct-browser/points.mjs';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';

process.env.SLEIGHT_POINT_INPUT = '1';
const style = '<style>#target{position:absolute;left:30px;top:30px;width:160px;height:60px}#target>*{pointer-events:none}#target i{position:absolute;inset:0;pointer-events:auto}</style>';
async function setup(t, html, routes = {}) {
  const f = await fixture(t, '<meta charset="utf-8">' + style + html, routes), page = f.entry.page;
  const ctx = createV3Context({ browser: 'bfixture', binding: createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text: 'Test the plain target' }, () => !page.isClosed()) });
  t.after(() => ctx.dispose());
  const run = createActionRunner({ check: () => assert.fail('trusted context required'), snapshot, backgroundClick });
  return { ...f, page, act: async () => {
    const read = await snapshot(page);
    assert.equal(acknowledgeSnapshot(page, read.number), true); f.entry.state.snapshotNo = read.number;
    return run(f.entry, [{ do: 'click', x: 70, y: 50, view: read.viewSignature }], ctx, { observe: 'none' });
  } };
}
const channels = [
  ['descendant img alt', '<img alt="Pay now">'],
  ['descendant SVG aria-label', '<svg aria-label="Pay now"></svg>'],
  ['descendant title', '<span title="Pay now"></span>'],
  ['descendant aria-labelledby', '<span aria-labelledby="name"></span>'],
  ['shadow-local aria-labelledby', '<span id="shadow"></span><script>shadow.attachShadow({mode:"open"}).innerHTML=\'<span aria-labelledby="shadowName"></span><span id="shadowName" hidden>Pay now</span>\'</script>'],
  ['open shadow text', '<span id="shadow"></span><script>shadow.attachShadow({mode:"open"}).innerHTML="<span>Pay now</span>"</script>'],
  ['CSS before', '<span class="css"></span><style>.css::before{content:"Pay now"}</style>'],
  ['CSS after', '<span class="css"></span><style>.css::after{content:"Pay now"}</style>'],
  ['zero width text', '<span>P\u200bay now</span>'],
  ['format text', '<span>B\u2060uy now</span>'],
];
for (const [name, contents] of channels) for (const signal of ['onclick', 'listener', 'target'])
  test('FD2F refuses ' + name + ' on ' + (signal === 'target' ? 'target' : signal + ' ancestor'), { skip, timeout: 60000 }, async t => {
    const extras = contents.match(/<(?:script|style)>[\s\S]*?<\/(?:script|style)>/g) ?? [];
    const markup = contents.replace(/<(?:script|style)>[\s\S]*?<\/(?:script|style)>/g, '');
    const f = await setup(t, `<div id="target" ${signal !== 'listener' ? 'onclick="pays++"' : ''}>${markup}<i ${signal === 'target' ? 'style="pointer-events:none"' : ''}></i></div>${extras.join('')}${name === 'descendant aria-labelledby' ? '<span id="name" hidden>Pay now</span>' : ''}<script>window.pays=0;window.downs=0;document.addEventListener('pointerdown',()=>downs++,true);${signal === 'listener' ? "target.addEventListener('click',()=>pays++)" : ''}</script>`);
    await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
    await f.page.reload();
    const result = await f.act();
    assert.match(result.lines[0], /covered by .*use its ref/i);
    assert.doesNotMatch(result.lines[0], /\bat (?:eval|point|named|utility)|\.mjs:\d|<anonymous>|Error:/);
    assert.deepEqual(await f.page.evaluate(() => ({ pays, downs })), { pays: 0, downs: 0 });
  });

for (const signal of ['onclick', 'listener', 'role']) test('FD2F refuses closed action host: ' + signal, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, `<div id="target" ${signal === 'onclick' ? 'onclick="pays++"' : signal === 'role' ? 'role="button"' : ''}></div><script>
    window.pays=0;window.downs=0;document.addEventListener('pointerdown',()=>downs++,true);
    target.attachShadow({mode:'closed'}).innerHTML='<span style="display:block;width:160px;height:60px">Pay now</span>';
    ${signal !== 'onclick' ? "target.addEventListener('click',()=>pays++)" : ''}</script>`);
  await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload(); const result = await f.act();
  assert.match(result.lines[0], /covered by .*use its ref/i);
  assert.deepEqual(await f.page.evaluate(() => ({ pays, downs })), { pays: 0, downs: 0 });
});

for (const [name, before, after, script] of [
  ['tabindex minus one', '<main tabindex="-1">', '<span>Pay now</span></main>', ''],
  ['body listener', '', '<span>Pay now</span>', "document.body.addEventListener('click',()=>{})"],
  ['html listener', '', '<span>Pay now</span>', "document.documentElement.addEventListener('click',()=>{})"],
  ['delegated root', '<div id="root" style="min-height:100vh;width:100vw">', '<span>Pay now</span></div>', "root.addEventListener('click',()=>{})"],
  ['long delegated root', '<div id="root" style="min-height:100vh;width:100vw">', '<p>' + 'Plain prose. '.repeat(500) + '</p><button>Pay now</button></div>', "root.addEventListener('click',()=>{});document.body.addEventListener('click',()=>{})"],
  ['heading in card form', '<form><input autocomplete="cc-number" style="position:absolute;left:500px">', '</form>', ''],
]) test('FD2F allows prose inside ' + name, { skip, timeout: 60000 }, async t => {
  const f = await setup(t, before + '<h2 id="target">Plain heading</h2>' + after + `<script>${script}</script>`);
  const result = await f.act();
  assert.match(result.lines[0], /input sent/);
  assert.doesNotMatch(result.lines[0], /not run|unconfirmed/);
});

test('FD2F listener name budget refusal never returns a utility script stack', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<div id="ancestor" style="width:300px;height:200px"><p id="target">Plain heading</p><span style="position:absolute;left:500px">' + 'Plain '.repeat(12000) + '</span></div><script>ancestor.addEventListener("click",()=>{})</script>');
  const result = await f.act();
  assert.match(result.lines[0], /Point geometry scan unavailable; use a control ref\./);
  assert.doesNotMatch(result.lines[0], /\bat |<anonymous>|Error:|\.mjs:\d/);
});

for (const [name, attrs, css, refused] of [
  ['90 percent viewport root', 'onclick=""', 'width:100vw;height:90vh', false],
  ['below root threshold', 'onclick=""', 'width:100vw;height:89vh', true],
  ['negative tabindex target', 'tabindex="-1" onclick=""', 'width:160px;height:60px', false],
  ['negative tabindex with role', 'tabindex="-1" role="button"', 'width:160px;height:60px', true],
]) test('FD2F name-test target exclusion: ' + name, { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, `<style>html,body{margin:0}#surface{${css}}</style><div id="surface" ${attrs}>Pay now</div>`);
  const page = f.entry.page, read = await snapshot(page);
  assert.equal(acknowledgeSnapshot(page, read.number), true);
  const resolve = async () => { const handle = await resolvePoint(page, { x: 70, y: 50, view: read.viewSignature }); await handle.dispose(); };
  if (refused) await assert.rejects(resolve, /covered by .*use its ref/);
  else await resolve();
});

test('FD2F disabled point input publishes no view and dispatches no input on a real page', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, '<div id="target" onclick="downs++">Plain</div><script>window.downs=0;document.addEventListener("pointerdown",()=>downs++,true)</script>');
  const previous = process.env.SLEIGHT_POINT_INPUT;
  t.after(() => { process.env.SLEIGHT_POINT_INPUT = previous; });
  delete process.env.SLEIGHT_POINT_INPUT;
  const read = await snapshot(f.page);
  assert.equal(read.viewSignature, undefined);
  await assert.rejects(f.act(), /SLEIGHT_POINT_INPUT=1/);
  assert.equal(await f.page.evaluate(() => downs), 0);
});

for (const signal of ['onclick', 'listener']) test('FD2F viewport root exemption keeps covered frame actions guarded: ' + signal, { skip, timeout: 60000 }, async t => {
  const child = `<div style="position:absolute;inset:0;pointer-events:none" ${signal === 'onclick' ? 'onclick="top.pays++"' : ''}>Pay</div>${signal === 'listener' ? '<script>document.querySelector("div").addEventListener("click",()=>top.pays++)</script>' : ''}`;
  const f = await setup(t, '<iframe src="/child" style="position:absolute;left:30px;top:30px;width:160px;height:60px;border:0"></iframe><div id="target"></div><script>window.pays=0;window.downs=0;target.onclick=()=>document.querySelector("iframe").contentDocument.querySelector("div").click();document.addEventListener("pointerdown",()=>downs++,true)</script>', { '/child': child });
  await f.page.frameLocator('iframe').locator('div').waitFor();
  await f.page.mouse.click(70, 50); assert.equal(await f.page.evaluate(() => pays), 1);
  await f.page.reload(); await f.page.frameLocator('iframe').locator('div').waitFor();
  const result = await f.act();
  assert.match(result.lines[0], /covered by .*use its ref/);
  assert.deepEqual(await f.page.evaluate(() => ({ pays, downs })), { pays: 0, downs: 0 });
});
