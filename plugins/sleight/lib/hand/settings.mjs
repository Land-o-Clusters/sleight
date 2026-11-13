// Whether the ghost hand is on, and whether captures show it. The hand is off by default. A saved enabled: true opts in.
// SLEIGHT_HAND=0 forces it off; SLEIGHT_HAND=1 forces it on for benchmarks. Without an environment override, an unsafe file
// leaves it off. Capture is hidden by default (the user's own screenshots and recordings included) or visible;
// SLEIGHT_HAND_CAPTURE wins over the file's capture setting.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, normalize } from 'node:path';
import { getPlatform } from '../platform/index.mjs';
import { observeSettingsFile, readSettingsBytes, trustedSettingsContent } from '../sealed-settings.mjs';

export const handConfigPath = (home = userInfo().homedir, { platform = process.platform, env } = {}) => {
  const adapter = getPlatform(platform);
  return adapter.join(adapter.paths({ home, env }).settings, 'hand.json');
};
export const NARRATION_MODES = Object.freeze(['off', 'bubbles', 'voice']);
export const voiceSettingValid = value => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(k => ['id', 'rate'].includes(k)) && typeof value.id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value.id) &&
  (value.rate === undefined || typeof value.rate === 'number' && Number.isFinite(value.rate) && value.rate >= 0.1 && value.rate <= 0.6);
export const CAPTURE_MODES = Object.freeze(['hidden', 'visible']);
export const CURSOR_STYLES = Object.freeze(['glove', 'ring', 'seam', 'sprite']);
// Sprite options (A2): perch (the character sits on the target window) and the character's lines, on unless turned off.
export const LINES_MODES = Object.freeze(['on', 'off']);
export const characterIdValid = value => typeof value === 'string' && /^[a-z0-9-]{1,48}$/.test(value);
export const CHARACTER_SIZES = Object.freeze(['small', 'medium', 'stage']);
export const DEFAULT_CHARACTER_SIZE = 'medium';
export const characterSizeValid = value => CHARACTER_SIZES.includes(value) ||
  typeof value === 'number' && Number.isFinite(value) && value >= 104 && value <= 560;
// An empty cast keeps the selected character. Session allocation belongs to the client.
export const characterCastValid = value => Array.isArray(value) && value.length <= 32 &&
  Array.from(value).every(characterIdValid) && new Set(value).size === value.length;
export const cursorDrawing = setting => setting?.enabled === true && ['ring', 'seam', 'sprite'].includes(setting.style);

/** { state: 'absent' | 'on' | 'off' | 'unsafe', capture? }. Unsafe is a link, another owner, a mode other than 0600, or anything
 *  but { version: 1, enabled, capture?, stream?, labels?, style?, character?, record_runs?, narration?, voice?, perch?, lines?, size?, cast?, stageAttention? }. */
export function readHandConfig(path = handConfigPath(), uid = process.getuid?.(), { platform = process.platform, seals, privateFile = (...args) => getPlatform(platform).filePermissions.privateFile(...args) } = {}) {
  const verified = platform === 'darwin' ? seals ?? observeSettingsFile(path) : undefined, enforced = verified?.enforcing;
  let stat;
  if (!enforced) try { stat = lstatSync(path); } catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'unsafe' }; }
  try {
    if (!enforced && (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path ||
        !privateFile(path, { kind: 'file', uid, stat }).ok || stat.size > 4096)) return { state: 'unsafe' };
    const bytes = enforced ? trustedSettingsContent(verified, 'hand.json', 'display') : platform === 'darwin' ? readSettingsBytes(path) : readFileSync(path, 'utf8');
    if (bytes === undefined) return { state: 'absent' };
    const data = JSON.parse(bytes);
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['version', 'enabled', 'capture', 'stream', 'labels', 'style', 'character', 'record_runs', 'narration', 'voice', 'perch', 'lines', 'size', 'cast', 'stageAttention'].includes(key)) ||
        data.version !== 1 || typeof data.enabled !== 'boolean' || data.capture !== undefined && !CAPTURE_MODES.includes(data.capture) ||
        data.stream !== undefined && typeof data.stream !== 'boolean' || data.record_runs !== undefined && typeof data.record_runs !== 'boolean' || data.labels !== undefined && !['off', 'role', 'title'].includes(data.labels) ||
        data.style !== undefined && !CURSOR_STYLES.includes(data.style) || data.character !== undefined && !characterIdValid(data.character) || data.narration !== undefined && !NARRATION_MODES.includes(data.narration) ||
        data.voice !== undefined && !voiceSettingValid(data.voice) || data.size !== undefined && !characterSizeValid(data.size) ||
        data.cast !== undefined && !characterCastValid(data.cast) || data.stageAttention !== undefined && typeof data.stageAttention !== 'boolean' ||
        data.perch !== undefined && typeof data.perch !== 'boolean' || data.lines !== undefined && !LINES_MODES.includes(data.lines)) return { state: 'unsafe' };
    return { ...data.narration !== undefined ? { narration: data.narration } : {}, ...data.voice !== undefined ? { voice: data.voice } : {}, state: data.enabled ? 'on' : 'off', ...data.capture ? { capture: data.capture } : {},
      ...data.record_runs !== undefined ? { record_runs: data.record_runs } : {}, ...data.stream !== undefined ? { stream: data.stream } : {}, ...data.labels !== undefined ? { labels: data.labels } : {},
      ...data.style !== undefined ? { style: data.style } : {}, ...data.character !== undefined ? { character: data.character } : {},
      ...data.perch !== undefined ? { perch: data.perch } : {}, ...data.lines !== undefined ? { lines: data.lines } : {},
      ...data.size !== undefined ? { size: data.size } : {}, ...data.cast !== undefined ? { cast: data.cast } : {},
      ...data.stageAttention !== undefined ? { stageAttention: data.stageAttention } : {} };
  } catch { return { state: 'unsafe' }; }
}

