// Whether the ghost hand is on, and whether captures show it. The hand is off by default. A saved enabled: true opts in.
// SLEIGHT_HAND=0 forces it off; SLEIGHT_HAND=1 forces it on for benchmarks. Without an environment override, an unsafe file
// leaves it off. Capture is hidden by default (the user's own screenshots and recordings included) or visible;
// SLEIGHT_HAND_CAPTURE wins over the file's capture setting.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

export const handConfigPath = (home = userInfo().homedir) => join(home, 'Library/Application Support/sleight/hand.json');
export const CAPTURE_MODES = Object.freeze(['hidden', 'visible']);

/** { state: 'absent' | 'on' | 'off' | 'unsafe', capture? }. Unsafe is a link, another owner, a mode other than 0600, or anything
 *  but { version: 1, enabled, capture?, stream?, labels? }. */
export function readHandConfig(path = handConfigPath(), uid = process.getuid()) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'unsafe' }; }
  try {
    if (!isAbsolute(path) || normalize(path) !== path || !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
        stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) return { state: 'unsafe' };
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['version', 'enabled', 'capture', 'stream', 'labels'].includes(key)) ||
        data.version !== 1 || typeof data.enabled !== 'boolean' || data.capture !== undefined && !CAPTURE_MODES.includes(data.capture) ||
        data.stream !== undefined && typeof data.stream !== 'boolean' || data.labels !== undefined && !['off', 'role', 'title'].includes(data.labels)) return { state: 'unsafe' };
    return { state: data.enabled ? 'on' : 'off', ...data.capture ? { capture: data.capture } : {},
      ...data.stream !== undefined ? { stream: data.stream } : {}, ...data.labels !== undefined ? { labels: data.labels } : {} };
  } catch { return { state: 'unsafe' }; }
}

/** { enabled, reason, capture, captureReason }. reason is 'platform', 'env', 'unsafe', 'user' or 'default', in that order of
 *  precedence. captureReason is 'env', 'env-invalid' (an unknown value, which keeps the panel hidden), 'user' or 'default'. */
export function handSetting({ env = process.env, platform = process.platform, path = handConfigPath(), read = readHandConfig } = {}) {
  const file = platform === 'darwin' ? read(path) : { state: 'absent' };
  const asked = env.SLEIGHT_HAND_CAPTURE;
  const [capture, captureReason] = asked !== undefined && asked !== '' ? CAPTURE_MODES.includes(asked) ? [asked, 'env'] : ['hidden', 'env-invalid']
    : file.capture ? [file.capture, 'user'] : ['hidden', 'default'];
  const result = (enabled, reason) => ({ enabled, reason, capture, captureReason,
    ...file.stream !== undefined ? { stream: env.SLEIGHT_HAND !== '0' && file.state !== 'unsafe' && file.stream } : {},
    ...file.labels !== undefined ? { labels: file.labels } : {} });
  if (platform !== 'darwin') return result(false, 'platform');
  if (['0', '1'].includes(env.SLEIGHT_HAND)) return result(env.SLEIGHT_HAND === '1', 'env');
  if (file.state === 'unsafe') return result(false, 'unsafe');
  if (file.state === 'absent') return result(false, 'default');
  return result(file.state === 'on', 'user');
}

const words = setting => setting.reason === 'platform' ? 'off (macOS only)' : setting.reason === 'env' ? `${setting.enabled ? 'on' : 'off'} (SLEIGHT_HAND=${setting.enabled ? '1' : '0'})`
  : setting.reason === 'unsafe' ? 'off (hand.json is a link or has another owner, mode or format)'
  : setting.reason === 'default' ? 'off (the default; sleight-mcp hand on turns it on)' : setting.enabled ? 'on' : 'off (you turned it off)';
const captureWords = setting => `${setting.capture === 'visible' ? 'visible (your screenshots and recordings show the hand)'
  : 'hidden (no screenshot or recording shows the hand)'}${setting.captureReason === 'env' ? ', from SLEIGHT_HAND_CAPTURE'
  : setting.captureReason === 'env-invalid' ? ', because SLEIGHT_HAND_CAPTURE is neither hidden nor visible'
  : setting.captureReason === 'default' ? ', the default' : ''}`;
const hostWords = built => built ? 'compiled' : 'not compiled yet (it compiles in the background the first time sleight acts, and that session has no hand)';

/** `sleight-mcp hand status`. */
export const handStatusLines = (setting, built) => [`hand      ${words(setting)}`,
  ...setting.enabled ? [`capture   ${captureWords(setting)}`, `host      ${hostWords(built)}`] : []];

/** Doctor section. Only an unsafe hand.json or an unknown SLEIGHT_HAND_CAPTURE is a problem: off is a choice, and the host
 *  compiles on first use. */
export function handDoctorLines(setting, built) {
  const lines = ['ghost hand'];
  if (setting.reason === 'unsafe') {
    lines.push(`PROBLEM   hand: ${words(setting)}`, '          fix: delete ~/Library/Application Support/sleight/hand.json, then run sleight-mcp hand on');
    return lines;
  }
  lines.push(`ok        hand: ${words(setting)}${setting.reason === 'user' && !setting.enabled ? ', sleight-mcp hand on turns it back on'
    : setting.enabled ? ', sleight-mcp hand off turns it off' : ''}`);
  if (!setting.enabled) return lines;
  lines.push(`${setting.captureReason === 'env-invalid' ? 'PROBLEM' : 'ok     '}   hand capture: ${captureWords(setting)}`);
  if (setting.captureReason === 'env-invalid') lines.push('          fix: set SLEIGHT_HAND_CAPTURE to hidden or visible, or remove it');
  lines.push(`ok        hand host: ${hostWords(built)}`);
  return lines;
}
