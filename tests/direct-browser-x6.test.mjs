import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { utilityLocator } from './direct-browser-utility-fixture.mjs';

function fixture(options = {}) {
  const page = new EventEmitter(), events = [], snapshots = [];
  let time = 0, number = 1, closed = false;
  const schedule = (at, fn) => events.push({ at, fn });
  const sleep = async ms => {
    const until = time + ms;
    events.sort((a, b) => a.at - b.at);
    while (events[0]?.at <= until) { const event = events.shift(); time = event.at; event.fn(); }
    time = until;
  };
  page.url = () => { if (closed) throw Error('page closed'); return 'https://fixture.invalid/'; };
  page.isClosed = () => closed;
  page.mainFrame = () => page;
  page.evaluate = async () => sleep(16);
  page.waitForLoadState = async state => { assert.equal(state, 'domcontentloaded'); await sleep(200); };
  page.context = () => ({ newCDPSession: async () => ({ send: async () => ({ result: { value: [1000, 800] } }), detach: async () => {} }) });
  page.setViewportSize = async () => {};
  page.goBack = page.goForward = async () => {};
  page.mouse = { wheel: async () => {} };
  page.getByRef = () => utilityLocator({ evaluate: async fn => fn.name === 'inspectTarget' ? {} : null,
    click: async () => { closed = true; page.emit('close'); throw Error('Target page has been closed'); } });
  const tab = { page, state: { snapshotNo: 1 } };
  const snapshot = async p => { snapshots.push([p, time]); return { text: 'snapshot', number: ++number }; };
  const run = createActionRunner({ check: () => 'allow', snapshot, now: () => time, sleep, ...options });
  return { page, tab, run, snapshot, snapshots, schedule, sleep, time: () => time };
}

for (const step of [{ do: 'viewport', width: 390, height: 844 }, { do: 'scroll', dy: 500 }, { do: 'back' }, { do: 'forward' }]) {
  test(`${step.do} without activity finishes at a frame and skips an unrequested snapshot`, async () => {
    const f = fixture();
    const result = await f.run(f.tab, [step], {}, { observe: 'none' });
    assert.equal(result.stoppedAt, null, result.lines.join('\n'));
    assert.ok(f.time() < 150, `settle took ${f.time()} ms`);
    assert.equal(result.observe, undefined);
    assert.equal(f.snapshots.length, 0);
  });
  test(`${step.do} waits for requests it starts, including one started on the next frame`, async () => {
    const f = fixture(), request = { resourceType: () => 'fetch' };
    f.schedule(10, () => f.page.emit('request', request));
    f.schedule(800, () => f.page.emit('requestfinished', request));
    const result = await f.run(f.tab, [step], {});
    assert.equal(result.stoppedAt, null, result.lines.join('\n'));
    assert.ok(f.snapshots[0][1] >= 800, `snapshot at ${f.snapshots[0][1]} ms`);
    assert.equal(f.page.listenerCount('request'), 0);
  });
}

test('wait ms ends after 150 ms of quiet instead of sleeping its whole duration', async () => {
  const f = fixture();
  await f.run(f.tab, [{ do: 'wait', ms: 3000 }], {}, { observe: 'none' });
  assert.equal(f.time(), 150);
  assert.equal(f.snapshots.length, 0);
});

