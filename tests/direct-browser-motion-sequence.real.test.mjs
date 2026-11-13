import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/fd1-filtered-real.mjs';
import { createJobFixture, jobHandler } from '../bench/world/job-fixtures.mjs';
import { jpegSize } from '../plugins/sleight/lib/direct-browser/screenshot.mjs';
import { motionClock } from '../plugins/sleight/lib/direct-browser/motion-clock.mjs';

const palette = { amber: [255, 191, 38], teal: [19, 141, 134], violet: [135, 83, 216] };

async function hideVisibility(f) {
  // Headless shell keeps both tabs visible even after bringToFront. Emulate
  // hidden visibility and the 1 s timer floor in both worlds of this owned page.
  const hide = () => {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'hidden', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => true, configurable: true });
    const timer = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => timer(fn, Math.max(1000, ms), ...args);
  };
  await f.entry.page.evaluate(hide);
  const frame = f.entry.page.mainFrame(), utility = await frame._connection.toImpl(frame).utilityContext();
  await utility.evaluateExpression(hide.toString(), { isFunction: true });
  assert.equal(await f.entry.page.evaluate(() => document.visibilityState), 'hidden');
  assert.equal(await utility.evaluateExpression('() => document.visibilityState', { isFunction: true }), 'hidden');
}

test('TA1R bundled Playwright must acquire and run an isolated utility clock', { skip, timeout: 20000 }, async t => {
  const f = await fixture(t, '<p>Owned utility-world compatibility fixture</p>');
  const clock = await motionClock(f.entry);
  assert.ok(clock, 'bundled playwright-core utility-world API changed: motionClock acquired undefined');
  try {
    const result = await clock.next({ after: Date.now(), left: 3, fallback: 100 });
    assert.equal(result.remaining, 0); assert.equal(result.gap, 100);
  } finally { await clock.dispose(); }
});

test('TA1R SVG attributes and characterData wake the real utility observer', { skip, timeout: 20000 }, async t => {
  const f = await fixture(t, '<svg><rect width="100" height="100"/></svg><output>0</output>');
  const clock = await motionClock(f.entry);
  assert.ok(clock, 'utility clock is required, interval fallback would hide an observer regression');
  try {
    for (const kind of ['attribute', 'characterData']) {
      const start = performance.now();
      const pending = clock.next({ after: performance.timeOrigin + start, left: 3, fallback: 1000 });
      await f.entry.page.evaluate(kind => {
        if (kind === 'attribute') document.querySelector('rect').setAttribute('x', '10');
        else document.querySelector('output').firstChild.data = '1';
      }, kind);
      const result = await pending;
      assert.equal(result.gap, 1000);
      assert.ok(performance.now() - start < 500, `${kind} did not wake the observer`);
      assert.deepEqual(Object.keys(result).sort(), ['active', 'changed', 'gap', 'remaining']);
      assert.equal(result.changed, true);
    }
  } finally { await clock.dispose(); }
});

test('TA1R emulated hidden visibility and throttled timers retain four no-signal frames', { skip, timeout: 20000 }, async t => {
  const f = await fixture(t, '<button>Animate</button>');
  await hideVisibility(f);
  const read = await f.call('browser_read', {}), ref = /button "Animate" \[ref=(\w+)\]/.exec(read.text)?.[1];
  const result = await f.call('browser_act', { steps: [{ do: 'hover', ref }], frames: 4, observe: 'screenshot' });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.images?.length, 4, result.text);
  const offsets = [...result.text.matchAll(/\+(\d+)/g)].map(match => Number(match[1]));
  assert.equal(offsets.length, 4, result.text);
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] - offsets[i - 1] < 450, result.text);
  assert.equal(f.wire.filter(row => row.method === 'Page.captureScreenshot').length, 4);
  t.diagnostic(result.text.split('\n').find(line => line.startsWith('Motion frames')));
});

test('TA1R2 hidden visibility with throttled timers captures a 150 ms phase', { skip, timeout: 20000 }, async t => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const f = await fixture(t, `<style>
      #tile{width:100px;height:100px;background:#777}
      .running{animation:phases 450ms steps(1,end) forwards}
      @keyframes phases{0%{background:#8753d8}33.333333%{background:#ffbf26}66.666667%,100%{background:#138d86}}
      </style><button onclick="this.disabled=true;tile.className='running'">Start</button><div id="tile"></div>`);
    await hideVisibility(f);
    const read = await f.call('browser_read', {}), ref = /button "Start" \[ref=(\w+)\]/.exec(read.text)?.[1];
    const result = await f.call('browser_act', { steps: [{ do: 'click', ref }], frames: 4 });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.images?.length, 4, result.text);
    const phases = await phasesInImages(f.sentinel, result.images);
    const offsets = [...result.text.matchAll(/\+(\d+)/g)].map(match => Number(match[1]));
    t.diagnostic(JSON.stringify({ attempt, phases, offsets }));
    // A host scheduling gap longer than the phase can miss it even with the
    // correct clock. Retry that owned fixture, keeping the 150 ms assertion.
    if (!phases.includes('amber') && offsets.some((time, i) => i > 0 && time - offsets[i - 1] > 150) && attempt < 3) continue;
    assert.deepEqual(phases, ['violet', 'amber', 'teal'],
      'the middle amber phase lasts 150 ms and must appear in an image');
    t.diagnostic(result.text.split('\n').find(line => line.startsWith('Motion frames')));
    break;
  }
});

