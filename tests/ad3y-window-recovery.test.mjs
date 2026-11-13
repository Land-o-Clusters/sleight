import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { identityRelay, settle } from './helpers/native-identity-relay.mjs';
import { SELECT_WINDOW_TOOL } from '../plugins/sleight/lib/select-window.mjs';

test('AH1B a selected-window input refusal keeps reselection advice after a successful read', async t => {
  const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'Untitled', url: null };
  const h = identityRelay(t, { localTools: {
    tools: [SELECT_WINDOW_TOOL], target: async () => target,
    call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, target,
      identity: { pid: h.state.pid, windowNumber: 11 } }) }] }),
  } });
  h.call('select', 'select_window', { app: 'TextEdit', title: 'Untitled', windowNumber: 11 });
  await settle();
  await h.read('first', 'let app = await cua.getApp("TextEdit")');
  // Preserve the source across an ordinary action result as well as the read.
  h.send('unchanged', 'await app.typeText("fixture")'); await settle();
  assert.equal(h.forwarded.at(-1).id, 'unchanged');
  h.reply('unchanged'); await settle();
  h.state.number = 77;
  for (const id of ['blocked', 'blocked-again']) {
    h.send(id, 'await app.typeText("never forwarded")'); await settle();
    assert.equal(h.forwarded.at(-1).id, 'unchanged');
    assert.equal(h.received.at(-1).result.isError, true);
    assert.match(h.received.at(-1).result.content[0].text, /step=window-number.*Next: select_window\.$/);
    assert.equal(h.requests.at(-1).nativeIdentity.windowNumber, 11);
  }
});

test('AD3Z a vanished selected number advises explicit reselection without silently rebinding', async t => {
  const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'Untitled', url: null };
  const selections = [];
  const h = identityRelay(t, { localTools: {
    tools: [SELECT_WINDOW_TOOL], target: async () => target,
    call: async (name, args) => {
      assert.equal(name, 'select_window');
      selections.push(args);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, target,
        identity: { pid: h.state.pid, windowNumber: h.state.number } }) }] };
    },
  } });
  h.call('select', 'select_window', { app: 'TextEdit', title: 'Untitled', windowNumber: 11 });
  await settle();
  assert.equal(h.received.at(-1).result.isError, undefined);
  await h.read('first', 'let app = await cua.getApp("TextEdit")');
  h.state.number = 77;
  await h.read('stale', 'app = await cua.getApp("com.apple.TextEdit")');
  h.send('blocked', 'await app.typeText("never forwarded")'); await settle();
  assert.equal(h.forwarded.at(-1).id, 'stale');
  const refusal = h.received.at(-1).result;
  assert.equal(refusal.isError, true);
  assert.match(refusal.content[0].text, /step=window-number/);
  const advice = /Next: (select_window)\.$/.exec(refusal.content[0].text);
  assert.ok(advice, 'a selected-number refusal must name the recovery tool');
  assert.doesNotMatch(refusal.content[0].text, /getApp|windowNumber/);
  assert.ok(h.requests.slice(1).every(request => request.windowNumber === 11), 'the stale selection stays pinned until reselection');
  assert.equal(selections.length, 1);
  // Follow the advised tool using the intended title from the original selection.
  h.call('reselect', advice[1], { app: target.appId, title: target.title }); await settle();
  assert.equal(h.received.at(-1).result.isError, undefined);
  await h.read('recover', 'app = await cua.getApp("com.apple.TextEdit")');
  h.send('act', 'await app.typeText("recovered")'); await settle();
  assert.equal(h.forwarded.at(-1).id, 'act');
  assert.equal(h.requests.at(-1).nativeIdentity.windowNumber, 77);
  assert.equal(selections.length, 2);
  h.reply('act');
});

