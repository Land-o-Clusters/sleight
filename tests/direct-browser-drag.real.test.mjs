import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, skip } from './fixtures/fd1-filtered-real.mjs';
import { createJobFixture, jobHandler, gradeJob } from '../bench/world/job-fixtures.mjs';

const ref = (text, name) => {
  const line = text.split('\n').find(line => line.includes(JSON.stringify(name)) && line.includes('[ref='));
  const found = /\[ref=(\w+)\]/.exec(line ?? '')?.[1];
  assert.ok(found, `missing ${name}\n${text}`); return found;
};
const passed = result => {
  assert.equal(result.isError, false, result.text);
  assert.doesNotMatch(result.text, /not run:|effect unconfirmed|timed out/);
};
const presses = wire => wire.filter(row => row.type === 'mousePressed');
async function receipt(ready) {
  const deadline = Date.now() + 3000;
  while (!ready() && Date.now() < deadline) await delay(20);
  assert.ok(ready(), 'fixture event POSTs did not settle');
}

// Removing interpolated moves must fail these tests against the unchanged job
// page: it counts trusted pointer moves while the grip owns pointer capture.
for (const seed of ['td1-a', 'td1-b', 'td1-c']) test('TD1 filtered job-kanban grip to heading: ' + seed, { skip, timeout: 30000 }, async t => {
  const job = createJobFixture('job-kanban', { nonce: 'td1', seed });
  const route = (req, res) => {
    if (req.url === '/start') req.url = '/td1/';
    return jobHandler(job, 'http://' + req.headers.host)(req, res);
  };
  const f = await fixture(t, '', { message: 'Move the named card to Review by its grip, without opening it.',
    routes: { '/start': route, '/td1/event': route } });
  const read = await f.call('browser_read', {}); passed(read);
  await receipt(() => job.kanban?.column === 'Queue');
  const before = f.wire.length;
  const result = await f.call('browser_act', { steps: [{ do: 'drag', ref: ref(read.text, 'Drag ' + job.expected.card), to: ref(read.text, 'Review') }] });
  passed(result);
  assert.equal(await f.entry.page.locator('#review #card').count(), 1, result.text);
  assert.equal(await f.entry.page.locator('#status').textContent(), 'Moved');
  await receipt(() => job.kanban?.column === 'Review' && job.events.some(event => event.kind === 'drag'));
  assert.deepEqual(job.kanban, job.expected);
  const drag = job.events.find(event => event.kind === 'drag');
  assert.ok(drag?.points >= 3, JSON.stringify(job.events));
  const grade = gradeJob({ task: { worldFixture: 'job-kanban' }, site: job, expected: job.expected, answer: JSON.stringify(job.expected) });
  assert.equal(grade.ok, true, JSON.stringify(grade));
  const wire = f.wire.slice(before);
  assert.equal(presses(wire).length, 1);
  assert.equal(wire.filter(row => row.type === 'mouseReleased').length, 1);
  assert.ok(wire.filter(row => row.type === 'mouseMoved').length >= 5);
  assert.equal(f.wire.filter(row => row.method === 'Page.captureScreenshot' || /bringToFront|activateTarget/.test(row.method)).length, 0);
  t.diagnostic(`Fixture recorded ${drag.points} trusted moves, Queue to Review, one press and one release.`);
});

test('TD1 interpolated ref drag preserves native HTML5 dataTransfer', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>#source,#destination{display:inline-block;margin:20px;padding:40px}</style>
    <div id="source" role="button" draggable="true">Source</div><div id="destination" role="button">Destination</div><output>Waiting</output>
    <script>source.ondragstart=e=>{if(e.isTrusted)e.dataTransfer.setData('text/plain','moved payload')};
    destination.ondragover=e=>e.preventDefault();destination.ondrop=e=>{e.preventDefault();if(e.isTrusted)document.querySelector('output').textContent=e.dataTransfer.getData('text/plain')};</script>`);
  const read = await f.call('browser_read', {});
  passed(await f.call('browser_act', { steps: [{ do: 'drag', ref: ref(read.text, 'Source'), to: ref(read.text, 'Destination') }] }));
  assert.equal(await f.entry.page.locator('output').textContent(), 'moved payload');
});

// Reading the destination box after the source hover scrolls back to the top
// sends the old implementation's held moves beyond the 800px viewport.
test('TD1 destination below the fold keeps every drag point in the viewport', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0}#source{margin:20px;width:120px;height:80px}
    #destination{margin:1600px 0 800px 500px;width:200px;height:160px}</style>
    <div id="source" role="button">Source</div><div id="destination" role="button">Destination</div><output>Waiting</output>
    <script>let held=false,points=0;source.onpointerdown=e=>{if(e.isTrusted){held=true;source.setPointerCapture(e.pointerId)}};
    source.onpointermove=e=>{if(held&&e.isTrusted)points++};source.onpointerup=e=>{
      const r=destination.getBoundingClientRect();if(held&&e.isTrusted&&points>=3&&e.clientX>=r.left&&e.clientX<r.right&&e.clientY>=r.top&&e.clientY<r.bottom)
        document.querySelector('output').textContent='Moved';held=false};</script>`);
  assert.ok((await f.entry.page.locator('#destination').boundingBox()).y > 800);
  const read = await f.call('browser_read', {}); passed(read);
  const before = f.wire.length;
  passed(await f.call('browser_act', { steps: [{ do: 'drag', ref: ref(read.text, 'Source'), to: ref(read.text, 'Destination') }] }));
  const wire = f.wire.slice(before), input = wire.filter(row => ['mouseMoved', 'mousePressed', 'mouseReleased'].includes(row.type));
  assert.ok(input.length >= 8);
  for (const { x, y, type } of input) assert.ok(x >= 0 && x < 1200 && y >= 0 && y < 800, `${type} outside viewport: ${x},${y}`);
  assert.equal(presses(wire).length, 1);
  assert.equal(wire.filter(row => row.type === 'mouseReleased').length, 1);
  assert.equal(await f.entry.page.locator('output').textContent(), 'Moved');
  assert.equal(f.wire.filter(row => row.method === 'Page.captureScreenshot' || /bringToFront|activateTarget/.test(row.method)).length, 0);
});