for (const frame_ms of [300, 1000]) test(`TA1R2 a mutation storm respects frame_ms ${frame_ms} on a real page`, { skip, timeout: 20000 }, async t => {
  const f = await fixture(t, `<button>Animate</button><svg><rect width="100" height="100"/></svg><output>0</output>`);
  // Mutations begin with the first capture, after actionability checks settle.
  const context = f.entry.page.context(), attach = context.newCDPSession.bind(context);
  let started = false;
  context.newCDPSession = async frame => {
    const cdp = await attach(frame), send = cdp.send.bind(cdp);
    cdp.send = async (method, ...args) => {
      if (!started && method === 'Debugger.enable') {
        started = true;
        await f.entry.page.evaluate(() => {
          const rect = document.querySelector('rect'), text = document.querySelector('output').firstChild;
          let tick = 0;
          window.storm = setInterval(() => {
            rect.setAttribute('x', String(++tick % 10)); text.data = String(tick);
            rect.style.opacity = tick % 2 ? '0.8' : '1';
          }, 1);
        });
      }
      return send(method, ...args);
    };
    return cdp;
  };
  const read = await f.call('browser_read', {}), ref = /button "Animate" \[ref=(\w+)\]/.exec(read.text)?.[1];
  const result = await f.call('browser_act', { steps: [{ do: 'hover', ref }], frames: 4, frame_ms });
  await f.entry.page.evaluate(() => clearInterval(window.storm));
  assert.equal(result.images?.length, 4, result.text);
  const offsets = [...result.text.matchAll(/\+(\d+)/g)].map(match => Number(match[1]));
  assert.equal(offsets.length, 4, result.text);
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] - offsets[i - 1] >= frame_ms / 2 - 1, result.text);
  t.diagnostic(result.text.split('\n').find(line => line.startsWith('Motion frames')));
});

// Decode only the synthetic, owned headless images. The product does not decode pixels.
async function phasesInImages(page, images) {
  return page.evaluate(async ({ images, palette }) => {
    const phases = [];
    for (const { data } of images) {
      const image = new Image(); image.src = 'data:image/jpeg;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      for (const [name, rgb] of Object.entries(palette)) {
        let matches = 0;
        for (let i = 0; i < pixels.length; i += 4) if (rgb.every((v, n) => Math.abs(v - pixels[i + n]) < 12)) matches++;
        if (matches > 150 && phases.at(-1) !== name) phases.push(name);
      }
    }
    return phases;
  }, { images, palette });
}

for (const frame_ms of [undefined, 100, 250, 300]) test(`TA1 real job-motion, interval ${frame_ms ?? 'default'}`, { skip, timeout: 20000 }, async t => {
  const job = createJobFixture('job-motion', { nonce: 'motion-sequence', seed: frame_ms === 300 ? 'ta1-rotation-4' : `ta1-${frame_ms}` });
  let plays = 0;
  const handle = (req, res) => {
    if (req.url === '/start') req.url = `/${job.nonce}/`;
    if (req.url.endsWith('/phases')) plays++;
    return jobHandler(job, `http://${req.headers.host}`)(req, res);
  };
  const f = await fixture(t, '', { message: 'Press Play once and inspect the animation as it runs. Report the three colors in order.',
    routes: { '/start': handle, [`/${job.nonce}/phases`]: handle, [`/${job.nonce}/event`]: handle } });
  const read = await f.call('browser_read', {});
  const ref = /button "Play" \[ref=(\w+)\]/.exec(read.text)?.[1]; assert.ok(ref, read.text);
  const frame = f.entry.page.mainFrame(), utility = await frame._connection.toImpl(frame).utilityContext();
  const evaluate = utility.evaluateExpression.bind(utility), timings = [];
  utility.evaluateExpression = async (...args) => {
    const result = await evaluate(...args);
    if (result?.remaining !== undefined) timings.push(result);
    return result;
  };
  const result = await f.call('browser_act', { steps: [{ do: 'click', ref }], frames: 4, ...(frame_ms === undefined ? {} : { frame_ms }) });
  assert.equal(result.isError, false, result.text);
  assert.equal(plays, 1, 'one trusted Play dispatch');
  assert.equal(result.images?.length, 4, result.text);
  for (const image of result.images) assert.ok(Math.max(...Object.values(jpegSize(image.data))) <= 480);
  const phases = await phasesInImages(f.sentinel, result.images);
  t.diagnostic(JSON.stringify({ expected: job.expected.phases, phases, note: result.text.split('\n').find(line => line.startsWith('Motion frames')) }));
  t.diagnostic(JSON.stringify({ timings }));
  assert.deepEqual(phases, job.expected.phases);
  assert.ok(timings.some(timing => timing.active && timing.remaining === 0), 'script-driven activity must survive between captures');
});

