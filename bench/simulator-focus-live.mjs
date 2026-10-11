#!/usr/bin/env node
// Owner-away probe. Captures a fresh image, then waits for an operator's point tied to its hash.
// No typing, paste, keyboard-capture toggle, model call, or coordinate correction.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { executeRealTask, acquireFixture } from './real-run.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';
import { observePermission } from './real-permission.mjs';
import { simctl, quitSimApp } from './tasks.mjs';
import { launchSimulatorFocus, shutdownSimulatorFocus, simulatorFocusProbeOptions } from './simulator-focus-setup.mjs';
import { simulatorFocusReport } from './simulator-focus-report.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { probeClient } from './double-keys-client.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { imageSize } from '../plugins/sleight/lib/relay.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

if (!process.argv.includes('--owner-away')) throw new Error('Requires --owner-away; do not run while the owner is at the Mac');
const mode = process.argv[process.argv.indexOf('--observation') + 1];
if (!['screenshot', 'combined'].includes(mode)) throw new Error('Use --observation screenshot or --observation combined');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('interrupted')));
const free = () => { if (existsSync('/tmp/sleight-hold')) throw new Error('Live hold exists; stopped'); controller.signal.throwIfAborted(); };
const probeOptions = simulatorFocusProbeOptions({ check: free, observe: observePermission });
free();
const dir = trackTemp(mkdtempSync('/private/tmp/sleight-simulator-focus-'));
const ownerName = execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8' }).trim();
if (ownerName.length < 3) throw new Error('Owner-name scrub identity unavailable; stopped');
const report = { started: new Date().toISOString(), ownerAway: true, mode, rows: [], events: [], attempts: [] };
const save = () => writeFileSync(join(dir, 'result.json'), simulatorFocusReport(report, ctx.sim, { home: homedir(), ownerName }), { mode: 0o600 });
let release, client, engineCollected = true;
const ctx = { dir: join(dir, 'fixture'), nonce: randomUUID(), ownerAway: true };
controller.signal.addEventListener('abort', () => { void client?.close().catch(error => { report.engineCloseError = error.message; save(); }); });

