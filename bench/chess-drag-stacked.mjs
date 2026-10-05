// Focused owned-game trials through the production relay; no shared engine child.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { callLocalTool } from '../plugins/sleight/lib/launch.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { screenshotCoordinates, stackedChessTrial } from './chess-drag-trial.mjs';

const root = resolve(import.meta.dirname, '..');
const call = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 30000, ...options });
const fixture = join(root, '.dev/chess-drag-fixture');
if (process.argv[2] === '--prepare') {
  mkdirSync(join(root, '.dev'), { recursive: true });
  call('swiftc', ['-O', '-module-cache-path', '/private/tmp/sleight-chess-stacked-swift-cache', '-o', fixture, 'bench/chess-drag-fixture.swift']);
  process.exit(0);
}
if (process.argv[2] === '--cleanup') {
  const input = process.argv[3], output = process.argv[4];
  if (![input, output].every(path => /^docs\/benchmarks\/[a-z0-9.-]+\.json$/.test(path ?? ''))) throw new Error('Cleanup needs two results filenames');
  const original = JSON.parse(readFileSync(join(root, input), 'utf8'));
  const results = { input, paths: [...new Set(original.runs.flatMap(run => run.paths))], cleanup: [] };
  for (const path of results.paths) {
    try { results.cleanup.push({ path, result: JSON.parse(call(fixture, [JSON.stringify({ op: 'close', path })])) }); }
    catch (e) { results.cleanup.push({ path, error: e.message }); }
  }
  try { results.finalChess = JSON.parse(call(fixture, [JSON.stringify({ op: 'snapshot' })])); }
  catch (e) { results.finalSnapshotError = e.message; }
  results.closedAllOpenedWindows = results.cleanup.every(item => item.result?.ok);
  results.exitCode = results.closedAllOpenedWindows ? 0 : 73;
  writeFileSync(join(root, output), JSON.stringify(results, null, 2).split(homedir()).join('~') + '\n');
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.exitCode);
}
const output = process.argv[2];
if (!/^docs\/benchmarks\/[a-z0-9.-]+\.json$/.test(output ?? '')) throw new Error('Use a docs/benchmarks results filename');
if (process.argv[3] !== '--measure') throw new Error('Use --measure to verify Chess points from the owned screenshot; AX coordinates are reversed');
const dir = mkdtempSync('/private/tmp/sleight-chess-stacked-');
const results = { started: new Date().toISOString(), runs: [], approvals: [], trace: [] };
const sanitize = value => JSON.stringify(value, null, 2).split(homedir()).join('~') + '\n';
const save = () => writeFileSync(join(root, output), sanitize(results));
const native = request => {
  const reply = JSON.parse(call(fixture, [JSON.stringify(request)]));
  if (!reply.ok) throw new Error(reply.error);
  return reply;
};
const approve = message => {
  const response = call(process.execPath, ['bench/approve.mjs'], { input: JSON.stringify({ mcp_server_name: 'plugin:sleight:computer', message }) });
  const action = response ? JSON.parse(response).hookSpecificOutput.action : 'decline';
  results.approvals.push({ message, action }); save(); return action;
};
const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
const pending = new Map(); let nextId = 1, buffer = '', stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
clientOut.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    pending.get(message.id)?.(message); pending.delete(message.id);
  }
});
const relay = createRelay({
  clientIn, clientOut, serverIn, serverOut, sessionId: `stacked-chess-${process.pid}`,
  inputLease: new InputLease({ holder: `stacked Chess live ${process.pid}` }),
  localTools: { tools: [{ name: 'drag' }], call: callLocalTool,
    target: async args => {
      const reply = JSON.parse(call('/usr/bin/osascript', ['-l', 'JavaScript', 'plugins/sleight/lib/lease-target.js', JSON.stringify(args)]));
      if (!reply.ok) throw new Error(reply.error); return reply.target;
    },
  },
  ask: async message => approve(message),
  trace: (direction, message) => { results.trace.push({ t: new Date().toISOString(), direction, message }); save(); },
});
const drag = args => new Promise(resolve => {
  const id = nextId++; pending.set(id, resolve);
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'drag', arguments: args } }) + '\n');
});
let measured;
const coordinates = async source => {
  if (!measured) {
    const image = join(dir, 'owned-board.png'), plan = join(dir, 'points.json');
    call('/usr/sbin/screencapture', ['-x', '-l', String(source.windowId), image]);
    results.coordinateMeasurement = { windowId: source.windowId, bounds: source.bounds, image, plan,
      screenshotSha256: createHash('sha256').update(readFileSync(image)).digest('hex') };
    save(); console.log(sanitize({ coordinateMeasurement: results.coordinateMeasurement }));
    const deadline = Date.now() + 120000;
    while (!existsSync(plan)) {
      if (stopping || Date.now() > deadline) throw new Error('Screenshot points unavailable; stopped before dragging');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    measured = JSON.parse(readFileSync(plan, 'utf8'));
    results.coordinateMeasurement.measured = measured; save();
  }
  return screenshotCoordinates(measured, source);
};
// Saved Human/Human games avoid an automatic computer reply. Board geometry is
// measured from the owned screenshot because Chess AX square y is reversed.
const game = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Variant</key><string>Chess</string><key>WhiteType</key><string>human</string><key>BlackType</key><string>human</string>
<key>White</key><string>Sleight White</string><key>Black</key><string>Sleight Black</string>
<key>Position</key><string>rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1</string>
<key>Holding</key><string></string><key>Moves</key><string></string><key>MBCBoardSpin</key><integer>180</integer>
<key>MBCBoardAngle</key><integer>60</integer><key>MBCSpeakMoves</key><false/><key>MBCSpeakHumanMoves</key><false/>
</dict></plist>`;
let failed = false, cleanupFailed = false;
try {
  if (approve('Allow Claude to drag in Chess? It moves your pointer for a few seconds.') !== 'accept') throw new Error('Benchmark allowlist refused Chess');
  // Open saved documents directly, including when Chess is not running. Never
  // launch an untitled game or send a generic app-wide close command.
  results.initialChess = native({ op: 'snapshot' }); save();
  for (let n = 1; n <= 3 && !stopping; n++) {
    const paths = ['target', 'cover'].map(kind => join(dir, `sleight-stacked-${n}-${kind}.game`));
    let partial;
    const run = await stackedChessTrial(paths, {
      cancelled: () => stopping, snapshot: () => native({ op: 'snapshot' }).windows,
      open: path => { writeFileSync(path, game); call('/usr/bin/open', ['-g', '-a', 'Chess', path]); },
      place: path => native({ op: 'place', path }), read: path => native({ op: 'read', path }),
      closePath: path => native({ op: 'close', path }), drag, coordinates,
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
      checkpoint: run => { partial = run; results.activeRun = run; save(); },
    });
    results.runs.push({ n, ...run }); delete results.activeRun;
    if (!run.passed || partial?.cleanup.some(c => c.error)) failed = true;
    if (!run.closedAllOpenedWindows) { cleanupFailed = true; save(); break; }
    save(); console.log(sanitize(results.runs.at(-1)));
  }
} catch (e) { results.error = String(e.message || e); results.stdout = e.stdout?.toString(); failed = true; }
finally {
  relay.close(); results.finished = new Date().toISOString(); results.exitCode = cleanupFailed ? 73 : stopping ? 130 : failed ? 1 : 0; save();
}
process.exitCode = results.exitCode;
