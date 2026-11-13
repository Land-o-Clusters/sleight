#!/usr/bin/env node
// Renderer-only RSS: production --hand, no fixture windows in the measured process, no capture or app input.
// Offline: --dry-run. Live: --owner-away-file FILE --character DIR --out NEW_DIR [--size all|small|medium|stage].
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoSequence, playSequence } from './cursor-sequence.mjs';
import { createCostSampler } from './cost-sampler.mjs';
import { HOST_SOURCE, ROOT, compileArgs, helperClient, openTextEditFixture, playRect, startHandHost, tilde } from './vc7-live.mjs';
import { privateStageHome } from './private-stage-home.mjs';
import { prepareStageCharacter, stageWire, stageRunGuard } from './stage-live.mjs';
import { characterEnv } from './synthetic-character.mjs';

const SIZES = ['small', 'medium', 'stage'], MIB = 1024 ** 2;
export function parseArgs(argv) {
  const opts = { sizes: SIZES };
  const paths = { '--owner-away-file': 'ownerAwayFile', '--character': 'character', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--size') {
      const size = argv[++i];
      if (size !== 'all' && !SIZES.includes(size)) throw Error('--size must be all, small, medium or stage');
      opts.sizes = size === 'all' ? SIZES : [size];
    } else if (paths[flag]) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw Error(flag + ' needs a path');
      if (opts[paths[flag]]) throw Error('duplicate ' + flag);
      opts[paths[flag]] = resolve(value);
    } else throw Error('unknown argument: ' + flag);
  }
  return opts;
}

const markerExists = path => { try { return lstatSync(path).isFile(); } catch { return false; } };
export function rendererRefusal({ ownerAwayFile, platform = process.platform, hold = existsSync('/tmp/sleight-hold'), exists = markerExists }) {
  if (!ownerAwayFile || !exists(ownerAwayFile)) return '--owner-away-file must name an existing owner-away marker';
  if (hold) return '/tmp/sleight-hold exists; another project is measuring';
  if (platform !== 'darwin') return 'renderer RSS measurement requires macOS';
  return null;
}

export function dryRunPlan(opts = {}) {
  return [
    'Renderer-only RSS, dry run: opens nothing, captures nothing.',
    'Refuse without an existing --owner-away-file marker, with /tmp/sleight-hold, or with TextEdit running. Take /tmp/sleight-live.lock without waiting.',
    'Compile consent-host with the optimized production recipe, private storage home and one read-only snapshot pipe for existing cache counters. No SLEIGHT_STAGE_BENCH, no fixture code or observation timer in this process.',
    'Build the metadata helper; /usr/bin/open -g -a TextEdit <work>/renderer-rss.txt with document restoration disabled.',
    ...(opts.sizes ?? SIZES).map(size => `${size}: consent-host --hand --capture=hidden --cursor-style=sprite; sample empty host floor; load stage pack; 40 actions at 1500 ms from VC7 autoSequence; 61 s active, 6 s settle, 61 s parked; sample live descendants and self RSS; vmmap --summary PID once at the parked endpoint.`),
    'Print one table per size: empty host, parked self/tree, measured strip cache, remainder, MALLOC, CG image, IOSurface and every other vmmap resident category. Cache comes from the renderer snapshot, separately from vmmap CG image.',
    'Close and await each owned host; quit the owned TextEdit with NSRunningApplication (no Apple events); release the lock only after cleanup is confirmed.',
    `Write renderer-rss.json, renderer-rss.md and one vmmap summary per size to ${tilde(opts.out ?? '<new --out directory>')}.`,
  ];
}

