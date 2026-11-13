import { darwin } from './darwin.mjs';
import { win32 } from './win32.mjs';

const linux = Object.freeze({ ...darwin, hand: Object.freeze({ supported: false }) });

/** Injectable selection only. No filesystem reads, native builds or child processes. */
export function getPlatform(platform = process.platform) {
  // Ubuntu CI has always used the POSIX paths and mocked Mac helpers. Keep that
  // fixture behavior; handSetting still disables native drawing outside macOS.
  if (platform === 'darwin') return darwin;
  if (platform === 'linux') return linux;
  if (platform === 'win32') return win32;
  throw Object.assign(Error(`Unsupported sleight platform: ${String(platform)}`), { code: 'PLATFORM_UNSUPPORTED' });
}