/** { enabled, reason, capture, captureReason }. reason is 'platform', 'env', 'unsafe', 'user' or 'default', in that order of
 *  precedence. captureReason is 'env', 'env-invalid' (an unknown value, which keeps the panel hidden), 'user' or 'default'. */
export function handSetting({ env = process.env, platform = process.platform, path, read = readHandConfig } = {}) {
  let supported = false;
  try { supported = getPlatform(platform).hand.supported; }
  catch (error) { if (error.code !== 'PLATFORM_UNSUPPORTED') throw error; }
  const file = supported ? read(path ?? handConfigPath(undefined, { platform }), undefined, { platform }) : { state: 'absent' };
  const asked = env.SLEIGHT_HAND_CAPTURE;
  const [capture, captureReason] = asked !== undefined && asked !== '' ? CAPTURE_MODES.includes(asked) ? [asked, 'env'] : ['hidden', 'env-invalid']
    : file.capture ? [file.capture, 'user'] : ['hidden', 'default'];
  const result = (enabled, reason) => ({ enabled, reason, capture, captureReason, narration: file.narration ?? 'off',
    ...file.voice !== undefined ? { voice: file.voice } : {},
    ...(env.SLEIGHT_CURSOR_STYLE ? { style: CURSOR_STYLES.includes(env.SLEIGHT_CURSOR_STYLE) ? env.SLEIGHT_CURSOR_STYLE : 'glove',
      styleReason: CURSOR_STYLES.includes(env.SLEIGHT_CURSOR_STYLE) ? 'env' : 'env-invalid' }
      : file.style ? { style: file.style, styleReason: 'user' } : {}),
    ...file.record_runs !== undefined ? { record_runs: env.SLEIGHT_HAND !== '0' && file.state !== 'unsafe' && file.record_runs } : {},
    ...file.character !== undefined ? { character: file.character } : {},
    size: file.size ?? DEFAULT_CHARACTER_SIZE, ...file.cast !== undefined ? { cast: file.cast } : {},
    ...file.stageAttention !== undefined ? { stageAttention: file.stageAttention } : {},
    ...file.perch !== undefined ? { perch: file.perch } : {}, ...file.lines !== undefined ? { lines: file.lines } : {},
    ...file.stream !== undefined ? { stream: env.SLEIGHT_HAND !== '0' && file.state !== 'unsafe' && file.stream } : {},
    ...file.labels !== undefined ? { labels: file.labels } : {} });
  if (!supported) return result(false, 'platform');
  if (['0', '1'].includes(env.SLEIGHT_HAND)) return result(env.SLEIGHT_HAND === '1', 'env');
  if (file.state === 'unsafe') return result(false, 'unsafe');
  if (file.state === 'absent') return result(false, 'default');
  return result(file.state === 'on', 'user');
}

// Hot-path readers share a 250 ms snapshot. The CLI keeps the uncached reader above.
// Include file identity and permissions with mtime/size so a replacement cannot reuse an old parse.
export function createHandSettingReader({ now = Date.now, setting, ...options } = {}) {
  if (setting?.cachedHandSetting === true) return setting;
  let checked = -Infinity, value, signature, parsed, parsedAt = -Infinity;
  const read = path => {
    let key;
    try { const s = lstatSync(path); key = [s.dev, s.ino, s.uid, s.mode, s.mtimeMs, s.ctimeMs, s.size].join(':'); } catch { key = 'absent'; }
    const at = now();
    if (key !== signature || at < parsedAt || at - parsedAt >= 250) {
      signature = key; parsedAt = at; parsed = readHandConfig(path, undefined, { platform: options.platform });
    }
    return parsed;
  };
  const reader = () => {
    const at = now();
    if (at < checked || at - checked >= 250) {
      checked = at;
      try { value = setting ? setting() : handSetting({ ...options, read }); } catch { value = {}; }
    }
    return value;
  };
  Object.defineProperty(reader, 'cachedHandSetting', { value: true });
  return reader;
}

const hotReaders = new WeakMap();
export function handSettingReader(env = process.env) {
  let read = hotReaders.get(env);
  if (!read) { read = createHandSettingReader({ env }); hotReaders.set(env, read); }
  return read;
}
export const cachedHandSetting = (env = process.env) => handSettingReader(env)();

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
