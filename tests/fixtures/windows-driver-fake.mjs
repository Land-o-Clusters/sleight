// Hand-written provider fixtures. No Windows APIs or competitor code.
import { fileURLToPath } from 'node:url';
import { ACTION_METHODS, validateActionParams } from '../../plugins/sleight/lib/windows-driver/actions.mjs';
import * as clipboardRule from '../../plugins/sleight/lib/windows-driver/clipboard.mjs';
import { guardWindowsAction } from '../../plugins/sleight/lib/windows-driver/guard.mjs';
import { clickRoute, scriptedSettle } from './windows-action-model.mjs';
import { deflateSync } from 'node:zlib';
import { formatWindowsDriverError } from '../../plugins/sleight/lib/windows-driver/errors.mjs';

// Independent executable mirrors of the native pure tables. These receive
// samples as data and never inspect the desktop or the owner's session.
export function windowsPersonDecision(ageMs, foregroundPid, pointerPid, targetPid) {
  if (ageMs >= 0x80000000 || !foregroundPid || !pointerPid || !targetPid) return 'person-unknown';
  if (ageMs < 500 && (foregroundPid === targetPid || pointerPid === targetPid)) return 'person-active';
  return null;
}
export function windowsSessionDecision(wtsOk, state, flags, desktopOpened, desktopName) {
  if (!wtsOk || (flags !== 0 && flags !== 1)) return 'session-unknown';
  if (state !== 0) return 'session-disconnected';
  if (flags === 0) return 'session-locked';
  if (!desktopOpened || desktopName === 'Winlogon') return 'secure-desktop';
  if (desktopName === 'Screen-saver') return 'screensaver';
  if (desktopName === 'Default') return null;
  return 'input-desktop-unavailable';
}
// A deterministic clock and provider walk for counting read probes. The optional
// factory lets offline tests execute the production memo against these samples.
export function windowsSessionReadFixture({ makeProbe, scenario = 'locked', lockAt = Infinity } = {}) {
  let time = 0;
  const probes = [], results = [], posts = [];
  const sample = () => {
    probes.push(time);
    if (time >= lockAt) throw Object.assign(Error(scenario), {
      code: scenario === 'secure' ? 'SECURE_DESKTOP_ACTIVE' : 'SCREEN_LOCKED',
    });
  };
  const createProbe = makeProbe ?? (({ sample, now }) => {
    sample(); let last = now();
    return { Require() { if (now() - last >= 50) { sample(); last = now(); } }, Finish() { sample(); } };
  });
  return {
    probes, results, posts,
    advance(ms) { time += ms; },
    input() { sample(); posts.push('input'); },
    read({ nodes, nodeMs }) {
      const probe = createProbe({ sample, now: () => Math.floor(time) });
      const began = time;
      for (let i = 1; i <= nodes; i++) { time = began + i * nodeMs; probe.Require(); }
      probe.Finish();
      const result = { nodes }; results.push(result); return result;
    },
  };
}
export function windowsSafetyFixture({ scenario, site = 'admission', person = false } = {}) {
  let unlocked = false;
  const cleanup = [], posts = [], patterns = [], reads = [];
  const beforeInput = new Set(['admission', 'post', 'pattern', 'setValue', 'selectText', 'scroll', 'read', 'capture', 'surface']);
  const readSites = new Set(['final-read', 'read', 'capture', 'surface']);
  const state = () => windowsSessionDecision(true, 0, !unlocked && scenario === 'locked' ? 0 : 1, true,
    !unlocked && scenario === 'secure' ? 'Winlogon' : 'Default');
  const checkpoint = at => {
    const session = state();
    if (session) return { code: session === 'secure-desktop' ? 'SECURE_DESKTOP_ACTIVE' : 'SCREEN_LOCKED', reason: session };
    if (!readSites.has(at)) {
      const reason = windowsPersonDecision(!unlocked && (scenario === 'person' || person) ? 100 : 600, 41, 42, 41);
      if (reason) return { code: 'PERSON_TOOK_OVER', reason, personTookOver: reason === 'person-active' };
    }
  };
  return {
    cleanup, posts, patterns, reads,
    unlock() { unlocked = true; },
    hint(mode) { return ['cap', 'budget', 'deadline', 'ACTION_BUDGET'].includes(mode) && state() === 'secure-desktop' ? ['secure-desktop-seen'] : []; },
    run(at = site) {
      let typed = 0;
      // Each late boundary represents actual prior input, with the next effect
      // held until that boundary passes. Refused effects never enter the arrays.
      if (!beforeInput.has(at)) { posts.push('prior-input'); if (at === 'pump') typed = 64; }
      try {
        const failure = checkpoint(at);
        if (failure) return { ...failure, unhealthy: false, typed,
          delivery: posts.length ? 'sent-unverified' : 'not-sent', retry: posts.length ? 'read-first' : 'safe',
          ...failure.reason === 'secure-desktop' ? { limits: ['secure-desktop-seen'] } : {} };
        (readSites.has(at) ? reads : ['pattern', 'setValue', 'selectText', 'scroll'].includes(at) ? patterns : posts).push(at);
        return { passed: true };
      } finally { cleanup.push('key-up', 'mouse-up'); }
    },
  };
}