test('wait ms cannot return before a pending request even past the requested duration', async () => {
  const f = fixture(), request = { resourceType: () => 'image' };
  f.schedule(50, () => f.page.emit('request', request));
  f.schedule(900, () => f.page.emit('requestfinished', request));
  const result = await f.run(f.tab, [{ do: 'wait', ms: 200 }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.ok(f.snapshots[0][1] >= 900);
});

test('wait carries a request from the preceding click instead of declaring the page quiet', async () => {
  const f = fixture(), request = { resourceType: () => 'fetch' };
  f.page.getByRef = () => utilityLocator({ evaluate: async () => ({}), click: async () => f.page.emit('request', request) });
  f.schedule(1200, () => f.page.emit('requestfinished', request));
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'wait', ms: 3000 }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.ok(f.snapshots[0][1] >= 1200);
});

for (const pending of [false, true]) test(`an owned background popup ends the batch without a popup event, pending request: ${pending}`, async t => {
  const f = fixture(), request = { resourceType: () => 'document' };
  f.tab.popups = [];
  let inputs = 0;
  const boundaries = [];
  f.page.getByRef = () => utilityLocator({ evaluate: async () => ({}), click: async () => {
    inputs++;
    // The registry creates target=_blank destinations itself in the background.
    // That path publishes an owned handle without emitting page.popup.
    f.tab.popups.push({ tab: 'tchild', opener: 'tparent' });
    if (pending) f.page.emit('request', request);
  } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'wait', ms: 500 },
    { do: 'click', ref: 'e2' }], {}, { observe: 'none', onStep: event => boundaries.push(event.boundary) });
  t.diagnostic(`simulated settle/wait time: ${f.time()} ms; input calls: ${inputs}`);
  assert.equal(result.stoppedAt, 1, result.lines.join('\n'));
  assert.match(result.lines[0], /opened background tab tchild/);
  assert.match(result.lines[1], /not reached/);
  assert.match(result.lines[2], /not reached/);
  assert.equal(inputs, 1);
  assert.deepEqual(boundaries, ['popup'], 'control memory must forget the previous opener at this boundary');
  assert.ok(result.observe, 'the boundary must return the opener read even with observe:none');
  assert.equal(f.time(), 0, 'the observed popup needs no extra settle timer or following wait');
  assert.equal(f.page.listenerCount('request'), 0);
});

test('a registry popup observed during settling ends that wait early', async () => {
  const f = fixture();
  f.tab.popups = [];
  f.page.getByRef = () => utilityLocator({ evaluate: async () => ({}), click: async () => {
    f.schedule(125, () => f.tab.popups.push({ tab: 'tchild', opener: 'tparent' }));
  } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'wait', ms: 500 }], {});
  assert.equal(result.stoppedAt, 1, result.lines.join('\n'));
  assert.ok(f.time() >= 125 && f.time() < 600, `settle took ${f.time()} ms`);
  assert.match(result.lines[1], /not reached/);
});

test('a late registry popup also ends a numeric wait with an active request', async () => {
  const f = fixture();
  f.tab.popups = [];
  f.schedule(10, () => f.page.emit('request', { resourceType: () => 'fetch' }));
  f.schedule(125, () => f.tab.popups.push({ tab: 'tchild' }));
  const result = await f.run(f.tab, [{ do: 'wait', ms: 500 }, { do: 'click', ref: 'e2' }], {}, { observe: 'none' });
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[0], /opened background tab tchild/);
  assert.match(result.lines[1], /not reached/);
  assert.ok(f.time() >= 125 && f.time() < 500, `wait took ${f.time()} ms`);
  assert.ok(result.observe);
});

for (const condition of ['until', 'gone', 'url']) for (const event of [false, true])
  test(`a popup during wait ${condition} is named in the outcome (event=${event})`, async () => {
    let f, opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      if (event) f.page.emit('popup', { url: () => 'https://child.invalid/', isClosed: () => false });
      else f.tab.popups.push({ tab: 'tchild' });
    };
    f = fixture({ snapshot: async () => { open(); return { text: '- text "ready"', number: 2 }; } });
    f.tab.popups = [];
    if (condition === 'url') f.page.url = () => { open(); return 'https://fixture.invalid/ready'; };
    const result = await f.run(f.tab, [{ do: 'wait', [condition]: condition === 'gone' ? 'missing' : 'ready' },
      { do: 'click', ref: 'e2' }], {}, { observe: 'none' });
    assert.equal(result.stoppedAt, 1);
    assert.match(result.lines[0], /wait condition met.*opened background tab/);
    if (!event) assert.match(result.lines[0], /tchild/);
    assert.match(result.lines[1], /not reached/);
    assert.ok(result.observe);
  });

