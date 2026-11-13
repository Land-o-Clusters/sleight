import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dragScriptFixture } from './fixtures/drag-script.mjs';

for (const defaultAppId of ['com.apple.TextEdit', 'org.sleight.NativeEditor']) {
const test = (name, fn) => nodeTest(`${defaultAppId}: ${name}`, fn);

// Only the native AX/CG boundary is replaced. run() does the real selection,
// validation, coordinate conversion, mouse sequence and post-drop check.
const harness = options => dragScriptFixture(options, defaultAppId);

function shiftFixture(h, { failures = 0, stage = 'post', downFailure = false, nullEvent = false } = {}) {
  const posts = [], creations = [];
  let remaining = failures;
  const fail = (at, down) => {
    if (at === stage && down === downFailure && remaining-- > 0) throw new Error(`Shift ${at} failed`);
  };
  Object.assign(h.context.$, {
    kCGEventFlagMaskShift: 1 << 17, kCGEventFlagsChanged: 12,
    CGEventCreateKeyboardEvent: (_source, key, down) => {
      assert.equal(key, 56); creations.push(down); fail('create', down);
      return nullEvent && !down && remaining-- > 0 ? null : { down };
    },
    CGEventSetFlags: (e, flags) => { fail('flags', e.down); e.flags = flags; },
    CGEventSetType: (e, type) => { fail('type', e.down); e.type = type; },
    CGEventPostToPid: (pid, e) => { posts.push([pid, e.down]); fail('post', e.down); },
    CGEventPost: () => assert.fail('no foreground input'),
  });
  const delay = h.context.delay;
  h.context.delay = seconds => { if (seconds === 0.05) fail('delay', creations.at(-1)); delay(seconds); };
  return { posts, creations };
}

for (const failures of [0, 1, 2]) {
  test(`DS1 engine AX move with ${failures} failed Shift releases`, () => {
    const h = harness({ ax: { nativeSettle: true } }), shift = shiftFixture(h, { failures });
    const result = h.run({ windowId: 11, dp2: true, from: 'the current text selection', to: 'end of line 1' });
    assert.equal(result.ok, failures < 2);
    assert.equal(result.path, 'accessibility');
    assert.equal(h.values.get(11), 'beta gamma alpha\n');
    assert.equal(h.axWrites.filter(Array.isArray).length, 2);
    assert.deepEqual(shift.posts, [[7, true], [7, false], ...(failures ? [[7, false]] : [])]);
    if (failures === 0) assert.deepEqual(h.delays.filter(seconds => seconds === 0.05), [0.05, 0.05]);
    assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0); assert.equal(h.mainWrites.length, 0);
    if (failures === 2) {
      assert.equal(result.deliveryVerified, false);
      assert.match(result.error, /Shift release failed twice for pid 7; Shift may still be held/);
      assert.doesNotMatch(result.error, /nothing was pressed/);
    } else assert.equal(result.error, undefined);
  });
}

for (const stage of ['create', 'flags', 'type', 'post', 'delay']) {
  for (const downFailure of [false, true]) {
    test(`DS1 Shift ${downFailure ? 'down' : 'up'} failure at ${stage} still releases to the same pid`, () => {
      const h = harness({ ax: { nativeSettle: true } }), shift = shiftFixture(h, { failures: 1, stage, downFailure });
      assert.equal(h.run({ windowId: 11 }).ok, true);
      assert.deepEqual(shift.creations, [true, false, ...(!downFailure ? [false] : [])]);
      assert.deepEqual(shift.posts.at(-1), [7, false]);
      assert.ok(shift.posts.every(([pid]) => pid === 7));
      assert.equal(h.axWrites.filter(Array.isArray).length, 2); assert.equal(h.events.length, 0);
    });
  }
}

for (const [name, options, expectedText, lostText] of [
  ['verified move', {}, 'beta gamma alpha\n', undefined],
  ['ignored move', { ignored: true }, 'alpha beta gamma\n', undefined],
  ['partial move', { failWrite: 2 }, 'alpha beta gamma alpha\n', false],
]) test(`DS1B held Shift reports the single-window ${name} outcome`, () => {
  const h = harness({ ax: { ...options, nativeSettle: true } }), shift = shiftFixture(h, { failures: 2 });
  const result = h.run({ windowId: 11, dp2: true, from: 'the current text selection', to: 'end of line 1' });
  assert.equal(result.ok, false); assert.equal(result.path, 'accessibility');
  assert.equal(result.deliveryVerified, false); assert.equal(h.values.get(11), expectedText);
  assert.equal(result.lostText, lostText);
  assert.match(result.error, /Shift may still be held/); assert.match(result.error, /tell the user/i);
  if (name === 'verified move') assert.match(result.error, /text move.*11.*verified/i);
  if (name === 'ignored move') {
    assert.equal(result.textChanged, false); assert.match(result.error, /ignored.*unchanged/i);
    assert.doesNotMatch(result.error, /Cmd\+Z/);
  }
  if (name === 'partial move') assert.match(result.error, /Cmd\+Z twice/);
  assert.deepEqual(shift.posts, [[7, true], [7, false], [7, false]]);
  assert.equal(h.events.length, 0); assert.equal(h.pidEvents.length, 0); assert.equal(h.activations.length, 0);
});

test('DS1B held Shift reports unreadable single-window text as unverified', () => {
  const h = harness({ ax: { nativeSettle: true } });
  const adapter = h.context.axTextArea;
  h.context.axTextArea = (...args) => {
    const area = adapter(...args), replace = area.replace;
    area.replace = (...edit) => {
      replace(...edit);
      area.value = () => { throw new Error('value unavailable'); };
    };
    return area;
  };
  shiftFixture(h, { failures: 2 });
  const result = h.run({ windowId: 11, dp2: true });
  assert.equal(result.ok, false); assert.equal(result.deliveryVerified, false);
  assert.equal(result.lostText, true); assert.match(result.error, /cannot verify|could not be read/i);
  assert.match(result.error, /Cmd\+Z twice/); assert.match(result.error, /Shift may still be held/);
  assert.equal(h.events.length, 0); assert.equal(h.pidEvents.length, 0); assert.equal(h.activations.length, 0);
});

test('DS1B held Shift preserves lost-text recovery after a destructive write', () => {
  const h = harness({ ax: { nativeSettle: true } });
  const adapter = h.context.axTextArea;
  h.context.axTextArea = (...args) => {
    const area = adapter(...args), replace = area.replace;
    let writes = 0;
    area.replace = (...edit) => {
      replace(...edit);
      if (++writes === 2) h.values.set(11, 'beta gamma\n');
    };
    return area;
  };
  const shift = shiftFixture(h, { failures: 2 });
  const result = h.run({ windowId: 11, dp2: true });
  assert.equal(result.ok, false); assert.equal(result.path, 'accessibility');
  assert.equal(result.lostText, true); assert.equal(result.deliveryVerified, false);
  assert.match(result.error, /Cmd\+Z twice/); assert.match(result.error, /Shift may still be held/);
  assert.deepEqual(shift.posts, [[7, true], [7, false], [7, false]]);
  assert.equal(h.axWrites.filter(Array.isArray).length, 2);
  assert.equal(h.events.length, 0); assert.equal(h.pidEvents.length, 0); assert.equal(h.activations.length, 0);
});