for (const health of [true, false]) for (const recovery of ['reread', 'getApp']) {
  for (const change of ['replacement', 'new-pid', 'recycled-pid']) {
    test(`AD3Y read, ${change}, ${recovery}, act (health=${health})`, async t => {
      const h = identityRelay(t, { health });
      await h.read('first', 'let app = await cua.getApp("TextEdit")');
      if (change === 'replacement') h.state.number = 77;
      if (change === 'new-pid') h.state.pid = 456;
      if (change === 'recycled-pid') h.state.processStart = 2;
      await h.read('again', recovery === 'getApp' ? 'app = await cua.getApp("com.apple.TextEdit")' : undefined);
      assert.equal(h.requests.length, 3, 'the retained-pin mismatch and fresh proof both run');
      assert.equal(h.observations[1].status, 'mismatch');
      assert.equal(h.observations[1].error, change === 'replacement' ? 'Known window number disappeared' : 'Window owner process changed');
      assert.equal(h.requests[1].nativeIdentity.windowNumber, 11);
      assert.equal(h.requests[2].nativeIdentity, undefined);
      assert.equal(h.received.at(-1).result.isError, undefined);
      h.send('act', 'await app.typeText("x")'); await settle();
      assert.equal(h.forwarded.at(-1).id, 'act');
      const pin = h.requests.at(-1).nativeIdentity;
      assert.deepEqual([pin.windowNumber, pin.pid, pin.processStart], [h.state.number, h.state.pid, h.state.processStart]);
      h.reply('act'); await settle();
      assert.equal(h.received.at(-1).result.isError, undefined);
      assert.equal(h.requests.length, 4, 'input admission still takes a fresh helper sample');
    });
  }
}

test('AD3Y a refused action invalidates reuse and the advised getApp rebinds', async t => {
  const h = identityRelay(t);
  await h.read('first', 'let app = await cua.getApp("TextEdit")');
  h.state.number = 77;
  h.send('stale', 'await app.typeText("never forwarded")'); await settle();
  assert.equal(h.forwarded.at(-1).id, 'first');
  assert.equal(h.received.at(-1).result.content[0].text,
    'Input lease: step=window-number the native window changed. Unconfirmed target identity. Read the intended window again before acting. Next: await cua.getApp("com.apple.TextEdit").');
  // A stale concurrent census must not let a previous mismatch reuse the pin.
  h.state.health = { windowNumbers: [11] };
  await h.read('reread');
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests.at(-1).nativeIdentity, undefined);
  h.state.number = 88;
  h.send('stale-again', 'await app.typeText("never forwarded")'); await settle();
  assert.equal(h.received.at(-1).result.isError, true);
  await h.read('recover', 'app = await cua.getApp("com.apple.TextEdit")');
  h.send('act', 'await app.typeText("recovered")'); await settle();
  assert.equal(h.forwarded.at(-1).id, 'act');
  assert.equal(h.requests.at(-1).nativeIdentity.windowNumber, 88);
  h.reply('act');
});

for (const fault of ['unknown-before-mismatch', 'unknown-after-mismatch', 'ambiguous-after-mismatch']) {
  test(`AD3Y ${fault} retains the old pin and refuses repeated input`, async t => {
    const h = identityRelay(t);
    await h.read('first', 'let app = await cua.getApp("TextEdit")');
    h.state.number = 77;
    if (fault === 'unknown-before-mismatch') h.state.unavailable = true;
    if (fault === 'unknown-after-mismatch') {
      h.state.afterInspect = (_request, observed) => { if (observed.status === 'mismatch') h.state.unavailable = true; };
    }
    if (fault === 'ambiguous-after-mismatch') h.state.numbers = [77, 88];
    await h.read('again');
    assert.equal(h.requests.length, fault === 'unknown-before-mismatch' ? 2 : 3);
    if (fault !== 'unknown-before-mismatch') assert.equal(h.observations[1].status, 'mismatch');
    const calls = h.requests.length;
    for (const id of ['act', 'act-again']) {
      h.send(id, 'await app.typeText("never forwarded")'); await settle();
      assert.equal(h.forwarded.at(-1).id, 'again');
      assert.equal(h.received.at(-1).result.isError, true);
      assert.match(h.received.at(-1).result.content[0].text, /native window identity is unavailable|window identity is ambiguous/);
    }
    assert.equal(h.requests.length, calls, 'a refused read cannot downgrade input to unchecked admission');
    h.state.health = { windowNumbers: [11] };
    await h.read('still-failed');
    assert.ok(h.requests.length > calls, 'the read error prevents reuse even with a stale matching census');
    assert.equal(h.requests[calls].nativeIdentity.windowNumber, 11);
    const beforeRecovery = h.requests.length;
    h.state.afterInspect = undefined; h.state.unavailable = false; h.state.numbers = undefined;
    await h.read('recover');
    assert.equal(h.requests[beforeRecovery].nativeIdentity.windowNumber, 11, 'the failed bind retained the preceding pin');
    assert.equal(h.requests.at(-1).nativeIdentity, undefined);
    h.send('recovered', 'await app.typeText("x")'); await settle();
    assert.equal(h.forwarded.at(-1).id, 'recovered');
    assert.equal(h.requests.at(-1).nativeIdentity.windowNumber, 77);
    h.reply('recovered');
  });
}

