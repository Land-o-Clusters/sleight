import { win32 } from 'node:path';
import { InputLease } from '../input-lease.mjs';
import { win32Paths } from '../platform/paths.mjs';
import { windowsFileOperation } from '../platform/win32-files.mjs';
import { prepareWindowsHandHost } from '../direct-browser/windows-host.mjs';
import { createWindowsFilePermissions, createWindowsGateHelper } from '../direct-browser/windows-gates.mjs';

// Reuse SQLite's cross-session lock and token protocol. Native handle checks
// create and validate the directory, coordinator and every JSON record with
// protected user/SYSTEM DACLs. POSIX mode bits never establish Windows privacy.
export class WindowsInputLease extends InputLease {
  constructor({ directory, operate = windowsFileOperation, permissions, prepare = prepareWindowsHandHost, ...options } = {}) {
    super({ ...options, directory: directory ?? (process.platform === 'win32' ? win32.join(win32Paths().settings, 'leases') : '') });
    this.operate = operate;
    this.permissions = permissions;
    this.prepare = prepare;
  }
  async ready() {
    if (this.permissions) return;
    this.preparing ??= (async () => {
      // Build only. No host is spawned with a window. WIN2's existing validator
      // proves volume, reparse points, mandatory label, protected ACL and parents.
      const host = await this.prepare({ platform: 'win32' });
      if (host.status !== 'ready') throw Error(host.code ?? 'WINDOWS_LEASE_UNPROVED');
      this.permissions = createWindowsFilePermissions({ platform: 'win32',
        helper: createWindowsGateHelper({ platform: 'win32', receipt: host.receipt }) });
    })();
    await this.preparing;
  }
  prove(path, directory = false) {
    const proof = directory ? this.permissions?.privateDirectory(path) : this.permissions?.privateFile(path);
    if (proof?.ok !== true) throw Error('WINDOWS_LEASE_UNPROVED: ' + (proof?.reason ?? 'validator unavailable'));
  }
  coordinator() {
    this.operate({ operation: 'lease-init', path: this.directory });
    this.prove(this.directory, true);
    const proof = this.permissions?.privateCoordinator(win32.join(this.directory, '.coordinator.sqlite'));
    if (proof?.ok !== true) throw Error('WINDOWS_LEASE_UNPROVED: ' + (proof?.reason ?? 'coordinator validator unavailable'));
    return super.coordinator();
  }
  read(path) {
    const reply = this.operate({ operation: 'lease-read', path });
    if (reply.absent === true) return undefined;
    this.prove(path);
    let value;
    try { value = JSON.parse(reply.text); } catch { throw Error('Input lease: invalid lease file; stop actions.'); }
    if (typeof value?.holder !== 'string' || typeof value.token !== 'string' || !Number.isFinite(value.expires) ||
        typeof value.window?.appId !== 'string' || !['window', 'app', 'desktop'].includes(value.scope))
      throw Error('Input lease: invalid lease record; stop actions.');
    return value;
  }
  store(path, record) {
    const text = JSON.stringify(record) + '\n';
    const reply = this.operate({ operation: 'lease-write', path, text });
    this.prove(path);
    if (reply.text !== text) throw Error('Input lease: native readback changed; stop actions.');
  }
}