test('DS1 a null Shift-up event is retried and persistent failure is reported', () => {
  for (const failures of [1, 2]) {
    const h = harness({ ax: { nativeSettle: true } }), shift = shiftFixture(h, { failures, stage: 'unused', nullEvent: true });
    const result = h.run({ windowId: 11 });
    assert.equal(result.ok, failures === 1);
    assert.deepEqual(shift.creations, [true, false, false]);
    if (failures === 2) assert.match(result.error, /Shift may still be held/);
  }
});

test('DS1C shared held-Shift warning keeps the unknown text outcome', () => {
  const h = harness(), shift = shiftFixture(h, { failures: 2 });
  assert.throws(() => h.context.settleAfterTextWrite(7), error => {
    assert.equal(error.modifierReleaseFailed, true);
    assert.match(error.message, /Text may already have moved/);
    assert.match(error.message, /Shift may still be held/);
    assert.match(error.message, /Tell the user; read the window before continuing/);
    return true;
  });
  assert.deepEqual(shift.posts, [[7, true], [7, false], [7, false]]);
  assert.equal(h.textWrites.length, 0); assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
});

for (const background of [true, false]) test(`DS1C spacing repair reports an unverified ${background ? 'background' : 'foreground'} drop without repeating it`, () => {
  const h = harness({ background, after: 'beta gammaalpha\n' }), shift = shiftFixture(h, { failures: 2 });
  // Retain pointer posting for the drag, and inject failures only for modifier events.
  const modifierPost = h.context.$.CGEventPostToPid;
  h.context.$.CGEventPostToPid = (pid, e) => {
    if (e.down !== undefined) return modifierPost(pid, e);
    assert.equal(pid, 7); h.pidEvents.push(e);
    if (e.type === 2) h.values.set(11, 'beta gammaalpha\n');
  };
  if (!background) h.context.$.CGEventPost = (_tap, e) => {
    h.events.push(e);
    if (e.type === 2) h.values.set(11, 'beta gammaalpha\n');
  };
  const result = h.run({ windowId: 11, from: [20, 40], to: [300, 40], steps: 2, holdMs: 0 });
  assert.equal(result.ok, false); assert.equal(result.path, background ? 'background' : 'foreground');
  assert.equal(result.deliveryVerified, false);
  assert.match(result.error, /Shift may still be held/);
  assert.match(result.error, /Text may already have moved/);
  assert.match(result.error, /the drop may have landed; its outcome is unverified/);
  assert.doesNotMatch(result.error, /nothing was pressed/);
  const pointerEvents = background ? h.pidEvents : h.events;
  assert.equal(pointerEvents.filter(e => e.type === 1).length, 1);
  assert.equal(pointerEvents.filter(e => e.type === 2).length, 1);
  assert.deepEqual(h.textWrites, [' alpha']);
  assert.equal(h.values.get(11), 'beta gamma alpha\n');
  assert.deepEqual(shift.posts, [[7, true], [7, false], [7, false]]);
  assert.equal((background ? h.events : h.pidEvents).length, 0);
  assert.equal(h.activations.length, background ? 0 : 1);
});
// Window 11's text area starts at x 105, so [150, 38.5] is past the line's end.
const pastEnd = { windowId: 11, to: [150, 38.5] };

test('semantic selection to line end takes the guarded pointer-free text move without a screenshot', () => {
  const h = harness({ second: false, background: true, ax: {} });
  const r = h.run({ windowId: 11, from: 'the current text selection', to: 'end of line 1', screenshot: [1200, 800] });
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'accessibility');
  assert.equal(h.values.get(11), 'beta gamma alpha\n');
  assert.equal(h.events.length, 0); assert.equal(h.pidEvents.length, 0); assert.equal(h.activations.length, 0);
});

test('semantic requests keep ambiguous-window, toolbar and text-area guards', () => {
  const ambiguous = harness({ background: true, ax: {} });
  assert.match(ambiguous.run({ from: 'the current text selection', to: 'end of line 1' }).error, /ambiguous/);
  const chrome = harness({ second: false, background: true, ax: {} });
  const r = chrome.run({ windowId: 11, from: 'the current text selection', to: [20, 25] });
  assert.equal(r.ok, false); assert.match(r.error, /outside.*content/);
  assert.equal(chrome.events.length + chrome.pidEvents.length + chrome.axWrites.length, 0);
});

