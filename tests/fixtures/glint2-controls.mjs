// Broken controls for the GLS3 regressions. No production test switch is added.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const controls = {
  recovery: ['mac-driver/errors.mjs', "if (code === 'INVALID_PARAMS' && requestMethods.includes(method) && !action) next = 'retry-safe';", '', 'mac-driver-errors'],
  vocabulary: ['mac-driver/errors.mjs', "MAC_DRIVER_PARAM_FIELDS.includes(source?.field) ? source.field : 'params'", 'source.field', 'mac-driver-errors'],
  field: ['driver-client.mjs', "if ('field' in error &&", 'if (false &&', 'driver-client'],
  fieldCopy: ['driver-client.mjs', "['field', 'timing', 'next'", "['timing', 'next'", 'driver-client'],
  emptyField: ['driver-client.mjs', 'if (invalid !== undefined)', 'if (invalid)', 'driver-client'],
  webcompat: ['repl/rebindings.mjs', 'webcompat: true', 'webcompat: false', 'gls2b-repl'],
  failedNames: ['repl/worker.mjs', 'if (nextDeclared) for (const name of nextDeclared)', 'if (false) for (const name of nextDeclared)', 'gls2b-repl'],
  backoffScope: ['direct-browser/host.mjs', '&& compileFailureCaptured(error)', '', 'glide-build-startup'],
  duration: ['direct-browser/host.mjs', 'expectedCompileMs = automatic ?', 'expectedCompileMs = false ?', 'glide-build-startup'],
  doctor: ['runtime-doctor.mjs', '; clear ${helperBuildKey(hashes)}.startup-failed.json in the helper cache to retry now', '', 'glide-build-startup'],
  sessionRetry: ['mac-driver/input-registrar.mjs', "['HOST_BUILD_BUSY', 'HOST_COMPILE_BACKOFF'].includes(cause?.code)", "cause?.code === 'HOST_BUILD_BUSY'", 'glide-startup'],
  hold: ['runtime-select.mjs', '&& estimate.remainingMs <= 30000', '&& false', 'glide-startup'],
  preparationLedger: ['runtime-select.mjs', 'const result = refuse(error, true);',
    "const result = refuse(error, true); result.content.push(text('0 requests arrived; no later action request reached sleight.'));", 'glide-startup'],
  removals: ['mac-driver/diff.mjs', 'removalDiffs: true', 'removalDiffs: false', 'gls2-delivery'],
  popupBinding: ['mac-driver/diff.mjs', "if (JSON.stringify(expanded(delivered)) !== JSON.stringify(expanded(current))) return true;", '', 'gls2-delivery'],
};
const variant = controls[process.env.GLINT2_MUTANT];
assert.ok(variant, 'select a named GLINT2_MUTANT');
const [file, before, after, suite] = variant;
const target = new URL('../../plugins/sleight/lib/' + file, import.meta.url).href;
const hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url !== target) return loaded;
  assert.ok(String(loaded.source).includes(before), 'GLINT2 mutation anchor ' + process.env.GLINT2_MUTANT);
  return { ...loaded, source: String(loaded.source).replace(before, after) };
} });
process.on('exit', () => hook.deregister());
await import('../' + suite + '.test.mjs');
