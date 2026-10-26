// Offline only: identical relay requests against a selected worktree, fake geometry and private sockets.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

const root = resolve(process.argv[2] ?? new URL('../../', import.meta.url).pathname);
const load = name => import(pathToFileURL(join(root, 'plugins/sleight/lib', name)));
const { createRelay } = await load('relay.mjs');
const { createRelayHand } = await load('hand/relay-hand.mjs');
const settings = await load('hand/settings.mjs');
let cursorModule;
try { cursorModule = await load('hand/events.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const dir = realpathSync(mkdtempSync('/tmp/vc1r-cost-'));
const geometry = { ok: true, window: { pid: 42, windowId: 7, bounds: { X: 0, Y: 0, Width: 500, Height: 400 } },
  windows: [{ id: 7, pid: 42, bounds: { X: 0, Y: 0, Width: 500, Height: 400 } }], displays: [{ X: 0, Y: 0, Width: 1000, Height: 800 }] };
const tree = 'Window: "Editor", App: Editor.\n0 standard window Editor\n\t1 button Description: Save, ID: Save';
const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(500, 16); png.writeUInt32BE(400, 20);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const summary = values => {
  values.sort((a, b) => a - b);
  return { medianUs: values[values.length >> 1] * 1000, p95Us: values[Math.floor(values.length * 0.95)] * 1000, samples: values.length };
};
const rows = [];
try {
  for (const mode of cursorModule ? ['off-absent', 'off-file', 'hand-only', 'stream-0', 'stream-2'] : ['off-absent', 'off-file', 'hand-only']) {
    const bank = join(dir, mode); mkdirSync(bank, { mode: 0o700 });
    const path = join(bank, 'hand.json'), stream = mode.startsWith('stream-'), drawing = mode === 'hand-only' || stream;
    if (mode !== 'off-absent') writeFileSync(path, JSON.stringify({ version: 1, enabled: drawing, ...(stream ? { stream: true } : {}) }), { mode: 0o600 });
    // Both revisions use their own real reader and only the fixture path differs from production.
    const setting = settings.createHandSettingReader ? settings.createHandSettingReader({ path, env: {}, platform: 'darwin' })
      : () => settings.handSetting({ path, env: {}, platform: 'darwin' });
    const clients = [], servers = []; let sink, events, relay, frames = 0, eventCount = 0;
    try {
      if (stream) {
        for (let i = 0; i < (mode === 'stream-2' ? 2 : 0); i++) {
          const server = net.createServer(c => { clients.push(c); c.resume(); }); servers.push(server);
          const socketPath = join(bank, i + '.sock'); await new Promise(r => server.listen(socketPath, r)); chmodSync(socketPath, 0o600);
        }
        sink = cursorModule.createRendererSink({ dir: bank });
      }
      events = cursorModule?.createCursorEvents({ setting, sink, onEvent() { eventCount++; } });
      if (stream) {
        events.status('thinking'); const end = Date.now() + 2000;
        while (sink.stats().connected !== servers.length) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 5)); }
      }
      const hand = createRelayHand({ setting, events, now: () => 0, env: {}, client: drawing ? { enabled: true, send() { frames++; }, close() {} } : undefined,
        locate: async () => geometry });
      const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
      let last;
      serverIn.on('data', d => { for (const line of d.toString().trim().split('\n')) last = JSON.parse(line).id; }); clientOut.resume();
      relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'fixture', changeReview: false, hand, cursor: events });
      const request = (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
      const response = (id, screenshot = false) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: tree },
        ...(screenshot ? [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] : [])] } }) + '\n');
      request(1, 'let app = await cua.getApp("Editor")'); await settle(); response(1, true); await settle();
      const row = { mode, connected: sink?.stats().connected ?? 0 };
      // Include normal cache hits and a separate expired read, with real stat/realpath/read/JSON work.
      setting(); const reads = [];
      for (let j = 0; j < 20; j++) {
        const start = performance.now(); for (let i = 0; i < 1000; i++) setting(); reads.push((performance.now() - start) / 1000);
      }
      row.setting = summary(reads);
      for (const [name, code] of [['single', 'await app.click([20,20])'], ['long', Array(16).fill('await app.click([20,20])').join(';')]]) {
        const admission = [], complete = [];
        for (let i = 0; i < 350; i++) {
          const id = 100 + i, start = performance.now(); request(id, code);
          assert.equal(last, id, 'dispatch must remain synchronous'); const admitted = performance.now() - start;
          await settle(); const resultStart = performance.now(); response(id); const resultTime = performance.now() - resultStart;
          await settle();
          if (i >= 50) { admission.push(admitted); complete.push(admitted + resultTime); }
        }
        row[name] = { admission: summary(admission), requestAndResult: summary(complete) };
      }
      row.frames = frames; row.events = eventCount; rows.push(row);
    } finally {
      relay?.dispose(); events?.close(); sink?.close(); clients.forEach(c => c.destroy());
      await Promise.all(servers.map(server => new Promise(r => server.close(r))));
    }
  }
  if (cursorModule) {
    const hand = rows.find(r => r.mode === 'hand-only');
    for (const row of rows.filter(r => r.mode.startsWith('stream-'))) for (const name of ['single', 'long'])
      assert.ok(row[name].admission.medianUs - hand[name].admission.medianUs < 250, `${row.mode} ${name} adds at least 250 us`);
  }
  console.log(JSON.stringify({ root, revisionHasCursor: !!cursorModule, warmupPerRow: 50, rows }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
