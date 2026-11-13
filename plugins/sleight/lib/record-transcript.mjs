// The mod's offline transcript conversion. This entry never accepts live recording or replay arguments.
import { record } from './replay.mjs';
import { writeOutsideSettings } from './person-gate.mjs';
import { isMainModule } from './main-module.mjs';

export function recordTranscript(args, { convert = record, write = writeOutsideSettings } = {}) {
  if (args.length !== 2 || args.some(arg => typeof arg !== 'string' || !arg || arg.startsWith('-')))
    throw Error('Expected a saved transcript or session id and an output file.');
  const script = convert(args[0]);
  write(args[1], JSON.stringify(script, null, 1) + '\n', { exclusive: true, mode: 0o600 });
  return script.steps.length;
}

if (isMainModule(import.meta.url)) {
  try { recordTranscript(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`sleight: ${error.message}\n`); process.exitCode = 1; }
}