test('AD3Y an explicit window-number acquisition cannot silently choose a replacement', async t => {
  const h = identityRelay(t);
  await h.read('first', 'let app = await cua.getApp({ windowId: 11 })');
  h.state.number = 77;
  await h.read('again');
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].windowNumber, 11, 'the fresh bind preserves the explicit selector');
  h.send('act', 'await app.typeText("never forwarded")'); await settle();
  assert.equal(h.forwarded.at(-1).id, 'again');
  assert.equal(h.received.at(-1).result.isError, true);
  assert.equal(h.received.at(-1).result.content[0].text,
    'Input lease: step=window-number the native window changed. Unconfirmed target identity. Read the intended window again before acting. Next: await cua.getApp("com.apple.TextEdit").');
  assert.equal(h.requests.at(-1).windowNumber, 11, 'advice never clears the acquisition pin');
});

test('AD3Y a different focused window is refused without an unpinned retry', async t => {
  const h = identityRelay(t);
  await h.read('first', 'let app = await cua.getApp("TextEdit")');
  h.state.numbers = [11, 22]; h.state.focused = 1;
  h.state.health = { windows: 2, allWindows: 2, windowNumbers: [11, 22] };
  await h.read('again');
  assert.equal(h.requests.length, 2);
  assert.equal(h.observations[1].status, 'mismatch');
  assert.equal(h.observations[1].error, 'Focused window differs');
  h.send('act', 'await app.typeText("never forwarded")'); await settle();
  assert.equal(h.forwarded.at(-1).id, 'again');
  assert.match(h.received.at(-1).result.content[0].text, /step=window-root/);
});

for (const evidence of ['unchanged', 'no-health', 'no-pid', 'no-start', 'no-numbers', 'unknown-health', 'more-windows', 'changed-root', 'acquisition']) {
  test(`AD3Y baseline reuse requires independent unchanged evidence: ${evidence}`, async t => {
    const h = identityRelay(t, { health: evidence !== 'no-health' });
    await h.read('first', 'let app = await cua.getApp("TextEdit")');
    const edits = { 'no-pid': { pid: undefined }, 'no-start': { processStart: undefined }, 'no-numbers': { windowNumbers: undefined },
      'unknown-health': { status: 'unknown' }, 'more-windows': { windows: 2, allWindows: 2 } };
    h.state.health = edits[evidence];
    await h.read('again', evidence === 'acquisition' ? 'app = await cua.getApp("TextEdit")' : undefined,
      evidence === 'changed-root' ? 'Window: "Untitled", App: TextEdit.\n0 standard window Untitled, ID: new-root' : undefined);
    assert.equal(h.requests.length, evidence === 'unchanged' ? 1 : 2);
    assert.equal(h.events.filter(e => e.direction === 'native-window-read-identity').at(-1).reused, evidence === 'unchanged');
    h.send('act', 'await app.typeText("x")'); await settle();
    assert.equal(h.forwarded.at(-1).id, 'act');
    assert.equal(h.requests.length, evidence === 'unchanged' ? 2 : 3);
    h.reply('act');
  });
}