for (const notice of [{ tab: 'tchild' }, { tab: 'tchild', closed: true }, { blocked: true }])
  test(`a registry popup between carried type steps stops before the next input (${JSON.stringify(notice)})`, async () => {
    const f = fixture();
    f.tab.popups = [];
    let reads = 0, inputs = 0;
    const boundaries = [];
    f.page.getByRef = () => utilityLocator({ evaluate: async () => {
      if (++reads === 2) f.tab.popups.push(notice);
      return {};
    }, fill: async () => { inputs++; } });
    const result = await f.run(f.tab, [1, 2, 3].map(n => ({ do: 'type', ref: 'e' + n, text: 'fixture' })), {},
      { onStep: event => boundaries.push(event.boundary) });
    assert.equal(inputs, 1, result.lines.join('\n'));
    assert.equal(result.stoppedAt, 2);
    assert.match(result.lines[1], notice.blocked ? /blocked/i : notice.closed ? /closed itself/ : /opened background tab tchild/);
    assert.match(result.lines[2], /not reached/);
    assert.deepEqual(boundaries, [undefined, 'popup']);
    assert.equal(f.page.listenerCount('request'), 0);
  });

test('a self-closed registry popup is reported without an open tab handle', async () => {
  const f = fixture();
  f.tab.popups = [];
  f.page.getByRef = () => utilityLocator({ evaluate: async () => ({}), click: async () => {
    f.tab.popups.push({ tab: 'tchild', closed: true });
  } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'wait', ms: 500 }], {});
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[0], /opened background tab that closed itself; opener below/);
  assert.doesNotMatch(result.lines[0], /tchild/);
  assert.match(result.lines[1], /not reached/);
});

test('a consent-decline click that opens a registry popup leaves the decline unverified', async () => {
  const f = fixture();
  f.tab.popups = [];
  let inputs = 0, released = 0;
  const locator = utilityLocator({ evaluate: async () => ({}), click: async () => {
    inputs++; f.tab.popups.push({ tab: 'tchild' });
  } });
  const base = locator._connection.toImpl;
  locator._connection.toImpl = handle => {
    const node = base(handle), context = node._frame.utilityContext;
    node._frame.utilityContext = async () => {
      const utility = await context();
      return { ...utility, evaluateExpression: async (source, options, args) => {
        if (source.startsWith('([el, arg]) => { return (function inspectConsent(')) {
          assert.equal(args[1], undefined, 'a popup must not attempt to confirm the wall closure');
          return { wall: true, decline: true };
        }
        return utility.evaluateExpression(source, options, args);
      }, evaluateExpressionHandle: async () => ({ dispose: async () => { released++; } }) };
    };
    return node;
  };
  f.page.getByRef = () => locator;
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }], {});
  assert.equal(inputs, 1);
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[0], /Decline unverified.*opened background tab tchild/);
  assert.doesNotMatch(result.lines[0], /Decline confirmed/);
  assert.equal(released, 1);
  assert.equal(f.tab.state.consentObservation, undefined);
});

test('an earlier popup does not stop an unrelated later batch', async () => {
  const f = fixture();
  f.tab.popups = [{ tab: 'told', opener: 'tparent' }];
  let inputs = 0;
  f.page.getByRef = () => utilityLocator({ evaluate: async () => ({}), click: async () => {
    inputs++;
  } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }], {});
  assert.equal(inputs, 2);
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
});

for (const notice of [{ blocked: true }, { tab: 'tblocked', blocked: true }])
  test(`a new blocked-endpoint popup ends the batch (${JSON.stringify(notice)})`, async () => {
    const f = fixture();
    f.tab.popups = [];
    let inputs = 0;
    f.page.getByRef = () => utilityLocator({ evaluate: async () => ({}), click: async () => {
      inputs++; f.tab.popups.push(notice);
    } });
    const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }], {}, { observe: 'none' });
    assert.equal(inputs, 1);
    assert.equal(result.stoppedAt, 1);
    assert.match(result.lines[0], /blocked/i);
    assert.match(result.lines[1], /not reached/);
    assert.ok(result.observe);
  });

test('a short step caps a streaming fetch and returns a read without an input failure', async () => {
  const f = fixture();
  f.schedule(10, () => f.page.emit('request', { resourceType: () => 'fetch' }));
  const result = await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }, { do: 'forward' }], {}, { observe: 'none' });
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[0], /activity still pending.*cap/);
  assert.doesNotMatch(result.lines.join('\n'), /effect unconfirmed/);
  assert.match(result.lines[1], /not reached/);
  assert.ok(f.time() >= 1500 && f.time() < 1600, `settle took ${f.time()} ms`);
  assert.ok(result.observe);
  assert.equal(f.page.listenerCount('request'), 0);
});

