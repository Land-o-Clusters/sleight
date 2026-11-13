import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness({ timeoutError = 0, hitError = 0 } = {}) {
  const deadlines = [], reads = [], hits = [];
  const list = items => ({ count: items.length, objectAtIndex: i => items[i] });
  const $ = value => value;
  Object.assign($, {
    AXUIElementCreateApplication: () => app,
    AXUIElementSetMessagingTimeout: (el, seconds) => { deadlines.push([el, seconds]); return timeoutError; },
    CFEqual: (a, b) => a === b,
    AXUIElementCopyElementAtPosition: (el, x, y, out) => {
      assert.equal(el, app); hits.push([x, y]);
      out[0] = y < 130 ? toolbar : area; return hitError;
    },
    AXUIElementCopyAttributeValue: (el, name, out) => {
      reads.push(name);
      if (el[name]?.error) return el[name].error;
      if (!(name in el)) return -25205;
      out[0] = Array.isArray(el[name]) ? list(el[name]) : el[name]; return 0;
    },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return !!value; },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { bytes, mutableBytes: bytes }; } },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
    AXUIElementSetAttributeValue: (el, name, value) => { el[name] = value; return 0; },
    AXUIElementPerformAction: (el, name) => { el.action = name; return 0; },
  });
  const element = (role, x, y, width, height, children = []) => ({ AXRole: role,
    AXPosition: { x, y }, AXSize: { width, height }, AXChildren: children });
  const area = { ...element('AXTextArea', 105, 130, 590, 365), AXValue: 'alpha beta', AXSelectedText: 'alpha' };
  const toolbar = element('AXToolbar', 100, 120, 600, 10);
  const win = { ...element('AXWindow', 100, 100, 600, 400, [toolbar, area]), AXWindowNumber: 11, AXTitle: 'document' };
  area.AXParent = win; toolbar.AXParent = win;
  const app = { AXWindows: [win] };
  const context = vm.createContext({ $, Ref: () => [], Application: () => assert.fail('no Apple events'),
    ObjC: { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  const bounds = { X: 100, Y: 100, Width: 600, Height: 400 };
  const window = () => context.axWindow(7, { id: 11, title: 'document', bounds });
  return { context, window, app, win, area, toolbar, element, bounds, deadlines, reads, hits };
}

test('native content scan keeps text and toolbar guards without Apple events', () => {
  const h = harness(), win = h.window();
  const info = h.context.content(win, h.bounds);
  assert.equal(info.areas.length, 1); assert.equal(info.areas[0].role, 'AXTextArea');
  assert.deepEqual(JSON.parse(JSON.stringify(info.toolbars)), [{ X: 100, Y: 120, Width: 600, Height: 10 }]);
  const points = h.context.validatePoints(info, h.bounds, [20, 40], [200, 40], 'Editor');
  assert.equal(points.text.text, 'alpha beta'); assert.equal(points.text.selected, 'alpha');
  assert.throws(() => h.context.validatePoints(info, h.bounds, [20, 25], [200, 40], 'Editor'), /outside the window content/);
  points.text.el.attributes.byName('AXSelectedText').value = 'beta';
  assert.equal(h.area.AXSelectedText, 'beta');
  h.context.raiseWindow(win); assert.equal(h.win.AXMain, true); assert.equal(h.win.action, 'AXRaise');
  assert.ok(h.deadlines.length >= 1); assert.ok(h.deadlines.every(([, seconds]) => seconds === 0.5));
  assert.ok(h.reads.includes('AXChildren'));
});

test('native window match falls back to unique geometry and title, refusing ambiguity', () => {
  const h = harness(); delete h.win.AXWindowNumber;
  assert.equal(h.window().name(), 'document');
  h.app.AXWindows.push({ ...h.win });
  assert.throws(h.window, /cannot match window 11/);
});

test('native deadline failure prevents scanning and unreadable geometry prevents a match', () => {
  assert.throws(harness({ timeoutError: -25202 }).window, /deadline/);
  const h = harness(); delete h.win.AXWindowNumber; delete h.win.AXPosition;
  assert.throws(h.window, /cannot match window 11/);
});

test('native content scan preserves clipping, excluded chrome and the element limit', () => {
  const h = harness();
  h.win.AXChildren.push({ ...h.element('AXTextArea', 100, 100, 600, 400), AXSubrole: 'AXCloseButton' });
  h.area.AXPosition.y = 90;
  const info = h.context.content(h.window(), h.bounds);
  assert.equal(info.areas.length, 1); assert.equal(info.areas[0].bounds.Y, 100);
  h.win.AXChildren = Array.from({ length: 301 }, () => h.element('AXButton', 110, 140, 10, 10));
  assert.throws(() => h.context.content(h.window(), h.bounds), /300-element limit/);
});

test('native content timeouts refuse rather than hiding toolbar role or geometry', () => {
  for (const name of ['AXRole', 'AXPosition']) {
    const h = harness(); h.toolbar[name] = { error: -25204 };
    assert.throws(() => h.context.content(h.window(), h.bounds), error => error.axCode === -25204);
  }
});

test('unsupported and no-value attributes are still skipped during native scanning', () => {
  for (const code of [-25205, -25212]) {
    const h = harness(); h.toolbar.AXSubrole = { error: code };
    const info = h.context.content(h.window(), h.bounds);
    assert.equal(info.areas.length, 1); assert.equal(info.toolbars.length, 1);
  }
});

test('non-text endpoints validate without reading unrelated children in a large window', () => {
  const h = harness(); h.area.AXRole = 'AXOutline';
  h.win.AXChildren.push(...Array.from({ length: 301 }, () => h.element('AXButton', 110, 140, 10, 10)));
  const info = h.context.dragContent(7, h.window(), h.bounds, [20, 40], [200, 40]);
  const points = h.context.validatePoints(info, h.bounds, [20, 40], [200, 40], 'Files');
  assert.equal(points.text, null); assert.equal(h.hits.length, 2);
  assert.equal(h.reads.includes('AXChildren'), false);
});

test('endpoint ancestry rejects chrome, other windows and missing parents', () => {
  for (const change of [
    h => { h.area.AXParent = h.toolbar; },
    h => { h.area.AXSubrole = 'AXTitleBar'; },
    h => { h.area.AXParent = { ...h.win }; },
    h => { delete h.area.AXParent; },
    h => { h.area.AXParent = h.area; },
  ]) {
    const h = harness(); h.area.AXRole = 'AXOutline'; change(h);
    assert.throws(() => h.context.dragContent(7, h.window(), h.bounds, [20, 40], [200, 40]), /content|window|parent|limit/i);
  }
});

// Chess's board reported ancestor frames that cut off its right half, so every drag there was refused
// although the hit test had found the board at the point (2026-10-17 A/B). The hit test is the evidence.
test('an ancestor frame that excludes the hit point does not refuse a non-text drag', () => {
  const h = harness(); h.area.AXRole = 'AXImage';
  const group = h.element('AXGroup', 100, 130, 150, 300); group.AXParent = h.win; h.area.AXParent = group;
  h.area.AXSize = { width: 150, height: 300 };
  const info = h.context.dragContent(7, h.window(), h.bounds, [400, 40], [400, 200]);
  const points = h.context.validatePoints(info, h.bounds, [400, 40], [400, 200], 'Chess');
  assert.equal(points.text, null); assert.equal(h.hits.length, 2);
});

// Widening a mis-framed text field to the window would make it contain a non-text start point, and a
// stale selection there would turn the drag into a text move (review, 2026-10-17).
test('a text field whose frame misses the point is not widened to the window', () => {
  const h = harness(); h.area.AXRole = 'AXImage';
  const field = { ...h.element('AXTextField', 600, 130, 90, 300), AXSelectedText: 'stale', AXValue: 'stale text', AXParent: h.win };
  h.area.AXParent = field;
  const image = { ...h.element('AXImage', 105, 130, 100, 100), AXParent: h.win };
  const hit = h.context.$.AXUIElementCopyElementAtPosition;
  h.context.$.AXUIElementCopyElementAtPosition = (el, x, y, out) => { const error = hit(el, x, y, out); if (x < 300) out[0] = image; return error; };
  const info = h.context.dragContent(7, h.window(), h.bounds, [20, 40], [400, 200]);
  assert.equal(info.areas.some(area => area.role === 'AXTextField' && area.bounds.Width === h.bounds.Width), false);
  assert.equal(h.context.validatePoints(info, h.bounds, [20, 40], [400, 200], 'Editor').text, null);
});

test('endpoint AX timeouts and unreadable roles or geometry fail closed', () => {
  const failed = harness({ hitError: -25204 });
  assert.throws(() => failed.context.dragContent(7, failed.window(), failed.bounds, [20, 40], [200, 40]), error => error.axCode === -25204);
  for (const name of ['AXRole', 'AXPosition']) {
    const h = harness(); h.area.AXRole = 'AXOutline'; h.area[name] = { error: -25204 };
    assert.throws(() => h.context.dragContent(7, h.window(), h.bounds, [20, 40], [200, 40]), error => error.axCode === -25204);
  }
});

test('text endpoint validation retains the bounded whole-tree text scan', () => {
  const h = harness();
  const info = h.context.dragContent(7, h.window(), h.bounds, [20, 40], [200, 40]);
  assert.equal(h.context.validatePoints(info, h.bounds, [20, 40], [200, 40], 'Editor').text.selected, 'alpha');
  assert.ok(h.reads.includes('AXChildren'));
  h.win.AXChildren.push(...Array.from({ length: 301 }, () => h.element('AXButton', 110, 140, 10, 10)));
  assert.throws(() => h.context.dragContent(7, h.window(), h.bounds, [20, 40], [200, 40]), /300-element limit/);
});

test('an empty text selection refuses without scanning unrelated window content', () => {
  const h = harness(); h.area.AXSelectedText = '';
  h.win.AXChildren.push(...Array.from({ length: 301 }, () => h.element('AXButton', 110, 140, 10, 10)));
  assert.throws(() => h.context.dragContent(7, h.window(), h.bounds, [20, 40], [200, 40]), /Select non-whitespace/);
  assert.equal(h.reads.includes('AXChildren'), false);
});

test('selected text retains the original scan through an ancestor without geometry', () => {
  const h = harness();
  const group = { AXRole: 'AXGroup', AXChildren: [h.area], AXParent: h.win };
  h.area.AXParent = group; h.win.AXChildren = [h.toolbar, group];
  const info = h.context.dragContent(7, h.window(), h.bounds, [20, 40], [200, 40]);
  assert.equal(h.context.validatePoints(info, h.bounds, [20, 40], [200, 40], 'Editor').text.selected, 'alpha');
});

function semanticFixture() {
  const h = harness(), win = h.window();
  h.area.AXValue = 'alpha beta\ngamma delta\n';
  h.area.AXSelectedText = 'alpha';
  h.app.AXFocusedUIElement = h.area;
  const text = {
    reference: h.area, value: () => h.area.AXValue,
    selection: () => ({ location: 0, length: h.area.AXSelectedText.length }),
    lineRange: n => n === 0 ? { location: 0, length: 11 } : n === 1 ? { location: 11, length: 12 } : null,
    rect: i => ({ X: 110 + (i < 11 ? i : i - 11) * 8, Y: i < 11 ? 140 : 160, Width: 8, Height: 14 }),
  };
  h.context.axTextArea = () => text;
  const main = { id: 11, title: 'document', bounds: h.bounds };
  const request = { from: 'the current text selection', to: 'end of line 2' };
  return { ...h, text, request, resolve: (change = {}) => h.context.semanticPoints({ ...request, ...change }, 7, win, main) };
}

test('selection and one-based line end resolve from glyph geometry in window points', () => {
  const h = semanticFixture(), points = h.resolve();
  assert.deepEqual(Array.from(points.from), [14, 47]);
  assert.deepEqual(Array.from(points.to), [97, 67]);
  assert.equal(h.reads.includes('AXFocusedUIElement'), true);
});

for (const [value, range] of [['destination\n\n', { location: 12, length: 1 }],
  ['destination\n', { location: 12, length: 0 }], ['destination\r\n\r\n', { location: 13, length: 2 }]]) {
  test(`DPg resolves a blank destination line from its own AX caret: ${JSON.stringify(value)}`, () => {
    const h = semanticFixture(); h.area.AXValue = value; h.area.AXSelectedText = '';
    h.text.lineRange = () => range;
    h.text.rect = (i, n) => {
      assert.equal(i, range.location); assert.equal(n, range.length);
      return { X: 110, Y: 160, Width: 0, Height: 14 };
    };
    const main = { id: 11, title: 'document', bounds: h.bounds };
    const resolve = () => h.context.semanticPoints(h.request, 7, h.window(), main, undefined, 'to', 'area');
    assert.deepEqual(Array.from(resolve().to), [10, 67]);
    vm.runInContext('dp7 = false', h.context);
    assert.throws(resolve, /line/);
  });
}

for (const rect of [null, { X: 0, Y: 0, Width: 0, Height: 14 }, { X: 110, Y: 160, Width: 0, Height: 0 },
  { X: 110, Y: 160, Width: -1, Height: 14 }, { X: 110, Y: NaN, Width: 0, Height: 14 },
  { X: 99, Y: 160, Width: 0, Height: 14 }, { X: 110, Y: 490, Width: 0, Height: 14 }]) {
  test(`DPg refuses an unproven blank caret: ${JSON.stringify(rect)}`, () => {
    const h = semanticFixture(); h.area.AXValue = 'destination\n\n'; h.area.AXSelectedText = '';
    h.text.lineRange = () => ({ location: 12, length: 1 }); h.text.rect = () => rect;
    assert.throws(() => h.context.semanticPoints(h.request, 7, h.window(),
      { id: 11, title: 'document', bounds: h.bounds }, undefined, 'to', 'area'), /line|geometry|window/);
  });
}

test('DPg blank-line geometry propagates AX timeouts', () => {
  const h = semanticFixture(); h.area.AXValue = 'destination\n\n'; h.area.AXSelectedText = '';
  h.text.lineRange = () => ({ location: 12, length: 1 });
  h.text.rect = () => { throw Object.assign(Error('AX timeout'), { axCode: -25204 }); };
  assert.throws(() => h.context.semanticPoints(h.request, 7, h.window(),
    { id: 11, title: 'document', bounds: h.bounds }, undefined, 'to', 'area'), error => error.axCode === -25204);
});

test('semantic text endpoints refuse empty selections, invalid ranges, foreign focus and unreadable bounds', () => {
  for (const change of [
    h => { h.area.AXSelectedText = ''; },
    h => { h.area.AXParent = { ...h.win }; },
    h => { h.text.rect = () => null; },
    h => { h.text.rect = () => ({ X: 99, Y: 140, Width: 8, Height: 14 }); },
    h => { h.text.lineRange = () => ({ location: 10, length: -1 }); },
    h => { h.text.selection = () => ({ location: 1, length: 5 }); },
  ]) {
    const h = semanticFixture(); change(h);
    assert.throws(() => h.resolve(), /selection|window|geometry|line|range/i);
  }
  for (const to of ['end of line 0', 'end of line -1', 'end of line 1.5', 'end of line 999']) {
    assert.throws(() => semanticFixture().resolve({ to }));
  }
});

test('element numbers resolve observed unique AX identities, never tree traversal indices', () => {
  const h = semanticFixture();
  h.area.AXRole = 'AXImage'; h.area.AXIdentifier = 'source';
  const target = { ...h.element('AXImage', 300, 180, 40, 40), AXIdentifier: 'target', AXParent: h.win };
  h.win.AXChildren.push(target);
  const hit = h.context.$.AXUIElementCopyElementAtPosition;
  h.context.$.AXUIElementCopyElementAtPosition = (el, x, y, out) => {
    if (x >= 300 && x < 340 && y >= 180 && y < 220) { out[0] = target; return 0; }
    return hit(el, x, y, out);
  };
  const request = { from: 71, to: 92, elementWindow: { title: 'document', windowId: 11 },
    elementLines: { 71: 'image ID: source', 92: 'image ID: target' } };
  const points = h.resolve(request);
  assert.deepEqual(Array.from(points.from), [300, 212.5]);
  assert.deepEqual(Array.from(points.to), [220, 100]);
  h.win.AXChildren.push({ ...target });
  assert.throws(() => h.resolve(request), /ambiguous|exactly one/i);
});

test('element endpoints reject missing identities, other windows, chrome and unavailable geometry', () => {
  for (const change of [
    request => { delete request.elementLines[71]; },
    request => { request.elementLines[71] = 'image'; },
    request => { request.elementWindow.title = 'other'; },
    request => { request.elementWindow.windowId = 22; },
    (request, h) => { h.area.AXPosition = { error: -25204 }; },
    (request, h) => { h.win.AXChildren = [h.toolbar]; h.toolbar.AXChildren = [h.area]; },
  ]) {
    const h = semanticFixture(); h.area.AXRole = 'AXImage'; h.area.AXIdentifier = 'source';
    const request = { from: 71, to: [40, 60], elementWindow: { title: 'document', windowId: 11 }, elementLines: { 71: 'image ID: source' } };
    change(request, h); assert.throws(() => h.resolve(request));
  }
});

test('semantic revalidation refuses replacement elements, geometry and selection changes', () => {
  for (const change of [
    h => { h.area.AXValue = 'owner edit\n'; },
    h => { h.area.AXSelectedText = 'alpha beta'; },
    h => { h.text.rect = () => ({ X: 120, Y: 140, Width: 8, Height: 14 }); },
    h => { h.app.AXFocusedUIElement = { ...h.area }; },
  ]) {
    const h = semanticFixture(), before = h.resolve(); change(h);
    assert.throws(() => h.context.checkSemantic(before, h.request, 7, h.window(), { id: 11, title: 'document', bounds: h.bounds }));
  }
});

test('text adapter asks AX for a visual line and a nonempty glyph range without hit testing or writes', () => {
  const h = harness(), parameters = [], allocations = [];
  const api = h.context.$;
  Object.assign(api, {
    malloc: () => { const buffer = {}; allocations.push(buffer); return buffer; },
    free: buffer => { assert.equal(allocations.pop(), buffer); },
    NSMakeRange: (location, length) => ({ location, length }),
    NSNumber: { numberWithInteger: value => ({ objcType: 'q', integerValue: value }) },
    NSValue: { ...api.NSValue, valueWithRange: range => ({ getValue: buffer => { buffer.range = range; } }) },
    AXValueCreate: (type, buffer) => { assert.equal(type, 4); return buffer.range; },
    AXUIElementCopyParameterizedAttributeValue: (el, name, arg, out) => {
      assert.equal(el, h.area); parameters.push([name, arg]);
      out[0] = { description: name === 'AXRangeForLine' ? 'location:11 length:12' : 'x:110 y:140 w:16 h:14' }; return 0;
    },
    AXUIElementSetAttributeValue: () => assert.fail('no text writes while resolving'),
  });
  h.context.ObjC.bindFunction = () => {};
  const area = h.context.axTextArea(7, null, h.area);
  assert.deepEqual(JSON.parse(JSON.stringify(area.lineRange(1))), { location: 11, length: 12 });
  assert.deepEqual(JSON.parse(JSON.stringify(area.rect(11, 2))), { X: 110, Y: 140, Width: 16, Height: 14 });
  assert.deepEqual(parameters[0], ['AXRangeForLine', { objcType: 'q', integerValue: 1 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(parameters[1])), ['AXBoundsForRange', { location: 11, length: 2 }]);
  assert.equal(h.hits.length, 0); assert.equal(allocations.length, 0);
});

test('WD3 native adapter resolves below the last range without reading document text', () => {
  const h = harness(), api = h.context.$, parameters = [];
  h.area.AXNumberOfCharacters = 12;
  h.area.AXPosition = { x: 757, y: 81 }; h.area.AXSize = { width: 700, height: 520 };
  const attribute = api.AXUIElementCopyAttributeValue;
  api.AXUIElementCopyAttributeValue = (el, name, out) => {
    assert.notEqual(name, 'AXValue', 'geometry must not read the document');
    return attribute(el, name, out);
  };
  Object.assign(api, {
    malloc: () => ({}), free() {},
    NSNumber: { numberWithInteger: value => value },
    NSMakeRange: (location, length) => ({ location, length }), NSMakePoint: (x, y) => ({ x, y }),
    NSValue: { ...api.NSValue,
      valueWithRange: value => ({ getValue: buffer => { buffer.value = value; } }),
      valueWithPoint: value => ({ getValue: buffer => { buffer.value = value; } }),
    },
    AXValueCreate: (_type, buffer) => buffer.value,
    AXUIElementCopyParameterizedAttributeValue: (el, name, arg, out) => {
      assert.equal(el, h.area); parameters.push([name, arg]);
      if (name === 'AXRangeForPosition') return -25212;
      if (name === 'AXLineForIndex') { assert.equal(arg, 11); out[0] = 0; return 0; }
      if (name === 'AXRangeForLine') { assert.equal(arg, 0); out[0] = { description: 'location:0 length:12' }; return 0; }
      assert.equal(name, 'AXBoundsForRange');
      if (arg.location === 11 && arg.length === 1) out[0] = { description: 'x:833.5 y:81 w:0 h:13' };
      else {
        assert.deepEqual(JSON.parse(JSON.stringify(arg)), { location: 0, length: 12 });
        out[0] = { description: 'x:762 y:81 w:71.5 h:13' };
      }
      return 0;
    },
    AXUIElementSetAttributeValue: () => assert.fail('endpoint resolution must not write'),
  });
  h.context.ObjC.bindFunction = () => {};
  const area = h.context.axTextArea(7, null, h.area);
  assert.equal(h.context.dropIndex(area, { x: 764, y: 101 }), 12);
  assert.ok(h.reads.includes('AXNumberOfCharacters'));
  assert.ok(h.reads.includes('AXPosition')); assert.ok(h.reads.includes('AXSize'));
  assert.equal(parameters.length, 5); assert.equal(h.hits.length, 0);
});

test('line-end geometry requests the whole last Unicode glyph and skips CRLF', () => {
  const h = semanticFixture(), ranges = [];
  h.area.AXValue = 'alpha\nlast 😀\r\n';
  h.text.lineRange = () => ({ location: 6, length: h.area.AXValue.length - 6 });
  h.text.rect = (index, length) => { ranges.push([index, length]); return { X: 110, Y: 160, Width: 16, Height: 14 }; };
  h.resolve();
  assert.deepEqual(ranges.at(-1), [11, 2]);
});

test('a numbered element covered by another control in the same window refuses before input', () => {
  const h = semanticFixture(); h.area.AXRole = 'AXImage'; h.area.AXIdentifier = 'source';
  const cover = { ...h.element('AXImage', 105, 130, 590, 365), AXParent: h.win };
  h.context.$.AXUIElementCopyElementAtPosition = (_el, _x, _y, out) => { out[0] = cover; return 0; };
  assert.throws(() => h.resolve({ from: 71, to: [40, 60], elementWindow: { title: 'document', windowId: 11 },
    elementLines: { 71: 'image ID: source' } }), /covered|endpoint|identity/i);
});

test('selection ranges extending beyond the text refuse instead of using a truncated slice', () => {
  const h = semanticFixture();
  h.area.AXSelectedText = h.area.AXValue;
  h.text.selection = () => ({ location: 0, length: h.area.AXValue.length + 1 });
  assert.throws(() => h.resolve(), /selection|range/i);
});

test('numbered labels and mixed screenshot coordinates resolve without scaling AX geometry', () => {
  for (const identity of ['title', 'description']) {
    const h = semanticFixture(); h.area.AXRole = 'AXImage';
    h.area[identity === 'title' ? 'AXTitle' : 'AXDescription'] = 'Source';
    const points = h.resolve({ from: 71, to: [80, 120], screenshot: [1200, 800],
      elementWindow: { title: 'document', windowId: 11 }, elementLines: { 71: identity === 'title' ? 'image Source' : 'image Description: Source' } });
    assert.deepEqual(Array.from(points.from), [300, 212.5]);
    assert.deepEqual(Array.from(points.to), [40, 60]);
  }
});


test('both numbered endpoints share one deep 2000-node scan and revalidate without another tree walk', () => {
  const h = semanticFixture(); h.area.AXRole = 'AXImage'; h.area.AXIdentifier = 'source';
  const target = { ...h.element('AXImage', 300, 180, 40, 40), AXIdentifier: 'target', AXParent: h.win };
  let root = h.area;
  for (let i = 0; i < 31; i++) {
    const parent = { ...h.element('AXGroup', 105, 130, 590, 365, [root]), AXParent: h.win };
    root.AXParent = parent; root = parent;
  }
  h.win.AXChildren = [...Array.from({ length: 1966 }, () => h.element('AXStaticText', 110, 140, 10, 10)), root, target];
  h.context.$.AXUIElementCopyElementAtPosition = (_el, x, _y, out) => { out[0] = x === 320 ? target : h.area; return 0; };
  const request = { from: 71, to: 92, elementWindow: { title: 'document', windowId: 11 },
    elementLines: { 71: 'image ID: source', 92: 'image ID: target' } };
  const started = performance.now(), points = h.resolve(request);
  assert.deepEqual(Array.from(points.to), [220, 100]);
  assert.ok(performance.now() - started < 1000, 'fake 31-deep, 2000-node tree resolves within 1 second');
  assert.equal(h.reads.filter(name => name === 'AXChildren').length, 2000, 'one walk for both endpoints');
  h.reads.length = 0;
  h.context.checkSemantic(points, request, 7, h.window(), { id: 11, title: 'document', bounds: h.bounds });
  assert.equal(h.reads.includes('AXChildren'), false, 'known references are revalidated directly');
  target.AXIdentifier = 'changed';
  assert.throws(() => h.context.checkSemantic(points, request, 7, h.window(), { id: 11, title: 'document', bounds: h.bounds }), /identity|changed/);
});

test('element identity parsing keeps commas in titles, descriptions and IDs', () => {
  for (const [attribute, line] of [['AXTitle', 'button Save, then close'],
    ['AXDescription', 'button Description: Save, then close, ID: target'],
    ['AXIdentifier', 'button ID: Save, then close, Help: action']]) {
    const h = semanticFixture(); h.area.AXRole = 'AXButton'; h.area[attribute] = 'Save';
    h.area.AXIdentifier = attribute === 'AXIdentifier' ? 'Save' : 'target';
    assert.throws(() => h.resolve({ from: 71, to: [40, 60], elementWindow: { title: 'document', windowId: 11 },
      elementLines: { 71: line } }), /exactly one|missing|identity/);
    h.area[attribute] = 'Save, then close';
    const points = h.resolve({ from: 71, to: [40, 60], elementWindow: { title: 'document', windowId: 11 }, elementLines: { 71: line } });
    assert.deepEqual(Array.from(points.from), [300, 212.5]);
  }
});

test('unreadable unrelated roles are skipped but AX timeouts still refuse element discovery', () => {
  for (const code of [-25205, -25212, -25204]) {
    const h = semanticFixture(); h.area.AXRole = 'AXImage'; h.area.AXIdentifier = 'source';
    h.win.AXChildren.unshift({ AXRole: { error: code }, AXChildren: [] });
    const resolve = () => h.resolve({ from: 71, to: [40, 60], elementWindow: { title: 'document', windowId: 11 }, elementLines: { 71: 'image ID: source' } });
    if (code === -25204) assert.throws(resolve, error => error.axCode === code);
    else assert.deepEqual(Array.from(resolve().from), [300, 212.5]);
  }
});

test('element discovery stops on its second match before scanning unrelated nodes', () => {
  const h = semanticFixture(); h.area.AXRole = 'AXImage'; h.area.AXIdentifier = 'source';
  h.win.AXChildren = [h.area, { ...h.area }, ...Array.from({ length: 6000 }, () => h.element('AXGroup', 110, 140, 10, 10))];
  assert.throws(() => h.resolve({ from: 71, to: [40, 60], elementWindow: { title: 'document', windowId: 11 }, elementLines: { 71: 'image ID: source' } }), /ambiguous|exactly one/);
  assert.ok(h.reads.filter(name => name === 'AXRole').length <= 3);
});

test('element discovery refuses depth, size and elapsed-time exhaustion without accepting a partial match', () => {
  for (const budget of ['depth', 'size', 'time']) {
    const h = semanticFixture(); h.area.AXRole = 'AXImage'; h.area.AXIdentifier = 'source';
    if (budget === 'depth') {
      let root = h.area;
      for (let i = 0; i < 65; i++) root = h.element('AXGroup', 110, 140, 10, 10, [root]);
      h.win.AXChildren = [root];
    } else if (budget === 'size') {
      h.win.AXChildren.push(...Array.from({ length: 5001 }, () => h.element('AXGroup', 110, 140, 10, 10)));
    } else {
      let time = 0; h.context.Date = { now: () => (time += 1000) };
    }
    assert.throws(() => h.resolve({ from: 71, to: [40, 60], elementWindow: { title: 'document', windowId: 11 }, elementLines: { 71: 'image ID: source' } }), /depth|element limit|time.*limit/);
  }
});

test('semantic points retain negative display origins and mixed screenshot scale', () => {
  const h = semanticFixture();
  h.bounds.X = -1500; h.bounds.Y = -400;
  h.win.AXPosition = { x: -1500, y: -400 }; h.area.AXPosition = { x: -1495, y: -370 };
  h.text.rect = () => ({ X: -1490, Y: -360, Width: 8, Height: 14 });
  const points = h.resolve({ to: [80, 120], screenshot: [1200, 800] });
  assert.deepEqual(Array.from(points.from), [14, 47]);
  assert.deepEqual(Array.from(points.to), [40, 60]);
});

test('end of line uses AX visual wrapping rather than newline-separated text', () => {
  const h = semanticFixture(), asked = [];
  h.area.AXValue = 'alpha beta gamma delta';
  h.text.lineRange = n => { asked.push(n); return n === 1 ? { location: 6, length: 5 } : null; };
  const points = h.resolve();
  assert.deepEqual(asked, [1]);
  assert.deepEqual(Array.from(points.to), [97, 47]);
});


test('known semantic elements moved into window chrome still refuse before input', () => {
  const h = semanticFixture(); h.area.AXRole = 'AXImage'; h.area.AXIdentifier = 'source';
  const request = { from: 71, to: [40, 60], elementWindow: { title: 'document', windowId: 11 }, elementLines: { 71: 'image ID: source' } };
  const before = h.resolve(request);
  h.area.AXParent = h.toolbar; h.toolbar.AXChildren = [h.area]; h.win.AXChildren = [h.toolbar];
  assert.throws(() => h.context.checkSemantic(before, request, 7, h.window(), { id: 11, title: 'document', bounds: h.bounds }), /chrome|content|toolbar/);
});

// CC8, owner ruling 2026-10-19 (LAWS native apps line): a web list row named only by AXValue binds to the label the
// engine printed, and nothing else's value is read.
function labelFixture() {
  const h = semanticFixture(), valueReads = [];
  const copy = h.context.$.AXUIElementCopyAttributeValue;
  h.context.$.AXUIElementCopyAttributeValue = (el, name, out) => {
    if (name === 'AXValue') valueReads.push(el);
    return copy(el, name, out);
  };
  const list = { ...h.element('AXGroup', 300, 160, 200, 120), AXParent: h.win };
  const row = (label, y) => ({ ...h.element('AXStaticText', 310, y, 80, 20), AXValue: label, AXParent: list });
  list.AXChildren = [row('Billing', 170), row('Security', 200), row('Product updates', 230)];
  h.win.AXChildren.push(list);
  const hit = h.context.$.AXUIElementCopyElementAtPosition;
  h.context.$.AXUIElementCopyElementAtPosition = (el, x, y, out) => {
    const found = list.AXChildren.find(r => x >= r.AXPosition.x && x < r.AXPosition.x + r.AXSize.width &&
      y >= r.AXPosition.y && y < r.AXPosition.y + r.AXSize.height);
    if (found) { out[0] = found; return 0; }
    return hit(el, x, y, out);
  };
  const request = (lines, from = 90, to = 91) => ({ from, to, elementWindow: { title: 'document', windowId: 11 }, elementLines: lines });
  return { ...h, list, row, valueReads, request };
}
const main = h => ({ id: 11, title: 'document', bounds: h.bounds });

test('an engine-printed static-text label binds by exact AXValue and reads no other kind of value', () => {
  const h = labelFixture();
  const request = h.request({ 90: 'text Security', 91: 'text Billing' });
  const points = h.resolve(request);
  assert.deepEqual(Array.from(points.from), [250, 110]);
  assert.deepEqual(Array.from(points.to), [250, 80]);
  assert.ok(h.valueReads.length > 0);
  assert.ok(h.valueReads.every(el => el.AXRole === 'AXStaticText'), 'only static text values are read');
  assert.equal(h.valueReads.includes(h.area), false, "the document's text area value is never read");
  h.list.AXChildren[1].AXValue = 'Security changed';
  assert.throws(() => h.context.checkSemantic(points, request, 7, h.window(), main(h)), /identity|changed/);
});

test('a static-text label refuses a different, cased, padded or substring value without naming it', () => {
  for (const value of ['Security alerts', 'security', 'Security ', ' Security', 'Secur']) {
    const h = labelFixture(); h.list.AXChildren[1].AXValue = value;
    assert.throws(() => h.resolve(h.request({ 90: 'text Security' }, 90, [40, 60])), error =>
      /missing/.test(error.message) && !error.message.includes(value.trim() === 'Security' ? 'Security ' : value));
  }
});

test('a label longer than the cap is refused without reading any AXValue', () => {
  const h = labelFixture(), long = 'Security '.repeat(9) + 'x';
  assert.ok(long.length > 80);
  h.list.AXChildren[1].AXValue = long;
  assert.throws(() => h.resolve(h.request({ 90: 'text ' + long }, 90, [40, 60])), /missing/);
  assert.equal(h.valueReads.length, 0);
  const h2 = labelFixture(), atCap = 'S'.repeat(80);
  h2.list.AXChildren[1].AXValue = atCap;
  assert.deepEqual(Array.from(h2.resolve(h2.request({ 90: 'text ' + atCap }, 90, [40, 60])).from), [250, 110]);
});

test('text fields, text areas and other roles never bind by value, and values under them are never read', () => {
  for (const role of ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXRow', 'AXButton']) {
    const h = labelFixture(); h.list.AXChildren[1].AXRole = role;
    assert.throws(() => h.resolve(h.request({ 90: 'text Security' }, 90, [40, 60])), /missing/);
    assert.equal(h.valueReads.includes(h.list.AXChildren[1]), false, role + ' value read');
  }
  for (const role of ['AXTextArea', 'AXTextField', 'AXComboBox', 'AXLayoutArea']) {
    const h = labelFixture(); h.list.AXRole = role;
    assert.throws(() => h.resolve(h.request({ 90: 'text Security' }, 90, [40, 60])), /missing/);
    assert.equal(h.valueReads.length, 0, 'static text under ' + role + ' was read');
  }
  const h = labelFixture();
  assert.throws(() => h.resolve(h.request({ 90: 'row Security' }, 90, [40, 60])), /missing/);
  assert.throws(() => h.resolve(h.request({ 90: 'text field Security' }, 90, [40, 60])), /missing/);
});

test("a document's text never gets read for a drag endpoint, even when it equals the label", () => {
  const h = labelFixture();
  h.win.AXChildren = [h.toolbar, h.area];
  h.area.AXValue = 'Security';
  const paragraph = { ...h.element('AXStaticText', 110, 140, 80, 20), AXValue: 'Security', AXParent: h.area };
  h.area.AXChildren = [paragraph];
  assert.throws(() => h.resolve(h.request({ 90: 'text Security' }, 90, [40, 60])), /missing/);
  assert.deepEqual(h.valueReads, [], 'no AXValue read from the document or its text');
});

test('a label value outside the leased window or in its toolbar is never bound or read', () => {
  const h = labelFixture();
  h.win.AXChildren = h.win.AXChildren.filter(el => el !== h.list);
  const other = { ...h.element('AXWindow', 700, 100, 400, 400, [h.list]), AXWindowNumber: 22, AXTitle: 'other' };
  h.list.AXParent = other; h.app.AXWindows.push(other);
  assert.throws(() => h.resolve(h.request({ 90: 'text Security' }, 90, [40, 60])), /missing/);
  assert.equal(h.valueReads.length, 0);
  const t = labelFixture();
  t.win.AXChildren = t.win.AXChildren.filter(el => el !== t.list);
  t.toolbar.AXChildren = [t.list]; t.list.AXParent = t.toolbar;
  assert.throws(() => t.resolve(t.request({ 90: 'text Security' }, 90, [40, 60])), /missing/);
  assert.equal(t.valueReads.length, 0);
});

test('label binding keeps uniqueness, the character-count gate and the move-into-input refusal', () => {
  const dup = labelFixture(); dup.list.AXChildren.push(dup.row('Security', 260));
  assert.throws(() => dup.resolve(dup.request({ 90: 'text Security' }, 90, [40, 60])), /ambiguous/);
  const counted = labelFixture();
  for (const r of counted.list.AXChildren) r.AXNumberOfCharacters = r.AXValue.length + 5;
  assert.throws(() => counted.resolve(counted.request({ 90: 'text Security' }, 90, [40, 60])), /missing/);
  assert.equal(counted.valueReads.length, 0, 'a count that differs rules the value out unread');
  const exact = labelFixture();
  for (const r of exact.list.AXChildren) r.AXNumberOfCharacters = r.AXValue.length;
  const request = exact.request({ 90: 'text Security' }, 90, [40, 60]);
  const before = exact.resolve(request);
  assert.ok(exact.valueReads.length && exact.valueReads.every(el => el === exact.list.AXChildren[1]), 'only the row whose count equals the label is read');
  const field = { ...exact.element('AXTextField', 300, 160, 200, 120), AXParent: exact.win };
  exact.list.AXParent = field;
  assert.throws(() => exact.context.checkSemantic(before, request, 7, exact.window(), main(exact)), /text input|document/);
});

test('a titled static text still binds by name without reading its value', () => {
  const h = labelFixture(), row = h.list.AXChildren[1];
  row.AXTitle = 'Security'; row.AXValue = 'something else';
  assert.deepEqual(Array.from(h.resolve(h.request({ 90: 'text Security' }, 90, [40, 60])).from), [250, 110]);
  assert.equal(h.valueReads.includes(row), false);
});

test('a row label inside a web area binds, and each static text value is read at most once per walk', () => {
  const h = labelFixture();
  const web = { ...h.element('AXWebArea', 300, 160, 200, 120), AXParent: h.win, AXChildren: [h.list] };
  h.list.AXParent = web; h.win.AXChildren = h.win.AXChildren.filter(el => el !== h.list).concat(web);
  const points = h.resolve(h.request({ 90: 'text Security', 91: 'text Product updates' }));
  assert.deepEqual(Array.from(points.from), [250, 110]);
  assert.equal(h.valueReads.includes(web), false, 'the web area value is never read');
  const walkReads = h.valueReads.slice(0, -2); // resolve rechecks the two bound rows after the walk
  assert.equal(new Set(walkReads).size, walkReads.length, 'one AXValue read per element in the walk');
});

test('a name match and a value match on different elements refuse as ambiguous', () => {
  const h = labelFixture();
  h.list.AXChildren.push({ ...h.element('AXStaticText', 310, 260, 80, 20), AXTitle: 'Security', AXParent: h.list });
  assert.throws(() => h.resolve(h.request({ 90: 'text Security' }, 90, [40, 60])), /ambiguous/);
});

test('without a character count, a long value is compared and refused, never bound', () => {
  const h = labelFixture(); h.list.AXChildren[1].AXValue = 'Security' + ' and more'.repeat(10);
  assert.throws(() => h.resolve(h.request({ 90: 'text Security' }, 90, [40, 60])), /missing/);
});
