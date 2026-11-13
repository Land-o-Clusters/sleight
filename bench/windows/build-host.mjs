// Compile the reviewed cursor host and copy it for headless planner checks. Never launch it here.
import { constants, copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareWindowsHandHost, windowsHostExecutable } from '../../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { sha256 } from './guest-integrity.mjs';
import { checkReportPath, isMain, ROOT } from './kit.mjs';

export async function buildHost(output, { root = ROOT, platform = process.platform, prepare = prepareWindowsHandHost, executable = windowsHostExecutable } = {}) {
  if (platform !== 'win32') throw Error('Host build requires Windows');
  const path = resolve(root, output);
  if (path !== resolve(root, 'vm-results', 'consent-host.exe')) throw Error('Use vm-results/consent-host.exe');
  checkReportPath(path);
  const built = await prepare({ platform });
  if (built.status !== 'ready') throw Error('Host build refused: ' + built.code);
  const source = executable(built.receipt, { platform });
  const expected = sha256(readFileSync(source));
  copyFileSync(source, path, constants.COPYFILE_EXCL);
  if (sha256(readFileSync(path)) !== expected) throw Error('Host copy hash mismatch');
  return { path: 'vm-results/consent-host.exe', sha256: expected, launched: false };
}
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') { console.error('Usage: build-host.mjs --output vm-results/consent-host.exe'); process.exitCode = 1; }
  else buildHost(args[1]).then(receipt => console.log(JSON.stringify(receipt))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