for (const step of [{ do: 'viewport', width: 390, height: 844 }, { do: 'scroll', dy: 500 }, { do: 'back' }, { do: 'forward' }]) {
  test(`${step.do} falls back to a host timer when the page never renders a frame`, async () => {
    const f = fixture({ actionTimeoutMs: 50 });
    f.page.evaluate = () => new Promise(() => {});
    const result = await f.run(f.tab, [step], {}, { observe: 'none' });
    assert.equal(result.stoppedAt, null, result.lines.join('\n'));
    assert.doesNotMatch(result.lines.join('\n'), /unconfirmed/);
  });
}

test('an unconfirmed submit keeps the full next-call wait before reading the old page', async () => {
  const f = fixture(), request = { resourceType: () => 'fetch' };
  f.page.getByRef = () => utilityLocator({ evaluate: async fn => fn.name === 'inspectTarget' ? { submit: true } : null,
    click: async () => f.page.emit('request', request) });
  const submitted = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {}, { observe: 'none' });
  assert.match(submitted.lines[0], /submit unconfirmed/);
  assert.ok(f.tab.state.submitUnconfirmed);
  const start = f.time();
  f.schedule(start + 2000, () => f.page.emit('requestfinished', request));
  const waited = await f.run(f.tab, [{ do: 'wait', ms: 3000 }], {});
  assert.ok(f.time() >= start + 3000, `wait ended at ${f.time() - start} ms`);
  assert.match(waited.lines[0], /page quiet after 3000 ms/);
  assert.ok(f.snapshots[0][1] >= start + 3000);
});

for (const type of ['eventsource', 'ping', 'websocket', 'media', 'other']) test(`a persistent ${type} does not delay a no-input step`, async () => {
  const f = fixture();
  f.schedule(10, () => f.page.emit('request', { resourceType: () => type }));
  const result = await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.ok(f.time() < 150, `settle took ${f.time()} ms`);
});

for (const type of ['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image']) test(`a no-input step waits for ${type} completion`, async () => {
  const f = fixture(), request = { resourceType: () => type };
  f.schedule(10, () => f.page.emit('request', request));
  f.schedule(350, () => f.page.emit('requestfinished', request));
  const result = await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.ok(f.snapshots[0][1] >= 350);
});

test('the frame fallback retains the navigation boundary race', async () => {
  const f = fixture();
  f.page.evaluate = async () => { f.page.emit('framenavigated', f.page); throw Error('context destroyed'); };
  const result = await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }], {});
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[0], /navigated/);
  assert.doesNotMatch(result.lines[0], /unconfirmed/);
});

test('a quiet wait reports its elapsed quiet time', async () => {
  const f = fixture();
  const result = await f.run(f.tab, [{ do: 'wait', ms: 3000 }], {}, { observe: 'none' });
  assert.match(result.lines[0], /page quiet after 150 ms/);
});

test('an unconfirmed submit keeps the wait cap and reports it', async () => {
  const f = fixture();
  f.tab.state.submitUnconfirmed = { startedAt: 0 };
  const result = await f.run(f.tab, [{ do: 'wait', ms: 10000 }], {});
  assert.equal(f.time(), 5000);
  assert.match(result.lines[0], /page quiet after 5000 ms \(cap\)/);
});

test('observe none explicitly loses click change counts without taking a comparison snapshot', async () => {
  const f = fixture();
  f.page.getByRef = () => utilityLocator({ evaluate: async () => ({}), click: async () => {} });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {}, { observe: 'none' });
  assert.equal(result.lines[0], '1 click e1: input sent');
  assert.equal(f.snapshots.length, 0);
  assert.equal(result.observe, undefined);
});

test('history load waiting has a usable timeout even when commit uses the step deadline', async () => {
  const f = fixture();
  f.page.goBack = async () => { await f.sleep(6990); f.page.emit('framenavigated', f.page); };
  f.page.waitForLoadState = async (state, { timeout }) => {
    assert.equal(state, 'domcontentloaded');
    assert.ok(timeout >= 1000, `load timeout was ${timeout} ms`);
  };
  const result = await f.run(f.tab, [{ do: 'back' }], {});
  assert.doesNotMatch(result.lines.join('\n'), /effect unconfirmed/);
});