test('TD1 unknown refs and unsupported offsets dispatch no press; payment still asks', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<div role="button">Grip</div><h2>Target</h2><button onclick="window.paid=true">Pay $9</button>`);
  const read = await f.call('browser_read', {}), grip = ref(read.text, 'Grip'), target = ref(read.text, 'Target');
  for (const [step, refusal] of [
    [{ do: 'drag', ref: 'e99999', to: target }, /Ref is stale or its snapshot was not delivered; use browser_read again\./],
    [{ do: 'drag', ref: grip, to: 'e99999' }, /Ref is stale or its snapshot was not delivered; use browser_read again\./],
    [{ do: 'drag', ref: grip, dx: 400, dy: 20 }, /drag needs to/],
    [{ do: 'click', ref: ref(read.text, 'Pay $9') }, /^1 click e\d+: not run: confirmation required through the trusted consent UI/m],
  ]) {
    const before = f.wire.length, result = await f.call('browser_act', { steps: [step] });
    assert.match(result.text, refusal);
    assert.equal(presses(f.wire.slice(before)).length, 0, result.text);
  }
  assert.equal(await f.entry.page.evaluate(() => window.paid), undefined);
});

test('TD1 moving destination cannot drop the card into an unrelated zone after a failed final hover', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0}section{position:fixed;top:20px;width:180px;height:140px}
    #queue{left:20px}#other,#destination{left:400px}#destination{background:white}
    #card{width:120px;height:80px}</style>
    <section id="queue" data-zone="queue"><div id="card" role="button">Source</div></section>
    <section id="other" data-zone="other">Other zone</section><section id="destination" role="button" data-zone="destination">Destination</section>
    <script>let held=false;window.drops=[];window.movedAway=false;
      card.onpointerdown=e=>{if(e.isTrusted){held=true;card.setPointerCapture(e.pointerId)}};
      card.onpointermove=e=>{if(held&&e.isTrusted&&e.clientX>=400){destination.style.left='2400px';window.movedAway=true}};
      card.onpointerup=e=>{if(held&&e.isTrusted){
        const zone=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-zone]');
        if(zone&&zone!==card.parentElement){window.drops.push(zone.dataset.zone);zone.append(card)}held=false}};
    </script>`);
  const read = await f.call('browser_read', {}); passed(read);
  const before = f.wire.length;
  const result = await f.call('browser_act', { steps: [{ do: 'drag', ref: ref(read.text, 'Source'), to: ref(read.text, 'Destination') }] });
  assert.match(result.text, /timed out|outside of the viewport|effect unconfirmed/);
  assert.equal(await f.entry.page.evaluate(() => window.movedAway), true, 'destination must move before the final hover');
  assert.deepEqual(await f.entry.page.evaluate(() => window.drops), [], result.text);
  assert.equal(await f.entry.page.locator('#queue #card').count(), 1);
  assert.equal(await f.entry.page.locator('#other #card').count(), 0);
  const wire = f.wire.slice(before), press = presses(wire), releases = wire.filter(row => row.type === 'mouseReleased');
  assert.equal(press.length, 1); assert.equal(releases.length, 1);
  assert.deepEqual([releases[0].x, releases[0].y], [press[0].x, press[0].y]);
  assert.equal(f.wire.filter(row => row.method === 'Page.captureScreenshot' || /bringToFront|activateTarget/.test(row.method)).length, 0);
  t.diagnostic('Destination moved offscreen before final hover; card stayed in Queue, zero new drops, release at source.');
});
