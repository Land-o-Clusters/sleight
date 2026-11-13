// Offline broken variants. The production modules have no test switches.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const controls = {
  backoffText: ['mac-driver/input-registrar.mjs', "if (cause.code === 'HOST_COMPILE_BACKOFF')", 'if (false)', 'glide-startup'],
  retryTime: ['runtime-select.mjs', 'retryAfterMs: host.detail?.retryAfterMs', 'retryAfterMs: undefined', 'glide-startup'],
  estimateText: ['mac-driver/input-registrar.mjs', 'Number.isFinite(remainingMs) && remainingMs > 0', 'Number.isFinite(remainingMs)', 'glide-startup'],
  estimateHold: ['runtime-select.mjs', 'estimate.remainingMs > 0', 'estimate.remainingMs !== undefined', 'glide-startup'],
  relayScript: ['relay.mjs', '{ script: nativeMac }', '{ script: false }', 'glide-startup'],
  preflightScript: ['runtime-api.mjs', '{ script: true }', '{ script: false }', 'glide-startup'],
  scriptRanges: ['code-ast.mjs', 'node.range = node.range.map(n => n - prefix.length);',
    'node.range = node.range;', 'code-ast'],
  invalidSource: ['code-ast.mjs', "if (typeof code !== 'string') return parseUncachedCell(code);", '', 'code-ast'],
  awaitGrammar: ['code-ast.mjs', 'ast = wrapper.body; wrapped = true;',
    'ast = cellParser.parseScript(code, options); wrapped = false;', 'runtime-api'],
  diagnosticScope: ['direct-browser/compiler-diagnostics.mjs', "String(stderr ?? '').split(/\\r?\\n/).flatMap", "('error: ' + String(stderr ?? '')).split(/\\r?\\n/).flatMap", 'glide-build-startup'],
  deterministic: ['direct-browser/host.mjs', 'return diagnostics.length > 0 &&', "return diagnostics.some(line => /no such module/.test(line)) &&", 'glide-build-startup'],
  transient: ['direct-browser/host.mjs', '!diagnostics.some(line => transient.test(cause(line)))', 'true', 'glide-build-startup'],
  diagnosticNames: ['direct-browser/host.mjs', 'transient.test(cause(line))', 'transient.test(line)', 'glide-build-startup'],
  receiptSource: ['driver-client.mjs', 'driverSourceBuild: hello.build', "driverSourceBuild: '0'.repeat(64)", 'driver-client'],
  receiptBinary: ['driver-client.mjs', 'driverBuild: host.binarySha256', 'driverBuild: hello.build', 'driver-client'],
  receiptValidator: ['driver-client.mjs', 'if (validBuildHash(host.binarySha256))', 'if (host.binarySha256)', 'driver-client'],
  retiredReceipt: ['driver-client.mjs',
    'runtimeReceipt: () => generation && !generation.stopped && generation.runtimeReceipt\n        ? structuredClone(generation.runtimeReceipt) : undefined,',
    'runtimeReceipt: (() => { let previous; return () => generation?.runtimeReceipt ? (previous = structuredClone(generation.runtimeReceipt)) : previous; })(),', 'driver-client'],
  receiptDelivery: ['runtime-select.mjs', 'if (runtimeReceipt) {', 'if (false) {', 'glide-startup'],
  prebuiltMode: ['mac-driver/build.mjs', 'const binarySha256 = digest(ordinary(binary));', 'const binarySha256 = digest(ordinary(binary, 0o700));', 'mac-driver-core-build'],
  builderHash: ['mac-driver/build.mjs', 'binary, binarySha256, build, origin', 'binary, build, origin', 'mac-driver-core-build'],
};
const variant = controls[process.env.GLINT3_MUTANT];
assert.ok(variant, 'select a named GLINT3_MUTANT');
const [file, before, after, suite] = variant;
const target = new URL('../../plugins/sleight/lib/' + file, import.meta.url).href;
const hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url !== target) return loaded;
  assert.ok(String(loaded.source).includes(before), 'GLINT3 mutation anchor ' + process.env.GLINT3_MUTANT);
  return { ...loaded, source: String(loaded.source).replaceAll(before, after) };
} });
process.on('exit', () => hook.deregister());
await import('../' + suite + '.test.mjs');
