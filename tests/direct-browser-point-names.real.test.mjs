process.env.SLEIGHT_POINT_INPUT = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { resolvePoint } from '../plugins/sleight/lib/direct-browser/points.mjs';
import { holdPointEvidence, withReplayDeadline, assertNoPointInput, pointPhases } from './helpers/point-evidence-replay.mjs';

const labelledPayment = '<style>#pay{position:absolute;left:30px;top:30px;width:160px;height:60px}</style>' +
  '<label for="pay" style="position:absolute;left:500px">Pay now</label><input id="pay" type="button" value="">' +
  '<script>window.pays=0;window.inputs=[];pay.onclick=()=>pays++;for(const type of ["pointermove","pointerdown","click"])document.addEventListener(type,()=>inputs.push(type))</script>';

for (const stalled of ['payment name', 'unrelated ancestor'])
  test('FL4 payment name acquisition refuses a held ' + stalled + ' reply', { skip, timeout: 15000 }, async t => {
    const f = await fixture(t, labelledPayment), page = f.entry.page;
    const read = await snapshot(page); assert.equal(acknowledgeSnapshot(page, read.number), true);
    assert.match(read.viewSignature, /^[a-f0-9]{16}$/);
    const held = holdPointEvidence(t, page, (method, params, result) => stalled === 'payment name'
      ? method === 'Accessibility.getPartialAXTree'
      : method === 'DOM.describeNode' && params.objectId && result?.node?.localName === 'body');
    const name = stalled === 'unrelated ancestor'
      ? holdPointEvidence(t, page, method => method === 'Accessibility.getPartialAXTree') : undefined;
    const acquisition = resolvePoint(page, { x: 70, y: 50, view: read.viewSignature });
    // Observe rejection immediately; the controller may release a reply during cleanup.
    acquisition.catch(() => {});
    try {
      if (name) {
        await withReplayDeadline(Promise.race([held.ready, acquisition]), 10000);
        name.release();
      }
      await assert.rejects(withReplayDeadline(acquisition, 10000), stalled === 'payment name' ? /use a control ref/ : /use its ref/);
      if (stalled === 'payment name') {
        assert.equal(held.trace.length, 1);
        assert.equal(held.trace[0].name, 'Pay now');
      } else assert.equal(held.trace.length, 1, 'ancestor evidence starts alongside the payment target');
      await assertNoPointInput(page);
    } finally {
      name?.release(); held.release();
      await assert.rejects(acquisition, /use (?:its|a control) ref/);
    }
  });

test('FL4 a late native listener handle is collected after the evidence deadline', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, labelledPayment.replace('Pay now', 'Plain')), page = f.entry.page;
  const read = await snapshot(page); assert.equal(acknowledgeSnapshot(page, read.number), true);
  const held = holdPointEvidence(t, page, (method, params) => method === 'DOM.resolveNode' && params.executionContextId === undefined);
  const acquisition = resolvePoint(page, { x: 70, y: 50, view: read.viewSignature });
  acquisition.catch(() => {});
  try {
    await assert.rejects(withReplayDeadline(acquisition, 10000), /use a control ref/);
    assert.equal(held.trace.length, 1); assert.equal(held.objects.size, 1);
    await assertNoPointInput(page);
  } finally { held.release(); }
  const objectId = await withReplayDeadline(held.collected, 10000);
  assert.equal(await held.send('Runtime.getProperties', { objectId, ownProperties: true }), undefined);
  await assert.rejects(acquisition, /use a control ref/);
});

test('FL4C a plain target still refuses a held ancestor reply', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, labelledPayment.replace('Pay now', 'Plain')), page = f.entry.page;
  const read = await snapshot(page); assert.equal(acknowledgeSnapshot(page, read.number), true);
  const held = holdPointEvidence(t, page, (method, params, result) =>
    method === 'DOM.describeNode' && params.objectId && result?.node?.localName === 'body');
  const acquisition = resolvePoint(page, { x: 70, y: 50, view: read.viewSignature });
  acquisition.catch(() => {});
  try {
    await assert.rejects(withReplayDeadline(acquisition, 10000), /Point geometry scan unavailable; use a control ref\./);
    assert.equal(held.trace.length, 1);
    await assertNoPointInput(page);
  } finally { held.release(); await assert.rejects(acquisition, /use a control ref/); }
});

test('FL4C starts ancestor evidence while the plain target name is held', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, labelledPayment.replace('Pay now', 'Plain')), page = f.entry.page;
  const read = await snapshot(page); assert.equal(acknowledgeSnapshot(page, read.number), true);
  const body = holdPointEvidence(t, page, (method, params, result) =>
    method === 'DOM.describeNode' && params.objectId && result?.node?.localName === 'body');
  const target = holdPointEvidence(t, page, method => method === 'Accessibility.getPartialAXTree');
  const acquisition = resolvePoint(page, { x: 70, y: 50, view: read.viewSignature });
  acquisition.catch(() => {});
  try {
    await withReplayDeadline(Promise.race([body.ready, acquisition.then(() => {
      assert.fail('plain target returned before held ancestor evidence');
    })]), 10000);
    await withReplayDeadline(target.ready, 10000);
    target.release();
    body.release();
    const handle = await withReplayDeadline(acquisition, 10000); await handle.dispose();
    assert.equal(target.trace.length, 1); assert.equal(body.trace.length, 1);
    await assertNoPointInput(page);
  } finally {
    target.release(); body.release();
    await acquisition.then(handle => handle.dispose(), () => {});
  }
});

