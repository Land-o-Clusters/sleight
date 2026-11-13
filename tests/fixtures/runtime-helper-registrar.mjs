// A separate module keeps static registrar imports outside the fixture's
// top-level await while retaining the helper lane's fake capability boundary.
export { MAC_INPUT_GATE_NOTICES, prepareMacInputRegistrar, deferMacInputRegistrar, startMacInputPreparation, macInputPreparation, waitForMacInputRegistrar, macPreparingError, macInputState, hasMacInputRegistrar, ownsMacInputRegistrar } from '../../plugins/sleight/lib/mac-driver/input-registrar.mjs';
const capabilities = new WeakMap();
export function registrar(driver) { const token = Object.freeze({}); capabilities.set(token, driver); return token; }
export function admitsMacInput(token, _method, driver) { return capabilities.get(token) === driver; }
export function bindMacInputRegistrar(token, driver, alias) { if (capabilities.get(token) === driver) return registrar(alias); }