// Synthetic clock and keyboard evidence only. The C# ownership is source-checked
// on non-Windows hosts and still requires the attended native sitting.
export function windowsTurnFixture() {
  let current, armed = false, last = 0, now = 0, seen = 0;
  return {
    get armed() { return armed; },
    get current() { return current; },
    begin(id) {
      if (current?.id === id) return;
      if (current || id <= last) throw Error('INVALID_PARAMS');
      last = id; current = { id, active: true, escape: false };
    },
    end(id) {
      if (!current || current.id !== id) throw Error('INVALID_PARAMS');
      current.active = false; current = undefined; armed = false;
    },
    activate(owner = current) {
      if (!owner || owner !== current || !owner.active) throw Error('TURN_INACTIVE');
      if (owner.escape) throw Error('USER_STOPPED');
      armed = true; seen = now;
    },
    request() { seen = now; },
    advance(ms) { now += ms; if (now - seen >= 60000) armed = false; },
    key({ code = 0, message = 0x100, key = 27, flags = 0 } = {}) {
      if (armed && current?.active && code >= 0 && message === 0x100 && key === 27 && (flags & 0x12) === 0) current.escape = true;
      return 'next-hook';
    },
  };
}

export const notepadNodes = () => [
  { depth: 0, role: 'standard window', name: 'Untitled - Notepad' },
  { depth: 1, role: 'menu bar', name: 'Application' },
  { depth: 2, role: 'menu item', name: 'File', id: 'File', actions: ['Expand/Collapse'] },
  { depth: 1, role: 'text entry area', name: 'Text editor', id: 'TextEditor', value: 'Hello 日本 🪄', focused: true },
  { depth: 1, role: 'text field', name: 'hidden fixture secret', value: 'password fixture secret', password: true, help: 'secret help', id: 'Password' },
];
export const calculatorNodes = () => [
  { depth: 0, role: 'standard window', name: 'Calculator' },
  { depth: 1, role: 'text', name: 'Display is 0', id: 'CalculatorResults' },
  { depth: 1, role: 'group', name: 'Number pad' },
  { depth: 2, role: 'button', name: 'Seven', id: 'num7Button', actions: ['Invoke'] },
  { depth: 2, role: 'button', name: 'Plus', id: 'plusButton', actions: ['Invoke'] },
  { depth: 2, role: 'button', name: 'Five', id: 'num5Button', actions: ['Invoke'] },
  { depth: 2, role: 'button', name: 'Equals', id: 'equalButton', actions: ['Invoke'] },
];
const clean = value => String(value ?? '').slice(0, 16384).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
// Executable reference for the C# serializer. Native equivalence needs --driver-selftest on Windows.
export function serializeFixtureTree(title, app, nodes) {
  const lines = [`Window: ${JSON.stringify(clean(title))}, App: ${clean(app)}.`], map = new Map();
  let skippedDepth;
  let truncated = false;
  for (const node of nodes) {
    if (skippedDepth !== undefined && node.depth > skippedDepth) continue;
    skippedDepth = undefined;
    if (node.type === 50007 && node.offscreen) { skippedDepth = node.depth; continue; }
    if (map.size >= 3000) { truncated = true; break; }
    const number = map.size; map.set(number, node);
    let line = '\t'.repeat(node.depth) + number + ' ' + node.role;
    const name = node.password ? '<redacted>' : clean(node.name);
    if (name) line += ' ' + name;
    if (node.enabled === false) line += ' (disabled)';
    if (node.focused) line += ' (focused)';
    if (node.selected === true) line += ' (selected)';
    if (node.toggle === 1) line += ' (checked)';
    if (node.toggle === 2) line += ' (mixed)';
    if (node.expanded === 0) line += ' (collapsed)';
    if (node.expanded === 1) line += ' (expanded)';
    if (node.id) line += ', ID: ' + clean(node.id);
    if (!node.password && node.value) line += ', Value: ' + clean(node.value);
    else if (!node.password && node.rangeValue != null) line += ', Value: ' + node.rangeValue;
    if (!node.password && node.help) line += ', Help: ' + clean(node.help);
    if (node.actions?.length) line += ', Secondary Actions: ' + node.actions.join(', ');
    lines.push(line);
  }
  return { text: lines.join('\n'), truncated, map };
}
const window = (windowId, pid, app, title) => ({ windowId, pid, app, title, processStart: '134059077770000001',
  imageIdentity: '134059077770000000:4096',
  image: 'C:\\Windows\\System32\\' + app + '.exe', aumid: null, className: 'Fixture', integrity: 'medium',
  cloaked: false, onCurrentDesktop: true, minimized: false, popup: false, ownerWindowId: '0', refused: null });