test('semantic text and selection changes during settle refuse before any input', () => {
  for (const key of ['changeOnActivate', 'movedOnActivate']) {
    const h = harness({ second: false, [key]: true, ax: { failWrite: 1 } });
    const r = h.run({ windowId: 11, from: 'the current text selection', to: 'end of line 1' });
    assert.equal(r.ok, false); assert.match(r.error, /changed|outside/);
    assert.equal(h.events.filter(e => e.type === 1).length, 0);
  }
});
test('timed-out toolbar role or geometry refuses before any press', () => {
  for (const name of ['AXRole', 'AXPosition']) {
    const h = harness({ background: true, nativeFailure: { name, code: -25204 } });
    const result = h.run(pastEnd);
    assert.equal(result.ok, false); assert.match(result.error, /nothing was pressed/);
    assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0);
  }
});
test('readback timeouts report unverified delivery and never repeat the drag', () => {
  for (const [background, afterPress, name] of [[true, 1, 'AXValue'], [true, 3, 'AXValue'],
    [true, 4, 'AXValue'], [true, 5, 'AXValue'], [true, 1, 'AXSelectedText'], [false, 1, 'AXValue']]) {
    const h = harness({ background, nativeFailure: { name, code: -25204, afterPress } });
    const result = h.run(pastEnd);
    assert.equal(result.ok, false); assert.match(result.error, /cannot verify.*read.*window/i);
    assert.doesNotMatch(result.error, /nothing was pressed|unchanged|disappeared|failed \(-25204\)/);
    assert.equal(result.deliveryVerified, false);
    assert.equal(h.pidEvents.length, background ? 29 : 0);
    assert.equal(h.events.length, background ? 0 : 28);
  }
});
test('default attributes keep AX moves while mixed or uniform bold selections use posting', () => {
  for (const [selectionFonts, expectedPath] of [[['regular', 'regular', 'regular', 'regular'], 'accessibility'],
    [['regular', 'bold', 'regular', 'regular'], 'background'], [['bold', 'bold', 'bold', 'bold'], 'background']]) {
    const attributes = Array(17).fill('regular'); attributes.splice(6, 4, ...selectionFonts);
    const h = harness({ background: true, selection: 'beta', ax: { attributes }, backgroundAfter: 'alpha gamma beta\n' });
    const result = h.run(pastEnd);
    assert.equal(result.ok, true, result.error); assert.equal(result.path, expectedPath);
    assert.equal(h.axWrites.length > 0, expectedPath === 'accessibility');
    assert.equal(h.pidEvents.length > 0, expectedPath === 'background');
  }
});
test('unconfirmed formatting does not suppress spacing repair after failed AX setup or reads', () => {
  for (const failure of ['failArea', 'failValue', 'failSelection']) {
    const h = harness({ background: true, ax: { [failure]: true } });
    const result = h.run(pastEnd);
    assert.equal(result.ok, true, result.error); assert.equal(result.path, 'background');
    assert.equal(result.spaceInserted, true, failure);
    assert.equal(h.values.get(11), 'beta gamma alpha\n', failure);
    assert.equal(h.textWrites.length, 1, failure);
  }
});
test('formatted selections use posted dragging without plain text writes', () => {
  const h = harness({ background: true, ax: { formatted: true }, backgroundAfter: 'beta gamma alpha\n' });
  const result = h.run(pastEnd);
  assert.equal(result.ok, true, result.error); assert.equal(result.path, 'background');
  assert.equal(h.axWrites.length, 0); assert.equal(h.pidEvents.length, 29);
  assert.match(result.fallbackReason, /formatting/);
});
test('covered formatted selections retain the foreground coverage refusal', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { formatted: true } });
  const result = h.run(pastEnd);
  assert.equal(result.path, 'foreground'); assert.equal(h.axWrites.length, 0);
  assert.equal(result.ok, false); assert.match(result.error, /covered/);
  assert.equal(h.events.length, 0); assert.match(result.fallbackReason, /formatting/);
});
test('formatted selections use foreground dragging when posting is unavailable', () => {
  const h = harness({ ax: { formatted: true } });
  const result = h.run(pastEnd);
  assert.equal(result.ok, true, result.error); assert.equal(result.path, 'foreground');
  assert.equal(h.axWrites.length, 0); assert.equal(h.textWrites.length, 0);
  assert.equal(h.events.length, 28); assert.match(result.fallbackReason, /formatting/);
});
test('unreadable formatting cannot permit a plain text write', () => {
  const h = harness({ background: true, ax: { unreadableAttributes: true }, backgroundAfter: 'beta gamma alpha\n' });
  const result = h.run(pastEnd);
  assert.equal(result.path, 'background'); assert.equal(h.axWrites.length, 0);
  assert.match(result.fallbackReason, /attributed string unavailable/);
});
test('formatted posted drops skip the plain text spacing repair', () => {
  const h = harness({ background: true, ax: { formatted: true } });
  const result = h.run(pastEnd);
  assert.equal(result.path, 'background'); assert.equal(result.ok, true, result.error);
  assert.equal(h.axWrites.length, 0); assert.equal(h.textWrites.length, 0);
  assert.equal(h.values.get(11), 'beta gammaalpha\n'); assert.equal(result.spaceInserted, false);
});
test('a covered text drop moves the text through Accessibility with no pointer, focus or posting', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: {} }); const r = h.run(pastEnd);
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'accessibility');
  assert.equal(h.values.get(11), 'beta gamma alpha\n'); assert.equal(r.spaceInserted, true);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0); assert.equal(h.pidEvents.length, 0);
  assert.equal(h.restored.length, 0);
});
test('generic validation refuses cross-area and blank text drags for every bundle', () => {
  for (const appId of ['com.apple.TextEdit', 'org.sleight.NativeEditor']) {
    for (const options of [{ splitAreas: true, selection: 'alpha' }, { selection: ' ' }, { selection: '' }]) {
      const h = harness({ background: true, appId, ...options });
      const r = h.run({ windowId: 11, ...(options.splitAreas ? { to: [119, 190] } : {}) });
      assert.equal(r.ok, false, `${appId}: ${JSON.stringify(options)}`);
      assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0);
      if (options.splitAreas) assert.match(r.error, /toWindowId/);
    }
  }
});
test('every selected-text drag tries Accessibility before posted events', () => {
  for (const appId of ['com.apple.TextEdit', 'org.sleight.NativeEditor']) {
    for (const background of [true, false]) {
    const h = harness({ background, appId, selection: 'alpha', ax: {} });
    const r = h.run(pastEnd);
    assert.equal(r.path, 'accessibility'); assert.equal(r.ok, true, r.error);
    assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0);
    assert.equal(h.axWrites.at(-1), 'settle');
    }
  }
});
test('DP2 moves text without a raise or pre-move settle, with a same-app overlap exception', () => {
  for (const stacked of [false, true]) {
    const h = harness({ background: true, stacked, ax: {} });
    const r = h.run({ ...pastEnd, dp2: true });
    assert.equal(r.ok, true, r.error); assert.equal(r.path, 'accessibility');
    assert.deepEqual(h.mainWrites, stacked ? [11] : []);
    assert.deepEqual(h.delays, []); assert.equal(h.axWrites.at(-1), 'settle');
    assert.equal(h.pidEvents.length + h.events.length, 0);
  }
});
test('DP2 trace proves AX starts before any raise, while DP2 off preserves raise and settle first', () => {
  for (const dp2 of [true, false]) {
    for (const failArea of [false, true]) {
      const h = harness({ background: true, ax: { failArea } });
      const result = h.run({ ...pastEnd, dp2, trace: true });
      assert.equal(result.ok, true, result.error);
      const phases = h.traces.map(e => `${e.phase}:${e.edge}`);
      const prefix = ['raise:start', 'raise:end', 'settle:start', 'settle:end'];
      assert.deepEqual(phases, dp2
        ? failArea ? ['ax-move:start', 'ax-move:end', ...prefix, 'posted-press:start', 'posted-press:end', 'settle:start', 'settle:end']
          : ['ax-move:start', 'settle:start', 'settle:end', 'ax-move:end']
        : failArea ? [...prefix, 'ax-move:start', 'ax-move:end', 'posted-press:start', 'posted-press:end', 'settle:start', 'settle:end']
          : [...prefix, 'ax-move:start', 'settle:start', 'settle:end', 'ax-move:end']);
      h.traces.forEach((e, i) => {
        assert.deepEqual(Object.keys(e).sort(), ['edge', 'monoMs', 'phase']);
        assert.ok(Number.isFinite(e.monoMs) && e.monoMs >= 0);
        if (i) assert.ok(e.monoMs > h.traces[i - 1].monoMs);
      });
      assert.equal(JSON.stringify(h.traces).includes('alpha'), false);
      const quiet = harness({ background: true, ax: { failArea } });
      assert.deepEqual(quiet.run({ ...pastEnd, dp2 }), result);
      assert.deepEqual(quiet.traces, []);
    }
  }
});
test('DP2 keeps raise and settle for posted presses and refuses a failed overlap raise', () => {
  const h = harness({ background: true });
  assert.equal(h.run({ ...pastEnd, dp2: true }).path, 'background');
  assert.deepEqual(h.mainWrites, [11]); assert.equal(h.delays[0], 1.5);
  const blocked = harness({ background: true, stacked: true, raiseWorks: false, ax: {} });
  assert.equal(blocked.run({ ...pastEnd, dp2: true }).ok, false);
  assert.equal(blocked.axWrites.length + blocked.pidEvents.length + blocked.events.length, 0);
});
test('drag trace records the same-app overlap raise exception before the AX attempt', () => {
  const h = harness({ background: true, stacked: true, ax: {} });
  assert.equal(h.run({ ...pastEnd, dp2: true, trace: true }).path, 'accessibility');
  assert.deepEqual(h.traces.map(e => `${e.phase}:${e.edge}`), [
    'raise:start', 'raise:end', 'ax-move:start', 'settle:start', 'settle:end', 'ax-move:end',
  ]);
});
test('foreground and failed posted presses have paired phase events without changing results', () => {
  for (const options of [{ ax: { failArea: true } }, { background: true, ax: { failArea: true }, postFails: true }]) {
    const h = harness(options), r = h.run({ ...pastEnd, dp2: true, trace: true });
    const quiet = harness(options);
    assert.deepEqual(quiet.run({ ...pastEnd, dp2: true }), r);
    assert.deepEqual(h.traces.map(e => `${e.phase}:${e.edge}`), [
      'ax-move:start', 'ax-move:end', 'raise:start', 'raise:end', 'settle:start', 'settle:end',
      'posted-press:start', 'posted-press:end',
      ...(options.background ? ['settle:start', 'settle:end'] : []),
    ]);
  }
});
test('DP2 posted fallback rechecks owner text and selection after its settle', () => {
  for (const change of ['text', 'selection']) {
    const h = harness({ background: true, ax: { failArea: true }, onDelay: ({ values, selected }) => {
      if (change === 'text') values.set(11, 'owner edit\n'); else selected.set(11, 'beta');
    } });
    const r = h.run({ ...pastEnd, dp2: true });
    assert.equal(r.ok, false); assert.match(r.error, /changed before input/);
    assert.equal(h.pidEvents.length + h.events.length, 0);
  }
});
test('every covered window without a focused selection refuses before raising', () => {
  for (const appId of ['com.apple.TextEdit', 'org.sleight.NativeEditor']) {
    const h = harness({ background: true, appId, selection: '', coveredEnd: true, coveredPid: 9 });
    const r = h.run({ windowId: 11 });
    assert.equal(r.ok, false); assert.match(r.error, /no selected text/);
    assert.deepEqual(h.mainWrites, []); assert.deepEqual(h.delays, []);
    assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0);
    assert.doesNotMatch(r.error, /Chess pawn/);
  }
});
test('posted text drags have no app-specific Command modifier', () => {
  for (const appId of ['com.apple.TextEdit', 'org.sleight.NativeEditor']) {
    const h = harness({ background: true, appId, selection: 'alpha' });
    const r = h.run(pastEnd);
    assert.equal(r.ok, true, r.error);
    assert.equal(h.pidEvents.length, 29);
    assert.ok(h.pidEvents.every(e => e.flags === 0));
  }
});
test('drag dispatch contains no bundle-ID branch or rich-text mechanism', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8');
  assert.equal(/target\.bundleIdentifier|isTextEdit|SLEIGHT_RICH_TEXT_MOVE|richTextMove|richClipboardState|textEditPasteItem|sameTextEditFormatting|pressRichPaste|richMove|pasteRich|verifyRich/.test(source), false);
});
test('an unchanged background drag moves the text through Accessibility before any foreground drag', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n', ax: {} }); const r = h.run(pastEnd);
  assert.equal(r.path, 'accessibility'); assert.equal(h.values.get(11), 'beta gamma alpha\n');
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
});
test('a drop inside a line lands before the word under it, with one space each side', () => {
  // x 193 is the left half of "gamma"'s g (index 11, x 193 to 201).
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: {} }); const r = h.run({ windowId: 11, to: [93, 38.5] });
  assert.equal(r.ok, true, r.error); assert.equal(h.values.get(11), 'beta alpha gamma\n');
});
test('text that changed before the Accessibility move stops everything', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { changedBeforeMove: true } }); const r = h.run(pastEnd);
  assert.equal(r.ok, false); assert.match(r.error, /changed before the move/);
  assert.equal(h.axWrites.length, 0); assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
});
test('a failed first Accessibility write that changed nothing falls back to the guarded foreground drag', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { failWrite: 1 } }); const r = h.run(pastEnd);
  assert.equal(r.path, 'foreground'); assert.match(r.fallbackReason, /accessibility move failed: AX write failed/);
});
test('a failed second Accessibility write reports the half-done move with Cmd+Z and never falls back', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { failWrite: 2 } }); const r = h.run(pastEnd);
  assert.equal(r.ok, false); assert.equal(r.path, 'accessibility'); assert.match(r.error, /Cmd\+Z twice/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
});
test('the foreground path waits for the person at the Mac to stop, then drags', () => {
  const h = harness({ busyChecks: 3 }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'foreground');
  assert.equal(h.delays.filter(s => s === 1.9).length, 3, 'waits out the 2 s idle window three times');
});
test('a person who keeps using the Mac stops the foreground path before it takes focus', () => {
  const h = harness({ busyChecks: Infinity }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /kept typing.*nothing was pressed/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
  assert.ok(h.delays.reduce((a, b) => a + b, 0) <= 10.01);
});
test('the background path never waits for the person at the Mac', () => {
  const h = harness({ background: true, busyChecks: Infinity }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true); assert.equal(r.path, 'background');
});
test('keys typed after the target takes focus stop the press and report it', () => {
  const h = harness({ typesAt: 'focused' }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /typed while .* was in front.*nothing was pressed/);
  assert.equal(h.events.some(e => e.type === 1), false); assert.ok(h.restored.includes('app'));
});
test('keys typed during the drag turn a success into an error that says so', () => {
  const h = harness({ typesAt: 'dragging' }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /typed during the drag/);
  assert.equal(h.values.get(11), 'beta gamma alpha\n');
});
test('background text move uses PID posting, repairs spacing and never activates or warps', () => {
  const h = harness({ background: true }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true); assert.equal(r.path, 'background'); assert.equal(r.spaceInserted, true);
  assert.equal(r.textChanged, true); assert.equal(h.values.get(11), 'beta gamma alpha\n');
  assert.equal(h.pidEvents.length, 29); assert.equal(h.events.length, 0);
  assert.ok(h.pidEvents.every(e => e.flags === 0));
  assert.equal(h.activations.length, 0); assert.equal(h.restored.length, 0);
});
test('unchanged background text alone permits the foreground fallback', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n' }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true); assert.equal(r.path, 'foreground'); assert.equal(r.fallbackReason, 'background text unchanged');
  assert.equal(h.pidEvents.length, 29); assert.equal(h.activations.length, 1); assert.equal(h.events.length, 28);
});
test('another app covering the drag points skips background posting and says which app', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9 }); const r = h.run({ windowId: 11 });
  assert.equal(r.path, 'foreground'); assert.equal(r.fallbackReason, 'background skipped: Other app covers the window at the drag points');
  assert.equal(h.pidEvents.length, 0);
});
test('a covered drag with no selected text, outside TextEdit, is refused before any raise or window scan', () => {
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, appId: 'com.apple.Chess', areaRole: 'AXImage', selection: '' }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /Other app covers the window at the drag points, and this drag has no selected text/);
  assert.deepEqual(h.delays, [], 'no settle wait'); assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0);
});
test('missing or failing private setter skips posting and names the foreground path', () => {
  for (const options of [{ background: false }, { background: true, setterFails: true }]) {
    const h = harness(options); const r = h.run({ windowId: 11 });
    assert.equal(r.path, 'foreground'); assert.match(r.fallbackReason, /background unavailable/);
    assert.equal(h.pidEvents.length, 0); assert.equal(h.activations.length, 1);
  }
});
test('lost text, changed partial text and unreadable text never permit a second drag', () => {
  for (const options of [{ backgroundAfter: '\n beta gamma\n' }, { backgroundAfter: 'beta alpha gamma\n', postFails: true }, { readFails: true }]) {
    const h = harness({ background: true, ...options }); const r = h.run({ windowId: 11 });
    assert.equal(r.ok, false); assert.equal(r.path, 'background');
    if (options.backgroundAfter === '\n beta gamma\n') { assert.equal(r.lostText, true); assert.match(r.error, /Cmd\+Z/); }
    assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0); assert.equal(h.restored.length, 0);
  }
});
test('non-text background posting reports unverified delivery without foreground repetition', () => {
  const h = harness({ background: true, appId: 'com.apple.Chess', areaRole: 'AXImage', selection: '' }); const r = h.run({ windowId: 11 });
  assert.equal(r.path, 'background'); assert.equal(r.deliveryVerified, false);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
  assert.ok(h.pidEvents.every(e => e.flags === 0), 'Chess piece moves must not become Command drags');
});
test('an owner edit after unchanged readback prevents foreground mouse-down', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n', changeOnActivate: true });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /changed.*foreground/);
  assert.equal(h.events.some(e => e.type === 1), false);
});
test('an unconfirmed background release cannot trigger foreground fallback', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n', releaseFails: true });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.equal(r.path, 'background'); assert.match(r.error, /release/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0);
});
test('unchanged text after both paths reports failure and never tries a third drag', () => {
  const h = harness({ background: true, backgroundAfter: 'alpha beta gamma\n', after: 'alpha beta gamma\n' });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.equal(r.path, 'foreground'); assert.equal(r.textChanged, false);
  assert.match(r.error, /unchanged/); assert.equal(h.pidEvents.filter(e => e.type === 1).length, 1);
  assert.equal(h.events.filter(e => e.type === 1).length, 1);
});
test('two TextEdit windows refuse ambiguous relative points before mouse-down and list IDs', () => {
  const h = harness(); const result = h.run({});
  assert.equal(result.ok, false);
  assert.match(result.error, /ambiguous.*windowId/i);
  assert.match(result.error, /11/); assert.match(result.error, /22/);
  assert.equal(h.events.length, 0);
});
test('windowId selects the smaller source window for both endpoints after activation moves it', () => {
  const h = harness({ movedOnActivate: true }); const result = h.run({ windowId: 11 });
  assert.equal(result.ok, true); assert.equal(result.windowId, 11);
  assert.deepEqual(h.events.find(e => e.type === 1).point, { x: 326.6, y: 438.5 });
  assert.deepEqual(h.events.find(e => e.type === 2).point, { x: 419, y: 438.5 });
  assert.equal(h.values.get(22), 'alpha beta gamma\n');
  assert.ok(h.restored.length >= 2);
});
test('title bar, toolbar and out-of-frame destinations refuse before pressing', () => {
  for (const to of [[119, 10], [119, 25], [700, 38.5], [-1, 38.5]]) {
    const h = harness(); const result = h.run({ windowId: 11, to });
    assert.equal(result.ok, false, JSON.stringify(to));
    assert.match(result.error, /content|text area|outside/i);
    assert.equal(h.events.length, 0);
  }
});
test('a second window of the same app covering the drop point refuses before pressing', () => {
  const h = harness({ coveredEnd: true }); const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.match(result.error, /cover|window/i);
  assert.equal(h.events.length, 0);
});
test('lost dragged text returns an error with Cmd+Z and the exact window, never success', () => {
  const h = harness({ after: '\n beta gamma\n' }); const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.equal(result.lostText, true);
  assert.match(result.error, /disappeared|lost|missing/i); assert.match(result.error, /Cmd\+Z/); assert.match(result.error, /11/);
  assert.ok(h.events.some(e => e.type === 2)); assert.ok(h.restored.length >= 2);
});
test('single-window calls still work; a foreign or stale windowId cannot fall back', () => {
  const h = harness({ second: false }); assert.equal(h.run({}).ok, true);
  const stale = harness(); assert.equal(stale.run({ windowId: 999 }).ok, false); assert.equal(stale.events.length, 0);
});
test('a windowId that matches no window uses the app\'s only window and says so', () => {
  // 3 was an open handle's number and 0 the tree's window index (textedit-drag, 2026-10-17).
  for (const windowId of [3, 0]) {
    const h = harness({ second: false }); const r = h.run({ windowId });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.windowId, 11);
    assert.equal(r.note, `windowId ${windowId} matched no window; used the app's only window 11`);
  }
});
test('with two windows a windowId that matches neither refuses before pressing and lists both IDs', () => {
  for (const windowId of [3, 0]) {
    const h = harness(); const r = h.run({ windowId });
    assert.equal(r.ok, false); assert.equal(h.events.length, 0); assert.equal(h.pidEvents.length, 0);
    assert.match(r.error, new RegExp(`windowId ${windowId} matches no window of this app; pass one of 22, 11 \\(window IDs, not indexes\\)`));
  }
});
test('non-TextEdit drags also reject title bars and toolbars', () => {
  for (const to of [[119, 10], [119, 25]]) {
    const h = harness({ second: false, appId: 'com.apple.Chess', areaRole: 'AXImage', selection: '' });
    assert.equal(h.run({ to }).ok, false); assert.equal(h.events.length, 0);
  }
});
test('TextEdit cannot drop into a different text area of the chosen window', () => {
  const h = harness({ splitAreas: true });
  const result = h.run({ windowId: 11, to: [119, 190] });
  assert.equal(result.ok, false); assert.match(result.error, /same.*text area/); assert.equal(h.events.length, 0);
});
test('missing content geometry and invalid inputs fail closed before pressing', () => {
  const h = harness({ missingContent: true }); assert.equal(h.run({ windowId: 11 }).ok, false); assert.equal(h.events.length, 0);
  for (const change of [{ windowId: 0 }, { windowId: 1.5 }, { from: [null, 38.5] }, { steps: 0 }, { holdMs: 9000 }]) {
    const invalid = harness(); assert.equal(invalid.run(change).ok, false); assert.equal(invalid.events.length, 0);
  }
});
test('a new substring formed by deleting selected text cannot conceal the loss', () => {
  const h = harness({ before: 'alalphapha\n', after: 'alpha\n' });
  const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.equal(result.lostText, true); assert.match(result.error, /Cmd\+Z/);
});
test('loss during an AX spacing write also returns an error', () => {
  const h = harness({ after: 'beta gammaalpha\n', repairDeletesText: true });
  const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.equal(result.lostText, true); assert.match(result.error, /Cmd\+Z/);
});
test('a verified spacing repair after a valid window-bound drag succeeds', () => {
  const h = harness({ after: 'beta gammaalpha\n' }); const result = h.run({ windowId: 11 });
  assert.equal(result.ok, true); assert.equal(result.spaceInserted, true); assert.equal(h.values.get(11), 'beta gamma alpha\n');
});
test('a valid overlapping partial-word move does not report loss', () => {
  const h = harness({ before: 'abababa X', after: 'abba Xaba', selection: 'aba' });
  assert.equal(h.run({ windowId: 11 }).ok, true);
});
test('whitespace-only selections refuse before pressing', () => {
  const h = harness({ selection: ' ' });
  assert.equal(h.run({ windowId: 11 }).ok, false); assert.equal(h.events.length, 0);
});
test('Unicode text loss is detected and a conserved repeated selection is accepted', () => {
  const lost = harness({ before: 'é🦊 é🦊 X', after: 'é🦊 X', selection: 'é🦊' });
  assert.equal(lost.run({ windowId: 11 }).lostText, true);
  const moved = harness({ before: 'é🦊 é🦊 X', after: 'é🦊 Xé🦊', selection: 'é🦊' });
  assert.equal(moved.run({ windowId: 11 }).ok, true);
});
test('TextEdit smart spacing can change selected whitespace without a false loss error', () => {
  const h = harness({ selection: 'alpha ', after: 'beta gammaalpha\n' });
  assert.equal(h.run({ windowId: 11 }).ok, true);
});
test('large AX trees refuse before pressing after at most 300 elements and restore focus', () => {
  const h = harness({ extraElements: 1000 });
  const result = h.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.match(result.error, /300|limit/i);
  assert.ok(h.visits() <= 300); assert.equal(h.events.length, 0);
  assert.ok(h.restored.includes('app'));
});
test('a refusal states nothing was pressed exactly once', () => {
  const h = harness(); const result = h.run({ windowId: 11, to: [119, 10] });
  assert.equal(result.error.match(/nothing was pressed/g)?.length, 1);
});
test('stacked Chess and TextEdit windows make the named window main before dragging', () => {
  for (const appId of ['com.apple.Chess', 'com.apple.TextEdit']) {
    const h = harness({ stacked: true, appId });
    const result = h.run({ windowId: 11 });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(h.mainWrites, [11]);
    assert.equal(h.values.get(11), 'beta gamma alpha\n');
    assert.equal(h.values.get(22), 'alpha beta gamma\n');
  }
});
test('a raise that leaves another stacked same-app window in front refuses before pressing', () => {
  for (const appId of ['com.apple.Chess', 'com.apple.TextEdit']) {
    const h = harness({ stacked: true, raiseWorks: false, appId });
    const result = h.run({ windowId: 11 });
    assert.equal(result.ok, false); assert.match(result.error, /covered|topmost/i);
    assert.equal(h.events.length, 0); assert.ok(h.restored.includes('app'));
  }
});
test('an off-Space window is distinguished from an app with no window before any activation', () => {
  const hidden = harness({ offSpace: true });
  const result = hidden.run({ windowId: 11 });
  assert.equal(result.ok, false); assert.match(result.error, /another desktop or Space/i);
  assert.match(result.error, /on screen/i); assert.equal(hidden.events.length, 0); assert.equal(hidden.restored.length, 0);
  const empty = harness({ noWindows: true });
  assert.match(empty.run({}).error, /has no window/);
  assert.doesNotMatch(empty.run({}).error, /another desktop or Space/);
});
test('background posting raises the named stacked Chess and TextEdit window without HID input', () => {
  for (const appId of ['com.apple.Chess', 'com.apple.TextEdit']) {
    const h = harness({ background: true, stacked: true, backgroundAfter: 'beta gamma alpha\n', appId });
    const result = h.run({ windowId: 11 });
    assert.equal(result.ok, true, result.error); assert.equal(result.path, 'background');
    assert.deepEqual(h.mainWrites, [11]);
    assert.equal(h.values.get(11), 'beta gamma alpha\n'); assert.equal(h.values.get(22), 'alpha beta gamma\n');
    assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
  }
});
test('a failed background raise refuses at both same-app endpoints before PID or HID pressing', () => {
  for (const options of [{ stacked: true, raiseWorks: false }, { coveredEnd: true }]) {
    const h = harness({ background: true, ...options }); const result = h.run({ windowId: 11 });
    assert.equal(result.ok, false); assert.match(result.error, /covered|topmost/i);
    assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0);
  }
});
test('the prior front app is restored if AXRaise brings a background target forward, even on refusal', () => {
  for (const coveredEnd of [false, true]) {
    const h = harness({ background: true, raiseActivates: true, coveredEnd }); h.run({ windowId: 11 });
    assert.ok(h.restored.includes('app')); assert.equal(h.events.length, 0);
  }
});
test('off-Space diagnosis precedes both background and foreground event construction', () => {
  for (const background of [false, true]) {
    const h = harness({ background, offSpace: true }); const result = h.run({ windowId: 11 });
    assert.match(result.error, /another desktop or Space/); assert.equal(h.pidEvents.length, 0);
    assert.equal(h.events.length, 0); assert.equal(h.mainWrites.length, 0);
  }
});
test('screenshot pixels convert to window points with the relay\'s screenshot size', () => {
  // Window 11 is 600×400 points; a 1200×800 screenshot is 2×. [300, 77] is [150, 38.5] in points.
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: {} });
  const r = h.run({ windowId: 11, from: [53.2, 77], to: [300, 77], screenshot: [1200, 800] });
  assert.equal(r.ok, true, r.error); assert.equal(h.values.get(11), 'beta gamma alpha\n');
  // The result names the frame Claude sent, with the engine size Claude Code calls the original,
  // and no pixels-per-point factor that competes with Claude Code's display multiplier.
  assert.equal(r.coordinates, 'engine screenshot pixels, 1200 × 800');
  assert.equal('screenshotScale' in r, false);
});
test('a screenshot of another window shape is ignored and the result says the points were window points', () => {
  const h = harness({ second: false });
  const r = h.run({ screenshot: [1000, 1000] });
  assert.equal(r.ok, true, r.error); assert.match(r.coordinates, /another window size/);
  assert.equal(h.run({}).coordinates, 'window points: no engine screenshot of this app yet');
});
test('the screenshot of the dragged window wins over the app\'s latest one', () => {
  // The latest screenshot was of another window (1000×1000); window 11's own was 1200×800, so 2×.
  const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: {} });
  const r = h.run({ windowId: 11, from: [53.2, 77], to: [300, 77], screenshot: [1000, 1000], screenshots: { '11.txt': [1200, 800] } });
  assert.equal(r.ok, true, r.error); assert.equal(r.coordinates, 'engine screenshot pixels, 1200 × 800');
});
test('an Accessibility move settles the app after writing, even when its second write fails', () => {
  for (const failWrite of [undefined, 2]) {
    const h = harness({ background: true, coveredEnd: true, coveredPid: 9, ax: { failWrite } }); h.run(pastEnd);
    assert.equal(h.axWrites.at(-1), 'settle', `failWrite ${failWrite}`);
  }
});
test('a text field in another app moves through Accessibility first, never a Command-modified drag', () => {
  // Safari-like: a text field with selected text in an app that isn't TextEdit, nothing covering it.
  const h = harness({ background: true, appId: 'com.apple.Safari', selection: 'alpha', ax: {} }); const r = h.run(pastEnd);
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'accessibility');
  assert.equal(h.values.get(11), 'beta gamma alpha\n'); assert.equal(h.pidEvents.length, 0);
  assert.match(r.fallbackReason ?? '', /^$/);
});
test('another app\'s text drag without Accessibility posts a plain drag, without Command', () => {
  const h = harness({ background: true, appId: 'com.apple.Safari', selection: 'alpha' }); h.run(pastEnd);
  assert.ok(h.pidEvents.length > 0 && h.pidEvents.every(e => e.flags === 0));
});
test('an app that ignores Accessibility writes gets the next path, with no undo advice', () => {
  const h = harness({ background: true, appId: 'com.apple.Safari', selection: 'alpha', ax: { ignored: true } }); const r = h.run(pastEnd);
  assert.notEqual(r.path, 'accessibility'); assert.match(r.fallbackReason, /accessibility move failed: the app ignored/);
  assert.doesNotMatch(r.error ?? '', /Cmd\+Z twice/);
});
test('an untitled window of the same app over a drag point is named as a likely dialog', () => {
  const dialog = harness({ coveredEnd: true, coverTitle: '' }).run({ windowId: 11 });
  assert.equal(dialog.ok, false); assert.match(dialog.error, /no title \(windowId 33\), likely a dialog or sheet: finish or close it/);
  const titled = harness({ coveredEnd: true }).run({ windowId: 11 });
  assert.match(titled.error, /covered by another window of TextEdit \(windowId 33, "cover.txt"\)/);
});

