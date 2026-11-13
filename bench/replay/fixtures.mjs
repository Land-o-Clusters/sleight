import { randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { getTasks } from '../tasks.mjs';
import { genericTask } from '../generic-task.mjs';
import { realBrowserPlan, launchRealBrowser, resetRealBrowser, checkBrowserOwner } from '../fowl/real-browser.mjs';
import { startGateSites } from '../fowl/real-gate.mjs';
import { realAgentSetup, gateWindowApps } from '../fowl/real-gate-setup.mjs';
import { executeRealTask } from '../real-run.mjs';
import { observePermission } from '../real-permission.mjs';
import { dragMethodAudit } from '../world/method-check.mjs';
import { TargetMapper } from './mapping.mjs';
import { assertReplayArguments } from './allowlist.mjs';
import { isNativeSelection, windowReceipts } from './frames.mjs';

// This phase has no host effects and must finish before lock ownership changes.
export function prepareReplay(recording, dir, mapper = new TargetMapper()) {
  for (const call of recording.calls) assertReplayArguments(call.arguments);
  if (recording.kind === 'race') {
    realBrowserPlan({ browser: recording.task.browser, round: 'replay-plan', profile: 'fresh', surface: 'sleight' });
    const markers = new Set(JSON.stringify(recording.calls).match(/Sleight Gate [a-f0-9-]{36}/g) ?? []);
    if (markers.size > 1) throw Error('Recording names multiple gate windows');
    return { mapper };
  }
  // The read-only frame observer admits nonce documents only in the benchmark namespace.
  // Keep that namespace inside this iteration's owned bank, without widening the observer's filter.
  const hasFrames = recording.calls.some(call => isNativeSelection(call) && call.result?.content?.some(block =>
    block.type === 'text' && windowReceipts(block.text).some(row => row.frame)));
  const fixtureDir = hasFrames ? join(dir, 'sleight-bench', 'replay', 'fixture') : dir;
  const native = nativePlan(recording, fixtureDir);
  mapper.addString(native.oldDir, fixtureDir);
  if (/^\/(?:var|tmp)\//.test(native.oldDir)) mapper.addString('/private' + native.oldDir, fixtureDir);
  return { mapper, native };
}

export function nativePlan(recording, dir) {
  const { task, calls, metadata } = recording;
  // These fixture bytes can be restored from the task definition and the recorded nonce.
  const supported = ['textedit-drag', 'textedit-edit', 'textedit-save', 'textedit-window-drag', 'textedit-two-windows',
    'textedit-replace-save', 'textedit-replace-all', 'textedit-insert-line'];
  if (!supported.includes(task.id)) throw Error(`Native fixture ${task.id} is not reproducible by replay; random operands, real accounts and external documents require a saved fixture manifest`);
  const text = JSON.stringify(calls.map(c => c.arguments));
  const paths = [...text.matchAll(/(?:\/[^\s"\\]+)*\/sleight-bench\/[^\s"\\]+\/[^\s"\\]+\/((?:Source-|Target-)?[a-f0-9]{8}(?:-drag|-edit)?\.txt)/g)].map(m => m[0]);
  // Title-based selection need not repeat the fixture path in its arguments. Only the native tool's
  // successful receipt can supply that path, never arbitrary JavaScript output or document text.
  for (const call of calls.filter(c => isNativeSelection(c) && !c.result?.isError))
    for (const block of call.result?.content ?? []) if (block.type === 'text') for (const row of windowReceipts(block.text)) {
      try {
        if (row.target.appId !== 'com.apple.TextEdit') continue;
        const url = new URL(row.target.url);
        if (url.protocol !== 'file:' || url.hostname || url.search || url.hash || url.href !== row.target.url) continue;
        const path = fileURLToPath(url);
        if (basename(path) === row.target.title && /^\/(?:[^/]+\/)*sleight-bench\/[^/]+\/[^/]+\/(?:Source-|Target-)?[a-f0-9]{8}(?:-drag|-edit)?\.txt$/.test(path)) paths.push(path);
      } catch { /* Missing or invalid local fixture identity cannot establish a path. */ }
    }
  const folders = [...new Set(paths.map(p => dirname(p).replace(/^\/private(?=\/(?:var|tmp)\/)/, '')))];
  if (folders.length !== 1) throw Error('Native recording needs exactly one owned fixture directory');
  const nonces = [...new Set(paths.map(p => /(?:Source-|Target-)?([a-f0-9]{8})(?:-drag|-edit)?\.txt$/.exec(basename(p))?.[1]).filter(Boolean))];
  if (nonces.length !== 1) throw Error('Native fixture nonce is ambiguous');
  const suite = metadata?.suite ?? 'default';
  let definition = getTasks(suite).find(t => t.id === task.id);
  if (!definition) throw Error(`Task ${task.id} missing in current ${suite} suite`);
  if (!definition.fixtureLifecycle) definition = genericTask(definition);
  return { definition, ctx: { dir, nonce: nonces[0], ownerAway: true, stopOnAppDialog: true }, oldDir: folders[0], suite };
}

export async function withNative(recording, { dir, mapper, signal, abort, drive, beforeCall, prepared, permissionCheck = observePermission }) {
  const { definition, ctx } = (prepared ?? prepareReplay(recording, dir, mapper)).native;
  let replay;
  const lifecycle = await executeRealTask(definition, ctx, { lockHeld: true, signal,
    stop: () => abort?.(Error('Native fixture stopped')),
    permissionCheck: async () => {
      await beforeCall();
      const permission = await permissionCheck();
      if (permission) abort?.(Error('macOS permission prompt; replay stopped'));
      return permission;
    },
    drive: async () => {
      replay = await drive({ policy: 'bench', env: { BENCH_SUITE: recording.metadata.suite ?? 'default',
        BENCH_WORLD_TASKS: JSON.stringify([recording.task.id]) }, servers: null });
      await beforeCall();
      const transcript = replay.calls.flatMap(row => [
        { message: { content: [{ type: 'tool_use', id: row.id,
          name: row.server === 'plugin:sleight:computer' ? `mcp__plugin_sleight_computer__${row.name}` : row.name, input: row.arguments }] } },
        { message: { content: [{ type: 'tool_result', tool_use_id: row.id,
          is_error: !row.result || row.result.isError === true, content: row.result?.content }] } },
      ]).map(JSON.stringify).join('\n');
      return { code: replay.verdict === 'pass' ? 0 : 1, groupClean: true, out: { result: '' }, methodAudit: dragMethodAudit(transcript) };
    } });
  return { replay, lifecycle, cleanupConfirmed: lifecycle.groupClean !== false && !lifecycle.cleanupError && !lifecycle.cleanupUnconfirmed && !lifecycle.exitDisagreements?.length };
}

export async function cleanupRace({ sites, browser, signal, beforeCall, cleanupConfirmed = true, cleanupError }) {
  try { await sites?.close(); } catch (error) { cleanupError = error.message; cleanupConfirmed = false; }
  if (signal?.aborted && browser) cleanupConfirmed = false;
  if (browser && cleanupConfirmed) try {
    // The hold can arrive between the monitor poll and this finally block.
    await beforeCall(); signal?.throwIfAborted();
    await browser.stop();
  } catch (error) { cleanupError = error.message; cleanupConfirmed = false; }
  return { cleanupConfirmed, cleanupError };
}

export async function withRace(recording, { dir, repo, mapper, signal, drive, beforeCall, env, mcpRoot = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser') }) {
  const browserName = recording.task.browser;
  const surface = ['firefox', 'safari'].includes(browserName) ? 'sleight' : 'sleight-turbo';
  const plan = realBrowserPlan({ browser: browserName, round: randomUUID(), profile: 'fresh', surface });
  let sites, browser, replay, cleanupConfirmed = true, cleanupError;
  try {
    await beforeCall();
    mkdirSync(dir, { mode: 0o700 });
    sites = await startGateSites(mcpRoot);
    await beforeCall();
    browser = await launchRealBrowser(plan);
    await beforeCall();
    await resetRealBrowser(browser);
    await checkBrowserOwner(browser, { ownedPid: browser.pid });
    // The marker is the only fixture-specific title substitution. Other window titles must match literally.
    const markers = new Set(JSON.stringify(recording.calls).match(/Sleight Gate [a-f0-9-]{36}/g) ?? []);
    if (markers.size > 1) throw Error('Recording names multiple gate windows');
    for (const marker of markers) {
      mapper.addString(marker, browser.marker);
      mapper.addString(encodeURIComponent(marker), encodeURIComponent(browser.marker));
    }
    const arm = realAgentSetup({ task: recording.task, surface, dir, realBrowser: browser, repo, dryRun: false });
    const gate = gateWindowApps(browser);
    replay = await drive({ policy: 'race', env: { ...arm.env, FOWL_GATE_WINDOW: JSON.stringify(gate) },
      servers: arm.mcpConfig.mcpServers, turbo: surface === 'sleight-turbo', gateWindow: surface === 'sleight', switches: env });
  } catch (error) {
    cleanupError = error.message;
    if (error.message === 'BENCH_BROWSER_CLEANUP_UNPROVED' || error.cleanupUnconfirmed) cleanupConfirmed = false;
  } finally {
    ({ cleanupConfirmed, cleanupError } = await cleanupRace({ sites, browser, signal, beforeCall, cleanupConfirmed, cleanupError }));
  }
  return { replay, lifecycle: { cleanupError, browser: { browser: browserName, marker: plan.marker, profileRoot: plan.profileRoot } }, cleanupConfirmed };
}