export const fakeWindows = [window('101', 41, 'Notepad', 'Untitled - Notepad'), window('102', 42, 'Calculator', 'Calculator')];

// A 2x2 synthetic PNG. Every pixel is fixture art, never a screen capture.
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
function fixturePng() {
  const chunk = (name, data) => {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); head.write(name, 4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

function run() {
  const nonce = process.env.SLEIGHT_DRIVER_NONCE, scenario = process.argv[2];
  const windows = structuredClone(fakeWindows);
  if (scenario === 'confinement-binding') for (const window of windows) window.bindingId = 'a'.repeat(32);
  if (scenario === 'safety-forbidden') { windows[0].image = 'C:\\Apps\\WindowsTerminal.exe'; windows[0].app = 'Windows Terminal'; }
  if (scenario === 'safety-elevated') { windows[0].refused = 'ELEVATED_TARGET'; windows[0].integrity = 'high'; }
  if (scenario === 'safety-own-host') windows[0].refused = 'OWN_HOST';
  let buffer = '', readId = 0, latestWindow, nodes, sum = '', note = 'Hello 日本 🪄';
  const read = found => {
    latestWindow = found;
    nodes = found.app === 'Notepad' ? notepadNodes() : calculatorNodes();
    if (found.app === 'Notepad') nodes[3].value = note;
    if (found.app === 'Calculator') nodes[1].name = 'Display is ' + (sum === '7+5=' ? '12' : '0');
    let { text, truncated, map } = serializeFixtureTree(found.title, found.app, nodes);
    const focused = [...map.entries()].filter(([, node]) => node.focused).map(([id]) => id);
    if (scenario === 'safety-menu' || scenario === 'safety-menu-active') text += '\n0 menu File\n\t1 menu item Open';
    return { window: found, text, truncated, focusedElement: focused.length === 1 ? focused[0] : null, readId: ++readId, elapsedMs: 0 };
  };
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', bytes => {
    buffer += bytes;
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const r = JSON.parse(line);
      if (scenario === 'stall' || scenario === 'stall-action' && ACTION_METHODS.includes(r.method)) continue;
      if (scenario === 'exit') { process.exitCode = 7; process.stdin.destroy(); return; }
      if (scenario === 'partial') { process.stdout.write('{"partial":'); process.stdin.destroy(); return; }
      if (scenario === 'oversize') { process.stdout.write('x'.repeat(2049)); continue; }
      if (scenario === 'invalid-json') { process.stdout.write('not json\n'); continue; }
      if (scenario === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff, 10])); continue; }
      const envelope = { protocol: 'sleight.windows-driver/1', nonce, id: r.id };
      if (scenario === 'nonce') envelope.nonce = '0'.repeat(64);
      if (scenario === 'id') envelope.id++;
      if (scenario === 'protocol') envelope.protocol = 'wrong/1';
      if (scenario === 'extra') envelope.extra = true;
      const error = (code, unhealthy = false) => send({ ...envelope, ok: false, error: { code, message: code, unhealthy } });
      if (['person', 'locked', 'secure'].includes(scenario) && !['ping', 'cancel', 'turn-start', 'turn-end'].includes(r.method)) {
        const action = ACTION_METHODS.includes(r.method) || r.method === 'stuckMenuEscape';
        const failure = windowsSafetyFixture({ scenario }).run(action ? 'admission' : 'read');
        if (failure.code) {
          send({ ...envelope, ok: false, error: { ...failure, message: formatWindowsDriverError(failure, { action }) } });
          continue;
        }
      }
      if (scenario === 'unhealthy') { error('DEADLINE_EXCEEDED', true); continue; }
      if (scenario === 'output-limit' && r.method === 'getApp') { error('OUTPUT_LIMIT'); continue; }
      let result;
      if (r.method === 'turn-start' || r.method === 'turn-end') result = { turn: r.params.turn, active: r.method === 'turn-start' };
      else if (r.method === 'ping') result = { protocol: envelope.protocol, methods: ['ping', 'getState', 'listApps', 'getApp', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'verifyWindowIdentity',
        ...scenario === 'actions' ? ACTION_METHODS : []] };
      else if (r.method === 'getState' || r.method === 'listApps') result = { windows,
        apps: windows.map(w => ({ id: w.image, name: w.app, pid: w.pid, processStart: w.processStart, windows: [w] })) };
      else if (['getApp', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'verifyWindowIdentity'].includes(r.method)) {
        if (r.method !== 'getApp' && (Object.keys(r.params).filter(key => key !== 'bindingId').sort().join(' ') !== 'processStart windowId' ||
            Object.hasOwn(r.params, 'bindingId') && (typeof r.params.bindingId !== 'string' || !/^[a-f0-9]{32}$/.test(r.params.bindingId)) ||
            typeof r.params.windowId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(r.params.windowId) || BigInt(r.params.windowId) > 18446744073709551615n ||
            typeof r.params.processStart !== 'string' || !/^[1-9][0-9]{0,18}$/.test(r.params.processStart) || BigInt(r.params.processStart) > 9223372036854775807n)) {
          error('INVALID_PARAMS'); continue;
        }
        if (r.method !== 'getApp' && scenario === 'confinement-binding' && r.params.bindingId !== 'a'.repeat(32)) {
          error('IDENTITY_CHANGED'); continue;
        }
        const selector = r.params.selector;
        const found = windows.find(w => r.method !== 'getApp' ? w.windowId === r.params.windowId :
          typeof selector === 'object' ? selector?.windowId === w.windowId : [w.app, w.title, w.image].some(s => s.toLowerCase() === String(selector).toLowerCase()));
        if (!found) { error('WINDOW_NOT_FOUND'); continue; }
        if (found.refused) { error(found.refused); continue; }
        if (r.params.processStart && r.params.processStart !== found.processStart) { error('IDENTITY_CHANGED'); continue; }
        result = r.method === 'verifyWindowIdentity' ? { window: found } : read(found);
        if (scenario === 'safety-changed' && r.method === 'verifyWindowIdentity' && readId > 0)
          result = { window: { ...found, image: 'C:\\Other\\replacement.exe' } };
        if (['getScreenshot', 'getAXStateAndScreenshot'].includes(r.method)) {
          const refusal = { 'capture-own-host': 'OWN_HOST', 'capture-elevated': 'ELEVATED_TARGET', 'capture-changed': 'IDENTITY_CHANGED' }[scenario];
          if (refusal) { error(refusal); continue; }
          if (r.method === 'getScreenshot') result = { window: found };
          const status = ['capture-minimized', 'capture-cloaked', 'capture-black', 'capture-failed'].includes(scenario) ? scenario.slice(8) : 'ok';
          result.capture = { status, method: 'PrintWindow', ...(status === 'ok' ? { width: 2, height: 2 } : { note: 'Synthetic capture unavailable: ' + status }) };
          if (status === 'ok') result.screenshot = { mimeType: 'image/png', data: fixturePng() };
        }
      } else if ((scenario === 'actions' || scenario === 'foreground-changed' || scenario === 'background-unavailable' || scenario?.startsWith('safety-')) &&
          (ACTION_METHODS.includes(r.method) || r.method === 'stuckMenuEscape')) {
        if (r.method === 'stuckMenuEscape' && scenario === 'safety-menu-active') { error('USER_ACTIVE'); continue; }
        try { validateActionParams(r.method === 'stuckMenuEscape' ? 'pressKey' : r.method, r.params); } catch { error('INVALID_PARAMS'); continue; }
        if (scenario === 'background-unavailable') { error('BACKGROUND_UNAVAILABLE'); continue; }
        const p = r.params;
        if (!latestWindow || p.readId !== readId || p.windowId !== latestWindow.windowId || p.processStart !== latestWindow.processStart) {
          error('STALE_READ'); continue;
        }
        const t = p.args[0];
        const n = typeof t === 'number' ? nodes[t] : t && typeof t === 'object' && !Array.isArray(t) ?
          nodes.find(n => t.id ? n.id === t.id : n.name === t.label) : nodes[3];
        if (n?.password) { error('PASSWORD_TARGET'); continue; }
        let route = 'posted-key';
        if (['click', 'doubleClick', 'rightClick'].includes(r.method)) {
          if (!n) { error('ELEMENT_NOT_FOUND'); continue; }
          route = r.method === 'click' ? clickRoute(n.actions?.includes('Invoke') ? [10000] : n.actions?.includes('Expand/Collapse') ? [10005] : [], () => {}) : 'posted-mouse';
          if (latestWindow.app === 'Calculator') sum += ({ num7Button: '7', plusButton: '+', num5Button: '5', equalButton: '=' })[n.id] ?? '';
        } else if (r.method === 'setValue') { note = p.args[1]; route = 'Value'; }
        else if (r.method === 'typeText' || r.method === 'paste') { note += p.args[0]; route = 'WM_CHAR'; }
        else if (r.method === 'scroll') route = 'Scroll';
        else if (r.method === 'selectText') route = 'Text';
        else if (r.method === 'performSecondaryAction') route = p.args[1];
        else if (r.method === 'drag') route = 'posted-drag';
        result = { ...read(latestWindow), action: r.method, route, confirmation: 'unconfirmed',
          foregroundChanged: scenario === 'foreground-changed', foregroundExecutable: scenario === 'foreground-changed' ? 'Calculator.exe' : 'explorer.exe',
          settle: scriptedSettle(r.method === 'typeText' ? { events: [] } : { events: [0] }) };
      } else { error('METHOD_NOT_FOUND'); continue; }
      if (scenario === 'split') {
        const bytes = Buffer.from(JSON.stringify({ ...envelope, ok: true, result }) + '\n');
        for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
      } else send({ ...envelope, ok: true, result });
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) run();

