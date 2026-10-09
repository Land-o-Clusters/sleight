// No-model footprint probes. Offline mode never starts the engine or touches an app.
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const currentRoot = fileURLToPath(new URL('../', import.meta.url));

const codecs = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules';
export const loadCodec = name => import(pathToFileURL(join(codecs, name, 'lib', name === 'pngjs' ? 'png.js' : '../index.js')).href);
export async function pane(code, shot, load = loadCodec) {
  let frame;
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('cua', 'nodeRepl', 'Buffer', 'load', code.replaceAll('import(', 'load('));
  await run({ getApp: async () => ({ getScreenshot: async () => shot }) }, { write: line => { frame = JSON.parse(line.slice('SLEIGHT_FRAME '.length)); } }, Buffer, load);
  return frame;
}
export function acquisitionTraces(root = join(tmpdir(), 'sleight-bench')) {
  const rows = [];
  for (const directory of readdirSync(root).filter(d => d.startsWith('2026-10-09T22-'))) {
    for (const task of readdirSync(join(root, directory)).filter(d => d.startsWith('sleight-'))) {
      for (const file of readdirSync(join(root, directory, task)).filter(f => /^trace-.*\.jsonl$/.test(f))) {
        const events = readFileSync(join(root, directory, task, file), 'utf8').trim().split('\n').map(JSON.parse);
        const start = events.find(e => e.direction === 'to-server' && e.msg.id === 'sleight-acquire-0');
        const end = events.find(e => e.direction === 'from-server' && e.msg.id === 'sleight-acquire-0');
        if (!start || !end) continue;
        rows.push({ trace: `${directory}/${task}/${file}`, ms: Date.parse(end.t) - Date.parse(start.t),
          events: events.filter(e => e.t >= start.t && e.t <= end.t).map(e => ({ t: e.t, direction: e.direction,
            id: e.msg.id, method: e.msg.method, message: e.msg.params?.message, action: e.msg.result?.action })) });
      }
    }
  }
  return rows.sort((a, b) => b.ms - a.ms);
}
async function measured(name, repetitions, operation) {
  const load = loadavg(), cpu = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < repetitions; i++) await operation();
  const used = process.cpuUsage(cpu);
  return { name, repetitions, ms: performance.now() - start, cpuSeconds: (used.user + used.system) / 1e6, load };
}
async function offline(root = currentRoot) {
  const { InputLease } = await import(pathToFileURL(join(root, 'plugins/sleight/lib/input-lease.mjs')));
  const { snapshotCode } = await import(pathToFileURL(join(root, 'plugins/sleight/hooks/snapshot.ts')));
  const directory = mkdtempSync(join(tmpdir(), 'sleight-footprint-'));
  const results = [];
  try {
    const lease = new InputLease({ directory });
    const window = { app: 'Calculator', appId: 'com.apple.calculator', title: 'Calculator', url: null };
    results.push(await measured('lease acquire/renew/release', 1000, () => { lease.acquire(window); lease.renew(); lease.release(); }));
    lease.close();
    const { default: { PNG } } = await loadCodec('pngjs');
    const { default: jpeg } = await loadCodec('jpeg-js');
    const data = Buffer.alloc(674 * 408 * 4, 255);
    // Synthetic flat app window. No private screenshot or app is read.
    const png = PNG.sync.write({ width: 674, height: 408, data });
    const jpg = jpeg.encode({ width: 674, height: 408, data }, 70).data;
    for (const [format, shot] of [['png', png], ['jpeg', jpg]]) for (const terminal of [false, true]) {
      const code = snapshotCode('Calculator', 46, 13, terminal);
      results.push({ ...await measured(`pane ${format} ${terminal ? 'terminal' : 'desktop'}`, 12, () => pane(code, shot)), bytes: shot.length });
    }
    return { mode: 'offline', results, acquisitions: acquisitionTraces() };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv[2] === 'pairs') {
    const baseline = resolve(process.argv[3]), output = process.argv[4];
    const report = { stamp: new Date().toISOString(), mode: 'offline pairs', runs: [] };
    for (let repetition = 1; repetition <= 3; repetition++) {
      for (const [arm, root] of repetition % 2 ? [['before', baseline], ['after', currentRoot]] : [['after', currentRoot], ['before', baseline]]) {
        const measured = await offline(root);
        report.runs.push({ arm, repetition, stamp: new Date().toISOString(), results: measured.results });
        writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report.runs.at(-1)));
      }
    }
  } else {
    const report = { stamp: new Date().toISOString(), ...await offline() };
    if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, acquisitions: report.acquisitions.slice(0, 1) }, null, 2));
  }
}
