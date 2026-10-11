import { readFileSync } from 'node:fs';
import { plan, promptFor } from './plan.mjs';
import { tasks } from './tasks.mjs';
import { publicResult } from './metrics.mjs';

// Injected runtime keeps the actual orchestration testable without a Mac or model.
export async function executePlan(pass, runtime) {
  const results = [];
  for (let n = 0; n < pass.runs.length; n += 2) {
    const pair = pass.runs.slice(n, n + 2), task = tasks.find(t => t.id === pair[0].task);
    let ctx;
    try {
      ctx = await runtime.setupPair(task, pair[0]);
      const prompt = promptFor(task, ctx);
      for (const row of pair) {
        let host, response, verdict = 'RUN_NOT_STARTED', cleanup, failure;
        const started = Date.now();
        try {
          await runtime.resetFixture(task, ctx);
          host = await runtime.startHost(task, ctx);
          response = await runtime.drive(row.arm, prompt, task, ctx);
          if (!response.groupClean) verdict = 'DRIVER_CLEANUP_UNCONFIRMED';
          else if (response.approvalStop) verdict = 'PERMISSION_STOP';
          else if (response.forbidden) verdict = 'OUTSIDE_TOOL_USED';
          else if (response.code !== 0) verdict = 'DRIVER_FAILED';
          else verdict = await runtime.check(task, ctx, response.answer);
        } catch { failure = true; verdict = 'RUN_FAILED'; }
        finally {
          try { cleanup = await host?.finish({ abort: failure || response?.approvalStop || response?.groupClean === false }); }
          catch { cleanup = { confirmed: false, samples: [] }; }
        }
        const unsafe = !cleanup?.confirmed || response?.groupClean === false || response?.approvalStop;
        results.push(publicResult({ ...row, ...response, passed: verdict === true && !unsafe,
          turns: response?.turns ?? null, modelMs: response?.modelMs ?? null,
          footprint: response?.footprint ?? null, calls: response?.calls ?? [],
          seconds: Math.round((Date.now() - started) / 10) / 100,
          checkCode: !cleanup?.confirmed ? 'CLEANUP_UNCONFIRMED' : verdict === true ? 'PASS' : verdict,
          exitCode: response?.code ?? 1, cleanupConfirmed: cleanup?.confirmed === true,
          windows: { intervalMs: 200, samples: cleanup?.samples ?? [],
            focusChanges: (cleanup?.samples ?? []).filter(s => s.focusChanged).length,
            targetOverOwnerSamples: (cleanup?.samples ?? []).filter(s => s.targetOverOwner).length } }));
        runtime.publish(results);
        if (unsafe) throw new Error(!cleanup?.confirmed ? 'CLEANUP_UNCONFIRMED' : 'UNSAFE_DRIVER_STOP');
      }
    } catch (error) {
      if (!results.some(r => r.task === pair[0].task && r.run === pair[0].run)) {
        results.push(publicResult({ ...pair[0], passed: false, seconds: 0, turns: null,
          modelMs: null, footprint: null, calls: [], cleanupConfirmed: false, checkCode: 'SETUP_FAILED', exitCode: 1 }));
        runtime.publish(results);
      }
      throw error;
    } finally { if (ctx) await runtime.closePair(ctx); }
  }
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const option = (name, fallback) => { const n = argv.indexOf(`--${name}`); return n < 0 ? fallback : argv[n + 1]; };
  const flags = new Set(['--dry-run', '--owner-present', '--owner-away', '--clean-arms']);
  const values = new Set(['--suite', '--arm', '--runs', '--tasks', '--markers', '--local-fixtures', '--model', '--effort', '--codex-model', '--codex-effort', '--auth']);
  for (let n = 0; n < argv.length; n++) {
    if (flags.has(argv[n])) continue;
    if (!values.has(argv[n]) || !argv[n + 1] || argv[n + 1].startsWith('--')) throw new Error('invalid battery option');
    n++;
  }
  if (argv.includes('--owner-present') && argv.includes('--owner-away')) throw new Error('conflicting owner boundary');
  if (option('arm', 'sleight,codex') !== 'sleight,codex') throw new Error('battery requires --arm sleight,codex');
  const markerPath = option('markers');
  const markerData = markerPath ? JSON.parse(readFileSync(markerPath, 'utf8')) : {};
  const markers = markerData.seedMarkers ?? markerData;
  const localPath = option('local-fixtures');
  const localFixtures = localPath ? JSON.parse(readFileSync(localPath, 'utf8')) : {};
  const { stateSetupRequest } = await import('./scripting.mjs');
  for (const [id, container] of Object.entries(localFixtures)) {
    const task = tasks.find(t => t.id === id);
    if (!task?.scripting || !argv.includes('--owner-present')) throw new Error('local fixtures require a scripted task and --owner-present');
    stateSetupRequest(task, 'BATTERY-preflight', container);
  }
  const pass = plan({ ownerPresent: argv.includes('--owner-present'), wanted: option('tasks')?.split(','),
    runs: Number(option('runs', '1')), markers, localFixtures });
  // Return before auth, engine discovery, arm folders, observers, servers or locks.
  if (argv.includes('--dry-run')) { console.log(JSON.stringify(pass, null, 2)); return 0; }
  if (pass.ownerSetup.some(seed => !markers[seed.task])) throw new Error('OWNER_SEED_REQUIRED: save the dry plan and pass --markers after the owner seeds those items');
  const { liveRuntime } = await import('./runtime.mjs');
  const runtime = await liveRuntime({ pass, option, localFixtures, ownerPresent: argv.includes('--owner-present'), cleanArms: argv.includes('--clean-arms') });
  let confirmed = false;
  try {
    const results = await executePlan(pass, runtime);
    confirmed = true;
    return results.every(r => r.passed) ? 0 : 1;
  } finally { await runtime.close({ confirmed }); }
}
