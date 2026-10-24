import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CURSOR_PIN = Object.freeze({ version: '3.27.12', commit: 'df132ffba90dfc15a12e6b8f020ba4e5d026c4b0',
  bundleId: 'com.todesktop.230313mzl4w4u92', teamId: 'VDXQ22DGB9', cdhash: 'f4f1e4b4acdfb153f399f12c7432d1a3df219aaa' });

export const DESKTOP_BLOCKERS = Object.freeze([
  'Run supervised calibrate.mjs once with the owner, then obtain the owner go before qualification.',
]);
export function assertDesktopReady(paths = armPaths()) {
  ordinaryPath(paths.calibration);
  if (!existsSync(paths.calibration)) throw Object.assign(Error('Cursor calibration missing: run bench/world/arms/cursor-cu/calibrate.mjs with the owner'), { cleanupConfirmed: true });
  return JSON.parse(readFileSync(paths.calibration, 'utf8'));
}

export function guardLive({ ownerAway = false } = {}, { exists = existsSync } = {}) {
  if (!ownerAway) throw Error('Cursor desktop requires --owner-away');
  if (exists('/tmp/sleight-hold')) throw Error('sleight-hold is active');
  if (exists('/tmp/sleight-live.lock')) throw Error('sleight live lock is held');
}

export function ordinaryPath(path) {
  if (!path || !path.startsWith('/') || resolve(path) !== path) throw Error('path must be absolute and normalized');
  for (let p = path; p !== dirname(p); p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw Error(`symlink refused: ${p}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}

export function armPaths({ home = homedir(), root } = {}) {
  const fixed = join(home, 'Library/Caches/sleight-bench/cursor-cu-arm/desktop');
  if (root !== undefined && root !== fixed) throw Error('Cursor desktop root is fixed under the benchmark cache');
  const paths = { root: fixed, app: join(fixed, 'Cursor.app'), home: join(fixed, 'home'), userData: join(fixed, 'user-data'),
    extensions: join(fixed, 'extensions'), helperSupport: join(home, 'Library/Application Support/cursor-computer-use'), workspace: join(fixed, 'workspace'),
    database: join(fixed, 'user-data/User/globalStorage/state.vscdb'), receipt: join(fixed, 'setup.json'), calibration: join(fixed, 'calibration.json') };
  Object.values(paths).forEach(ordinaryPath);
  return paths;
}

export function assertBundlePin(found) {
  if (found.signatureVerified !== true) throw Error('Cursor signature verification failed');
  for (const [key, value] of Object.entries(CURSOR_PIN)) if (found[key] !== value) throw Error(`Cursor bundle pin mismatch: ${key}`);
  return found;
}

// The catalog is account supplied. Keep the actual id; never rewrite it to a guessed backend alias.
export function resolveModel(config, { modelId } = {}) {
  if (config?.selectedModels?.length !== 1) throw Error('Cursor needs a single model with explicit parameters');
  const selected = config.selectedModels[0], values = new Map((selected.parameters ?? []).map(p => [p.id, p.value]));
  if (!(modelId ? selected.modelId === modelId : ['grok-4.7', 'grok-4.7-high', 'cursor-grok-4.7-high'].includes(selected.modelId)) ||
    values.get('effort') !== 'high' || values.get('fast') !== 'false' || config.maxMode === true ||
    values.size !== (selected.parameters ?? []).length) throw Error('Grok 4.7 High at high effort and normal speed must be explicit in recorded modelConfig');
  return { label: 'Grok 4.7 High', model: selected.modelId, effort: 'high', speed: 'normal', parameters: selected.parameters };
}

export function composerPlan({ prompt, paths = armPaths(), timeoutMs = 300000, allowedApps = [], allowBenchmarkAppPrompts = true } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000 || prompt.includes('\0')) throw Error('invalid Cursor task prompt');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2400000) throw Error('invalid Cursor timeout');
  return { arm: 'cursor-cu', route: 'desktop', liveReady: false, blockers: DESKTOP_BLOCKERS, paths, prompt, timeoutMs, attachment: 'Computer Use', target: 'This Mac',
    modelLabel: 'Grok 4.7 High', effort: 'high', speed: 'normal', allowedApps, allowBenchmarkAppPrompts,
    steps: ['refuse foreign Cursor processes', 'new agent composer', 'verify calibrated persisted selection without changing it',
      'fill prompt', 'submit', 'poll profile state', 'quit owned copy and verify owned helper exit'],
    timing: { start: 'harness-submit', end: 'recorded-clientSettleTime', excludes: ['launch', 'login', 'composer setup', 'fixture check', 'cleanup'] },
    stateSource: 'User/globalStorage/state.vscdb: cursorDiskKV composerData and bubbleId',
    calibration: paths.calibration };
}

export const BENCHMARK_APPS = Object.freeze({ 'com.apple.TextEdit': 'TextEdit', 'com.google.Chrome': 'Google Chrome',
  'com.apple.calculator': 'Calculator', 'com.apple.finder': 'Finder', 'com.apple.Preview': 'Preview',
  'com.apple.Chess': 'Chess', 'com.microsoft.Word': 'Microsoft Word', 'com.microsoft.Excel': 'Microsoft Excel',
  'com.microsoft.VSCode': 'Visual Studio Code' });

export function approvalDecision(card, { ownerApproved = false, allowedApps = [] } = {}) {
  const name = BENCHMARK_APPS[card?.bundleId];
  const allow = ownerApproved === true && !!name && allowedApps.includes(card.bundleId) && card.source === 'Computer Use' &&
    card.name === name && card.title === `Allow Cursor to use ${name}?` && card.button === 'Allow in this chat';
  return { allow, ...(allow ? { button: card.button } : { reason: 'Cursor app approval needs owner authorization and an exact benchmark app card' }) };
}
