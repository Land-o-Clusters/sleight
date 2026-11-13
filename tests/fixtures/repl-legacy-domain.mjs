import { start as realStart } from 'node:repl';
import { create as createDomain } from 'node:domain';

export const evaluations = [];

// Model the pre-25.9 REPL contract on current Node: eval enters an inner
// domain, emits errors there, and never invokes its callback for those errors.
export function start(options) {
  const domain = options.domain ?? createDomain();
  const state = { domain, errors: [], callbacks: 0 };
  evaluations.push(state);
  domain.on('error', error => state.errors.push(error)); // Old debugDomainError consumed output.
  const { domain: _shared, ...modernOptions } = options;
  let repl;
  try { repl = realStart({ ...modernOptions, domain }); }
  catch (error) {
    if (error.code !== 'ERR_INVALID_ARG_VALUE' || !error.message.includes("'options.domain'")) throw error;
    repl = realStart(modernOptions);
  }
  const evaluate = repl.eval;
  repl.eval = domain.bind((code, context, filename, callback) => {
    evaluate(code, context, filename, (error, value) => {
      if (error) {
        process.domain.emit('error', error);
        process.domain.exit();
        return;
      }
      state.callbacks++;
      callback(null, value);
    });
  });
  return repl;
}
