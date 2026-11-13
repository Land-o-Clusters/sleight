import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod, realpath } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareNativeHelpers, environment, appleToolsPresent, nativeHelpersBuilt } from '../direct-browser/host.mjs';
import { ordinary, defaultHelperCache, helperBuildRecipes } from '../direct-browser/host-cache.mjs';
import { DRIVER_API_VERSION, DRIVER_CODES, DRIVER_SESSION_EXEMPT_METHODS, MAC_DRIVER_READ_NOTICES } from './protocol.mjs';
import { preparePrebuiltMacDriver } from './host.mjs';

const sourceRoot = fileURLToPath(new URL('./native/', import.meta.url));
const peerSource = fileURLToPath(new URL('../direct-browser/native/peer-host.c', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Update this pin in the same reviewed change as any peer source edit.
const reviewedPeerHash = 'e67c072cbb553d77f3b1fe57440c15b56f8a8017c71f27ec1c5723f814fc62e1';

const clipboardWatchPath = join(sourceRoot, 'DriverClipboardWatch.swift');
const reviewedSourceLines = new Map([
  [clipboardWatchPath, ['        return try NSPasteboard.general.changeCount']],
  [join(sourceRoot, 'DriverTools.swift'), [
    '            if let handle = dlopen(nil, RTLD_LAZY), let main = dlsym(handle, "CGSMainConnectionID"), let spaces = dlsym(handle, "CGSCopySpacesForWindows") {',
  ]],
  [join(sourceRoot, 'DriverPointer.swift'), [
    '              let setSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation"),',
    '              let getSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventGetWindowLocation") else {',
  ]],
]);

export function validateMacDriverClipboardSource(source, path) {
  // Pin the entire peer, including preprocessing spellings the scan cannot see.
  if (path === peerSource && digest(source) !== reviewedPeerHash) throw Error('DRIVER_CLIPBOARD_CAPABILITY');
  // C preprocessing can hide identifiers from the scan below. The peer needs
  // neither token pasting nor line splices with spaces or tabs.
  if (path?.endsWith('.c') && /##|\\[ \t]*(?:\r\n?|\n)/.test(source)) throw Error('DRIVER_CLIPBOARD_CAPABILITY');
  const literal = 'NSPasteboard.general.changeCount';
  let rest = source;
  if (path === undefined) {
    // Existing assembled-source callers get only exact, separately validated
    // file bodies from disk. Source comments confer no exception authority.
    if (source.split(literal).length !== 2) throw Error('DRIVER_CLIPBOARD_CAPABILITY');
    for (const file of reviewedSourceLines.keys()) {
      const body = ordinary(file).toString('utf8');
      validateMacDriverClipboardSource(body, file);
      if (rest.split(body).length !== 2) throw Error('DRIVER_CLIPBOARD_CAPABILITY');
      rest = rest.replace(body, '');
    }
  } else {
    if (path === clipboardWatchPath) {
      if (source.split(literal).length !== 2) throw Error('DRIVER_CLIPBOARD_CAPABILITY');
    }
    for (const line of reviewedSourceLines.get(path) ?? []) {
      const exactLine = '\n' + line + '\n';
      if (('\n' + rest + '\n').split(exactLine).length !== 2) throw Error('DRIVER_CLIPBOARD_CAPABILITY');
      rest = ('\n' + rest + '\n').replace(exactLine, '\n');
    }
  }
  // Tripwire for known board APIs and dynamic bridges, including aliases and
  // escaped identifiers. Source review covers reflection outside this list.
  // Generic string/types properties remain usable.
  if (/\b(?:NSPasteboard|NSPasteboardItem|UIPasteboard|Pasteboard\w*|pasteboardItems|readObjects|writeObjects|clearContents|setString|setData|DriverSemanticClipboardRecovery|DriverSemanticPasteboardNative|pbcopy|pbpaste|osascript|NSAppleScript|NSAppleEventDescriptor|NSTask|NSClassFromString|NSSelectorFromString|objc_getClass|objc_lookUpClass|objc_msgSend|dlsym|dlopen|classNamed|_silgen_name|objc_getRequiredClass|objc_getClassList|objc_copyClassList|NSProtocolFromString|sel_getUid|sel_registerName|Selector)\b|\b(?:system|popen|posix_spawn\w*|exec[lv][ep]?|fork|SetClipboardData|OpenClipboard|gtk_clipboard_set_\w*)\s*\(|\bProcess\s*[.(]|\bdata\s*\(\s*forType\b/.test(rest)) throw Error('DRIVER_CLIPBOARD_CAPABILITY');
}

// Single-file staging gives the Glide engine its own source map while retaining the compiler's
// lock, private cache, timeout and exact-byte checks. No consent UI is compiled.
export function macDriverSource() {
  const names = readdirSync(sourceRoot)
    .filter(name => /^Driver[A-Za-z0-9]*\.swift$/.test(name)).sort();
  if (!names.includes('DriverMain.swift')) throw Error('DRIVER_SOURCE_MISSING');
  const body = [...names.filter(name => name !== 'DriverMain.swift'), 'DriverMain.swift']
    .map(name => {
      const path = join(sourceRoot, name), source = ordinary(path).toString('utf8');
      validateMacDriverClipboardSource(source, path);
      return `// Source: ${name}\n${source}\n`;
    }).join('\n');
  const codes = Object.entries(DRIVER_CODES).map(([code, row]) => `    "${code}": ("${row.next}", ${row.unhealthy})`).join(',\n');
  const contract = `let driverAPIVersion = ${DRIVER_API_VERSION}\nlet driverSessionExemptMethods: Set<String> = ${JSON.stringify(DRIVER_SESSION_EXEMPT_METHODS)}\nlet driverSelectionNote = ${JSON.stringify(MAC_DRIVER_READ_NOTICES.selection)}\nlet driverNoFocusNote = ${JSON.stringify(MAC_DRIVER_READ_NOTICES.noFocus)}\nlet driverErrorCodes: [String: (next: String, unhealthy: Bool)] = [\n${codes}\n]\n`;
  return `let driverBuild = "${digest(contract + body)}"\n${contract}\n${body}`;
}

// Both distribution receipts and the client handshake use this single identity.
export function macDriverBuildInfo(source = macDriverSource()) {
  const build = /^let driverBuild = "([a-f0-9]{64})"\n/.exec(source)?.[1];
  if (!build) throw Error('DRIVER_BUILD_MISSING');
  return Object.freeze({ build, sourceHash: digest(source) });
}

// This operator A/B switch does not admit caller-selected environment controls.
export const macDriverTextEnvironment = (env = process.env) => env.SLEIGHT_DRIVER_TEXT_BELIEF === 'fallback'
  ? { SLEIGHT_DRIVER_TEXT_BELIEF: 'fallback' } : {};

function launchReceipt({ binary, build, validate, origin }) {
  const binarySha256 = digest(ordinary(binary));
  return Object.freeze({ status: 'ready', binary, binarySha256, build, origin, spawn: ({ nonce, actionEvents = false, geometryEvents = false }) => {
    if (!/^[a-f0-9]{64}$/.test(nonce ?? '')) throw Error('INVALID_NONCE');
    validate();
    return spawn(binary, [], { env: { ...environment(), ...macDriverTextEnvironment(), SLEIGHT_DRIVER_NONCE: nonce, ...actionEvents ? { SLEIGHT_DRIVER_EVENTS: '1' } : {}, ...geometryEvents ? { SLEIGHT_DRIVER_GEOMETRY: '1' } : {} },
      stdio: ['pipe', 'pipe', 'pipe', ...geometryEvents ? ['pipe', 'pipe'] : actionEvents ? ['pipe'] : []] });
  } });
}

// Construction is inert. prepare is an internal test seam, never a tool parameter.
export async function prepareMacDriver({ platform = process.platform, cacheRoot = join(defaultHelperCache(), 'mac-driver'),
  signal, onProgress, prepare = prepareNativeHelpers, tools = appleToolsPresent, cached = nativeHelpersBuilt,
  prebuilt = preparePrebuiltMacDriver, automatic = true } = {}) {
  if (platform !== 'darwin') return Object.freeze({ status: 'unavailable', code: 'PLATFORM' });
  const source = await macDriverSource(), peer = ordinary(peerSource);
  validateMacDriverClipboardSource(peer.toString('utf8'), peerSource);
  const identity = macDriverBuildInfo(source);
  signal?.throwIfAborted();
  const released = prebuilt(identity);
  if (released) return launchReceipt({ ...released, origin: 'prebuilt', validate: () => {
    if (digest(macDriverSource()) !== identity.sourceHash || digest(ordinary(peerSource)) !== digest(peer)) throw Error('HOST_SOURCE_MISMATCH');
    released.validate();
  } });
  const selectedSources = { 'peer-host': 'peer-host.c', 'glide-engine': 'glide-engine.swift' };
  const sources = { 'peer-host.c': digest(peer), 'glide-engine.swift': digest(source) };
  const staging = await mkdtemp(join(await realpath(tmpdir()), 'sleight-driver-source-'));
  await chmod(staging, 0o700);
  try {
    await writeFile(join(staging, 'glide-engine.swift'), source, { mode: 0o600, flag: 'wx' });
    await writeFile(join(staging, 'peer-host.c'), peer, { mode: 0o600, flag: 'wx' });
    const inventory = { accepted: true, protocol: 1, node: process.version, helperMode: 'source',
      files: Object.entries(sources).map(([name, sha256]) => ({ path: 'native/' + name, sha256 })) };
    if (!cached({ inventory, cacheRoot, selectedSources }) && !await tools()) return Object.freeze({ status: 'unavailable', code: 'APPLE_TOOLS_MISSING' });
    const built = await prepare({ inventory, sourceRoot: staging, cacheRoot, signal, onProgress, automatic, waitForBuild: true }, selectedSources);
    if (built.status !== 'ready') return built;
    // This source map builds the Glide engine separately from the consent UI.
    // DriverMain is its only entry point; no hand or consent code is included.
    const binary = join(built.directory, 'glide-engine');
    const recordHash = digest(ordinary(built.record, 0o600));
    const validate = () => {
      if (digest(macDriverSource()) !== sources['glide-engine.swift'] || digest(ordinary(peerSource)) !== sources['peer-host.c']) throw Error('HOST_SOURCE_MISMATCH');
      const recordBytes = ordinary(built.record, 0o600);
      if (digest(recordBytes) !== recordHash) throw Error('HOST_PACKAGE_MISMATCH');
      const record = JSON.parse(recordBytes);
      if (record.protocol !== 1 || record.arch !== process.arch ||
          JSON.stringify(record.sources) !== JSON.stringify(sources) ||
          JSON.stringify(record.recipes) !== JSON.stringify(helperBuildRecipes(sources)) ||
          digest(ordinary(binary, 0o700)) !== record.binaries?.['glide-engine']) throw Error('HOST_PACKAGE_MISMATCH');
    };
    validate();
    return launchReceipt({ binary, build: identity.build, validate, origin: 'source' });
  } finally { await rm(staging, { recursive: true, force: true }); }
}