test('a late dialog interrupts the final read and is reported without being answered', async () => {
  const f = fixture();
  let answered = false;
  const dialog = { type: () => 'alert', message: () => 'Late alert', accept: () => { answered = true; } };
  const run = createActionRunner({ check: () => 'allow', now: f.time, sleep: async () => {}, snapshot: async () => {
    f.page.emit('dialog', dialog);
    return new Promise(() => {});
  } });
  const result = await Promise.race([run(f.tab, [{ do: 'wait', ms: 0 }], {}),
    new Promise(resolve => setTimeout(() => resolve(null), 100))]);
  assert.ok(result, 'final read hung on the late alert');
  assert.match(result.lines.join('\n'), /dialog alert is waiting.*Late alert/);
  assert.equal(result.observe, undefined);
  assert.equal(f.tab.state.dialog, dialog);
  assert.equal(answered, false);
  assert.equal(f.page.listenerCount('dialog'), 0);
});

for (const rejects of [false, true]) test(`a closing submit retains its warning and opener through outcome suffixes (rejects=${rejects})`, async () => {
  const f = fixture(), opener = { page: { url: () => 'https://fixture.invalid/app' }, state: {} };
  f.page.getByRef = () => utilityLocator({ evaluate: async fn => fn.name === 'inspectTarget' ? { submit: true } : null,
    click: async () => { f.page.emit('close'); if (rejects) throw Error('Target page has been closed'); } });
  f.tab.raisablePopups = async () => ['t3'];
  const d = createToolDispatcher({ browser: 'bfixture',
    pages: { closedOpener: () => 't1', enqueue: async (id, fn) => fn(id === 't2' ? f.tab : opener) },
    snapshot: f.snapshot, runSteps: f.run, fillFields: async () => {} });
  const out = await d.call({ name: 'browser_act', arguments: { tab: 't2', steps: [{ do: 'click', ref: 'e1' }] } });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /tab closed itself.*opener t1 below/);
  assert.match(out.text, /its submit is unconfirmed; check the opener or the account before paying again/);
  if (!rejects) assert.match(out.text, process.env.SLEIGHT_MT === '0' ? /t3.*can be raised/ : /the page can bring t3 forward on its own/);
});

test('history navigation waits for its document and stops before the next step', async () => {
  const f = fixture();
  f.page.goBack = async () => f.page.emit('framenavigated', f.page);
  const result = await f.run(f.tab, [{ do: 'back' }, { do: 'forward' }], {}, { observe: 'none' });
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[1], /not reached/);
  assert.ok(f.snapshots[0][1] >= 200);
  assert.ok(result.observe, 'a boundary still delivers its read');
});

test('a wait resets its quiet clock when a same-document boundary arrives', async () => {
  const f = fixture();
  f.schedule(100, () => f.page.emit('framenavigated', f.page));
  const result = await f.run(f.tab, [{ do: 'wait', ms: 3000 }], {});
  assert.equal(result.stoppedAt, 1);
  assert.ok(f.snapshots[0][1] >= 300);
});

for (const observe of ['diff', 'none']) test(`a self-closing click returns and delivers only the opener snapshot (${observe})`, async () => {
  const f = fixture(), opener = { page: { url: () => 'https://fixture.invalid/app' }, state: { snapshotNo: 0 } };
  let admitted = false;
  const pages = { closedOpener: id => id === 't2' && f.page.isClosed() ? 't1' : undefined,
    enqueue: async (id, fn) => fn(id === 't2' ? f.tab : opener) };
  const d = createToolDispatcher({ browser: 'bfixture', pages, runSteps: f.run, snapshot: f.snapshot,
    fillFields: async () => assert.fail('no fill'),
    deliverSnapshot: (state, capture) => { assert.equal(state, opener.state); assert.equal(capture.page, opener.page); admitted = true; return true; } });
  const out = await d.call({ name: 'browser_act', arguments: { tab: 't2', steps: [{ do: 'click', ref: 'e1' }, { do: 'forward' }], observe } });
  assert.equal(out.isError, false);
  assert.match(out.text, /tab closed itself.*opener t1 below/);
  assert.match(out.text, /2 forward: not reached/);
  assert.doesNotMatch(out.text, /unconfirmed|Read unavailable/);
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.snapshots[0][0], opener.page);
  assert.equal(admitted, false);
  assert.equal(d.delivered(out), true);
  assert.equal(admitted, true);
});

