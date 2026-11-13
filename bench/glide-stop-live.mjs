// Attended STOP1 probe cell. Import is inert; this module opens no app itself.
import { pathToFileURL } from 'node:url';

export const glideStopProbePlan = Object.freeze({ cell: 'STOP1', trials: 10, limitMs: 500,
  fixtureOnly: true, cases: ['typeText', 'drag', 'pressKey', 'compound'],
  checks: ['USER_STOPPED', 'stop-tell-user', 'no held buttons', 'no held keys or modifiers',
    'no post-stop input except releases', 'input latched until the next prompt', 'no Stop in returned screenshots'],
  needsPerson: 'Click Stop in sleight on each trial; never synthesize or post that click.' });

// The sitting owns its fixture, gate, live lock, capture and cleanup. begin()
// starts a deliberately long fixture action and resolves only when it is held.
// personStop() observes the host's authenticated person click and its timestamp.
// Neither adapter may call the tool or helper stop method to fake that click.
export async function measureGlideStop({ check, begin, personStop, held, resetPrompt, now = performance.now.bind(performance) }) {
  const trials = [];
  for (let index = 0; index < glideStopProbePlan.trials; index++) {
    await check(); await resetPrompt();
    const call = await begin(glideStopProbePlan.cases[index % 4]);
    const receipt = await personStop();
    if (receipt?.person !== true || !Number.isFinite(receipt.at)) throw Error('PERSON_STOP_REQUIRED');
    let error;
    try { await call.result; } catch (caught) { error = caught; }
    const elapsedMs = now() - receipt.at, released = await held();
    const trial = { index, elapsedMs, code: error?.code, next: error?.next,
      buttons: released.buttons, keys: released.keys, modifiers: released.modifiers,
      postStopInput: released.postStopInput, screenshotHasStop: released.screenshotHasStop,
      latched: released.latched };
    trials.push(trial);
    if (trial.code !== 'USER_STOPPED' || trial.next !== 'stop-tell-user' || elapsedMs < 0 || elapsedMs > 500 ||
        ![trial.buttons, trial.keys, trial.modifiers, trial.postStopInput].every(value => value === 0) ||
        trial.screenshotHasStop !== false || trial.latched !== true) {
      throw Object.assign(Error('STOP_QUALIFICATION_FAILED'), { trials });
    }
  }
  return { cell: 'STOP1', passed: trials.length, requested: 10, trials };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).join(' ') !== '--dry-run') {
    process.stderr.write('Use --dry-run, or import measureGlideStop into the attended fixture sitting.\n');
    process.exitCode = 64;
  } else process.stdout.write(JSON.stringify({ ...glideStopProbePlan, dryRun: true, inputCalls: 0 }) + '\n');
}
