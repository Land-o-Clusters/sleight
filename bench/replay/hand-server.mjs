// Observe the private check-4 host's existing pipe. No frame or acknowledgement is injected.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { launchCheck4Server } from '../hand/check4-server.mjs';

export function observeHostWire(child, record, { now = Date.now, mono = () => performance.now() } = {}) {
  const pending = new Map();
  let outgoing = '', incoming = '', sequence = 0;
  const lines = (buffer, chunk, visit) => {
    buffer += chunk.toString();
    if (buffer.length > 131072) throw Error('Replay host observation overflow');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { visit(JSON.parse(line)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    return buffer;
  };
  const write = child.stdin.write;
  child.stdin.write = function (chunk, ...args) {
    outgoing = lines(outgoing, chunk, frame => {
      if (frame.hand !== 'clear' || typeof frame.token !== 'string') return;
      const row = { id: ++sequence, hostPid: child.pid, placed: frame.placed === true, seq: frame.placementSeq ?? null,
        requestedAtMs: now(), requestMonoMs: mono() };
      pending.set(frame.token, { row, nonce: frame.nonce });
      if (pending.size > 256) throw Error('Replay host observation pending overflow');
      record({ event: 'request', ...row });
    });
    return write.call(this, chunk, ...args);
  };
  child.stdout.on('data', chunk => {
    incoming = lines(incoming, chunk, frame => {
      const request = pending.get(frame.token);
      if (!request || frame.nonce !== request.nonce || !['clear-ready', 'placed-ready'].includes(frame.hand)) return;
      pending.delete(frame.token);
      record({ event: 'ack', ...request.row, kind: frame.hand, acknowledgedAtMs: now(), ackMs: mono() - request.row.requestMonoMs });
    });
  });
}

export async function launchHandReplay(config) {
  if (process.env.SLEIGHT_HAND !== '1' || !config.wire) throw Error('Hand-on replay configuration missing');
  await launchCheck4Server(config, { launch: (command, args, options) => {
    if (resolve(command) !== resolve(config.binary)) throw Error('Hand-on host binary changed');
    const child = spawn(command, args, options);
    observeHostWire(child, row => appendFileSync(config.wire, JSON.stringify(row) + '\n', { mode: 0o600 }));
    return child;
  } });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw Error('Expected private hand-on replay config');
  await launchHandReplay(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
