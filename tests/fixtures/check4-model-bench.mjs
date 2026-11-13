// Offline child process for the real Check 4 orchestration. Never imports the live benchmark.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--check4-config') + 1]));
if (process.env.CHECK4_FAKE_WAIT === '1') { await new Promise(resolve => setTimeout(resolve, 500)); process.exit(0); }
if (process.env.CHECK4_FAKE_CRASH === '1') process.exit(17);
writeFileSync(join(config.dir, 'fake-env.json'), JSON.stringify({ SLEIGHT_BENCH_HAND: process.env.SLEIGHT_BENCH_HAND,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }));
writeFileSync(config.transcript, JSON.stringify({ type: 'result', is_error: false }) + '\n');
writeFileSync(join(config.evidence, 'trace-42.jsonl'), JSON.stringify({ t: new Date(101000).toISOString(),
  direction: 'call-received', msg: { id: 1, params: { name: 'js' } } }) + '\n');
writeFileSync(config.result, JSON.stringify({ cleanupConfirmed: true, row: { arm: 'sleight', task: 'calculator-click', run: 1,
  passed: true, groupClean: true, exitCode: 0, stamps: { spawnAt: 100800, exitAt: 101200, closeAt: 101250 } } }));
writeFileSync(config.trace, JSON.stringify({ complete: true, records: [] }));
writeFileSync(join(config.collections, '42.json'), JSON.stringify({ collected: true, hosts: [] }));
