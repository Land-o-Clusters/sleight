import { CAPTURE_MODES, CURSOR_STYLES, characterIdValid } from './hand/settings.mjs';
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const invalid = () => { throw Error('WINDOWS_SETTING_INVALID'); };

export function validWindowsHand(value = { version: 1, enabled: false }) {
  if (!object(value, ['version', 'enabled', 'capture', 'stream', 'labels', 'style', 'character']) || value.version !== 1 ||
      typeof value.enabled !== 'boolean' || value.capture !== undefined && !CAPTURE_MODES.includes(value.capture) ||
      value.stream !== undefined && typeof value.stream !== 'boolean' || value.labels !== undefined && !['off', 'role', 'title'].includes(value.labels) ||
      value.style !== undefined && !CURSOR_STYLES.includes(value.style) || value.character !== undefined && !characterIdValid(value.character)) invalid();
  return structuredClone(value);
}
