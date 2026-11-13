// Offline guard timing only. Candidate commands are strings and are never executed.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [modulePath = 'plugins/sleight/hooks/preapproved-write-guard.mjs', sizeText = '65536', runsText = '1', budgetFlag] = process.argv.slice(2);
const { preapprovedWriteTarget } = await import(pathToFileURL(resolve(modulePath)));
const bytes = Number(sizeText), runs = Number(runsText);
if (![65536, 262144].includes(bytes) || !Number.isInteger(runs) || runs < 1 || runs > 20) throw Error('invalid timing arguments');
if (budgetFlag !== undefined && budgetFlag !== '--assert-budget') throw Error('invalid budget flag');
const stat = async path => ({ realPath: path });
for (const shape of ['lines', 'spaces', 'quotes']) {
  const header = "python3 <<'PY'\n", footer = '\nPY';
  const unit = shape === 'lines' ? '# padding' + ' '.repeat(70) + '\n' : shape === 'spaces' ? ' ' : "' padding ";
  const bodyBytes = bytes - header.length - footer.length;
  const command = header + unit.repeat(Math.ceil(bodyBytes / unit.length)).slice(0, bodyBytes) + footer;
  const timings = [];
  const cpuTimes = [];
  let target;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    target = await preapprovedWriteTarget({ tool: 'Bash', command }, { stat, home: '/fixture', configDir: '/fixture/.claude', platform: 'darwin' });
    timings.push(performance.now() - start);
    const cpu = process.cpuUsage(cpuStart); cpuTimes.push((cpu.user + cpu.system) / 1000);
  }
  console.log(JSON.stringify({ shape, bytes: Buffer.byteLength(command), runs, timingsMs: timings, cpuMs: cpuTimes, target: target ?? null }));
  if (budgetFlag && timings.some(ms => ms >= (bytes === 65536 ? 50 : 200))) process.exitCode = 1;
}
