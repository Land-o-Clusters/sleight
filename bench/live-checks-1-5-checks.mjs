import { readFileSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { jpegSize } from '../plugins/sleight/lib/direct-browser/screenshot.mjs';
import { pdfBytes } from './live-checks-1-5-fixtures.mjs';

const requireValue = (condition, message) => { if (!condition) throw Error(message); };
const text = value => value?.text ?? '';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function refFor(result, label) {
  const lines = text(result).split('\n').filter(line => line.includes('"' + label + '"') && /\[ref=/.test(line));
  requireValue(lines.length === 1, 'Expected one observed ref for ' + label);
  const ref = /\[ref=((?:f\d+)?e\d+|[sx]\d+)\]/.exec(lines[0])?.[1];
  requireValue(ref, 'Missing observed ref for ' + label);
  return ref;
}
async function open(runtime, path) {
  const result = await runtime.call('browser_open', { url: runtime.origin + path });
  const tab = /^(t[A-Za-z0-9_-]{1,64})(?:\s|$)/m.exec(text(result))?.[1];
  requireValue(tab, 'No owned tab handle'); return { tab, result };
}
const read = (runtime, tab, options = {}) => runtime.call('browser_read', { tab, ...options });
const act = (runtime, tab, steps, options = {}, policy) => runtime.call('browser_act', { tab, steps, ...options }, policy);
const refusal = (result, kind) => {
  const line = text(result).split('\n').find(line => /refused|not run:|Nothing was sent|confirmation required|not attempted/i.test(line) && kind.test(line));
  requireValue(line, 'Expected a named safety refusal: ' + text(result).slice(0, 500));
  return line.slice(0, 500);
};

export function parseMetrics(value) {
  const match = /Metrics width=(\d+) height=(\d+) dpr=([\d.]+) dark=(true|false) reduced=(true|false) touch=(\d+)/.exec(value);
  requireValue(match, 'Fixture viewport metrics unavailable');
  return { width: +match[1], height: +match[2], dpr: +match[3], dark: match[4] === 'true', reduced: match[5] === 'true', touch: +match[6] };
}
export function wholeMetrics(value) {
  const match = /Items read: (\d+) \(top first\)\. Seconds: ([\d.]+)\. Clicks: (\d+)\./.exec(value);
  requireValue(match, 'Whole-thread metrics unavailable');
  return { items: +match[1], seconds: +match[2], clicks: +match[3], complete: /^Complete: yes\./m.test(value) };
}
export function gifInfo(bytes) {
  requireValue(bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()), 'Invalid GIF header');
  let at = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0, ended = false;
  const need = n => requireValue(at + n <= bytes.length, 'Truncated GIF');
  const blocks = () => { for (;;) { need(1); const n = bytes[at++]; if (!n) return; need(n); at += n; } };
  while (at < bytes.length) {
    const kind = bytes[at++];
    if (kind === 0x3b) { ended = true; break; }
    if (kind === 0x21) { need(1); at++; blocks(); }
    else if (kind === 0x2c) {
      need(9); const flags = bytes[at + 8]; at += 9;
      if (flags & 0x80) { const n = 3 * 2 ** ((flags & 7) + 1); need(n); at += n; }
      need(1); at++; blocks(); frames++;
    } else throw Error('Invalid GIF block');
  }
  requireValue(ended && at === bytes.length && frames > 0, 'Incomplete GIF');
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), frames, bytes: bytes.length };
}

function ownedArtifact(path, kind, started) {
  const home = userInfo().homedir;
  if (path.startsWith('~/')) path = join(home, path.slice(2));
  const bank = join(home, 'Library/Application Support/sleight', kind);
  const rel = relative(bank, path);
  requireValue(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Artifact outside sleight ' + kind);
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path && stat.uid === process.getuid() && stat.mtimeMs >= started - 2000,
    'Artifact ownership or creation time unproved');
  return path;
}
async function eventually(runtime, predicate, message) {
  for (let i = 0; i < 30; i++) {
    runtime.signal?.throwIfAborted();
    if (predicate()) return;
    await sleep(100, undefined, { signal: runtime.signal });
  }
  throw Error(message);
}

