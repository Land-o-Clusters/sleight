// Offline detached session. Its idle close owns and collects all its resources.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { callSocket, enterSessionContext, startSocketSession } from '../../plugins/sleight/lib/socket-bridge.mjs';
import { idleClock } from './socket-clock.mjs';
const directory = process.argv[2];
const flags = process.argv.slice(3);
const signals = new EventEmitter();
const deadlineIndex = flags.indexOf('--deadline-ms');
const deadlineMs = deadlineIndex < 0 ? 10000 : Number(flags[deadlineIndex + 1]);
let waiting = 'startup admission', force;
const watchdog = setTimeout(() => {
  process.stderr.write(`socket-demand fixture timed out waiting for ${waiting}\n`);
  process.exitCode = 1;
  // Keep an independent hard bound if startup or close itself cannot finish.
  force = setTimeout(() => process.exit(1), 500);
  signals.emit('SIGTERM');
}, deadlineMs);
try {
  if (process.argv[3] === '--stop') {
    waiting = 'stop reply';
    await callSocket({ tool: 'js', args: { code: 'stop' } }, { directory, timeoutMs: 5000 });
  } else if (process.argv[3] === '--fail') {
    process.stderr.write('offline startup failure\n');
    process.exit(23);
  } else if (process.argv[3] === '--stale') {
    waiting = 'stale socket bind';
    const path = join(directory, 'session.sock');
    await new Promise((resolve, reject) => createServer().once('error', reject).listen(path, resolve));
    chmodSync(path, 0o600);
    process.exit(0);
  } else {
    enterSessionContext(directory);
    const clock = idleClock();
    process.on('message', message => { if (message.stop && !flags.includes('--ignore-stop')) signals.emit('SIGTERM'); });
    process.on('disconnect', () => signals.emit('SIGTERM'));
    const session = await startSocketSession({ directory, signals, idleClock: clock, accessibility: () => false, peerUid: async () => process.getuid(),
      publishSocket: async () => {
        if (flags.includes('--stall-startup')) {
          waiting = 'socket publication';
          await new Promise(() => {});
        }
      },
      startRelay: async options => ({ call: async (_tool, args) => {
        if (args.code === 'stop') setImmediate(() => clock.advance(600000));
        return { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, env: process.env, cwd: process.cwd(), relay: options }) }] };
      },
        close: async () => { writeFileSync(join(directory, 'collected'), 'yes'); } }),
    });
    waiting = 'session shutdown';
    if (process.connected) process.send({ ready: true });
    const { error } = await session.closed;
    if (error) throw error;
  }
} finally {
  clearTimeout(watchdog);
  clearTimeout(force);
  if (process.connected) process.disconnect();
}
