#!/usr/bin/env node
// VC7 check 5, a short visual record for the owner: one 20 s recording of the scripted sequence with the ring, and one with
// the synthetic sprite, in visible capture mode over a scratch TextEdit window. bench/capture/recorder.swift records one
// composite stream whose filter includes only the fixture window and the cursor's panel, cropped to the fixture window
// ("crop":"first"), so no other window and nothing outside the fixture can be in the film. Files go to
// ~/Library/Logs/sleight/vc7-<stamp>/ (or --out).
//
//   node bench/hand/cursor-record.mjs --owner-away [--styles ring,sprite] [--seconds 20] [--out DIR] [--host PATH] [--helper PATH]
//        [--recorder PATH] [--receipt PATH] [--dry-run]
//
// Exit 0: every style recorded. 1: a recording failed. 2: setup refused. 3: busy.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoSequence } from './cursor-sequence.mjs';
import { ROOT, tilde, stamp, logsRoot, commonArgs, liveRefusal, hostArgs, playRect } from './vc7-live.mjs';

export const STYLES = Object.freeze(['ring', 'sprite']);
export const SPACING_MS = 900; // under the ring's 1.2 s silence, so the panel (and its window id) stays up the whole take
export const FPS = 30;

/** The recorder's plan: one composite stream of the fixture window and the panel, cropped to the fixture window. */
export function recordPlan({ out, seconds, style, targetId, panelId }) {
  if (!out?.startsWith('/')) throw new Error('out must be absolute');
  if (!Number.isSafeInteger(targetId) || !Number.isSafeInteger(panelId) || targetId < 1 || panelId < 1 || targetId === panelId) throw new Error('two different window ids');
  return { version: 1, out, fps: FPS, duration: seconds, codec: 'hevc', streams: [{ name: `cursor-${style}`, windows: [targetId, panelId], composite: true, crop: 'first' }] };
}

/** The host's panel over the target: its one on-screen window, or undefined while it has none or more than one. */
export function panelWindow(windows, hostPid) {
  const own = windows.filter(w => w.pid === hostPid && w.alpha > 0);
  return own.length === 1 ? own[0] : undefined;
}

export function parseArgs(argv) {
  const common = commonArgs(argv);
  const styles = (common.value('--styles') ?? STYLES.join(',')).split(',').filter(Boolean);
  if (!styles.length || styles.some(s => !STYLES.includes(s)) || new Set(styles).size !== styles.length) throw new Error(`--styles must be a list of ${STYLES.join(', ')}`);
  const seconds = Number(common.value('--seconds') ?? 20);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) throw new Error('--seconds must be a whole number from 5 to 60');
  return { ...common, styles, seconds, recorder: common.value('--recorder') };
}

