// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from './helpers/window-identity-fixture.mjs';
import { verifyWindowIdentity } from '../plugins/sleight/lib/window-identity.mjs';
// Header shape from the published TextEdit tree; native fields model AX observations.
const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'Untitled', url: null };
const observed = { status: 'ok', appId: target.appId, title: target.title, url: null,
  epoch: 'helper-a', window: 1, pid: 123, processStart: 1000, matches: 1 };
for (const url of [null, 'file:///fixture/Source.txt']) {
  test(`selected-number refusal advises reselection by ${url ? 'URL' : 'title'} without the stale number`, () => {
    assert.throws(() => verifyWindowIdentity({ ...target, url, windowNumber: 11, windowNumberSource: 'selection' }, {
      status: 'mismatch', error: 'Known window number disappeared',
    }), error => {
      assert.match(error.message, /Next: select_window\.$/);
      assert.doesNotMatch(error.message, /getApp|windowNumber/);
      return true;
    });
  });
}
test('a selection source changes only advice and preserves every identity check', () => {
  const current = { ...observed, windowNumber: 11 };
  for (const windowNumberSource of [undefined, 'selection']) {
    const expected = { ...target, windowNumber: 11, windowNumberSource, nativeIdentity: current };
    assert.equal(verifyWindowIdentity(expected, current), current);
    for (const change of [{ windowNumber: 77 }, { matches: 2 }, { epoch: 'helper-b' }, { window: 2 },
      { pid: 456 }, { processStart: 2000 }, { title: 'Other' }, { url: 'file:///fixture/other' }, { status: 'unknown' }]) {
      assert.throws(() => verifyWindowIdentity(expected, { ...current, ...change }), error => {
        assert.ok(error.message.endsWith(windowNumberSource === 'selection'
          ? 'Next: select_window.' : 'Next: await cua.getApp("com.apple.TextEdit").'));
        return true;
      });
      assert.equal(expected.windowNumber, 11);
      assert.equal(expected.nativeIdentity, current);
    }
  }
});
test('an unsaved window needs one native match and retains its AX reference identity', () => {
  assert.deepEqual(verifyWindowIdentity(target, observed), observed);
  for (const reply of [{ ...observed, matches: 2 }, { ...observed, matches: 0 },
    { status: 'unknown' }, { ...observed, title: 'Other' }, { ...observed, appId: 'another.app' }]) {
    assert.throws(() => verifyWindowIdentity(target, reply), /Input lease:/);
  }
});
test('same-title replacement, app restart or helper replacement cannot reuse a lease identity', () => {
  const leased = { ...target, nativeIdentity: observed };
  for (const key of ['epoch', 'window', 'pid', 'processStart']) {
    const changed = typeof observed[key] === 'number' ? observed[key] + 1 : 'changed';
    assert.throws(() => verifyWindowIdentity(leased, { ...observed, [key]: changed }), /changed/);
  }
  assert.deepEqual(verifyWindowIdentity(leased, observed), observed);
});
test('native duplicate-title identity needs an explicit number instead of guessing from focus', () => {
  const current = inspect(target, [11, 22]);
  assert.equal(current.matches, 2);
  assert.throws(() => verifyWindowIdentity(target, current), /ambiguous/);
  assert.equal(inspect({ ...target, windowNumber: 22 }, [11, 22]).windowNumber, 22);
  assert.notEqual(inspect({ ...target, windowNumber: 11 }, [11, 22]).status, 'ok');
  assert.notEqual(inspect(target, [null, null]).matches, 1, 'missing numbers remain inconclusive');
});
test('LW1: native identity reports how many windows had the header before an explicit number narrowed them', () => {
  assert.equal(inspect(target, [11, 22]).headerMatches, 2);
  assert.equal(inspect({ ...target, windowNumber: 22 }, [11, 22]).headerMatches, 2);
  assert.equal(inspect(target, [11], 0).headerMatches, 1);
  assert.equal(inspect(target, [11, 22, 33], 2).headerMatches, 3);
});
test('native identity maps AX geometry to CG numbers and detects a known number disappearing', () => {
  const selected = inspect({ ...target, windowNumber: 12 }, [null, null], 1, true);
  assert.equal(selected.matches, 1); assert.equal(selected.windowNumber, 12);
  assert.equal(inspect({ ...target, nativeIdentity: { windowNumber: 99 } }, [11, 22]).status, 'mismatch');
  assert.notEqual(inspect({ ...target, nativeIdentity: { windowNumber: 99 } }, [null, null]).status, 'mismatch');
});

