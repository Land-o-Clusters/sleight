// Prepared for a separately authorized quiet window. The default mode only prints a plan.
// No model is used. Live modules are imported only behind the explicit live flags.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { parseRecording, loadRecording } from './recording.mjs';
import { materialize } from './write-effect-bank.mjs';
import { wrongFieldEffects, fieldWrites, writeFields } from '../../plugins/sleight/lib/write-effect.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/safari-wrong-field/safari-r1-c6.json', import.meta.url), 'utf8'));
export function prepareRepro(source) {
  if (createHash('sha256').update(source).digest('hex') !== fixture.sha256) throw Error('B-r1 transcript digest mismatch');
  const calls = parseRecording(source).slice(0, 6);
  if (calls.length !== 6 || calls.some(c => c.server !== 'plugin:sleight:computer' || c.name !== 'js') || calls[5].arguments.code !== fixture.code)
    throw Error('Expected B-r1 six-call prefix ending at the recorded address write');
  return calls;
}

export const passRules = [
  'All 6 recorded calls reach the engine in order, with only unique target/fixture-marker remapping and no extra refresh or repair calls.',
  'Calls 4 and 5 reproduce their recorded guarded failures; any other early error makes the run inconclusive.',
  'At call 6 Address holds the requested address, or Promo holds it while Address is unchanged and the tool returns the wrong-field notice with isError=true.',
  'Every write has a write-code record capped at 8192 bytes with an explicit truncation flag, plus a write-forwarded record for its actual method and element argument.',
  'Trace code contains no typed literals, including password and card values. The sequence stops before Apply or Pay now.',
  'The fixture browser and owned servers exit with cleanup confirmed. A stopped or incomplete sequence is inconclusive.',
];

// Injectable transport lets offline tests prove ordering and the verdict without importing a live driver.
export async function runSequence(calls, { call, mapper, beforeCall = () => {} }) {
  let previous;
  const steps = [];
  for (const [index, original] of calls.entries()) {
    await beforeCall();
    // Mapping failure stops. No new observation or action is inserted into B-r1's sequence.
    const args = mapper.arguments(original.arguments);
    const result = await call(original.server, original.name, args);
    const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    const after = materialize(text, previous);
    const effects = previous && after ? wrongFieldEffects(args.code, previous.text, after.text) : [];
    const expectedError = original.result?.isError === true;
    const row = { call: index + 1, isError: !!result.isError, expectedError, wrongWrites: effects.map(({ requested, received }) => ({ requested, received })) };
    steps.push(row);
    if (index < 5 && !!result.isError !== expectedError) return { verdict: 'inconclusive', reason: 'early result differs from the recorded error boundary', steps };
    if (index === 2) {
      const fields = writeFields(after?.text);
      if (fields.filter(f => f.label === 'Address' && f.role === 'combo box').length !== 1 ||
          fields.filter(f => f.label === 'Promo code' && f.role === 'text field').length !== 1)
        return { verdict: 'inconclusive', reason: 'checkout address combo box or promo field missing', steps };
    }
    if (index === 5) {
      const requested = fieldWrites(args.code, previous?.text).at(-1);
      const targets = requested && writeFields(after?.text).filter(f => f.path === requested.target.path);
      const correct = targets?.length === 1 && targets[0].value === requested.value;
      const detected = effects.length === 1 && result.isError === true && /Action not done; sleight made no repair\./.test(text);
      return { verdict: correct && !result.isError || detected ? 'pass' : 'inconclusive',
        outcome: correct ? 'address received text' : detected ? 'wrong destination detected' : 'final write unproved', steps };
    }
    mapper.observe((original.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'), text, original.arguments, original);
    previous = after;
  }
  return { verdict: 'inconclusive', reason: 'six-call prefix not completed', steps };
}

async function main(argv) {
  const live = argv.includes('--run-live');
  const value = flag => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1]; };
  const input = value('--recording');
  if (!input) throw Error('Expected --recording B_R1_EVENTS_JSONL');
  const calls = prepareRepro(readFileSync(input, 'utf8'));
  if (!live) {
    console.log(JSON.stringify({ live: false, fixture: 'Safari form-checkout, address combo box', calls: calls.length,
      sourceSHA256: fixture.sha256, expectedFailures: [4, 5], stopAfter: 6, passRules }, null, 2));
    return;
  }
  if (!argv.includes('--owner-away') || !argv.includes('--quiet-window') || !process.env.CLAUDE_CONFIG_DIR ||
      !existsSync(new URL('../../../ledger/vc/night/lanes-may-test', import.meta.url))) throw Error('Live run requires owner-away, quiet-window, isolated Claude config and the test gate');
  const out = value('--out');
  if (!out || existsSync(out)) throw Error('Expected an absent --out directory');
  // This script never acquires a live lock. The authorized operator must run it inside the normal
  // fixture/quiet-window ownership workflow. These flags alone grant no permission to run it.
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const { withRace, prepareReplay } = await import('./fixtures.mjs');
  const { clientsFor, replayControl } = await import('./run.mjs');
  const recording = { ...loadRecording(input), calls };
  const repo = fileURLToPath(new URL('../..', import.meta.url)), prepared = prepareReplay(recording, join(out, 'fixture'));
  const control = replayControl({ deadlineMs: 180000 });
  const record = row => {
    // The ordinary server trace owns code and UI cuts. This separate run receipt holds only metadata.
    if (row.event === 'engine-close') writeFileSync(join(out, 'server-exit.json'), JSON.stringify({ code: row.code, signal: row.signal }));
  };
  let report;
  try {
    const result = await withRace(recording, { dir: join(out, 'fixture'), repo, ...prepared, ...control, env: {},
      drive: async config => {
        const clients = await clientsFor(config, {}, resolve(out), record, repo);
        try { return await runSequence(calls, { ...clients, mapper: prepared.mapper, beforeCall: control.beforeCall }); }
        finally { await clients.close(); }
      } });
    report = { ...result.replay, cleanupConfirmed: result.cleanupConfirmed, lifecycle: result.lifecycle,
      passRules, traceReviewRequired: true };
    if (!result.cleanupConfirmed || !result.replay) report.verdict = 'inconclusive';
    // Trace completeness and literal redaction need review before an overall pass is claimed.
    report.sequenceVerdict = report.verdict;
    report.verdict = 'pending trace review';
  } finally { control.dispose(); }
  writeFileSync(join(out, 'repro.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
