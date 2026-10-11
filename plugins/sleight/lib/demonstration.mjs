// A passive demonstration observer. The native helper never posts input or asks for permission.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOwnedGroup } from './owned-group.mjs';
import { notification } from './notification.mjs';

const bundleID = app => typeof app === 'string' && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(app) ? app : undefined;
const editableText = element => ['AXTextArea', 'AXTextField'].includes(element?.role) && element.editable === true;
const step = code => ({ tool: 'js', args: { code }, positions: [] });
function selector(element) {
  if (element?.secure || element?.role === 'AXSecureTextField') throw new Error('secure fields cannot be recorded');
  if (element?.id && element.idCount === 1) return { id: element.id };
  if (element?.label && element.labelCount === 1) return { label: element.label };
  throw new Error('observed element has no unique ID or label');
}

export class DemoRecording {
  constructor(app) {
    this.app = bundleID(app);
    if (!this.app) throw new Error('demonstration recording requires the selected app bundle ID');
    this.steps = [step(`let app = await cua.getApp(${JSON.stringify(this.app)});`)];
    this.interactions = new Set();
    this.emptyFields = new Set();
  }
  observe(event) {
    if (this.stopped) throw new Error('recording stopped; start a new demonstration');
    try {
      if (event.kind === 'complete') return;
      if (event.kind === 'ready') {
        if (typeof event.title === 'string' && event.title) {
          this.window = { title: event.title, ...(event.url ? { url: event.url } : {}) };
        }
        return;
      }
      if (event.element?.secure || event.element?.role === 'AXSecureTextField') throw new Error('secure fields cannot be recorded');
      if (event.kind === 'focus') return;
      if (event.kind === 'baseline') {
        if (!editableText(event.element) || event.empty !== true) throw new Error('text recording requires an empty editable native field baseline');
        this.emptyFields.add(JSON.stringify(selector(event.element)));
      } else if (event.kind === 'click' || event.kind === 'menu') {
        if (!['AXButton', 'AXMenuBarItem', 'AXMenuItem', 'AXCheckBox', 'AXRadioButton'].includes(event.element?.role)) throw new Error('unsupported clickable element');
        if (event.interaction && this.interactions.has(event.interaction)) return;
        if (event.interaction) this.interactions.add(event.interaction);
        this.steps.push(step(`await app.click(${JSON.stringify(selector(event.element))});`));
        this.lastValue = undefined;
      } else if (event.kind === 'value') {
        if (!editableText(event.element) || typeof event.value !== 'string') throw new Error('only editable native text values can be recorded');
        const spec = JSON.stringify(selector(event.element));
        if (!this.emptyFields.has(spec)) throw new Error('text recording requires an empty field baseline from before observation');
        const code = `await app.setValue(${spec},${JSON.stringify(event.value)});`;
        if (this.lastValue === spec) this.steps[this.steps.length - 1] = step(code);
        else this.steps.push(step(code));
        this.lastValue = spec;
      } else throw new Error(`recording cannot capture ${event.reason ?? event.kind}`);
    } catch (error) { this.stopped = error.message; throw error; }
  }
  script() {
    if (this.stopped) throw new Error(`recording stopped: ${this.stopped}`);
    if (this.steps.length === 1) throw new Error('no actions were observed; nothing saved');
    return { sleightReplay: 1, recorded: new Date().toISOString(), source: 'demonstration', steps: this.steps,
      ...(this.window ? { window: this.window } : {}) };
  }
}

export function watchOptions(args) {
  if (args[0] !== '--watch' || !bundleID(args[1]) || !args[2] || args[2].startsWith('--')) throw new Error('usage: sleight-mcp record --watch bundle.id out.json [--seconds 60]');
  const output = args[2] && !args[2].startsWith('--') ? args[2] : undefined;
  const options = args.slice(output ? 3 : 2);
  let seconds = 60;
  if (options.length) {
    if (options.length !== 2 || options[0] !== '--seconds' || !/^\d+$/.test(options[1])) throw new Error('unknown record option');
    seconds = Number(options[1]);
  }
  if (seconds < 1 || seconds > 3600) throw new Error('record seconds must be from 1 to 3600');
  return { app: args[1], output, seconds };
}