test('a drag that spent its time budget before pressing presses nothing', () => {
  for (const background of [true, false]) {
    const h = harness({ background, slowDelays: true }); const r = h.run({ windowId: 11 });
    assert.equal(r.ok, false); assert.match(r.error, /over 20 s.*nothing was pressed/);
    assert.equal(h.events.length, 0); assert.equal(h.pidEvents.length, 0);
  }
});
test('a covered drag with no selected text presses nothing and points to the engine drag', () => {
  const h = harness({ background: true, appId: 'com.apple.Chess', areaRole: 'AXImage', selection: '', coveredEnd: true, coveredPid: 9 }); const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /without a drag .*use that\. Otherwise use the engine's app\.drag.*nothing was pressed/);
  assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
});
test('a large non-text window posts without scanning unrelated elements', () => {
  const h = harness({ background: true, areaRole: 'AXOutline', selection: '', extraElements: 301 });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background');
  assert.equal(r.deliveryVerified, false); assert.equal(h.visits(), 0); assert.equal(h.pidEvents.length, 29);
});
test('non-text posting failure before mouse-down reaches guarded foreground fallback', () => {
  const h = harness({ background: true, areaRole: 'AXOutline', selection: '', failBeforePress: true, busyChecks: 2 });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'foreground');
  assert.match(r.fallbackReason, /posting unavailable before press/);
  assert.equal(h.pidEvents.some(e => e.type === 1), false); assert.equal(h.events.length, 28);
  assert.equal(h.delays.filter(s => s === 1.9).length, 2);
});
test('non-text foreground fallback still stops for owner input', () => {
  for (const options of [{ busyChecks: Infinity }, { typesAt: 'focused' }]) {
    const h = harness({ background: true, areaRole: 'AXOutline', selection: '', failBeforePress: true, ...options });
    const r = h.run({ windowId: 11 });
    assert.equal(r.ok, false); assert.equal(h.events.some(e => e.type === 1), false);
    assert.match(r.error, /kept typing|typed while/);
  }
});
test('non-text posting failure after mouse-down never repeats an uncertain drag', () => {
  const h = harness({ background: true, areaRole: 'AXOutline', selection: '', postFails: true });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /posting interrupted/);
  assert.equal(r.path, 'background'); assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
});

