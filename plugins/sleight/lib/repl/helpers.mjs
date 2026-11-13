import { isDeepStrictEqual } from 'node:util';
import { DRIVER_ACTION_METHODS } from '../mac-driver/protocol.mjs';
import { normalizeMacAction } from './arguments.mjs';
// Parent-owned setup source. Reuse the same serialized functions as the engine
// without widening the restricted worker's filesystem permissions.
import { fillFormCode } from '../fill-form.mjs';
import { dragToCode } from '../drag-to.mjs';
import { pickFromListCode } from '../pick-from-list.mjs';
import { listPickerCode } from '../native-list-pick.mjs';
import { windowFromText, sameElement, hasIdentifier, hasLabel, elementLines } from '../document-scope.mjs';

export function runtimeHelperSource(completeness = false) {
  return `(() => {
    const globalThis = { sleight: {} };
    ${fillFormCode('void 0;', true)}
    ${dragToCode('void 0;', true)}
    ${pickFromListCode('void 0;', completeness, true)}
    const hasIdentifier = ${hasIdentifier.toString()};
    const hasLabel = ${hasLabel.toString()};
    return { ...globalThis.sleight, listPicker: (${listPickerCode(completeness)}),
      parse: ${windowFromText.toString()}, sameElement: ${sameElement.toString()},
      elements: ${elementLines.toString()} };
  })()`;
}

// RT8 integration seam: inspect this ordinary canonical call with the bound
// window's relay, flow and payment policy before returning true. A true result
// does not grant driver admission, a lease or a retained-number baseline.
export function helperInspection(helper, method, params) {
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return freeze({ helper, method, params: structuredClone(params),
    code: `await app.${method}(${params.args.map(value => JSON.stringify(value)).join(', ')});` });
}

// IPC is JSON, but direct parent callers must not smuggle getters, prototypes,
// aliases or selector objects past the same literal-only boundary.
export function validateHelperInspection(proposal) {
  const invalid = () => { throw Object.assign(Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' }); };
  const literal = value => {
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object' ||
        ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => typeof key === 'string' &&
      (Array.isArray(value) && key === 'length' || Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value') && literal(value[key])));
  };
  if (!proposal || !Object.isFrozen(proposal.params) || !literal(proposal.params) ||
      !['pickFromList', 'fillForm', 'dragTo'].includes(proposal.helper) || !DRIVER_ACTION_METHODS.includes(proposal.method) ||
      !Array.isArray(proposal.params.args) || !Number.isSafeInteger(proposal.params.readId) || proposal.params.readId < 1) invalid();
  const { method, args } = normalizeMacAction(proposal.method, proposal.params.args);
  if (method !== proposal.method || !isDeepStrictEqual(args, proposal.params.args)) invalid();
  const target = value => Number.isSafeInteger(value) && value >= 0 ||
    Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  if (!['typeText', 'paste', 'pressKey'].includes(method) && !target(args[0]) || method === 'drag' && !target(args[1])) invalid();
  if (proposal.code !== `await app.${method}(${args.map(value => JSON.stringify(value)).join(', ')});`) invalid();
  return true;
}
