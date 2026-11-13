// Explicit code injection, never an environment path that could redirect production grants.
import { PreapprovedApps } from '../../plugins/sleight/lib/preapproved.mjs';
export const emptyPreapprovedIO = { lstatSync() { throw Object.assign(Error('fixture absent'), { code: 'ENOENT' }); } };
export const emptyApprovalStorage = {
  load: () => new PreapprovedApps({ version: 1, apps: [] }),
  live: apps => apps,
  add: () => { throw Error('offline launcher must not persist approvals'); },
};

export const offlineDoctor = { preapprovedIO: emptyPreapprovedIO, seals: () => 'seals fixture', permissions: () => [], hand: () => [], settings: () => [] };