const memoryMiB = text => {
  const m = /^(\d+(?:\.\d+)?)([BKMGTP]?)$/i.exec(text);
  return m ? Number(m[1]) * (1024 ** 'BKMGTP'.indexOf(m[2].toUpperCase() || 'B')) / MIB : null;
};
export function parseVmmapSummary(text) {
  const header = /VIRTUAL\s+RESIDENT[^\n]*/i.exec(text)?.[0];
  if (!/REGION TYPE/.test(text) || !header) throw Error('vmmap summary lacks VIRTUAL and RESIDENT columns');
  const columns = header.trim().split(/\s+/).length;
  const size = String.raw`\d+(?:\.\d+)?[BKMGTP]?`;
  // Match every numeric column before optional notes, so a numbered name cannot shift the sizes.
  const row = new RegExp(String.raw`^\s*(.+?)\s+(${size})\s+(${size})\s+(${size})\s+(${size})(?:\s+${size}){${columns - 4}}(?!\s+${size}(?:\s|$))(?:\s{2,}.*)?\s*$`, 'i');
  const regions = [];
  for (const line of text.split('\n')) {
    // The later zone table describes the same allocations again.
    if (/^\s*MALLOC ZONE(?:\s|$)/i.test(line)) break;
    const m = row.exec(line);
    if (!m || /^(TOTAL|TOTAL,|REGION TYPE|Physical footprint)/i.test(m[1])) continue;
    const [, name, virtual, resident, dirty, swapped] = m;
    regions.push({ name: name.trim(), virtualMiB: memoryMiB(virtual), residentMiB: memoryMiB(resident), dirtyMiB: memoryMiB(dirty), swappedMiB: memoryMiB(swapped) });
  }
  if (!regions.length) throw Error('vmmap summary has no resident region rows');
  const group = predicate => ({ residentMiB: regions.filter(r => predicate(r.name)).reduce((n, r) => n + r.residentMiB, 0) });
  const malloc = name => /^MALLOC(?:\s|_|$)/i.test(name), cg = name => /^CG image(?:\s|$)/i.test(name), io = name => /^IOSurface(?:\s|$)/i.test(name);
  return { regions, malloc: group(malloc), cgImage: group(cg), ioSurface: group(io), other: group(n => !malloc(n) && !cg(n) && !io(n)) };
}

/** Cache counters describe decoded strip allocations, not vmmap's CG image category. A missing snapshot
 * stays unmeasured; bounds are diagnostic fallback only. The live collector requires an exact snapshot. */
export function rendererFigures({ floor, endpoint, cacheBytes, cacheUpperBytes = 24 * MIB }) {
  if (![floor?.selfRssKb, endpoint?.selfRssKb, endpoint?.rssKb, cacheUpperBytes].every(n => Number.isFinite(n) && n >= 0))
    throw Error('missing renderer floor, endpoint or cache bound');
  const floorMiB = floor.selfRssKb / 1024, selfMiB = endpoint.selfRssKb / 1024, cacheUpperMiB = cacheUpperBytes / MIB;
  const stripCacheMiB = Number.isFinite(cacheBytes) && cacheBytes >= 0 ? cacheBytes / MIB : null;
  return { floorMiB, selfMiB, treeMiB: endpoint.rssKb / 1024, stripCacheMiB,
    remainderMiB: stripCacheMiB === null ? null : selfMiB - floorMiB - stripCacheMiB,
    stripCacheRangeMiB: [0, cacheUpperMiB], remainderRangeMiB: [selfMiB - floorMiB - cacheUpperMiB, selfMiB - floorMiB],
    cacheScope: stripCacheMiB === null ? 'cache snapshot unavailable; bound is min(pack decoded strip bytes, 24 MiB)' : 'decoded strip bytes from the measured renderer cache at its parked endpoint' };
}

/** Add one read-only observer to the temporary production source. Fail if its single call site drifts. */
export function rendererObserverSource(source) {
  const marker = '    app.delegate = hand\n    app.run()';
  const entry = 'let app = NSApplication.shared\nif arguments.isEmpty';
  if (source.split(marker).length !== 2 || source.split(entry).length !== 2) throw Error('renderer RSS observation seam changed');
  return source.replace(marker, '    app.delegate = hand\n    rendererRSSInstallObserver(hand)\n    app.run()')
    .replace(entry, 'if arguments == ["--renderer-rss-selftest"] {\n' +
      '    let host = HandHost()\n    rendererRSSInstallObserver(host, endOnEOF: true)\n' +
      '    withExtendedLifetime(host) { dispatchMain() }\n}\n' + entry);
}

