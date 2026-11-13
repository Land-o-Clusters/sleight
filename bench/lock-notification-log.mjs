#!/usr/bin/env node
// Read-only RT29 sitting logger. Run only at the owner's sitting:
// node bench/lock-notification-log.mjs --listen --output NEW_FILE.jsonl [--seconds 600]
// It observes notifications and session lock metadata. It never locks, unlocks,
// posts input, opens an app or captures the screen. Importing it is inert.
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Names from Hammerspoon hs.caffeinate.watcher documentation (MIT):
// https://www.hammerspoon.org/docs/hs.caffeinate.watcher.html#screensDidLock
// and #screensDidUnlock. No Hammerspoon code is copied.
export const lockNotificationSource = String.raw`import Foundation
import CoreGraphics

guard CommandLine.arguments.count == 2, let seconds = Double(CommandLine.arguments[1]),
      seconds.isFinite, seconds >= 1, seconds <= 1800 else { exit(64) }
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
func record(_ kind: String, notification: String? = nil) {
    let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any]
    func flag(_ key: String) -> Any {
        guard let number = dictionary?[key] as? NSNumber,
              number.doubleValue == 0 || number.doubleValue == 1 else { return NSNull() }
        return number.boolValue
    }
    let row: [String: Any] = ["kind": kind, "timestamp": formatter.string(from: Date()),
        "uptimeSeconds": ProcessInfo.processInfo.systemUptime,
        "notification": notification.map { $0 as Any } ?? NSNull(),
        "dictionaryPresent": dictionary != nil,
        "lockKeyPresent": dictionary?["CGSSessionScreenIsLocked"] != nil,
        "sessionLocked": flag("CGSSessionScreenIsLocked"),
        "onConsole": flag("kCGSSessionOnConsoleKey"), "loginDone": flag("kCGSessionLoginDoneKey")]
    guard var bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(65) }
    bytes.append(10); FileHandle.standardOutput.write(bytes)
}
let center = DistributedNotificationCenter.default()
let observers = ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"].map { name in
    center.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { _ in
        record("notification", notification: name)
    }
}
record("started")
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in record("sample") }
RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds))
timer.invalidate()
for observer in observers { center.removeObserver(observer) }
record("stopped")
`;

export function parseArguments(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { listen: false };
  const options = { listen: false, seconds: 600 }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw Error('Duplicate option.');
    seen.add(arg);
    if (arg === '--listen') options.listen = true;
    else if (arg === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) options.output = args[++i];
    else if (arg === '--seconds' && /^[1-9][0-9]*$/.test(args[i + 1] ?? '')) options.seconds = Number(args[++i]);
    else throw Error('Expected --listen --output NEW_FILE.jsonl [--seconds 1..1800].');
  }
  if (!options.listen || !options.output || options.seconds > 1800) throw Error('Expected --listen --output NEW_FILE.jsonl [--seconds 1..1800].');
  return options;
}

// This script owns its compiler/listener children and waits for their exit before
// removing staging. Signals preserve the partial sitting log in the output file.
function executeOwned(command, args, { stdout, timeoutMs, signal }) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', stdout?.fd ?? 'ignore', 'pipe'] });
    let stderr = '', forceTimer;
    const stop = () => {
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(stop, timeoutMs);
    const abort = () => stop();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) stop();
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-32768); });
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, receivedSignal) => {
      cleanup();
      if (receivedSignal) reject(Error(`Logger child ended with ${receivedSignal}.`));
      else if (code !== 0 && stderr) reject(Error(`Logger child exited ${code}: ${stderr.trim()}`));
      else resolveExit(code);
    });
  });
}

export async function runLogger({ output, seconds }, { execute = executeOwned, tempRoot = tmpdir(), signal } = {}) {
  if (!output || !Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw Error('Invalid logger options.');
  const log = await open(output, 'wx', 0o600);
  let staging;
  try {
    staging = await mkdtemp(join(tempRoot, 'sleight-lock-notifications-'));
    const source = join(staging, 'listener.swift'), binary = join(staging, 'listener');
    await writeFile(source, lockNotificationSource, { mode: 0o600 });
    const compiled = await execute('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(staging, 'modules'), source, '-o', binary],
      { timeoutMs: 240000, signal });
    if (compiled !== 0) throw Error(`Logger compile exited ${compiled}.`);
    if (signal?.aborted) throw Error('Logger cancelled before listening.');
    return await execute(binary, [String(seconds)], { stdout: log, timeoutMs: seconds * 1000 + 5000, signal });
  } finally {
    await log.close();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function main(args) {
  const options = parseArguments(args);
  if (!options.listen) {
    process.stdout.write('Read-only sitting logger. Use --listen --output NEW_FILE.jsonl [--seconds 1..1800].\n');
    return 0;
  }
  if (process.platform !== 'darwin') throw Error('The notification listener requires macOS.');
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { return await runLogger(options, { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
