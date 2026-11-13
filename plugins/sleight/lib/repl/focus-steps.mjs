const steps = new Set(['frontmost', 'snapshot-budget', 'snapshot-timeout', 'snapshot-read', 'snapshot-type',
  'activation-event', 'activation-roundtrip', 'belief-budget', 'belief-timeout', 'belief-read', 'belief-type',
  'source', 'active-interval', 'belief-deadline', 'belief', 'clear-belief', 'restore',
  'text-context', 'text-element', 'text-role', 'text-window', 'text-ancestry', 'menu-fallback',
  'element-focused', 'semantic-focus', 'semantic-read']);
export const macFocusDiagnostics = () => [...steps].map(step => `KEY_FOCUS_UNAVAILABLE step=${step}`);
export function focusErrorStep(error) {
  const step = error?.focusStep ?? /\bstep=([a-z-]+)\b/.exec(error?.message ?? '')?.[1];
  return steps.has(step) ? step : undefined;
}