// Rows of window 11 (at 100, 100): row i spans x 105..695, y 130 + 40 i .. 160 + 40 i. Row 0's centre is
// window point [300, 45] and row 2's is [300, 125].
const rowDrag = { windowId: 11, from: [300, 45], to: [300, 125] };
const rowFixture = options => harness({ background: true, areaRole: 'AXOutline', selection: '', rows: 3, ...options });
test('the background sequence adds one stationary move on the destination before the release', () => {
  const h = rowFixture({}); const r = h.run(rowDrag);
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background');
  const types = h.pidEvents.map(e => e.type);
  assert.deepEqual(types, [5, 1, ...Array(26).fill(6), 2]);
  const [lastMove, beforeLast, release] = [h.pidEvents.at(-2), h.pidEvents.at(-3), h.pidEvents.at(-1)];
  assert.deepEqual(lastMove.point, beforeLast.point); assert.deepEqual(lastMove.point, release.point);
  assert.deepEqual(release.point, { x: 400, y: 225 });
  assert.deepEqual(lastMove.local, release.local);
  assert.equal(r.steps, 25); assert.equal(h.delays.filter(s => s === 0.5).length, 1, 'hold unchanged');
  assert.equal(h.delays.filter(s => s === 0.02).length, 26);
  assert.equal(h.delays.includes(1.5), true, 'settle unchanged');
});
test('a single-step drag still ends with the stationary move before the release', () => {
  const h = rowFixture({}); const r = h.run({ ...rowDrag, steps: 1 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(h.pidEvents.map(e => e.type), [5, 1, 6, 6, 2]);
});
test('a covered destination row moves to an exposed point inside the same row', () => {
  const h = rowFixture({ coveredEnd: true, coveredPid: 9, coverBounds: { X: 350, Y: 205, Width: 100, Height: 40 } });
  const r = h.run(rowDrag);
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background'); assert.deepEqual(r.relocated, ['to']);
  assert.match(r.note, /to moved to an exposed point inside the same element/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.length, 0); assert.equal(h.restored.length, 0);
  const press = h.pidEvents.find(e => e.type === 1), release = h.pidEvents.at(-1);
  assert.deepEqual(press.point, { x: 400, y: 145 });
  // Inside row 2's frame and outside the covering window.
  assert.ok(release.point.x >= 105 && release.point.x <= 695 && release.point.y >= 220 && release.point.y <= 250, JSON.stringify(release.point));
  assert.equal(release.point.x < 350 || release.point.x >= 450, true);
  assert.deepEqual(h.pidEvents.at(-2).point, release.point);
});
test('a covered source row is relocated the same way and the destination is untouched', () => {
  const h = rowFixture({ coveredEnd: true, coveredPid: 9, coverBounds: { X: 350, Y: 125, Width: 100, Height: 40 } });
  const r = h.run(rowDrag);
  assert.equal(r.ok, true, r.error); assert.deepEqual(r.relocated, ['from']);
  const press = h.pidEvents.find(e => e.type === 1);
  assert.ok(press.point.y >= 130 && press.point.y <= 160 && (press.point.x < 350 || press.point.x >= 450), JSON.stringify(press.point));
  assert.deepEqual(h.pidEvents.at(-1).point, { x: 400, y: 225 });
});
test('a fully covered row refuses before any raise, press or window write and names the endpoint', () => {
  const h = rowFixture({ coveredEnd: true, coveredPid: 9, coverBounds: { X: 90, Y: 200, Width: 640, Height: 60 } });
  const r = h.run(rowDrag);
  assert.equal(r.ok, false);
  assert.match(r.error, /to is covered by Other app and no part of that element is exposed/);
  assert.match(r.error, /don't repeat it/); assert.match(r.error, /nothing was pressed$/);
  assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
  assert.deepEqual(h.mainWrites, []);
});
test('a covered endpoint on a container is never moved within it', () => {
  const h = harness({ background: true, areaRole: 'AXOutline', selection: '', coveredEnd: true, coveredPid: 9 });
  const r = h.run({ windowId: 11 });
  assert.equal(r.ok, false); assert.match(r.error, /can't move within it|no element is known/);
  assert.equal(h.pidEvents.length, 0);
});
test('a relocated drag never falls back to the foreground path', () => {
  const h = rowFixture({ coveredEnd: true, coveredPid: 9, coverBounds: { X: 350, Y: 205, Width: 100, Height: 40 }, failBeforePress: true });
  const r = h.run(rowDrag);
  assert.equal(r.ok, false); assert.match(r.error, /background posting did not work.*nothing was pressed/);
  assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0); assert.equal(h.restored.length, 0);
});
test('a child control inside the row is never the landing point', () => {
  // The press is on the row (x 400); its left part, x 105 to 305, is a button the point must not land on.
  const h = rowFixture({ rowChild: [5, 200], coveredEnd: true, coveredPid: 9, coverBounds: { X: 350, Y: 205, Width: 100, Height: 40 } });
  const r = h.run(rowDrag);
  assert.equal(r.ok, true, r.error);
  const release = h.pidEvents.at(-1).point;
  assert.ok(release.x > 305 && release.x <= 695, JSON.stringify(release));
  assert.ok(release.x < 346 || release.x >= 454, JSON.stringify(release));
});
test('a group or list parent is refused even when its row-sized frame is exposed', () => {
  for (const rowRole of ['AXGroup', 'AXList']) {
    const h = rowFixture({ rowRole, rowChild: [5, 200], coveredEnd: true, coveredPid: 9, coverBounds: { X: 350, Y: 205, Width: 100, Height: 40 } });
    const r = h.run(rowDrag);
    assert.equal(r.ok, false, rowRole); assert.match(r.error, /is not a single item, so the point can't move within it/);
    assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0);
  }
});
test('a leaf group is a single item and relocates', () => {
  const h = rowFixture({ rowRole: 'AXGroup', coveredEnd: true, coveredPid: 9, coverBounds: { X: 350, Y: 205, Width: 100, Height: 40 } });
  const r = h.run(rowDrag);
  assert.equal(r.ok, true, r.error); assert.deepEqual(r.relocated, ['to']);
});
test('a row that moves during the raise and settle refuses before the first post', () => {
  const h = rowFixture({ shiftRowsOnRaise: 20, coveredEnd: true, coveredPid: 9, coverBounds: { X: 350, Y: 205, Width: 100, Height: 40 } });
  const r = h.run(rowDrag);
  assert.equal(r.ok, false); assert.match(r.error, /element at the (from|to) point moved since it was chosen; read the window again; nothing was pressed$/);
  assert.equal(h.pidEvents.length, 0); assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
});
test('a point within four points of another app\'s window edge is refused', () => {
  // The cover leaves only x 690 to 695 of row 2; the nearest grid point, 693, is 3 points from its edge.
  const h = rowFixture({ coveredEnd: true, coveredPid: 9, coverBounds: { X: 90, Y: 200, Width: 600, Height: 60 } });
  const r = h.run(rowDrag);
  assert.equal(r.ok, false); assert.match(r.error, /no part of that element is exposed/);
  assert.equal(h.pidEvents.length, 0);
});
test('a window of another app above layer 0 covers the row too', () => {
  for (const layer of [20, 25]) {
    const h = rowFixture({ coveredEnd: true, coveredPid: 9, coverBounds: { X: 350, Y: 205, Width: 100, Height: 40 },
      extraWindows: [{ id: 55, layer, bounds: { X: 90, Y: 200, Width: 640, Height: 60 } }] });
    const r = h.run(rowDrag);
    assert.equal(r.ok, false, `layer ${layer}`); assert.match(r.error, /no part of that element is exposed/);
    assert.equal(h.pidEvents.length, 0);
  }
});
test('an uncovered row drag is not relocated', () => {
  const h = rowFixture({}); const r = h.run(rowDrag);
  assert.equal(r.relocated, undefined); assert.deepEqual(h.pidEvents.find(e => e.type === 1).point, { x: 400, y: 145 });
});
}
