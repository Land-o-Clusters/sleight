// Headless worker measurement. The delivery mode starts only silent afplay children in a private bank.
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { swiftModuleCache } from '../swift-cache.mjs';

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'requests' }, seconds: { type: 'string', default: '60' },
  rounds: { type: 'string', default: '3' }, period: { type: 'string', default: '0.5' },
  source: { type: 'string', default: new URL('../../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname },
} });
if (!['requests', 'blocked', 'watch', 'delivery'].includes(values.mode) || ![values.seconds, values.rounds, values.period].every(v => Number.isFinite(Number(v))) ||
    Number(values.seconds) < 1 || Number(values.seconds) > 120 || ![1, 2, 3].includes(Number(values.rounds)) ||
    Number(values.period) < 0.1 || Number(values.period) > 2) throw Error('bounded worker measurement arguments required');
const root = realpathSync(mkdtempSync('/private/tmp/sleight-worker-cost-'));
function run(file, args, timeout) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error || result.status !== 0) throw Error(`${file}: ${result.error?.message ?? result.signal ?? result.status}`);
}
const product = readFileSync(values.source, 'utf8');
let buildSource = values.source;
if (values.mode === 'delivery') {
  // Instrument a private source copy for notification/census timestamps only. Idle cost uses the unmodified source.
  let diagnostic = product.replace('= { [weak self] _, _ in self?.invalidate() }', () => `= { [weak self] count, addresses in
    let row: [String: Any] = ["event": "notification", "time": CACurrentMediaTime(),
      "processList": (0..<Int(count)).contains { addresses[$0].mSelector == kAudioHardwarePropertyProcessObjectList }]
    FileHandle.standardError.write(try! JSONSerialization.data(withJSONObject: row) + Data([10]))
    self?.invalidate() }`);
  const site = '    var active = false\n    for process in processes {';
  if (!diagnostic.includes(site) || diagnostic === product) throw Error('worker diagnostic seams missing');
  diagnostic = diagnostic.replace(site, `
    let pids = processes.compactMap { NarrationAudio.system.word($0, kAudioProcessPropertyPID,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain) }
    let row: [String: Any] = ["event": "census", "time": CACurrentMediaTime(), "pids": pids]
    FileHandle.standardError.write(try! JSONSerialization.data(withJSONObject: row) + Data([10]))
${site}`);
  buildSource = join(root, 'diagnostic.swift'); writeFileSync(buildSource, diagnostic);
}
const sourceSha256 = createHash('sha256').update(product).digest('hex');
console.log(JSON.stringify({ bank: root, mode: values.mode, source: values.source, sourceSha256,
  buildSourceSha256: createHash('sha256').update(readFileSync(buildSource)).digest('hex') }));
run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), buildSource, '-o', join(root, 'worker')], 600000);
run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), new URL('call-worker-cost.swift', import.meta.url).pathname,
  '-o', join(root, 'runner')], 600000);
run(join(root, 'runner'), [join(root, 'worker'), values.mode, values.seconds, values.rounds, values.period, sourceSha256],
  values.mode === 'delivery' ? 60000 : (Number(values.seconds) + 10) * Number(values.rounds) * 1000);