const task = {
  async setup(ctx) {
    free();
    const priorCleanupCheck = ctx.beforeFixtureCleanup;
    ctx.beforeFixtureCleanup = async () => { free(); await priorCleanupCheck?.(); free(); };
    const modern = existsSync('/Applications/Xcode.app/Contents/Applications/DeviceHub.app');
    await acquireFixture(ctx, 'simViewer', () => openFixture(ctx, {
      app: modern ? 'DeviceHub' : 'Simulator', bundle: modern ? 'com.apple.dt.Devices' : 'com.apple.iphonesimulator', target: '', mode: 'inherit', stopOnLiveHold: true,
    }, { launch: async begin => {
      // The armed native fixture has already recorded the exact viewer's initial running state.
      launchSimulatorFocus(ctx, { viewer: ctx.windowLeases.at(-1), simctl, check: free, beginLaunch: begin, record: save,
        openViewer: () => execFileSync('/usr/bin/open', ['-g', modern
          ? '/Applications/Xcode.app/Contents/Applications/DeviceHub.app'
          : '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app'], { timeout: 15000 }) });
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', bytes => { body += bytes; });
        req.on('end', () => {
          if (req.url === '/event') {
            try { const event = JSON.parse(body); report.events.push({ received: new Date().toISOString(), ...event }); save(); } catch {}
            res.writeHead(204); res.end(); return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>sleight focus fixture</title>
<label>Message <input id="message" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></label>
<script>
const field=document.querySelector('input');
const send=e=>{const r=field.getBoundingClientRect();fetch('/event',{method:'POST',body:JSON.stringify({
type:e.type,target:e.target?.id||null,x:e.clientX??null,y:e.clientY??null,focused:document.activeElement===field,
rect:{x:r.x,y:r.y,width:r.width,height:r.height},width:innerWidth,height:innerHeight,time:performance.now()})});};
for(const type of ['pointerdown','click','focusin','focusout'])document.addEventListener(type,send,true);
addEventListener('load',send);addEventListener('resize',send);
</script>`);
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      ctx.closeServer = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      free(); simctl('openurl', ctx.sim.udid, `http://127.0.0.1:${server.address().port}/`);
      ctx.simPageOpened = true;
    } }));
  },
  prompt: () => '',
  check: () => report.events.some(event => event.type === 'focusin' && event.focused) || 'No field focus observed',
  async cleanup(ctx) {
    try { free(); await closeFixtures(ctx); }
    finally {
      try { shutdownSimulatorFocus(ctx, { simctl, check: free, record: save }); }
      finally {
        try { free(); await quitSimApp({ ownedOnly: true, lease: ctx.windowLeases?.find(lease => ['DeviceHub', 'Simulator'].includes(lease.app)) }); }
        finally { await ctx.closeServer?.(); }
      }
    }
  },
};

async function call(label, code) {
  free();
  const started = performance.now();
  const result = await client.call('js', { code });
  const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const images = (result.content ?? []).filter(block => block.type === 'image');
  report.rows.push({ label, ms: performance.now() - started, isError: !!result.isError, text,
    images: images.map(image => imageSize(image.data)) }); save();
  if (result.isError) throw new Error(text);
  return images;
}

try {
  free(); release = await acquireLiveLock(); free();
  report.result = await executeRealTask(task, ctx, { signal: controller.signal, lockHeld: true,
    permissionCheck: probeOptions.permissionCheck, stop: () => controller.abort(new Error('permission or application dialog')),
    drive: async () => {
      try {
        engineCollected = false;
        client = await probeClient(resolveServer(), { relay: true, relayOptions: probeOptions.relayOptions, timeoutMs: 60000,
          record: event => { if (event.event) { report.attempts.push(event); save(); } } });
        await call('acquire', `var app = await cua.getApp(${JSON.stringify(ctx.sim.app === 'DeviceHub' ? 'com.apple.dt.Devices' : 'com.apple.iphonesimulator')})`);
        const images = await call('first-observation', mode === 'screenshot' ? 'await app.getScreenshot()' : 'await app.getAXStateAndScreenshot()');
        if (images.length !== 1 || !imageSize(images[0].data)) throw new Error('Expected one sized screenshot');
        const bytes = Buffer.from(images[0].data, 'base64'), sha256 = createHash('sha256').update(bytes).digest('hex');
        const size = imageSize(images[0].data);
        const imageFile = images[0].mimeType === 'image/png' ? 'first-image.png' : 'first-image.jpg';
        writeFileSync(join(dir, imageFile), bytes, { mode: 0o600 });
        writeFileSync(join(dir, 'point-request.json'), JSON.stringify({ sha256, ...size,
          instruction: `Inspect ${imageFile}. Write tap.json here with this sha256 and integer x,y at the Message field in these image dimensions.` }), { mode: 0o600 });
        console.log(`Fresh image and point request: ${dir}. Waiting up to 120 s for tap.json.`);
        const deadline = Date.now() + 120000;
        while (!existsSync(join(dir, 'tap.json'))) { free(); if (Date.now() >= deadline) throw new Error('No screenshot-derived point supplied'); await sleep(250, undefined, { signal: controller.signal }); }
        const point = JSON.parse(readFileSync(join(dir, 'tap.json'), 'utf8'));
        if (point.sha256 !== sha256 || !Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height) throw new Error('Point does not match the fresh screenshot');
        for (let i = 1; i <= 2; i++) {
          const before = report.events.length;
          await call(`tap-${i}`, `await app.click([${point.x},${point.y}]); await app.getScreenshot()`);
          await sleep(1000, undefined, { signal: controller.signal });
          report.rows.push({ label: `telemetry-${i}`, events: report.events.slice(before) }); save();
          if (report.events.slice(before).some(event => event.type === 'focusin' && event.focused)) break;
        }
        return { code: 0, groupClean: true, out: { result: 'focus probe completed; no text sent' } };
      } catch (error) {
        report.error = error.message; save();
        return { code: 1, groupClean: true, out: { result: 'focus probe stopped; no text sent' } };
      } finally { await client?.close(); engineCollected = true; }
    } });
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  const cleaned = report.result && !report.result.cleanupError && !report.result.cleanupUnconfirmed && !report.result.fixtureDir && engineCollected;
  if (release && cleaned) { await release(); report.lockReleased = true; }
  else if (release) report.lockRetained = 'Viewer, device, fixture, or engine cleanup unconfirmed; inspect before releasing /tmp/sleight-live.lock';
  save(); console.log(`Private probe result: ${join(dir, 'result.json')}`);
}
if (report.result?.passed !== true) process.exitCode = 1;
