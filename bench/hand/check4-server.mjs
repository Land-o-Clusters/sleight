// Check-4-only launcher. Settings, character cache and host instrumentation are private to the evidence bank.
import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { replayApprovalStorage } from '../replay/server.mjs';
import { characterEnv } from './synthetic-character.mjs';
import { windowFrameOutput } from '../replay/window-frames.mjs';

// The private runner records the existing read, without issuing another query or changing the planner's answer.
export function check4HealthObserver(helper, { hostPid, write, now = Date.now }) {
  return { ...helper, async handLocate(request) {
    const geometry = await helper.handLocate(request);
    try {
      const window = geometry?.window;
      write({ sampledAtMs: now(), hostPid: hostPid() ?? null, request: { pid: request.pid, windowNumber: request.windowNumber },
        geometry: { ok: geometry?.ok === true, state: geometry?.state ?? null,
          window: window ? { pid: window.pid, windowId: window.windowId, bounds: window.bounds } : null,
          elements: geometry?.elements ?? {}, focused: geometry?.focused ? { window: geometry.focused.window,
            inWindow: geometry.focused.inWindow, frame: geometry.focused.frame } : null,
          windows: geometry?.windows?.map(w => ({ id: w.id, pid: w.pid, layer: w.layer, bounds: w.bounds,
            engineOverlay: /Computer Use$/.test(w.owner ?? '') })) ?? [], displays: geometry?.displays ?? [] } });
    } catch { /* Diagnostic failure never changes the helper result. */ }
    return geometry;
  } };
}

export function check4HandPolicy(character) {
  return { setting: () => ({ enabled: true, style: 'sprite', character, capture: 'hidden', perch: true,
    size: 'stage', stageAttention: false, lines: 'off', narration: 'off', record_runs: false }),
    setHand: async () => { throw Error('CHECK4_PRIVATE_SETTINGS'); }, cursorPicker: null,
    watch: () => undefined, usage: null, permissions: null };
}

export function check4HostSpec(config, { capture, consent, cursorStyle }, env = process.env) {
  return { command: config.binary, args: ['--hand', `--capture=${capture}`, `--cursor-style=${cursorStyle}`, consent ? '--consent' : '--menu'],
    options: { env: { ...env, ...characterEnv(dirname(config.character)), SLEIGHT_CHECK4_STATUS: config.status, SLEIGHT_CHECK4_TRACE: config.trace },
      stdio: ['pipe', 'pipe', 'inherit', 'pipe', 'pipe'] } };
}

export function ownedHostCollection({ receipt, exit, graceMs = 3000 } = {}) {
  const children = new Map(); let closing;
  return { track(child) {
    const row = { pid: child.pid, collected: false };
    const done = new Promise(resolve => child.once('close', (code, signal) => { Object.assign(row, { collected: true, code, signal }); resolve(); }));
    children.set(child, { row, done });
  }, shutdown(code = 0) {
    return closing ??= (async () => {
      const timers = [];
      try {
        for (const [child, state] of children) if (!state.row.collected) {
          child.stdin?.end();
          timers.push(setTimeout(() => { if (!state.row.collected) child.kill('SIGTERM'); }, graceMs));
          timers.push(setTimeout(() => { if (!state.row.collected) child.kill('SIGKILL'); }, graceMs * 2));
        }
        let timer;
        try { await Promise.race([Promise.all([...children.values()].map(s => s.done)), new Promise(resolve => { timer = setTimeout(resolve, graceMs * 3); })]); }
        finally { clearTimeout(timer); }
        const hosts = [...children.values()].map(s => s.row), collected = hosts.every(h => h.collected);
        receipt({ collected, hosts }); exit(collected ? code : 1);
      } finally { for (const timer of timers) clearTimeout(timer); }
    })();
  } };
}

export async function launchCheck4Server(config, { launch = spawn } = {}) {
  const worktree = resolve(config.worktree);
  const collectionPath = config.collections ? join(config.collections, `${process.pid}.json`) : config.collection;
  const publishCollection = row => {
    const temp = collectionPath + '.partial'; writeFileSync(temp, JSON.stringify(row), { mode: 0o600 }); renameSync(temp, collectionPath);
  };
  publishCollection({ collected: false, hosts: [], serverPid: process.pid });
  const { sessionHandClient } = await import(pathToFileURL(join(worktree, 'plugins/sleight/lib/hand/client.mjs')));
  const { sessionCursorEvents } = await import(pathToFileURL(join(worktree, 'plugins/sleight/lib/hand/events.mjs')));
  const { loadCharacter, resolveCharacterStates } = await import(pathToFileURL(join(worktree, 'plugins/sleight/lib/hand/character.mjs')));
  const pack = loadCharacter(config.character);
  sessionCursorEvents({ setting: check4HandPolicy(pack.manifest.id).setting });
  process.env.SLEIGHT_HAND = '1'; process.env.SLEIGHT_CURSOR_STYLE = 'sprite';
  process.env.SLEIGHT_TURBO = '0'; process.env.SLEIGHT_RUNTIME = 'engine';
  const collection = ownedHostCollection({ receipt: publishCollection, exit: process.exit.bind(process) });
  const hand = sessionHandClient({ ...check4HandPolicy(pack.manifest.id), cursorStyle: 'sprite', character: pack.manifest.id,
    trace: (direction, msg) => appendFileSync(join(dirname(config.status), 'hand-client.jsonl'), JSON.stringify({ t: new Date().toISOString(), direction, msg }) + '\n', { mode: 0o600 }),
    loadSprite: async () => ({ character: pack, resolve: resolveCharacterStates }), built: () => true,
    prepare: async () => ({ status: 'ready', spawn: ({ capture, consent, cursorStyle }) => {
      const spec = check4HostSpec(config, { capture, consent, cursorStyle });
      const child = launch(spec.command, spec.args, spec.options);
      collection.track(child);
      return child;
    } }),
  });
  if (!hand) throw Error('Check 4 could not create the character client');
  // The ordinary launcher exits explicitly. This private wrapper collects its own native hosts before honoring that exit.
  process.exit = code => { hand.close(); void collection.shutdown(code); };
  const { run } = await import(pathToFileURL(join(worktree, 'plugins/sleight/lib/launch.mjs')));
  const { createAppHealthHelper } = await import(pathToFileURL(join(worktree, 'plugins/sleight/lib/read-failure.mjs')));
  try { await run({ approvalStorage: replayApprovalStorage, paymentCardFactory: () => undefined,
    ...(config.recordWindowFrames ? { clientOutputFactory: windowFrameOutput } : {}),
    healthHelperFactory: () => check4HealthObserver(createAppHealthHelper(), { hostPid: () => hand.pid,
      write: row => appendFileSync(join(dirname(config.status), 'hand-geometry.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 }) }),
    runRetentionOptions: { root: join(dirname(config.status), 'runs'), config: join(dirname(config.status), 'hand.json') } }); }
  catch (error) { process.stderr.write(`Check 4 server: ${error.message}\n`); hand.close(); await collection.shutdown(1); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw Error('Expected private check-4 config');
  await launchCheck4Server(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
