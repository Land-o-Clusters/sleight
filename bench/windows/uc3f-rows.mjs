// Fixed collector admission data. RT31 does not use these longer block caps.
export const UC3F_PROTOCOL = 'sleight.uc3f-transport/1';
export const UC3F_BLOCK_SECONDS = Object.freeze({ away: 9000, present: 3600 });
export const UC3F_PRESENT = Object.freeze(['lock-refused', 'lock-during-type', 'screensaver-refused',
  'session-switch-refused', 'uac-refused', 'uac-hint', 'escape-stop-hardware']);
export const UC3F_ROW_IDS = Object.freeze(['person-idle', 'person-key-before', 'person-key-during', ...UC3F_PRESENT,
  'escape-ignored-injected', 'escape-ignored-posted', 'cancel-frame', 'direct-launch-terminal',
  'direct-launch-override', 'browser-refused-edge', 'browser-refused-firefox', 'browser-refused-renamed', 'checkpoint-cost']);
export function admitUC3FRow(row, presence) {
  if (!['away', 'present'].includes(presence) || !UC3F_ROW_IDS.includes(row?.id) || row.presence !== presence) throw Error('ROW_MODE_MISMATCH');
  if (row.id !== 'person-idle' && UC3F_PRESENT.includes(row.id) !== (presence === 'present')) throw Error('ROW_MODE_MISMATCH');
  if (row.id === 'person-idle' && JSON.stringify(row.cases) !== JSON.stringify(presence === 'away' ? ['notepad', 'wpf', 'calculator-refused'] : ['background-word'])) throw Error('ROW_MODE_MISMATCH');
  if (row.id === 'checkpoint-cost') throw Error('NO_NOISE_CONSTANT');
}
export const VM_RECORD_PROVENANCE = Object.freeze({ hostname: 'Win32_ComputerSystem.Name',
  machineGuid: 'HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid', encoding: 'sha256:utf8:trim:lowercase' });