for (const [name, control] of [
  ['associated label', '<label for="pay" style="position:absolute;left:500px">Pay now</label><input id="pay" type="button" value="">'],
  ['CSS accessible name', '<style>#pay::before{content:"Pay now"}</style><button id="pay" type="button"></button>'],
  ['aria labelledby', '<span id="name" style="position:absolute;left:500px">Buy</span><div id="pay" role="button" aria-labelledby="name"></div>'],
]) test('FD2D point acquisition refuses the computed payment name: ' + name, { skip, timeout: 60000 }, async t => {
  const phase = pointPhases(t);
  const f = await phase('fixture', () => fixture(t, '<style>#pay{position:absolute;left:30px;top:30px;width:160px;height:60px}</style>' + control +
    '<script>window.pays=0;pay.onclick=()=>pays++</script>'));
  const page = f.entry.page;
  await phase('raw fixture click', () => page.mouse.click(70, 50));
  assert.equal(await phase('raw counter', () => page.evaluate(() => pays)), 1);
  await phase('reload load event', () => page.reload());
  const read = await phase('snapshot', () => snapshot(page)); assert.equal(acknowledgeSnapshot(page, read.number), true);
  await phase('point acquisition refusal', () => assert.rejects(async () => {
    const handle = await resolvePoint(page, { x: 70, y: 50, view: read.viewSignature }); await handle.dispose();
  }, /use its ref/));
  assert.equal(await phase('guarded counter', () => page.evaluate(() => pays)), 0);
});

for (const field of ['autocomplete="cc-number"', 'id="card-number"', 'aria-label="Card number"', 'placeholder="CVV"'])
  test('FD2D custom target in a payment form needs a ref: ' + field, { skip, timeout: 60000 }, async t => {
    const f = await fixture(t, `<form><input ${field} style="position:absolute;left:500px"><div id="pay" style="position:absolute;left:30px;top:30px;width:160px;height:60px" onclick="window.pays++">Continue</div></form><script>window.pays=0</script>`);
    const page = f.entry.page;
    await page.mouse.click(70, 50); assert.equal(await page.evaluate(() => pays), 1);
    await page.reload(); const read = await snapshot(page); assert.equal(acknowledgeSnapshot(page, read.number), true);
    await assert.rejects(async () => { const handle = await resolvePoint(page, { x: 70, y: 50, view: read.viewSignature }); await handle.dispose(); }, /use its ref/);
    assert.equal(await page.evaluate(() => pays), 0);
  });

for (const surface of ['draggable="true"', 'contenteditable="false"'])
  test('FD2D classifies the same custom surface that point input will resolve: ' + surface, { skip, timeout: 60000 }, async t => {
    const f = await fixture(t, `<div id="pay" ${surface} aria-label="Pay now" style="position:absolute;left:30px;top:30px;width:160px;height:60px"><span>Go</span></div><script>window.pays=0;document.onclick=()=>pays++</script>`);
    const page = f.entry.page, box = await page.locator('span').boundingBox();
    const point = { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) };
    await page.mouse.click(point.x, point.y); assert.equal(await page.evaluate(() => pays), 1);
    await page.reload(); const read = await snapshot(page); assert.equal(acknowledgeSnapshot(page, read.number), true);
    await assert.rejects(async () => { const handle = await resolvePoint(page, { ...point, view: read.viewSignature }); await handle.dispose(); }, /use its ref/);
    assert.equal(await page.evaluate(() => pays), 0);
  });

test('FD2D collects native node handles after a listener refusal', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<div id="under" style="position:absolute;left:30px;top:30px;width:160px;height:60px"></div><div style="position:absolute;left:30px;top:30px;width:160px;height:60px"></div><script>under.addEventListener("click",()=>{})</script>');
  const page = f.entry.page, read = await snapshot(page); assert.equal(acknowledgeSnapshot(page, read.number), true);
  const impl = page.mainFrame()._connection.toImpl(page.mainFrame()), client = impl._page.delegate._sessionForFrame(impl)._client;
  const send = client._sendMayFail, resolved = new Set();
  client._sendMayFail = async function(method, params) {
    const result = await send.call(this, method, params);
    if (method === 'DOM.resolveNode' && params.executionContextId === undefined && result?.object?.objectId)
      resolved.add(result.object.objectId);
    return result;
  };
  t.after(() => { client._sendMayFail = send; });
  await assert.rejects(async () => { const handle = await resolvePoint(page, { x: 70, y: 50, view: read.viewSignature }); await handle.dispose(); }, /use its ref/);
  assert.ok(resolved.size > 0, 'fixture must resolve a native listener subject');
  for (const objectId of resolved) assert.equal(await send.call(client, 'Runtime.getProperties', { objectId, ownProperties: true }), undefined, 'native listener subject must be released');
});
