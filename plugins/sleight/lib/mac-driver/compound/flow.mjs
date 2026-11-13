import { requireCompound } from './intent.mjs';

// Internal bridge into the existing FlowRules analyzer. formatObservation is
// trusted parent code using the ordinary authorized read formatter. It cannot
// be supplied by an intent, app or renderer. This module never evaluates code.
export function createCompoundFlowBridge({ rules, formatObservation }) {
  requireCompound(rules && typeof rules.analyze === 'function' && typeof rules.forward === 'function' &&
    typeof rules.observe === 'function' && typeof formatObservation === 'function', 'FLOW_REFUSED');
  const plans = new WeakMap();
  return Object.freeze({
    analyze({ witness, intent, before }) {
      const window = { app: before.binding.bundleId, title: before.title, url: before.context.url };
      let name = 'compound-input', args = { app: window.app };
      if (witness.primitive === 'write') {
        // JSON serialization quotes one literal value for static analysis only.
        name = 'js'; args = { code: `await app.setValue(0, ${JSON.stringify(witness.value)});` };
      } else if (witness.kind === 'choose.select') args.value = intent.option.label;
      const plan = rules.analyze(name, args, window);
      requireCompound(Array.isArray(plan.violations) && plan.violations.length === 0 && plan.unknown !== true,
        'FLOW_REFUSED');
      plans.set(witness, { plan, revision: rules.revision, consumed: false }); return true;
    },
    consume(witness) {
      const entry = plans.get(witness);
      requireCompound(entry && !entry.consumed && entry.revision === rules.revision, 'FLOW_REFUSED');
      rules.forward(entry.plan); entry.consumed = true; return true;
    },
    observe({ witness, observation }) {
      const entry = plans.get(witness);
      requireCompound(entry?.consumed === true, 'FLOW_REFUSED');
      const result = formatObservation(observation);
      requireCompound(result && Array.isArray(result.content), 'FLOW_REFUSED');
      rules.observe(result, entry.plan); plans.delete(witness); return true;
    },
  });
}