export function rendererObserverClient(child) {
  let buffer = '', pending;
  const fail = error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } };
  child.stdio[3].on('error', fail);
  child.stdio[4].on('data', bytes => {
    buffer += bytes;
    if (buffer.length > 65536) return fail(Error('renderer snapshot exceeds 64 KiB'));
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const row = JSON.parse(line);
      if (!pending || buffer.length || row.pid !== child.pid || typeof row.loaded !== 'boolean' ||
          ![row.cacheBytes, row.pending].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('invalid renderer snapshot');
      const request = pending; pending = null; clearTimeout(request.timer); request.resolve(row);
    } catch (e) { fail(e); }
  });
  child.on('close', () => fail(Error('renderer closed before snapshot')));
  return () => new Promise((resolve, reject) => {
    if (pending) return reject(Error('renderer snapshot already pending'));
    pending = { resolve, reject, timer: setTimeout(() => fail(Error('renderer snapshot timed out')), 5000) };
    child.stdio[3].write('snapshot\n');
  });
}

export function stripCacheUpperBytes(frame) {
  const files = new Map();
  for (const row of Object.values(frame.stage?.table ?? {})) if (row.file && !files.has(row.file)) {
    if (!Array.isArray(row.cell) || row.cell.length !== 2 || !row.cell.every(n => Number.isSafeInteger(n) && n > 0) ||
        !Number.isSafeInteger(row.frames) || row.frames < 1) throw Error('invalid stage strip dimensions');
    files.set(row.file, row.cell[0] * row.cell[1] * row.frames * 4);
  }
  return Math.min(24 * MIB, [...files.values()].reduce((n, b) => n + b, 0));
}

export async function measureRendererSize({ size, character, target, startHost, samplerFactory = createCostSampler,
  wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, vmmap }) {
  const host = await startHost();
  let sampler, failure;
  try {
    const healthy = () => {
      if (host.child && (host.child.exitCode !== null || host.child.signalCode !== null)) throw Error('renderer host exited before endpoint');
    };
    if (typeof host.snapshot !== 'function') throw Error('renderer cache observer unavailable');
    sampler = samplerFactory({ rootPid: host.pid, includeChildren: 'rss' });
    await wait(1000); healthy();
    const read = () => {
      healthy();
      const h = sampler.samples.at(-1)?.hosts?.[host.pid];
      if (!h || !Array.isArray(h.rssTree)) throw Error('renderer process tree unavailable');
      return structuredClone(h);
    };
    const empty = await host.snapshot();
    if (empty.loaded || empty.cacheBytes !== 0) throw Error('renderer floor already loaded a character');
    await sampler.sample(); const floor = read();
    if (floor.rssTree.some(r => r.kind !== 'host')) throw Error('empty renderer already has children');
    const wire = stageWire(undefined, { size }); host.write(wire.character(character.frame));
    let loaded;
    for (let i = 0; i < 100; i++) {
      loaded = await host.snapshot();
      if (loaded.loaded) break;
      await wait(100);
    }
    if (!loaded?.loaded || loaded.requestedSize !== size) throw Error('renderer did not load the requested character size');
    const sequence = autoSequence({ pid: target.pid, windowId: target.id, rect: playRect(target.bounds), count: 40, spacingMs: 1500 });
    const actions = [], start = now();
    await sampler.start();
    await playSequence(sequence, { wire, write: host.write, sleep: wait, now, record: row => actions.push(row) });
    await wait(Math.max(0, 61000 - (now() - start))); await sampler.pause();
    await wait(6000); await sampler.sample(); const parkedStart = now();
    await wait(61000);
    const snapshot = await host.snapshot();
    if (snapshot.pid !== host.pid || !snapshot.loaded || !snapshot.shown || snapshot.size !== size || snapshot.pending !== 0)
      throw Error('renderer parked endpoint is hidden, downgraded or still decoding');
    await sampler.sample(); const endpoint = read(), parkedEnd = now();
    if (endpoint.rssTree.some(row => row.kind === 'decode')) throw Error('decode child still present at parked endpoint');
    const raw = await vmmap(host.pid);
    healthy();
    return { size, pid: host.pid, floor, endpoint, start, parkedStart, parkedEnd, actions, samples: sampler.samples,
      snapshot, ...rendererFigures({ floor, endpoint, cacheBytes: snapshot.cacheBytes, cacheUpperBytes: stripCacheUpperBytes(character.frame) }),
      vmmap: parseVmmapSummary(raw), vmmapRaw: raw };
  } catch (error) { failure = error; throw error; }
  finally {
    try { if (sampler) await sampler.stop({ finalSample: false }); }
    finally {
      const exit = await host.close();
      if (exit.code !== 0) {
        if (failure) failure.hostExit = exit;
        else throw Error(`renderer exited ${exit.code ?? exit.signal}`);
      }
    }
  }
}