test('browser_open traces its capture and total without changing its result when a tracer throws', async () => {
  const f = fixture(), phases = [];
  f.page.title = async () => 'Fixture';
  const make = tracePhase => createToolDispatcher({ browser: 'bfixture', tracePhase,
    pages: { openTab: async ({ tracePhase }) => { tracePhase?.('browser-open-create-start'); return { tab: 't1' }; }, tab: () => f.tab },
    snapshot: f.snapshot, runSteps: f.run, fillFields: async () => {} });
  const input = { name: 'browser_open', arguments: { url: 'https://fixture.invalid/' } };
  const result = await make((phase, call) => phases.push([phase, call])).call(input);
  assert.equal(result.isError, false);
  assert.deepEqual(phases, [['browser-open-start', 1], ['browser-open-create-start', 1], ['browser-open-capture-start', 1],
    ['browser-open-capture-end', 1], ['browser-open-end', 1]]);
  assert.deepEqual(await make(() => { throw Error('trace unavailable'); }).call(input), result);
});

test('the A/B control retains the old viewport settle and discarded read', async t => {
  const old = process.env.SLEIGHT_LB12;
  process.env.SLEIGHT_LB12 = '0';
  t.after(() => { if (old === undefined) delete process.env.SLEIGHT_LB12; else process.env.SLEIGHT_LB12 = old; });
  const f = fixture();
  await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }], {}, { observe: 'none' });
  assert.equal(f.time(), 600);
  assert.equal(f.snapshots.length, 1);
});

test('self-close recovery still refuses a blocked opener before reading it', async () => {
  const f = fixture(), opener = { page: { url: () => 'https://blocked.invalid/' }, state: {} };
  const d = createToolDispatcher({ browser: 'bfixture',
    pages: { closedOpener: () => 't1', enqueue: async (id, fn) => fn(id === 't2' ? f.tab : opener) },
    sites: url => url === 'https://blocked.invalid/' ? 'Blocked by the user.' : undefined,
    snapshot: async () => assert.fail('blocked opener must not be read'), runSteps: f.run, fillFields: async () => {} });
  const result = await d.call({ name: 'browser_act', arguments: { tab: 't2', steps: [{ do: 'click', ref: 'e1' }] } });
  assert.equal(result.isError, true);
  assert.match(result.text, /tab closed itself.*opener t1 below/);
  assert.ok(result.text.endsWith('\nBlocked by the user.'));
});

for (const rejects of [false, true]) test(`a blocked opener retains the closing submit warning (rejects=${rejects})`, async () => {
  const f = fixture(), opener = { page: { url: () => 'https://blocked.invalid/' }, state: {} };
  f.page.getByRef = () => utilityLocator({ evaluate: async fn => fn.name === 'inspectTarget' ? { submit: true } : null,
    click: async () => { f.page.emit('close'); if (rejects) throw Error('Target page has been closed'); } });
  const d = createToolDispatcher({ browser: 'bfixture',
    pages: { closedOpener: () => 't1', enqueue: async (id, fn) => fn(id === 't2' ? f.tab : opener) },
    sites: url => url === 'https://blocked.invalid/' ? 'Blocked by the user.' : undefined,
    snapshot: async () => assert.fail('blocked opener must not be read'), runSteps: f.run, fillFields: async () => {},
    deliverSnapshot: () => assert.fail('blocked opener must not deliver refs') });
  const result = await d.call({ name: 'browser_act', arguments: {
    tab: 't2', steps: [{ do: 'click', ref: 'e1' }, { do: 'forward' }],
  } });
  assert.equal(result.isError, true);
  assert.match(result.text, /tab closed itself.*opener t1 below/);
  assert.match(result.text, /its submit is unconfirmed; check the opener or the account before paying again/);
  assert.match(result.text, /2 forward: not reached/);
  assert.ok(result.text.endsWith('\nBlocked by the user.'));
  assert.equal(d.delivered(result), false);
});