// All inputs and counters stay in memory. The mirror is injected for mutation
// witnesses; the default is the same module the Windows parent uses.
export function windowsClipboardFixture({ nodes = [{ depth: 0, role: 'standard window', name: 'Fixture' },
  { depth: 1, role: 'button', name: 'Ordinary', focused: true }], map = usKey,
  rule = clipboardRule, count = 10, error = 0, person = 0, sessionReason } = {}) {
  const actions = [], posts = [], patterns = [], order = [];
  let readId = 1, samples = 0;
  const watch = new rule.WindowsClipboardWatch(() => { samples++; order.push('baseline'); return { value: count, error }; }, () => person);
  const tree = () => serializeFixtureTree('Fixture', 'Fixture', nodes).text;
  const resolveTarget = target => {
    if (Array.isArray(target)) {
      const hits = nodes.filter(n => n.rect && target[0] >= n.rect[0] && target[1] >= n.rect[1] &&
        target[0] < n.rect[0] + n.rect[2] && target[1] < n.rect[1] + n.rect[3]);
      if (hits.length !== 1) throw Object.assign(Error('BACKGROUND_UNAVAILABLE'), { code: 'BACKGROUND_UNAVAILABLE' });
      return hits[0];
    }
    if (Number.isInteger(target)) return nodes[target];
    return nodes.find(n => target?.id ? n.id === target.id : n.name === target?.label);
  };
  return { nodes, actions, posts, patterns, order, watch,
    get samples() { return samples; },
    deny(value = 5) { count = 0; error = value; },
    restore(value) { count = value; error = 0; },
    bump(value = count + 1) { count = value >>> 0; }, person(value = person + 1) { person = value; },
    async action(method, args, { parent = true, during = () => {}, settle = () => {}, afterRead = () => {}, fail } = {}) {
      const text = tree(), focusedElement = nodes.findIndex(n => n.focused);
      rule.validateClipboardText?.(method, args);
      validateActionParams(method === 'stuckMenuEscape' ? 'pressKey' : method, { windowId: '101', processStart: '1', readId, args });
      if (parent && method !== 'stuckMenuEscape') await guardWindowsAction({ method, args, text, before: text, focusedElement });
      const blocked = new Set(rule.windowsClipboardBlockedRows(text));
      nodes.forEach((n, i) => { n.clipboardBlocked = blocked.has(i); });
      order.push('native-admission');
      const admission = rule.admitWindowsClipboardAction({ method: method === 'stuckMenuEscape' ? 'pressKey' : method,
        args, nodes, resolveTarget, map });
      // Paste cannot route through the system board when direct input is absent.
      if (method === 'paste' && (/[\x00-\x1f\x7f]/.test(args[0]) || admission.node?.edit === false))
        throw Object.assign(Error('the system clipboard was not accessed'), { code: 'BACKGROUND_UNAVAILABLE' });
      return rule.runWindowsClipboardTransaction(watch, () => {
        const pattern = admission.accelerator || ['click', 'performSecondaryAction', 'selectText', 'setValue'].includes(method);
        (pattern ? patterns : posts).push(method);
        actions.push([method, args]); order.push('input'); during();
        if (fail) throw Object.assign(Error(fail), { code: fail });
        return { delivery: 'sent-unverified', retry: 'read-first', clipboardChanged: false };
      }, () => { order.push('settle'); settle(); }, () => { order.push('read'); afterRead(); readId++; }, () => {
        order.push('session');
        if (sessionReason) throw Object.assign(Error('SCREEN_LOCKED'), { code: 'SCREEN_LOCKED', reason: sessionReason,
          delivery: 'not-sent', retry: 'safe' });
      });
    },
  };
}
export function usKey(character) {
  return /^[a-z]$/.test(character) ? character.toUpperCase().charCodeAt(0) : character === ' ' ? 32 : -1;
}