const number = n => Number.isFinite(n) ? n.toFixed(3) : 'unmeasured';
export function reportMarkdown(result) {
  const lines = ['# Renderer-only RSS', '', 'All sizes use the production renderer with a private storage home and a read-only cache snapshot pipe. TextEdit is a separate process. Capture count: 0. These are diagnostic figures; the 160 MiB limit covers the whole process tree, including the microphone worker.', ''];
  for (const [size, r] of Object.entries(result.sizes)) {
    lines.push(`## ${size}`, '', '| Figure | MiB |', '|---|---:|',
      `| Floor, empty host self | ${number(r.floorMiB)} |`, `| Parked self RSS | ${number(r.selfMiB)} |`,
      `| Parked tree RSS, including children | ${number(r.treeMiB)} |`,
      `| Strip cache, exact | ${number(r.stripCacheMiB)} |`, `| Strip cache bounds | ${r.stripCacheRangeMiB.map(number).join(' to ')} |`,
      `| Remainder, exact | ${number(r.remainderMiB)} |`, `| Remainder bounds, self minus floor minus cache | ${r.remainderRangeMiB.map(number).join(' to ')} |`,
      `| vmmap MALLOC resident | ${number(r.vmmap.malloc.residentMiB)} |`, `| vmmap CG image resident | ${number(r.vmmap.cgImage.residentMiB)} |`,
      `| vmmap IOSurface resident | ${number(r.vmmap.ioSurface.residentMiB)} |`, `| vmmap other resident | ${number(r.vmmap.other.residentMiB)} |`, '',
      r.stripCacheMiB === null ? 'Exact strip cache and remainder are unmeasured. Bounds use decoded pack bytes and the 24 MiB cache cap.' :
        'Strip cache is the measured renderer allocation counter. Remainder is parked self RSS minus the empty-host floor and cache. CG image includes non-strip images; floor subtraction also includes allocations made after startup.', '',
      '| vmmap region | Virtual MiB | Resident MiB | Dirty MiB | Swapped MiB |', '|---|---:|---:|---:|---:|',
      ...r.vmmap.regions.map(row => `| ${row.name} | ${number(row.virtualMiB)} | ${number(row.residentMiB)} | ${number(row.dirtyMiB)} | ${number(row.swappedMiB)} |`), '');
  }
  if (result.error) lines.push(`Stopped: ${result.error}`, '');
  return lines.join('\n');
}

async function prepareRendererSession({ opts, work, guard, check, live, cleanups }) {
  const source = join(work, 'main.swift'), hostBin = join(work, 'consent-host'), helperBin = join(work, 'metadata-helper');
  writeFileSync(source, privateStageHome(rendererObserverSource(readFileSync(HOST_SOURCE, 'utf8')), work), { mode: 0o600 });
  const { swiftModuleCache } = await import('../swift-cache.mjs');
  for (const [src, binary] of [[source, hostBin], [join(ROOT, 'bench/hand/capture.swift'), helperBin]]) {
    check();
    // compileArgs selects the production -O recipe by the source identity, then replace its source path.
    const args = compileArgs(binary === hostBin ? HOST_SOURCE : src, binary, swiftModuleCache()).map(a => a === HOST_SOURCE ? source : a);
    if (binary === hostBin) args.splice(args.indexOf('-o'), 0, join(ROOT, 'bench/hand/stage-renderer-rss-observer.swift'));
    await guard.execute('/usr/bin/xcrun', args, { timeout: 300000, killSignal: 'SIGKILL', maxBuffer: 4 << 20 });
  }
  check();
  const character = prepareStageCharacter(work, opts.character);
  const helper = helperClient(helperBin, guard.execute);
  check();
  const { target } = await openTextEditFixture({ helper, live, work, cleanups, name: 'renderer-rss.txt' });
  return { character, target,
    startHost: async () => {
      const host = await startHandHost({ hostBin, style: 'sprite', capture: 'hidden', env: characterEnv(character.root), spawnChild: guard.spawn, observationPipe: true });
      host.snapshot = rendererObserverClient(host.child); return host;
    },
    vmmap: async pid => (await guard.execute('/usr/bin/vmmap', ['--summary', String(pid)], { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 << 20 })).stdout };
}

