// Mac-specific error vocabulary; framing and child lifetime live in the shared client.
import { DRIVER_CODES } from './protocol.mjs';
export { createMacDriverClient, DRIVER_PROTOCOL, DRIVER_LINE_LIMIT } from '../driver-client.mjs';

const fault = (code, message = code, unhealthy = false) => Object.assign(new Error(message), { code, unhealthy,
  ...DRIVER_CODES[code] ? { next: DRIVER_CODES[code].next } : {} });
// Keep the closed local vocabulary at the platform boundary. Shared transport
// faults use these constructors; native codes retain their protocol-table next.
const localFaults = Object.freeze({
  PLATFORM: (...args) => fault('PLATFORM', ...args),
  DRIVER_BUSY: (...args) => fault('DRIVER_BUSY', ...args),
  DRIVER_CLOSED: (...args) => fault('DRIVER_CLOSED', ...args),
  DRIVER_RESTARTED: (...args) => fault('DRIVER_RESTARTED', ...args),
  DRIVER_UNAVAILABLE: (...args) => fault('DRIVER_UNAVAILABLE', ...args),
  DRIVER_EXIT: (...args) => fault('DRIVER_EXIT', ...args),
  DRIVER_IO: (...args) => fault('DRIVER_IO', ...args),
  DRIVER_LINE_LIMIT: (...args) => fault('DRIVER_LINE_LIMIT', ...args),
  DRIVER_UNHEALTHY: (...args) => fault('DRIVER_UNHEALTHY', ...args),
  DRIVER_RETIRE_TIMEOUT: (...args) => fault('DRIVER_RETIRE_TIMEOUT', ...args),
});
export function macClientFault(code, ...args) {
  return Object.hasOwn(localFaults, code) ? localFaults[code](...args) : fault(code, ...args);
}
