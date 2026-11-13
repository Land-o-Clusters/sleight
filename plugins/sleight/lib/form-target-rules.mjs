// SF3 is an unmeasured model-side experiment. Keep the shipped skill and A side
// byte-identical, including direct skill loading. Only the exact opt-in replaces
// the studied default passages; lean was not active in that route.
const candidateForm = '- `setValue` independent visible fields; autocomplete last. Changes/validation: fresh targets;\n' +
  '  `app.getAXState()` if missing. Pick shown options. Stop at a required confirmation.';
const originalForm = '- `setValue` independent visible fields in one call. Autocomplete last.\n' +
  '  Re-read after autocomplete, field-adding selection or async validation. Use fresh IDs.\n' +
  '  Stop at a required confirmation.';
const candidateTargets = '- Forms: unique observed `{id:"<ID: value>"}`/`{label:"<label>"}`. Never retry stale numbers.';
const originalTargets = '- After renumbering, prefer `{id:"<ID: value>"}` or `{label:"<label>"}` to an element number.';

export function formTargetRules(text, env = process.env) {
  if (env.SLEIGHT_SF3 !== '1' || env.SLEIGHT_PROMPT === 'lean') return text;
  return text?.replace(originalForm, candidateForm).replace(originalTargets, candidateTargets);
}