// Dependency seams keep safety and cleanup orchestration testable without host access.
export async function main(argv, { refuse = rendererRefusal,
  acquireLock = async () => (await import('../live-lock.mjs')).acquireLiveLock('/tmp/sleight-live.lock', { wait: false }),
  loadLive = () => import('../compat/live.mjs'), prepare = prepareRendererSession,
  collect = measureRendererSize, createGuard = stageRunGuard, log = console.log, error = console.error } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { error(e.message); return 2; }
  if (opts.dryRun) { log(dryRunPlan(opts).join('\n')); return 0; }
  const refused = refuse(opts);
  if (refused || !opts.out || !opts.character) { error(refused ?? '--out and --character are required'); return 2; }
  if (existsSync(opts.out)) { error('--out must be a new directory'); return 2; }
  // Check markers before any output bank, compilation, lock or app launch.
  let unlock;
  try { unlock = await acquireLock(); }
  catch (e) { error(e.message); return 3; }
  const guard = createGuard({ timeoutMs: 20 * 60000 }), cleanups = [];
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => [s, () => guard.abort(Error(s))]));
  for (const [s, fn] of Object.entries(handlers)) process.on(s, fn);
  const result = { schema: 'sleight.renderer-rss/1', sizes: {}, started: new Date().toISOString() };
  let code = 0, work, outputCreated = false, cleanupFailed = false;
  const ownerWatch = setInterval(() => {
    const reason = refuse(opts);
    if (reason) guard.abort(Error(reason));
  }, 250);
  try {
    const check = () => {
      guard.signal.throwIfAborted();
      const reason = refuse(opts);
      if (reason) { guard.abort(Error(reason)); guard.signal.throwIfAborted(); }
    };
    check();
    const live = await loadLive();
    if ((await live.appState('com.apple.TextEdit')).running) throw Error('TextEdit is already running; left untouched');
    work = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'sleight-renderer-rss-')));
    const session = await prepare({ opts, work, guard, check, live, cleanups });
    check();
    result.character = session.character.identity;
    mkdirSync(opts.out, { mode: 0o700 }); outputCreated = true;
    const wait = async ms => {
      const until = Date.now() + ms;
      do { check(); await new Promise(r => setTimeout(r, Math.min(250, Math.max(0, until - Date.now())))); } while (Date.now() < until);
      check();
    };
    for (const size of opts.sizes) {
      check();
      const record = await collect({ ...session, size, wait });
      check();
      writeFileSync(join(opts.out, `${size}-vmmap.txt`), record.vmmapRaw, { mode: 0o600 });
      delete record.vmmapRaw; result.sizes[size] = record;
      writeFileSync(join(opts.out, 'renderer-rss.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    }
  } catch (e) {
    const cause = guard.signal.aborted ? guard.signal.reason : e;
    result.error = tilde(cause.message); error(result.error); code = 1;
  }
  finally {
    clearInterval(ownerWatch);
    try { await guard.close(); } catch (e) { cleanupFailed = true; error(tilde(e.message)); }
    for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (e) { cleanupFailed = true; error(tilde(e.message)); }
    for (const [s, fn] of Object.entries(handlers)) process.removeListener(s, fn);
    if (!cleanupFailed) {
      if (work) rmSync(work, { recursive: true, force: true });
      await unlock();
    } else { error('Cleanup unproved; private bank and live lock retained'); code = 1; }
  }
  result.finished = new Date().toISOString();
  if (outputCreated && existsSync(opts.out) && lstatSync(opts.out).isDirectory()) {
    writeFileSync(join(opts.out, 'renderer-rss.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(opts.out, 'renderer-rss.md'), reportMarkdown(result), { mode: 0o600 });
  }
  log(reportMarkdown(result));
  return code;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