export async function runCheck(id, runtime) {
  if (id === 'turn-stats') return { skipReason: 'Turn stats need the Claude Code mod lifecycle; this scripted tool caller cannot verify them.' };
  if (id === 'watch-tick') return { skipReason: 'The sleight-mcp watch CLI has no unscheduled one-tick mode. run-now needs an installed watch; installing launchd is outside this check.' };
  const measured = runtime.measured ??= {};
  if (id === 'screenshot') {
    const { tab } = await open(runtime, '/visual');
    const captured = await read(runtime, tab, { screenshot: true });
    const metrics = parseMetrics(text(captured));
    Object.assign(measured, { dpr: metrics.dpr, cssSize: { width: metrics.width, height: metrics.height }, imageCount: captured.images?.length ?? 0 });
    requireValue(captured.images?.length === 1, 'Screenshot returned no pixels');
    const size = jpegSize(captured.images[0].data);
    requireValue(size.width > 0 && size.height > 0 && Math.max(size.width, size.height) <= 1000, 'Screenshot pixel bounds failed');
    const protectedTab = await open(runtime, '/protected');
    const protectedRead = await read(runtime, protectedTab.tab, { screenshot: true });
    requireValue(!protectedRead.images?.length && /Screenshot skipped.*protected/i.test(text(protectedRead)), 'Protected-field page returned pixels or no protected-field refusal');
    return { dpr: metrics.dpr, cssSize: { width: metrics.width, height: metrics.height }, pixels: size, protectedPixels: 0,
      zoom125: { status: 'skip', reason: 'Turbo exposes no page zoom operation. No browser shortcut or raw CDP zoom is substituted.' } };
  }
  if (id === 'motion-frames') {
    const { tab, result } = await open(runtime, '/motion');
    const frames = await act(runtime, tab, [{ do: 'hover', ref: refFor(result, 'Orchid Actions') }], { frames: 3 });
    requireValue(frames.images?.length === 3 && /Motion frames/.test(text(frames)), 'Motion frame sequence missing');
    const sizes = frames.images.map(image => jpegSize(image.data));
    requireValue(sizes.every(size => Math.max(size.width, size.height) <= 480), 'Motion frame exceeds 480 px');
    return { frames: sizes.length, sizes, timing: text(frames).split('\n').find(line => line.includes('Motion frames')) };
  }
  if (id === 'points') {
    if (!runtime.pointInput) return { skipReason: 'Worker point input was not enabled with SLEIGHT_POINT_INPUT=1.' };
    const { tab } = await open(runtime, '/points');
    const latest = await read(runtime, tab);
    const view = /view=([a-f0-9]{16})/.exec(text(latest))?.[1]; requireValue(view, 'Point view unavailable');
    await act(runtime, tab, [{ do: 'click', x: 80, y: 100, view }]);
    await eventually(runtime, () => runtime.fixtures.state('/points').plain === 1, 'Plain point did not click');
    measured.plainClicks = 1;
    const fresh = await read(runtime, tab), payView = /view=([a-f0-9]{16})/.exec(text(fresh))?.[1];
    requireValue(payView, 'Fresh payment point view unavailable');
    const stopped = await act(runtime, tab, [{ do: 'click', x: 80, y: 180, view: payView }], {}, { allowError: true });
    const reason = refusal(stopped, /pay|payment|confirm|sensitive|covered by button; use its ref/i);
    await sleep(200, undefined, { signal: runtime.signal });
    requireValue(runtime.fixtures.state('/points').pay === 0, 'Payment point reached the page');
    return { plainClicks: 1, payClicks: 0, payRefused: true, refusal: reason, workerPointInput: true };
  }
  if (id === 'mailto-detach') {
    const before = await runtime.frontmost();
    if (!before.bundleId || !before.pid) return { skipReason: 'NSWorkspace frontmost application could not be identified, so no mailto action was sent.' };
    const { tab, result } = await open(runtime, '/mailto');
    const action = await act(runtime, tab, [{ do: 'click', ref: refFor(result, 'Open fixture mail link') }], {}, { allowError: true });
    const afterRead = await read(runtime, tab);
    const notification = (text(action) + '\n' + text(afterRead)).split('\n').find(line => /Native (?:debugger detach|navigation) attempted/.test(line));
    const after = await runtime.frontmost();
    Object.assign(measured, { before, after, notification });
    requireValue(notification, 'HTTP-to-mailto returned no native navigation notification');
    requireValue(before.bundleId === after.bundleId && before.pid === after.pid, 'Frontmost application changed after mailto attempt');
    return { notification, before, after, noMailAppObserved: true,
      limitation: 'NSWorkspace before/after samples cannot rule out a background launch or a transient activation between samples. Native UI outcome remains unconfirmed.' };
  }
  if (id === 'viewport') {
    const { tab, result } = await open(runtime, '/visual');
    const before = parseMetrics(text(result));
    measured.before = before;
    const windowBefore = await runtime.windowSizes?.();
    if (windowBefore) requireValue(windowBefore.length > 0, 'Private browser window bounds unavailable');
    const changed = await act(runtime, tab, [{ do: 'viewport', width: 640, height: 480, color_scheme: 'dark', reduced_motion: true, touch: true }]);
    requireValue(/viewport 640x480/.test(text(changed)), 'Viewport step did not report requested size');
    await sleep(250, undefined, { signal: runtime.signal });
    const during = parseMetrics(text(await read(runtime, tab)));
    measured.during = during;
    requireValue(during.width === 640 && during.height === 480 && during.dark && during.reduced && during.touch > 0, 'Viewport/media/touch readback mismatch');
    const reset = await act(runtime, tab, [{ do: 'viewport' }]);
    requireValue(/restored/.test(text(reset)), 'Viewport restoration not confirmed');
    await sleep(250, undefined, { signal: runtime.signal });
    const after = parseMetrics(text(await read(runtime, tab)));
    measured.after = after;
    requireValue(['width', 'height', 'dark', 'reduced', 'touch'].every(key => before[key] === after[key]), 'Viewport did not return to its original size/media/touch');
    const windowAfter = await runtime.windowSizes?.();
    if (windowBefore && windowAfter) requireValue(JSON.stringify(windowBefore) === JSON.stringify(windowAfter), 'Browser window bounds changed');
    return { before, during, after, ...(windowBefore ? { windowBefore, windowAfter } : {}), released: true };
  }
  if (id === 'download') {
    const started = Date.now(), { tab, result } = await open(runtime, '/download');
    const saved = await act(runtime, tab, [{ do: 'download', ref: refFor(result, 'Download fixture PDF') }]);
    const file = /: saved (\{[^\n]+\})/.exec(text(saved))?.[1]; requireValue(file, 'No completed download receipt');
    const receipt = JSON.parse(file), path = ownedArtifact(receipt.path, 'downloads', started);
    runtime.ownFile(path);
    const bytes = readFileSync(path);
    Object.assign(measured, { bytes: bytes.length, sha256: digest(bytes), type: receipt.type });
    requireValue(bytes.equals(pdfBytes) && receipt.bytes === pdfBytes.length && receipt.type === 'application/pdf', 'Downloaded PDF bytes or MIME type mismatch');
    unlinkSync(path);
    return { bytes: bytes.length, sha256: digest(bytes), type: receipt.type, removed: true };
  }
  if (id === 'pdf') {
    const { tab } = await open(runtime, '/document.pdf');
    const result = await read(runtime, tab);
    measured.readCharacters = text(result).length;
    requireValue(/# PDF text/.test(text(result)) && /Page 1\/1:/.test(text(result)) && /ABC/.test(text(result)), 'Sandboxed PDF helper did not extract fixture text');
    return { pages: 1, expectedText: 'ABC', readCharacters: text(result).length, sandboxedHelper: true };
  }
  if (id === 'developer-reads') {
    const { tab, result } = await open(runtime, '/developer');
    // Developer domains are enabled on the first developer read, before the fixture emits events.
    await read(runtime, tab, { console: true, network: true, performance: true });
    await act(runtime, tab, [{ do: 'click', ref: refFor(result, 'Log fixture') }]);
    const observed = await read(runtime, tab, { console: true, network: true, performance: true });
    const logs = +( /Console: (\d+) retained/.exec(text(observed))?.[1] ?? 0);
    const requests = +( /Network: (\d+) retained/.exec(text(observed))?.[1] ?? 0);
    Object.assign(measured, { consoleEvents: logs, networkRequests: requests, developerText: text(observed) });
    requireValue(logs > 0, 'Developer console returned no fixture events');
    requireValue(requests > 0, 'Developer network returned no fixture events');
    requireValue(/Performance:/.test(text(observed)) && !/metrics enabled: unavailable/.test(text(observed)) && /^TaskDuration: \d/m.test(text(observed)), 'Developer performance metrics unavailable');
    return { consoleEvents: logs, networkRequests: requests, developerText: text(observed) };
  }
  if (id === 'paste') {
    const before = await runtime.clipboard(), { tab, result } = await open(runtime, '/paste');
    const pasted = await act(runtime, tab, [{ do: 'paste', ref: refFor(result, 'Note'), text: 'LC1 note' }]);
    requireValue(/paste sent:.*clipboard restored/i.test(text(pasted)), 'Textarea paste did not restore clipboard');
    await eventually(runtime, () => runtime.fixtures.state('/paste').note === 'LC1 note', 'Textarea paste value mismatch');
    measured.textarea = true;
    const fresh = await read(runtime, tab);
    const grid = await act(runtime, tab, [{ do: 'paste', ref: refFor(fresh, 'Paste grid'), text: 'Oak\t1\nPine\t2' }]);
    requireValue(/paste sent:.*clipboard restored/i.test(text(grid)), 'TSV paste did not restore clipboard');
    await eventually(runtime, () => JSON.stringify(runtime.fixtures.state('/paste').grid) === '[["Oak","1"],["Pine","2"]]', 'TSV grid value mismatch');
    const after = await runtime.clipboard();
    requireValue(before.equals(after), 'Clipboard text was not restored');
    return { textarea: true, gridRows: 2, gridColumns: 2, clipboardRestored: true,
      clipboardVerification: 'pbpaste text bytes compared in memory; clipboard content and hashes are not recorded; non-text representations not independently verified' };
  }
  if (id === 'turn-gif') {
    const started = Date.now(), { tab, result } = await open(runtime, '/record');
    await runtime.call('browser_fill', { tab, fields: [{ ref: refFor(result, 'Name'), value: 'LC1' }] });
    const filled = await read(runtime, tab);
    await act(runtime, tab, [{ do: 'click', ref: refFor(filled, 'First action') }]);
    const fresh = await read(runtime, tab);
    await act(runtime, tab, [{ do: 'click', ref: refFor(fresh, 'Second action') }]);
    const ended = await runtime.finishTurn();
    const match = /^Recording: (.+?) \((\d+) frames/.exec(ended.recording ?? '');
    requireValue(match, 'Recorded turn returned no GIF path or frames');
    const path = ownedArtifact(match[1], 'recordings', started); runtime.ownFile(path);
    const info = gifInfo(readFileSync(path));
    Object.assign(measured, info);
    requireValue(info.frames >= 2 && info.frames === +match[2] && info.width <= 640 && info.height <= 480 && info.bytes <= 12 * 1024 * 1024, 'GIF frame count or size failed');
    unlinkSync(path);
    return { ...info, removed: true };
  }
  if (id === 'whole-thread') {
    const { tab } = await open(runtime, '/whole/lc1-chat/');
    const result = await read(runtime, tab, { whole: { direction: 'both', max_items: 200, max_seconds: 45, max_clicks: 5 } });
    Object.assign(measured, wholeMetrics(text(result)));
    requireValue(measured.complete && measured.items === 120, 'Whole-thread read incomplete or wrong item count: ' + text(result).slice(0, 900));
    requireValue(runtime.fixtures.whole.posts === 0 && runtime.fixtures.whole.dangers.length === 0, 'Whole-thread fixture recorded unsafe effects');
    return measured;
  }
  if (id === 'cookie-wall') {
    const { tab, result } = await open(runtime, '/cookie');
    const stopped = await act(runtime, tab, [{ do: 'click', ref: refFor(result, 'Accept all cookies') }], {}, { allowError: true });
    const reason = refusal(stopped, /cookie|consent|optional/i);
    requireValue(!runtime.fixtures.state('/cookie').accepted, 'Cookie Accept reached the fixture');
    const fresh = await read(runtime, tab);
    await act(runtime, tab, [{ do: 'click', ref: refFor(fresh, 'Reject all') }]);
    await eventually(runtime, () => runtime.fixtures.state('/cookie').rejected === true, 'Cookie Reject did not reach fixture');
    requireValue(!runtime.fixtures.state('/cookie').accepted, 'Cookie Accept reached fixture before rejection');
    return { acceptRefused: true, rejected: true, refusal: reason };
  }
  throw Error('Unknown check ' + id);
}
