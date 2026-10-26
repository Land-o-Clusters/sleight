// A normal-priority spawn service is started before the controller lowers its own priority.
// Private Node IPC only. EOF/disconnect closes every owned stdin, then collects survivors.
import { fork, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { getPriority, setPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export function priorityPlan(priority = getPriority()) {
  if (priority !== 0) throw Error('C10 needs a normal-priority launcher; use zsh bench/hand/c10.command (no outer nice).');
  return { servicePriority: 0, runnerPriority: 20 };
}

export class PrioritySpawner {
  constructor(env) {
    this.channels = new Map(); this.serial = 0;
    this.service = fork(fileURLToPath(import.meta.url), ['--spawn-service'], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    // All service stdio is ignored; exit is the collection receipt. Its IPC channel closes separately.
    this.closed = new Promise(resolve => this.service.once('exit', (code, signal) => resolve({ code, signal })));
    this.ready = new Promise((resolve, reject) => {
      this.service.once('error', reject);
      this.service.once('exit', () => reject(Error('Spawn service exited before ready')));
      this.service.on('message', row => {
        if (row.op === 'ready') { resolve(row); return; }
        if (row.op === 'signal') { this.onSignal?.(row.signal); return; }
        const channel = this.channels.get(row.id); if (!channel) return;
        if (row.op === 'spawn') { channel.pid = row.pid; channel.emit('spawn'); }
        else if (row.op === 'data') channel[row.stream].write(Buffer.from(row.data, 'base64'));
        else if (row.op === 'error') channel.emit('error', Error(row.message));
        else if (row.op === 'close') {
          channel.exitCode = row.code; channel.signalCode = row.signal;
          channel.stdout.end(); channel.stderr.end(); channel.emit('close', row.code, row.signal); this.channels.delete(row.id);
        }
      });
    });
    this.service.on('exit', () => {
      for (const channel of this.channels.values()) {
        channel.stdout.end(); channel.stderr.end(); channel.emit('error', Error('Spawn service lost; child cleanup unproved'));
        // Never manufacture a collected-child close event after losing the service.
      }
    });
  }
  send(row, done = () => {}) {
    if (!this.service.connected) { done(Error('Spawn service disconnected')); return; }
    this.service.send(row, done);
  }
  spawn(command, args, options) {
    const id = ++this.serial, child = new EventEmitter();
    child.pid = undefined; child.exitCode = null; child.signalCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({
      write: (chunk, _encoding, done) => this.send({ op: 'input', id, data: chunk.toString('base64') }, done),
      final: done => this.send({ op: 'end', id }, done),
    });
    child.kill = signal => { this.send({ op: 'kill', id, signal }); return true; };
    this.channels.set(id, child);
    this.send({ op: 'spawn', id, command, args, cwd: options.cwd, env: options.env });
    return child;
  }
  async niceRunner() {
    let timer;
    try {
      const ready = await Promise.race([this.ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Spawn service ready timed out')), 10000);
      })]);
      priorityPlan(ready.priority); setPriority(process.pid, 20);
    } finally { clearTimeout(timer); }
  }
  async close() {
    if (this.channels.size) throw Object.assign(Error('Spawn service still owns children'), { code: 'CLEANUP' });
    if (this.service.connected) this.service.disconnect();
    let timer;
    try { const result = await Promise.race([this.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(Error('Spawn service cleanup unproved'), { code: 'CLEANUP' })), 9000);
    })]);
      if (result.code !== 0) throw Object.assign(Error(`Spawn service exited ${result.code ?? result.signal}`), { code: 'CLEANUP' });
    } finally { clearTimeout(timer); }
  }
}

async function serve() {
  const live = new Map(); let ending;
  const send = row => { if (process.connected) process.send(row, () => {}); };
  const finish = () => ending ??= (async () => {
    for (const child of live.values()) child.stdin.end();
    const until = Date.now() + 3000;
    while (live.size && Date.now() < until) await sleep(50);
    for (const child of live.values()) child.kill('SIGTERM');
    await sleep(300);
    for (const child of live.values()) child.kill('SIGKILL');
    const deadline = Date.now() + 3000;
    while (live.size && Date.now() < deadline) await sleep(50);
    const code = live.size ? 1 : 0;
    if (process.connected) process.disconnect();
    process.exit(code);
  })();
  process.on('disconnect', finish);
  // Terminal group signals also reach this process. Let the controller collect its channels first.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    if (process.connected) send({ op: 'signal', signal }); else finish();
  });
  process.on('message', row => {
    if (ending) return;
    if (row.op === 'spawn') {
      const child = spawn(row.command, row.args, { cwd: row.cwd, env: row.env, stdio: ['pipe', 'pipe', 'pipe'] });
      live.set(row.id, child); child.stdin.on('error', () => {});
      child.on('spawn', () => send({ op: 'spawn', id: row.id, pid: child.pid }));
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => send({ op: 'data', id: row.id, stream, data: chunk.toString('base64') }));
      child.on('error', error => send({ op: 'error', id: row.id, message: error.message }));
      child.on('close', (code, signal) => { live.delete(row.id); send({ op: 'close', id: row.id, code, signal }); });
    } else {
      const child = live.get(row.id); if (!child) return;
      if (row.op === 'input') child.stdin.write(Buffer.from(row.data, 'base64'));
      else if (row.op === 'end') child.stdin.end();
      else if (row.op === 'kill' && ['SIGTERM', 'SIGKILL'].includes(row.signal)) child.kill(row.signal);
    }
  });
  send({ op: 'ready', priority: getPriority() });
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--spawn-service' && process.send) await serve();