// Collect the owned compiler group before the caller removes its private cache.
export async function collectCompiler(child, { signals = process, timeoutMs = 180000, graceMs = 5000,
  collect = collectOwnedGroup,
  signalGroup = name => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } } } = {}) {
  let stderr = '', failure, force;
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536); });
  const stop = reason => {
    if (failure) return;
    failure = reason;
    if (child.pid) {
      signalGroup('SIGTERM');
      force = setTimeout(() => signalGroup('SIGKILL'), graceMs);
    }
  };
  const interrupt = () => stop('observer compilation interrupted');
  signals.once('SIGINT', interrupt); signals.once('SIGTERM', interrupt);
  const timer = setTimeout(() => stop('observer compilation timed out'), timeoutMs);
  child.once('error', error => { failure = error.message; });
  try {
    const code = await new Promise(resolve => child.once('close', resolve));
    clearTimeout(force);
    await collect(child.pid, { graceMs, signal: signalGroup });
    if (failure || code !== 0) throw new Error(failure || stderr.trim() || `observer compiler exited ${code}`);
  } finally {
    clearTimeout(timer); clearTimeout(force);
    signals.removeListener('SIGINT', interrupt); signals.removeListener('SIGTERM', interrupt);
  }
}

export async function sessionIdleSeconds({ execFile: run = promisify(execFile) } = {}) {
  const { stdout } = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'], { timeout: 5000, encoding: 'utf8' });
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
  if (!match) throw new Error('HID idle time unavailable');
  return Number(match[1]) / 1e9;
}

export function observerCacheKey(source) {
  return createHash('sha256').update(source).digest('hex');
}

export async function createDemoHelper({
  cacheRoot = join(userInfo().homedir, 'Library/Caches/sleight/observer'),
  source = fileURLToPath(new URL('./demonstration.swift', import.meta.url)),
  compile,
} = {}) {
  const key = observerCacheKey(readFileSync(source));
  const directory = join(cacheRoot, key);
  const binary = join(directory, 'observer');
  if (!existsSync(binary)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bank = mkdtempSync('/private/tmp/sleight-observer-');
    const built = join(bank, 'observer');
    try {
      if (compile) await compile({ source, binary: built, bank });
      else {
        const env = { ...process.env };
        // Prefer the installed full Xcode SDK when both toolchains exist. Do not change xcode-select.
        if (existsSync('/Applications/Xcode.app/Contents/Developer')) env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
        const compiler = spawn('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'cache'), source, '-o', built],
          { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env });
        await collectCompiler(compiler);
      }
      copyFileSync(built, binary);
      chmodSync(binary, 0o700);
      rmSync(bank, { recursive: true, force: true });
    } catch (error) {
      if (error.cleanupUnconfirmed) error.message += `; preserved compiler cache: ${bank}`;
      else rmSync(bank, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    async check() {
      const { stdout } = await promisify(execFile)(binary, ['--check'], { timeout: 5000 });
      return JSON.parse(stdout);
    },
    async state() {
      const { stdout } = await promisify(execFile)(binary, ['--routine-state'], { timeout: 5000 });
      return JSON.parse(stdout);
    },
    observe(emit, app, seconds) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, [app, String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let error, stderr = '', complete = false;
        const interrupt = () => child.kill('SIGINT');
        const terminate = () => { error = new Error('demonstration recording terminated; nothing saved'); child.kill('SIGTERM'); };
        process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
          if (error) return;
          try {
            const event = JSON.parse(line);
            if (event.kind === 'complete') complete = true;
            emit(event);
          } catch (caught) { error = caught; child.kill('SIGTERM'); }
        });
        child.once('error', caught => { error = caught; });
        child.once('close', code => {
          process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); lines.close();
          if (error || code !== 0 || !complete) reject(error ?? new Error(stderr.trim() || 'demonstration observer stopped without a complete stream'));
          else resolve();
        });
      });
    },
    close() {},
  };
}

export async function recordWatch({ app, output, seconds = 60, helper, log = () => {}, input = process.stdin,
  notify = state => notification(`sleight recording ${state}`, `${app} demonstration recording ${state}`) }) {
  if (!input.isTTY) throw new Error('recording must start in an interactive terminal');
  if (!output) throw new Error('recording requires an output file');
  const recording = new DemoRecording(app);
  if (output && existsSync(output)) throw new Error('output file already exists; choose a new filename');
  helper ??= await createDemoHelper();
  let started = false, script;
  try {
    const trust = await helper.check();
    if (!trust.trusted) throw new Error('Accessibility is unavailable; stopped without requesting permission');
    if (!trust.listening) throw new Error('Input Monitoring is unavailable; clicks cannot be observed, stopped without requesting permission');
    await notify('started'); started = true;
    log(`Observing ${app} for ${seconds}s. Demonstrate the task now; Ctrl-C finishes. No permission prompts will be requested.`);
    await helper.observe(event => recording.observe(event), recording.app, seconds);
    script = recording.script();
  } finally {
    try { await helper.close?.(); }
    finally { if (started) await notify('stopped'); }
  }
  writeFileSync(output, JSON.stringify(script, null, 1) + '\n', { flag: 'wx', mode: 0o600 });
  log(`Recorded ${script.steps.length - 1} observed actions to ${output}. Review the script before replay.`);
  return script;
}