test('a window without a title (Finder\'s desktop) is skipped instead of failing the identity', () => {
  const finder = { appId: 'com.apple.finder', title: 'rename-abc123', url: `file://${MAC_TMP}/x/rename-abc123/` };
  const result = inspect(finder, [11, 22], 1, false, [], (app, windows) => {
    windows[0].missing = ['AXTitle', 'AXDocument'];
    Object.assign(windows[1], { AXTitle: finder.title, AXDocument: finder.url });
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.matches, 1);
  assert.equal(inspect({ ...target, title: null }, [11], 0, false, [], (app, windows) => { windows[0].missing = ['AXTitle']; }).matches, 0);
});

test('OT2: native identity reports the matched window\'s subrole for the parent lease', () => {
  assert.equal(inspect({ ...target, windowNumber: 22 }, [11, 22], 1, false, [], (app, windows) => { windows[1].AXSubrole = 'AXStandardWindow'; }).windowSubrole, 'AXStandardWindow');
  assert.equal(inspect({ ...target, windowNumber: 22 }, [11, 22]).windowSubrole, null);
});

test('native identity includes the HID system idle duration without requesting trust', () => {
  assert.equal(inspect(target, [11, 22]).hidIdleSeconds, 12.5);
});

test('HID idle is sampled after the native reads so input during AX inspection cannot be missed', () => {
  const events = [];
  assert.equal(inspect(target, [11, 22], 1, false, events).status, 'ok');
  assert.equal(events.at(-1), 'hid');
  assert.equal(events.filter(event => event === 'hid').length, 1);
});

test('the light check after Return gets sheets and the focused element only when it asks', () => {
  const field = (window, owner = true) => owner ? { AXRole: 'AXTextField', AXWindow: window } : { AXRole: 'AXLayoutArea', AXParent: { AXRole: 'AXGroup', AXParent: window } };
  const focusOf = (request, setup) => inspect(request, [11], 0, false, [], setup).focus;
  assert.equal(focusOf(target, (app, windows) => { app.AXFocusedUIElement = field(windows[0]); }), undefined);
  const request = { ...target, focus: true };
  assert.deepEqual(focusOf(request, (app, windows, list) => { app.AXFocusedUIElement = field(windows[0]); windows[0].AXChildren = list([{ AXRole: 'AXGroup' }]); }),
    { sheets: 0, role: 'AXTextField', subrole: null, inWindow: true, inPage: false });
  assert.deepEqual(focusOf(request, (app, windows, list) => { app.AXFocusedUIElement = field(windows[0], false); windows[0].AXChildren = list([{ AXRole: 'AXSheet' }]); }),
    { sheets: 1, role: 'AXLayoutArea', subrole: null, inWindow: true, inPage: false });
  assert.deepEqual(focusOf(request, app => { app.AXFocusedUIElement = { AXRole: 'AXTextField', AXWindow: { AXRole: 'AXWindow' } }; }),
    { sheets: 0, role: 'AXTextField', subrole: null, inWindow: false, inPage: false });
  assert.deepEqual(focusOf(request, () => {}), { sheets: 0, role: null, subrole: null, inWindow: false, inPage: false });
  assert.deepEqual(focusOf(request, (app, windows) => { app.AXFocusedUIElement = { AXRole: 'AXTextField', AXSubrole: 'AXSecureTextField', AXWindow: windows[0] }; }),
    { sheets: 0, role: 'AXTextField', subrole: 'AXSecureTextField', inWindow: true, inPage: false });
  // AB1 review: a page's own field, under a web area or Gecko's HTML content, is in a page; an address field above it isn't.
  for (const page of [{ AXRole: 'AXWebArea' }, { AXRole: 'AXGroup', AXRoleDescription: 'HTML Content' }]) {
    assert.equal(focusOf(request, (app, windows) => { app.AXFocusedUIElement = { AXRole: 'AXTextField', AXWindow: windows[0],
      AXParent: { AXRole: 'AXGroup', AXParent: { ...page, AXParent: windows[0] } } }; }).inPage, true, JSON.stringify(page));
  }
  assert.equal(focusOf(request, (app, windows) => { app.AXFocusedUIElement = { AXRole: 'AXComboBox', AXWindow: windows[0],
    AXParent: { AXRole: 'AXToolbar', AXParent: windows[0] } }; windows[0].AXParent = { AXRole: 'AXWebArea' }; }).inPage, false);
});


test('pre-selection identity can read an unfocused window without weakening ordinary admission', () => {
  const requested = { ...target, windowNumber: 11 };
  assert.equal(inspect(requested, [11, 22]).status, 'mismatch');
  const result = inspect({ ...requested, allowUnfocused: true }, [11, 22]);
  assert.equal(result.status, 'ok');
  assert.equal(result.windowNumber, 11);
  assert.equal(inspect({ ...target, allowUnfocused: true }, [11, 22]).matches, 2);
});

// DPh: the smoke's AppInfo has neither pid nor windows. The native proof must
// select the leased process and inspect metadata without reading document fields.
const closeRequest = { appId: target.appId, closeCount: true, nativeIdentity: { pid: 123, processStart: 1 } };
test('DPo distinguishes a dead leased pid from a reused pid before and after the AX query', () => {
  for (const afterAX of [false, true]) for (const kind of ['absent', 'terminated', 'reused']) {
    const events = [];
    const result = inspect(closeRequest, [], 0, false, events, (app, windows, list, runtime) => {
      const change = () => {
        if (kind === 'absent') runtime.apps = [];
        if (kind === 'terminated') runtime.running.terminated = true;
        if (kind === 'reused') runtime.running.launchDate.timeIntervalSince1970 = 2;
      };
      if (afterAX) runtime.onRead = change;
      else change();
    });
    assert.equal(result.status, kind === 'reused' ? 'unknown' : 'ok', `${kind} afterAX=${afterAX}`);
    assert.equal(result.pid, 123);
    assert.equal(result.processStart, kind === 'reused' ? 2 : 1);
    if (kind === 'reused') assert.equal(result.unknownReason, 'process-changed');
    else assert.equal(result.running, false);
    if (!afterAX) assert.ok(!events.includes('AXWindows'));
  }
});
test('DPm distinguishes the closing AX reference from a remaining window without activating the app', () => {
  for (const remove of [false, true]) {
    const events = [];
    const result = inspect(closeRequest, [11, 12], 0, false, events, (app, windows, list, runtime) => {
      runtime.seedWindowIdentity = true;
      runtime.afterBaseline = () => {
        if (remove) app.AXWindows = list(windows.slice(1));
        events.length = 0;
      };
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.windowCount, remove ? 1 : 2);
    assert.equal(result.closedWindowPresent, !remove);
    assert.ok(!events.some(name => /Title|Document|Value|Description/.test(String(name))), events.join(','));
  }
});
test('DPp counts modal children only under the retained closing target', () => {
  for (const modalWindow of [0, 1]) for (const modal of [
    { AXRole: 'AXSheet' }, { AXRole: 'AXWindow', AXSubrole: 'AXDialog' },
    { AXRole: 'AXWindow', AXSubrole: 'AXSystemDialog' }, { AXRole: 'AXWindow', AXModal: true },
  ]) {
    const events = [];
    const reply = inspect(closeRequest, [11, 12], 0, false, events, (app, windows, list, runtime) => {
      runtime.seedWindowIdentity = true;
      runtime.afterBaseline = () => {
        windows[modalWindow].AXChildren = list([modal]);
        events.length = 0;
      };
    });
    assert.equal(reply.status, 'ok');
    assert.equal(reply.closedWindowPresent, true);
    assert.equal(reply.windowCount, 2);
    assert.equal(reply.modalCount, modalWindow === 0 ? 1 : 0);
    assert.ok(!events.some(name => /Title|Document|Value|Description/.test(String(name))), events.join(','));
  }
});
test('DPr target sheet checks do not descend into document children', () => {
  for (const sheet of [false, true]) {
    const events = [];
    const reply = inspect(closeRequest, [11], 0, false, events, (app, windows, list, runtime) => {
      runtime.seedWindowIdentity = true;
      runtime.afterBaseline = () => {
        const document = { AXRole: 'AXGroup', get AXChildren() { throw Error('document traversal'); } };
        windows[0].AXChildren = list([document, ...(sheet ? [{ AXRole: 'AXSheet' }] : [])]);
        events.length = 0;
      };
    });
    assert.equal(reply.status, 'ok');
    assert.equal(reply.modalCount, sheet ? 1 : 0);
    assert.equal(events.filter(name => name === 'AXChildren').length, 1);
  }
});
test('DPh counts AXWindows on the leased running pid without reading titles or documents', () => {
  const events = [];
  const reply = inspect(closeRequest, [], 0, false, events, (app, windows, list, runtime) => {
    app.AXChildren = list([{ AXRole: 'AXMenuBar', AXChildren: list([]) }]);
    runtime.apps.push({ ...runtime.running, processIdentifier: 456 });
  });
  assert.equal(reply.status, 'ok');
  assert.equal(reply.pid, 123);
  assert.equal(reply.processStart, 1);
  assert.equal(reply.running, true);
  assert.equal(reply.windowCount, 0);
  assert.equal(reply.modalCount, 0);
  assert.ok(events.includes('AXWindows'));
  assert.ok(!events.some(name => /Title|Document|Value|Description/.test(String(name))), events.join(','));
});

const orderedOut = Array.from({ length: 6 }, (_, i) => ({ kCGWindowOwnerPID: 123, kCGWindowLayer: 0, kCGWindowNumber: 100 + i }));
const noSpaces = Object.fromEntries(orderedOut.map(row => [row.kCGWindowNumber, []]));
test('DPk reports a fixed reason when native close counts fail instead of losing the exception', () => {
  for (const [reason, change] of [
    ['cgs-unbound', runtime => { runtime.bindThrows = true; }],
    ['cgs-error', runtime => { runtime.onSpace = () => { throw Error('private query error'); }; }],
    ['cgs-invalid', runtime => { runtime.spaces = { 100: null }; }],
    ['cgs-invalid', runtime => { runtime.connection = 0; }],
    ['predicate-error', runtime => { runtime.predicateThrows = true; }],
    ['cg-invalid', runtime => { runtime.cgWindows = [{ kCGWindowOwnerPID: 123 }]; }],
    ['deadline', runtime => { runtime.clockMs = 0; runtime.onSpace = () => { runtime.clockMs = 150; }; }],
    ['deadline', runtime => { runtime.clockMs = 0; runtime.onRead = () => { runtime.clockMs = 150; }; }],
  ]) {
    const reply = inspect(closeRequest, [], 0, false, [], (app, windows, list, runtime) => {
      runtime.cgWindows = [...orderedOut]; runtime.spaces = noSpaces; change(runtime);
    });
    assert.equal(reply.status, 'unknown');
    assert.equal(reply.unknownReason, reason);
    assert.ok(!JSON.stringify(reply).includes('private'));
  }
});
test('DPj ignores six ordered-out CG windows after the last AX window closes', () => {
  const events = [];
  const reply = inspect(closeRequest, [], 0, false, events, (app, windows, list, runtime) => {
    runtime.cgWindows = [...orderedOut, { kCGWindowLayer: 0 }, { kCGWindowOwnerPID: 456, kCGWindowLayer: 0 }];
    runtime.spaces = noSpaces;
  });
  assert.equal(reply.status, 'ok');
  assert.equal(reply.windowCount, 0);
  assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'spaces').length, 6);
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'predicate' &&
    event[1].includes('kCGWindowOwnerPID == %@') && event[1].includes('kCGWindowLayer <= 23') && event[2] === 123));
  assert.ok(!events.some(event => /Name|Title|Bounds|Alpha|Onscreen/.test(String(event))));
});
test('DPj counts another-Space documents, floating panels and standalone alerts on layers 0 through 23', () => {
  for (const layer of [0, 3, 8, 23]) {
    const events = [];
    const result = inspect(closeRequest, [], 0, false, events, (app, windows, list, runtime) => {
      runtime.cgWindows = [...orderedOut, { kCGWindowOwnerPID: 123, kCGWindowLayer: layer, kCGWindowNumber: 200 }];
      runtime.spaces = { ...noSpaces, 200: [5] };
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.windowCount, 1, `layer ${layer}`);
    assert.ok(events.some(event => Array.isArray(event) && event[0] === 'cg' && event[1] === 16));
  }
  const excluded = inspect(closeRequest, [], 0, false, [], (app, windows, list, runtime) => {
    runtime.cgWindows = [-1, 24].map(layer => ({ kCGWindowOwnerPID: 123, kCGWindowLayer: layer }));
  });
  assert.equal(excluded.windowCount, 0);
});
test('DPj failed or unknown CG and Space lookups keep the proof unknown within the 150 ms deadline', () => {
  for (const setup of [
    (app, windows, list, runtime) => { runtime.cgUnavailable = true; },
    (app, windows, list, runtime) => { runtime.cgWindows = [{ kCGWindowOwnerPID: 123 }]; },
    (app, windows, list, runtime) => { runtime.clockMs = 0; runtime.onRead = () => { runtime.clockMs = 150; }; },
    ...[
      runtime => { runtime.spaces = {}; },
      runtime => { runtime.spaces = { ...noSpaces, 100: null }; },
      runtime => { runtime.spaces = { ...noSpaces, 100: 'unknown' }; },
      runtime => { runtime.bindThrows = true; },
      runtime => { runtime.connection = 0; },
      runtime => { runtime.cgWindows[0] = { kCGWindowOwnerPID: 123, kCGWindowLayer: 0 }; },
      runtime => { runtime.onSpace = () => { throw Error('lookup failed'); }; },
      runtime => { runtime.clockMs = 0; runtime.onSpace = () => { runtime.clockMs = 150; }; },
    ].map(change => (app, windows, list, runtime) => {
      runtime.cgWindows = [...orderedOut]; runtime.spaces = noSpaces; change(runtime);
    }),
  ]) assert.notEqual(inspect(closeRequest, [], 0, false, [], setup).status, 'ok');
});
test('DPh reports remaining windows and sheet or dialog descendants', () => {
  assert.equal(inspect(closeRequest, [11], 0).windowCount, 1);
  for (const node of [{ AXRole: 'AXSheet' }, { AXRole: 'AXWindow', AXSubrole: 'AXDialog' },
    { AXRole: 'AXWindow', AXSubrole: 'AXSystemDialog' }, { AXRole: 'AXWindow', AXModal: true }]) {
    const reply = inspect(closeRequest, [], 0, false, [], (app, windows, list) => {
      app.AXChildren = list([{ AXRole: 'AXGroup', AXChildren: list([node]) }]);
    });
    assert.equal(reply.windowCount, 0);
    assert.equal(reply.modalCount, 1, JSON.stringify(node));
  }
});
test('DPh keeps native uncertainty for missing windows, restarted processes and incomplete children', () => {
  const cases = [
    (app, windows, list, runtime) => { runtime.trusted = false; },
    (app, windows, list, runtime) => { runtime.timeoutError = -25205; },
    (app, windows, list) => { app.AXChildren = list([{ AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow' }]); },
    (app, windows, list) => {
      let node = { AXRole: 'AXGroup' };
      for (let i = 0; i < 10; i++) node = { AXRole: 'AXGroup', AXChildren: list([node]) };
      app.AXChildren = list([node]);
    },
    (app, windows, list, runtime) => { runtime.running.launchDate.timeIntervalSince1970 = 2; },
    (app, windows, list, runtime) => { runtime.running.bundleIdentifier = 'other.app'; },
    app => { app.missing = ['AXWindows']; },
    app => { app.AXWindows = null; },
    app => { app.missing = ['AXChildren']; },
    (app, windows, list) => { app.AXChildren = list(Array.from({ length: 65 }, () => ({ AXRole: 'AXGroup' }))); },
  ];
  for (const setup of cases) assert.notEqual(inspect(closeRequest, [], 0, false, [], setup).status, 'ok');
  assert.notEqual(inspect({ ...closeRequest, nativeIdentity: { pid: 123 } }, [], 0).status, 'ok');
});

test('DPh does not traverse menu contents when a windowless app exposes its menu bar', () => {
  const reply = inspect(closeRequest, [], 0, false, [], (app, windows, list) => {
    app.AXChildren = list([{ AXRole: 'AXMenuBar', AXChildren: list(Array.from({ length: 65 }, () => ({ AXRole: 'AXMenuBarItem' }))) }]);
  });
  assert.equal(reply.status, 'ok');
  assert.equal(reply.windowCount, 0);
  assert.equal(reply.modalCount, 0);
});

// AD3 uses the real helper in a VM; only the OS metadata calls are faked.
const cursor = { appId: 'com.todesktop.230313mzl4w4u92', title: 'sleight', url: null };
function mac27(request = cursor, numbers = [null], focused = 0, setup = () => {}) {
  return inspect(request, numbers, focused, true, [], (app, windows, list, runtime) => {
    runtime.running.bundleIdentifier = cursor.appId;
    for (const window of windows) {
      window.AXTitle = 'sleight'; window.missing = ['AXWindowNumber', 'AXDocument'];
    }
    setup(app, windows, list, runtime);
  });
}
test('AD3 single macOS 27 window binds the server number, pid and process start', () => {
  const reply = mac27();
  assert.equal(reply.status, 'ok'); assert.equal(reply.windowNumber, 11);
  assert.equal(reply.pid, 123); assert.equal(reply.processStart, 1);
  assert.equal(verifyWindowIdentity(cursor, reply), reply);
});
test('AD3 equal-title replacement with a retained AX object but a new server number refuses', () => {
  const baseline = { ...observed, windowNumber: 11 };
  assert.throws(() => verifyWindowIdentity({ ...target, nativeIdentity: baseline },
    { ...baseline, windowNumber: 12 }), /changed/);
});
test('AD3 recycled pid with a new launch time refuses', () => {
  const baseline = mac27();
  const replacement = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => {
    runtime.running.launchDate.timeIntervalSince1970 = 2;
  });
  assert.throws(() => verifyWindowIdentity({ ...cursor, nativeIdentity: baseline }, replacement), /changed/);
});
test('AD3 same-title server windows stay ambiguous without an explicit number', () => {
  const reply = mac27(cursor, [null, null], 1);
  assert.throws(() => verifyWindowIdentity(cursor, reply), /ambiguous|unavailable/);
});
test('AD3 unreadable server list cannot certify even a readable AX number', () => {
  const reply = mac27(cursor, [11], 0, (_app, _windows, _list, runtime) => { runtime.cgUnavailable = true; });
  assert.throws(() => verifyWindowIdentity(cursor, reply), /unavailable/);
});
test('AD3 missing AXDocument uses server identity but a readable conflicting document refuses', () => {
  const request = { ...cursor, url: 'file:///synthetic/example.txt' };
  assert.equal(verifyWindowIdentity(request, mac27(request)).windowNumber, 11);
  const conflict = mac27(request, [null], 0, (_app, windows) => {
    windows[0].missing = ['AXWindowNumber']; windows[0].AXDocument = 'file:///synthetic/other.txt';
  });
  assert.throws(() => verifyWindowIdentity(request, conflict), /ambiguous|unavailable/);
});
test('AD3 server title must corroborate pid and geometry', () => {
  const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => { runtime.cgTitle = 'Other'; });
  assert.throws(() => verifyWindowIdentity(cursor, reply), /unavailable/);
});

test('AD3 server matching rejects missing titles, invalid numbers, wrong owners and conflicting bounds', () => {
  const row = { kCGWindowOwnerPID: 123, kCGWindowLayer: 0, kCGWindowNumber: 11, kCGWindowName: 'sleight',
    kCGWindowBounds: { X: 0, Y: 20, Width: 300, Height: 200 } };
  for (const rows of [[{ ...row, kCGWindowName: undefined }], [{ ...row, kCGWindowNumber: null }],
    [{ ...row, kCGWindowOwnerPID: 456 }], [{ ...row, kCGWindowBounds: { ...row.kCGWindowBounds, X: 1 } }],
    [row, { ...row, kCGWindowNumber: 12 }]]) {
    const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => { runtime.cgWindows = rows; });
    assert.throws(() => verifyWindowIdentity(cursor, reply), /unavailable/);
  }
});
test('AD3 a restart during the metadata sample cannot certify either process', () => {
  const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => {
    runtime.onRead = name => { if (name === 'AXSubrole') runtime.running.launchDate.timeIntervalSince1970 = 2; };
  });
  assert.throws(() => verifyWindowIdentity(cursor, reply), /changed/);
});

const serverRow = (more = {}) => ({ kCGWindowOwnerPID: 123, kCGWindowLayer: 0, kCGWindowNumber: 11,
  kCGWindowName: 'sleight', kCGWindowBounds: { X: 0, Y: 20, Width: 300, Height: 200 }, ...more });
test('AD3X only layer zero can certify a matching title and bounds', () => {
  for (const layer of [-1, 1, 3, 23]) {
    const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => {
      runtime.cgWindows = [serverRow({ kCGWindowLayer: layer })];
    });
    assert.equal(reply.status, 'unknown');
    assert.equal(reply.error, 'Window server identity unavailable');
  }
});
test('AD3X off-screen and minimized duplicates still prevent server certification', () => {
  for (const extra of [{ kCGWindowIsOnscreen: false }, { kCGWindowIsOnscreen: 0, minimized: true }]) {
    const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => {
      runtime.cgWindows = [serverRow(), serverRow({ ...extra, kCGWindowNumber: 12 })];
    });
    assert.equal(reply.status, 'unknown');
    assert.equal(reply.error, 'Window server identity unavailable');
  }
});
test('AD3X a different-bounds duplicate cannot move input off the bound window', () => {
  const baseline = mac27();
  const expected = { ...cursor, nativeIdentity: baseline };
  assert.equal(verifyWindowIdentity(expected, mac27(expected, [null, null], 0)).windowNumber, 11);
  const movedFocus = mac27(expected, [null, null], 1);
  assert.equal(movedFocus.status, 'mismatch');
  assert.equal(movedFocus.error, 'Focused window differs');
});
test('AD3X Foundation filters machine rows before bridging and reuses each window number', t => {
  const events = [];
  const reply = inspect({ ...target, windowNumber: 11 }, [11], 0, false, events, (_app, _windows, _list, runtime) => {
    runtime.cgWindows = [serverRow({ kCGWindowName: 'Untitled' }),
      ...Array.from({ length: 1000 }, (_, i) => serverRow({ kCGWindowOwnerPID: 456 + i })),
      serverRow({ kCGWindowLayer: 3 })];
  });
  assert.equal(reply.windowNumber, 11);
  assert.equal(events.filter(e => e === 'cg-row').length, 1);
  assert.equal(events.filter(e => e === 'AXWindowNumber').length, 1);
  for (const name of ['AXPosition', 'AXSize']) assert.equal(events.filter(e => e === name).length, 1);
  assert.equal(events.filter(e => e === 'kCGWindowOwnerPID').length, 0);
  assert.equal(events.filter(e => Array.isArray(e) && e[0] === 'cg').length, 1);
  t.diagnostic('1002 machine rows, 1 bridged row, 1 AX number/position/size read');
});
test('AD3X JXA BOOL process liveness accepts boolean and numeric representations', () => {
  for (const terminated of [false, 0, { boxedScalar: 0 }]) {
    const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => { runtime.running.terminated = terminated; });
    assert.equal(reply.status, 'ok'); assert.equal(reply.matches, 1);
  }
  for (const terminated of [true, 1, { boxedScalar: 1 }]) {
    const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => { runtime.running.terminated = terminated; });
    assert.equal(reply.status, 'mismatch'); assert.equal(reply.error, 'Window owner process changed during inspection');
  }
  for (const terminated of [undefined, null, '0', 'false', 2, {}, []]) {
    const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => { runtime.running.terminated = terminated; });
    assert.equal(reply.status, 'unknown'); assert.equal(reply.error, 'Window owner terminated invalid');
  }
});
test('AD3X JXA isNil supports methods and scalar BOOLs and rejects wrong shapes', () => {
  for (const owner of [false, true]) {
    for (const isNil of [undefined, false, 0, () => false, () => 0]) {
      const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => {
        Object.assign(owner ? runtime.running : (runtime.cgListShape = {}), { isNil });
      });
      assert.equal(reply.status, 'ok', `owner=${owner}`);
    }
    for (const isNil of [true, 1, () => true, () => 1]) {
      const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => {
        Object.assign(owner ? runtime.running : (runtime.cgListShape = {}), { isNil });
      });
      assert.equal(reply.status, owner ? 'mismatch' : 'unknown');
      assert.equal(reply.error, owner ? 'Window owner process changed during inspection' : 'Window server list unavailable');
    }
    for (const isNil of [null, '0', 2, {}, () => undefined, () => 'false', () => { throw Error('synthetic bridge'); }]) {
      const reply = mac27(cursor, [null], 0, (_app, _windows, _list, runtime) => {
        Object.assign(owner ? runtime.running : (runtime.cgListShape = {}), { isNil });
      });
      assert.equal(reply.status, 'unknown');
      assert.equal(reply.error, (owner ? 'Window owner' : 'Window server list') + ' isNil invalid');
    }
  }
});
test('AD3X AXWindowNumber scalar unwraps NSNumber and refuses malformed or conflicting values', () => {
  for (const value of [11, { boxedScalar: 11 }]) {
    const reply = inspect(target, [value], 0, true);
    assert.equal(reply.status, 'ok'); assert.equal(reply.windowNumber, 11);
  }
  for (const value of ['11', {}, [11], true, 0, -1, 1.5]) {
    const reply = inspect(target, [value], 0, true);
    assert.equal(reply.status, 'unknown'); assert.equal(reply.error, 'AXWindowNumber invalid');
  }
  const conflict = inspect(target, [12], 0, true);
  assert.equal(conflict.status, 'unknown'); assert.equal(conflict.error, 'AXWindowNumber differs from Window server');
});
test('AD3X metadata-only close counts share the BOOL and nil validation', () => {
  for (const terminated of [false, 0, true, 1]) {
    const reply = inspect(closeRequest, [], 0, false, [], (_app, _windows, _list, runtime) => {
      runtime.running.terminated = terminated; runtime.running.isNil = 0;
    });
    assert.equal(reply.status, 'ok'); assert.equal(reply.running, !terminated);
  }
  for (const [key, value, reason] of [['terminated', '0', 'process-state'], ['terminated', undefined, 'process-state'],
    ['isNil', 'false', 'process-nil'], ['isNil', () => undefined, 'process-nil']]) {
    const reply = inspect(closeRequest, [], 0, false, [], (_app, _windows, _list, runtime) => { runtime.running[key] = value; });
    assert.equal(reply.status, 'unknown'); assert.equal(reply.unknownReason, reason);
  }
  const badList = inspect(closeRequest, [], 0, false, [], (_app, _windows, _list, runtime) => {
    runtime.cgListShape = { isNil: 2 };
  });
  assert.equal(badList.status, 'unknown'); assert.equal(badList.unknownReason, 'cg-invalid');
});