test('TA1 held-out class changes with an asynchronous start retain each short phase', { skip, timeout: 20000 }, async t => {
  const f = await fixture(t, `<style>
    #tile{width:100px;height:100px;background:#777}
    #tile.a{background:#138d86}#tile.b{background:#8753d8}#tile.c{background:#ffbf26}
    </style><button onclick="this.disabled=true;setTimeout(()=>{tile.className='a';setTimeout(()=>{tile.className='b';setTimeout(()=>{tile.className='c'},220)},120)},160)">Start</button><div id="tile"></div>`);
  await f.entry.page.evaluate(() => {
    window.MutationObserver = class { constructor() { throw Error('MAIN-world observer called'); } };
    Document.prototype.getAnimations = () => { throw Error('MAIN-world animation getter called'); };
  });
  const read = await f.call('browser_read', {}), ref = /button "Start" \[ref=(\w+)\]/.exec(read.text)?.[1];
  const result = await f.call('browser_act', { steps: [{ do: 'click', ref }], frames: 4, frame_ms: 300 });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.images?.length, 4, result.text);
  assert.deepEqual(await phasesInImages(f.sentinel, result.images), ['teal', 'violet', 'amber']);
  t.diagnostic(result.text.split('\n').find(line => line.startsWith('Motion frames')));
});

test('TA1 timing observes the action iframe and cleans every utility clock', { skip, timeout: 20000 }, async t => {
  const f = await fixture(t, '<iframe src="/panel" width="500" height="500"></iframe>', { routes: {
    '/panel': `<style>#tile{width:100px;height:100px;background:#777}</style>
      <button onclick="this.disabled=true;tile.style.background='#138d86';setTimeout(()=>{tile.style.background='#8753d8';setTimeout(()=>{tile.style.background='#ffbf26'},180)},180)">Start</button><div id="tile"></div>`,
  } });
  const read = await f.call('browser_read', {}), ref = /button "Start" \[ref=(\w+)\]/.exec(read.text)?.[1];
  assert.ok(ref, read.text);
  const result = await f.call('browser_act', { steps: [{ do: 'click', ref }], frames: 4, frame_ms: 300 });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.images?.length, 4, result.text);
  assert.deepEqual(await phasesInImages(f.sentinel, result.images), ['teal', 'violet', 'amber']);
  t.diagnostic(result.text.split('\n').find(line => line.startsWith('Motion frames')));
});

for (const duration of [600, 1200]) test(`TA1 held-out CSS animation uses measured duration ${duration} ms`, { skip, timeout: 20000 }, async t => {
  const f = await fixture(t, `<style>
    #tile{width:100px;height:100px;background:#777}
    .running{animation:phases ${duration}ms steps(1,end) forwards}
    @keyframes phases{0%{background:#8753d8}34%{background:#ffbf26}67%,100%{background:#138d86}}
    </style><button onclick="this.disabled=true;tile.className='running'">Start</button><div id="tile"></div>`);
  const read = await f.call('browser_read', {}), ref = /button "Start" \[ref=(\w+)\]/.exec(read.text)?.[1];
  const impl = f.entry.page.mainFrame()._connection.toImpl(f.entry.page.mainFrame()), utility = await impl.utilityContext();
  const evaluate = utility.evaluateExpression.bind(utility), timings = [];
  utility.evaluateExpression = async (...args) => { const result = await evaluate(...args); if (result?.remaining !== undefined) timings.push(result); return result; };
  const result = await f.call('browser_act', { steps: [{ do: 'click', ref }], frames: 4 });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.images?.length, 4, result.text);
  t.diagnostic(result.text.split('\n').find(line => line.startsWith('Motion frames')));
  t.diagnostic(JSON.stringify(timings));
  assert.deepEqual(await phasesInImages(f.sentinel, result.images), ['violet', 'amber', 'teal']);
});
