// Saved, private fixture manifests for the four native classes ordinary replay cannot reconstruct.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareReplay } from '../replay/fixtures.mjs';
import { TargetMapper } from '../replay/mapping.mjs';
import { assertReplayArguments } from '../replay/allowlist.mjs';
import { getTasks } from '../tasks.mjs';
import { acquireFixture } from '../real-run.mjs';
import { openFixture, closeFixtures } from '../real-fixture.mjs';
import { runOwned } from '../preapproved-process.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const TEXT_REPLAYS = ['textedit-drag', 'textedit-edit', 'textedit-save', 'textedit-window-drag', 'textedit-two-windows',
  'textedit-replace-save', 'textedit-replace-all', 'textedit-insert-line'];
const APPS = { ...Object.fromEntries(TEXT_REPLAYS.map(id => [id, ['TextEdit']])), 'finder-move': ['Finder'], 'preview-read': ['Preview'],
  'calculator-click': ['Calculator'], 'textedit-calculator': ['TextEdit', 'Calculator'] };
export const allowedCheck4Replay = id => Object.hasOwn(APPS, id);
const BUNDLES = { TextEdit: 'com.apple.TextEdit', Finder: 'com.apple.finder', Preview: 'com.apple.Preview', Calculator: 'com.apple.calculator' };
export function fixturePath(root, relative) {
  if (typeof relative !== 'string' || !relative || isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p === '' || p === '.')) throw Error('Invalid saved fixture relative path');
  const path = resolve(root, relative);
  if (!path.startsWith(resolve(root) + sep)) throw Error('Saved fixture escapes bank');
  return path;
}
export function recordedCoverage(recording) {
  const calls = recording.calls;
  const scrollIndex = calls.findIndex(c => /\bscroll\s*\(/.test(c.arguments?.code ?? '') || c.name === 'scroll');
  const crossWindowDrag = calls.some(c => c.name === 'drag' && c.arguments?.toWindowId && c.arguments.toWindowId !== c.arguments.windowId ||
    /\.drag\s*\([^]*\btoWindowId\b/.test(c.arguments?.code ?? ''));
  // The recording lacks a monotonic action clock. Qualification checks the actual submitted-call clock too.
  return { scrollIndex, scrollInFirstFifthByCalls: scrollIndex >= 0 && scrollIndex < calls.length / 5, crossWindowDrag };
}
export function prepareCheck4Replay(recording, dir, saved, { open = openFixture, onPid = () => {}, run = runOwned } = {}) {
  if (!allowedCheck4Replay(recording.task.id) || recording.kind !== 'native') throw Error('Check 4 accepts only its allowed native fixture tasks');
  for (const call of recording.calls) {
    assertReplayArguments(call.arguments);
    const office = value => /^(?:Microsoft )?(?:Word|Excel)$|^com\.microsoft\.(?:Word|Excel)$/i.test(value);
    const walk = value => {
      if (typeof value === 'string' && office(value)) throw Error('Check 4 refuses Word and Excel');
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(call.arguments);
    if (typeof call.arguments.code === 'string') {
      const ts = require('typescript');
      const ast = ts.createSourceFile('check4-recording.js', call.arguments.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = node => {
        if (ts.isStringLiteralLike(node) && office(node.text)) throw Error('Check 4 refuses Word and Excel');
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  }
  if (!saved && TEXT_REPLAYS.includes(recording.task.id)) return prepareReplay(recording, dir);
  if (!saved || !/^[a-f0-9]{8}$/.test(saved.nonce ?? '') || !isAbsolute(saved.sourceDir ?? '') || !Array.isArray(saved.windows) || !saved.windows.length || saved.windows.length > 4)
    throw Error(`Saved fixture manifest required for ${recording.task.id}`);
  if (!saved.files || typeof saved.files !== 'object' || Array.isArray(saved.files) || Object.keys(saved.files).length > 32) throw Error('Invalid saved fixture files');
  let bytes = 0;
  for (const [name, data] of Object.entries(saved.files)) {
    fixturePath(dir, name);
    if (!/\.(txt|pdf)$/.test(name) || typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('Saved fixture requires base64 txt/pdf data');
    bytes += Buffer.from(data, 'base64').length;
  }
  if (bytes > 8 * 1024 ** 2) throw Error('Saved fixture data exceeds 8 MiB');
  for (const w of saved.windows) {
    if (!APPS[recording.task.id].includes(w.app) || !['document', 'folder', 'inherit'].includes(w.mode)) throw Error('Saved fixture app or mode refused');
    if (w.target) fixturePath(dir, w.target);
    if (w.mode !== 'inherit' && !w.target) throw Error('Saved fixture target missing');
  }
  if (recording.task.id === 'finder-move' && new Set(saved.windows.map(w => w.target)).size < 2)
    throw Error('Finder cross-window fixture requires two distinct folder windows');
  const mapper = new TargetMapper(); mapper.addString(saved.sourceDir, dir);
  if (/^\/(var|tmp)\//.test(saved.sourceDir)) mapper.addString('/private' + saved.sourceDir, dir);
  const fields = saved.context ?? {};
  const allowed = new Set(['left', 'right', 'expectedCalculator', 'calculatorBefore', 'readback', 'beforeHash', 'expectedTree', 'expectedText']);
  if (Object.keys(fields).some(k => !allowed.has(k))) throw Error('Unexpected saved context field');
  const ctx = { ...fields, dir, nonce: saved.nonce, ownerAway: true, stopOnAppDialog: true };
  const definition = getTasks('world').find(t => t.id === recording.task.id);
  if (!definition) throw Error('Missing world fixture definition');
  const wrapped = { ...definition, setup: async ctx => {
    if (saved.windows.some(w => w.app === 'Calculator')) {
      const result = await run('/usr/bin/pgrep', ['-x', 'Calculator'], { signal: ctx.signal, timeoutMs: 10000 });
      if (!result.groupClean || result.exit?.code !== 1) throw Error('Check 4 Calculator fixture requires Calculator to be closed before setup');
    }
    for (const [name, data] of Object.entries(saved.files)) {
      const path = fixturePath(dir, name); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(data, 'base64'), { mode: 0o600, flag: 'wx' });
    }
    // Existing fixture helpers enforce retained PID, start identity and window ownership at cleanup.
    for (const [index, w] of saved.windows.entries()) {
      const target = w.target ? fixturePath(dir, w.target) : '';
      if (w.mode === 'folder') mkdirSync(target, { recursive: true, mode: 0o700 });
      const key = w.app === 'Calculator' ? 'calculator' : `window${index}`;
      const fixture = await acquireFixture(ctx, key, () => open(ctx, { app: w.app, bundle: BUNDLES[w.app], target,
        mode: w.mode, ...(target ? { token: basename(target) } : {}), stopOnAppDialog: true,
        ...(w.app === 'Preview' ? { placement: { slot: 0, count: 1 } } : w.placement ? { placement: w.placement } : {}) }));
      const owned = fixture ?? ctx[key]; if (Number.isSafeInteger(owned?.pid)) onPid(owned.pid);
      if (w.app === 'TextEdit' || w.app === 'Preview') ctx.document = target;
      if (w.app === 'Finder' && !ctx.folder) ctx.folder = target;
      if (w.app === 'Calculator') {
        const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('../world/calculator-read.js', import.meta.url)),
          JSON.stringify({ pid: owned.pid })], { signal: ctx.signal, timeoutMs: 10000 });
        if (!result.groupClean || result.exit?.code !== 0) throw Error('Check 4 Calculator baseline unavailable');
        const state = JSON.parse(result.stdout);
        if (state.pid !== owned.pid || typeof state.value !== 'string' || !Number.isFinite(state.start)) throw Error('Check 4 Calculator baseline identity changed');
        ctx.calculatorBefore = state.value; ctx.calculatorIdentity = { pid: state.pid, start: state.start };
      }
    }
  }, prompt: () => 'Replay the saved native fixture.',
  check: ctx => definition.check({ ...ctx, answer: saved.answer ?? '' }), cleanup: closeFixtures };
  return { mapper, native: { definition: wrapped, ctx, oldDir: saved.sourceDir, suite: 'world' } };
}