export function dryRunPlan(opts, { out }) {
  const host = opts.host ?? '<work>/consent-host', recorder = opts.recorder ?? '<work>/capture-recorder';
  return [
    `VC7 cursor recording, styles ${opts.styles.join(', ')}, ${opts.seconds} s each (dry run: nothing opened)`,
    '1. refuse with /tmp/sleight-hold present, take /tmp/sleight-live.lock (no wait); refuse when TextEdit runs',
    ...(opts.host && opts.helper && opts.recorder ? [] : ['2. build the capture helper, the hand host and bench/capture/recorder.swift with xcrun swiftc']),
    `3. /usr/bin/open -g -a TextEdit <work>/sleight-vc7-record.txt --args -ApplePersistenceIgnoreState YES ...${opts.receipt ? `   (receipt ${tilde(opts.receipt)})` : ''}`,
    ...opts.styles.map((style, i) => `${4 + i}. ${style}: ${style === 'sprite' ? 'SLEIGHT_CURSOR_TEST=1 SLEIGHT_CURSOR_CHARACTERS_ROOT=<root> ' : ''}${host} ${hostArgs({ capture: 'visible', style }).join(' ')}; ` +
      `frames every ${SPACING_MS} ms; ${recorder} record <plan> with ${JSON.stringify(recordPlan({ out: join(out, `record-${style}`), seconds: opts.seconds, style, targetId: 1, panelId: 2 }).streams[0]).replace('[1,2]', '[<fixture window>,<panel>]')}`),
    `${4 + opts.styles.length}. quit the TextEdit this run started; kill any host left; release the lock; films in ${tilde(out)}`,
  ];
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const out = resolve(opts.out ?? join(logsRoot(), `vc7-record-${stamp()}`));
  if (opts.dryRun) { console.log(dryRunPlan(opts, { out }).join('\n')); return 0; }
  const refusal = liveRefusal(opts, 'The cursor recording');
  if (refusal) { console.error(refusal.message); return refusal.code; }
  const { acquireLiveLock } = await import('../live-lock.mjs');
  const { underLiveLock } = await import('./h5-capture.mjs');
  return underLiveLock({ acquire: () => acquireLiveLock('/tmp/sleight-live.lock', { wait: false }) }, async ({ cleanups }) => {
    mkdirSync(out, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'sleight-vc7-record-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const live = await import('../compat/live.mjs');
    const { compileSwift, helperClient, openTextEditFixture, startHandHost, killHosts, spriteSupport, RECORDER_SOURCE } = await import('./vc7-live.mjs');
    const { runRecorder } = await import('../capture/record.mjs');
    const { cursorWire, playSequence } = await import('./cursor-sequence.mjs');
    const { installSyntheticCharacter, characterEnv, characterWire } = await import('./synthetic-character.mjs');
    const helperBin = opts.helper ?? join(work, 'capture-helper'), hostBin = opts.host ?? join(work, 'consent-host'), recorderBin = opts.recorder ?? join(work, 'capture-recorder');
    await Promise.all([opts.helper ? undefined : compileSwift(join(ROOT, 'bench/hand/capture.swift'), helperBin),
      opts.host ? undefined : compileSwift(join(ROOT, 'plugins/sleight/lib/direct-browser/native/consent-host.swift'), hostBin),
      opts.recorder ? undefined : compileSwift(RECORDER_SOURCE, recorderBin)]);
    const helper = helperClient(helperBin);
    const grants = await helper(['preflight']);
    if (!grants.screenRecording) { console.error('Screen Recording is not granted to the app that started this shell.'); return 2; }
    const hosts = new Set();
    cleanups.push(() => killHosts(hosts));
    let character, spriteSkip;
    if (opts.styles.includes('sprite')) {
      character = installSyntheticCharacter();
      cleanups.push(() => rmSync(character.root, { recursive: true, force: true }));
      const probe = await spriteSupport(hostBin, JSON.stringify(characterWire(character, { nonce: randomBytes(32).toString('hex'), seq: 0 })) + '\n', characterEnv(character.root));
      if (!probe.sprite) spriteSkip = probe.detail;
    }
    const { target } = await openTextEditFixture({ helper, live, work, cleanups, receipt: opts.receipt, name: 'sleight-vc7-record.txt' });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const count = Math.ceil((opts.seconds * 1000 + 3000) / SPACING_MS);
    const sequence = autoSequence({ pid: target.pid, windowId: target.id, rect: playRect(target.bounds), count, spacingMs: SPACING_MS });
    const results = {};
    for (const style of opts.styles) {
      if (style === 'sprite' && spriteSkip) { results[style] = { skipped: spriteSkip }; continue; }
      console.log(`  recording ${style}`);
      const host = await startHandHost({ hostBin, capture: 'visible', style, env: style === 'sprite' ? characterEnv(character.root) : {}, hosts });
      const wire = cursorWire();
      if (style === 'sprite') host.write(wire.character(character));
      let stop = false;
      const playing = playSequence(sequence, { wire, write: line => host.write(line), sleep, stopped: () => stop });
      try {
        let panel;
        for (let i = 0; i < 40 && !panel; i++) { await sleep(100); panel = panelWindow((await helper(['windows'])).windows, host.pid); }
        if (!panel) throw new Error('the cursor panel did not appear');
        const dir = join(out, `record-${style}`);
        if (existsSync(dir)) throw new Error(`${tilde(dir)} exists; the recorder never overwrites a take`);
        mkdirSync(dir);
        const planPath = join(work, `plan-${style}.json`);
        writeFileSync(planPath, JSON.stringify(recordPlan({ out: dir, seconds: opts.seconds, style, targetId: target.id, panelId: panel.id })));
        const recorded = await runRecorder(recorderBin, planPath);
        const file = join(dir, `cursor-${style}.mov`);
        results[style] = recorded.code === 0 && existsSync(file) ? { file: tilde(file), bytes: statSync(file).size } : { error: recorded.error ?? `recorder exited ${recorded.code}` };
      } catch (error) { results[style] = { error: String(error.message).slice(0, 200) }; }
      finally { stop = true; await playing.catch(() => {}); host.write(wire.hide()); await host.close(); }
    }
    writeFileSync(join(out, 'record.json'), JSON.stringify({ seconds: opts.seconds, fps: FPS, results }, null, 2) + '\n');
    for (const [style, r] of Object.entries(results)) console.log(`  ${style}: ${r.file ? `${r.file} (${r.bytes} bytes)` : r.skipped ? `skipped: ${r.skipped}` : `failed: ${r.error}`}`);
    console.log(`VC7 RESULT: recording ${Object.entries(results).map(([s, r]) => `${s} ${r.file ? 'saved' : r.skipped ? 'skipped' : 'failed'}`).join(', ')}`);
    return Object.values(results).every(r => r.file) ? 0 : 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
