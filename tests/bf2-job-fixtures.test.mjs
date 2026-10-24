import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { inflateSync } from 'node:zlib';
import { createJobFixture, gradeJob, jobHandler } from '../bench/world/job-fixtures.mjs';

async function request(fixture, tail = '', method = 'GET') {
  const req = Readable.from([]);
  Object.assign(req, { url: `/${fixture.nonce}/${tail}`, method, headers: { host: '127.0.0.1:5432' } });
  const response = {};
  await jobHandler(fixture, 'http://127.0.0.1:5432')(req, {
    writeHead(code, headers) { Object.assign(response, { code, headers }); return this; },
    end(body) { response.body = body; },
  });
  return response;
}

const fixtureFor = kind => createJobFixture(kind, { nonce: 'trial', seed: 'bf2-held-out' });
const initial = { kind: 'media', width: 1200, height: 900, scheme: 'light', reduced: false };
const input = (fixture, events, extra = {}) => ({ task: { worldFixture: fixture.kind },
  site: { kind: fixture.kind, views: [''], events, ...extra }, expected: fixture.expected, answer: JSON.stringify(fixture.expected) });

test('BF2 media answers vary with the seed and repeat exactly for the same seed', async () => {
  const badges = new Set(), visible = new Set(), heights = new Set();
  for (let n = 0; n < 64; n++) {
    const options = { nonce: 'trial', seed: `bf2-${n}` };
    for (const kind of ['job-dark', 'job-phone']) {
      const fixture = createJobFixture(kind, options);
      assert.deepEqual(fixture, createJobFixture(kind, options));
      if (kind === 'job-dark') badges.add(fixture.expected.badge);
      else {
        visible.add(fixture.expected.actionVisible);
        const page = (await request(fixture)).body;
        heights.add(page.match(/@media\(max-width:500px\)\{\.spacer\{height:(\d+)px/)[1]);
      }
    }
  }
  assert.deepEqual([...badges].sort(), ['amber', 'teal', 'violet']);
  assert.equal(visible.size, 2);
  assert.ok(heights.size > 10);
});

test('BF2 dark grading refuses an initially dark or absent profile, then requires a later dark event and restoration', () => {
  const fixture = fixtureFor('job-dark'), dark = { ...initial, scheme: 'dark' };
  for (const events of [[], [dark], [dark, initial, dark]]) {
    assert.deepEqual(gradeJob(input(fixture, events)).problems, ['JOB_FIXTURE_UNAVAILABLE']);
  }
  assert.deepEqual(gradeJob(input(fixture, [initial])).problems, ['JOB_DARK_NOT_PROVED']);
  assert.deepEqual(gradeJob(input(fixture, [initial, dark])).problems, ['JOB_MEDIA_NOT_RESTORED']);
  assert.equal(gradeJob(input(fixture, [initial, dark, initial])).ok, true);
});

test('BF2 routing code is a server PNG with no text metadata or answer in the page source', async () => {
  const fixture = fixtureFor('job-canvas');
  const page = (await request(fixture)).body;
  assert.ok(!page.includes(fixture.expected.code));
  assert.match(page, /src="\/trial\/slip\.png"/);
  const response = await request(fixture, 'slip.png');
  assert.equal(response.code, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  const png = response.body;
  assert.ok(Buffer.isBuffer(png));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = [], compressed = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), name = png.toString('ascii', offset + 4, offset + 8);
    chunks.push(name);
    if (name === 'IHDR') { assert.equal(png.readUInt32BE(offset + 8), 480); assert.equal(png.readUInt32BE(offset + 12), 160); }
    if (name === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.ok(pixels.includes(21), 'routing ink must exist in the pixels');
  assert.ok(!png.includes(Buffer.from(fixture.expected.code)));
  assert.equal((await request(fixtureFor('job-dark'), 'slip.png')).code, 404);
});

// A deterministic page scheduler covers paused and very late rAF without wall-clock races.
async function pageRuntime(kind, { paused = false } = {}) {
  const fixture = fixtureFor(kind), html = (await request(fixture)).body;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const events = [], requests = [], timers = new Map(), frames = new Map(), listeners = new Map(), paints = [];
  let clock = 0, id = 0;
  const signal = { style: new Proxy({}, { set(target, key, value) { target[key] = value; if (key === 'background') paints.push(value); return true; } }) };
  const nodes = { '#play': {}, '#status': {}, '#signal': signal };
  const context = {
    innerWidth: 1200, innerHeight: 900,
    document: { querySelector: selector => nodes[selector] },
    addEventListener: (name, handler) => listeners.set(name, handler),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/event')) { events.push(JSON.parse(options.body)); return { ok: true }; }
      const response = await request(fixture, url.split('/').at(-1), options?.method);
      return { ok: response.code === 200, json: async () => JSON.parse(response.body) };
    },
    setTimeout: (fn, delay) => { timers.set(++id, { at: clock + delay, fn }); return id; },
    clearTimeout: token => timers.delete(token),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: token => frames.delete(token),
  };
  runInNewContext(script, context);
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const tick = async (late = false) => {
    if (!paused && frames.size) {
      clock += late ? 700 : 16;
      const queued = [...frames.values()]; frames.clear();
      for (const fn of queued) fn(clock);
    } else if (timers.size) {
      const [token, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(token); clock = Math.max(clock, timer.at); timer.fn();
    }
    await flush();
  };
  return { fixture, events, requests, nodes, context, listeners, paints, frames, timers, tick, flush };
}

test('BF2 motion phases stay server-side until a trusted Play', async () => {
  const fixture = fixtureFor('job-motion'), html = (await request(fixture)).body;
  assert.ok(!html.includes(JSON.stringify(fixture.expected.phases)));
  assert.equal((await request(fixture, 'phases')).code, 404, 'GET cannot disclose phases');
  const runtime = await pageRuntime('job-motion');
  assert.ok(!runtime.requests.some(req => req.url.endsWith('/phases')));
  await runtime.nodes['#play'].onclick({ isTrusted: false }); await runtime.flush();
  assert.ok(!runtime.requests.some(req => req.url.endsWith('/phases')));
  await runtime.nodes['#play'].onclick({ isTrusted: true }); await runtime.flush();
  assert.equal(runtime.requests.filter(req => req.url.endsWith('/phases') && req.options.method === 'POST').length, 1);
});

for (const paused of [false, true]) test(`BF2 motion paints every phase exactly once with ${paused ? 'paused' : 'late'} rAF`, async () => {
  const runtime = await pageRuntime('job-motion', { paused });
  await runtime.nodes['#play'].onclick({ isTrusted: true }); await runtime.flush();
  for (let n = 0; n < 40 && !runtime.events.some(event => event.kind === 'motion'); n++) {
    await runtime.tick(true);
    const completion = runtime.events.find(event => event.kind === 'motion');
    if (completion) assert.deepEqual(runtime.paints.slice(0, 3), runtime.fixture.expected.phases.map(color => ({ amber: '#ffbf26', teal: '#138d86', violet: '#8753d8' }[color])));
  }
  const completions = runtime.events.filter(event => event.kind === 'motion');
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0].phases, runtime.fixture.expected.phases);
  assert.equal(runtime.nodes['#status'].textContent, 'Finished');
  assert.equal(runtime.frames.size, 0);
  assert.equal(runtime.timers.size, 0);
});

test('BF2 emit is private and synthetic media events cannot add evidence', async () => {
  const runtime = await pageRuntime('job-motion');
  assert.equal(runInNewContext('typeof emit', runtime.context), 'undefined');
  const before = runtime.events.length;
  runtime.context.innerWidth = 390;
  runtime.listeners.get('resize')({ isTrusted: false }); await runtime.flush();
  assert.equal(runtime.events.length, before);
  runtime.listeners.get('resize')({ isTrusted: true }); await runtime.flush();
  assert.equal(runtime.events.length, before + 1);
});

test('BF2 kanban grading requires the matching card to remain in Review', () => {
  const fixture = fixtureFor('job-kanban');
  const drag = { kind: 'drag', card: fixture.expected.card, from: 'Queue', to: 'Review', points: 6 };
  for (const kanban of [undefined, { card: fixture.expected.card, column: 'Queue' }, { card: 'Other parcel', column: 'Review' }]) {
    assert.deepEqual(gradeJob(input(fixture, [drag], { kanban })).problems, ['JOB_DRAG_NOT_PROVED']);
  }
  assert.equal(gradeJob(input(fixture, [drag], { kanban: fixture.expected })).ok, true);
});
