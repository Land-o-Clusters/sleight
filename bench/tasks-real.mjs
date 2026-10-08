import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootedIPhone, simctl } from './tasks.mjs';
import { serveRealPage, checkForm, checkFlow } from './real-server.mjs';
import { writeTestPDF, checkPDF } from './real-pdf.mjs';
import { acquireFixture } from './real-run.mjs';

const execute = promisify(execFile);
async function fixtureWindow(op, app, target, id, signal) {
  const script = app === 'net.imput.helium' ? 'real-helium.applescript' : app === 'com.apple.Safari' ? 'real-safari.applescript' : 'real-window.applescript';
  const windowScript = fileURLToPath(new URL(script, import.meta.url));
  const { stdout } = await execute('/usr/bin/osascript', [windowScript, op, app, target, ...(id == null ? [] : [String(id)])],
    { encoding: 'utf8', timeout: 15000, signal });
  return stdout.trim();
}
async function closePage(ctx, app) {
  try {
    if (ctx.windowOpening && !ctx.windowID) throw new Error('Browser window creation was interrupted before its ID was recorded; cleanup unconfirmed');
    if (ctx.windowID) await fixtureWindow('close', app, ctx.url, ctx.windowID, ctx.cleanupSignal);
  } finally {
    if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; }
  }
}
const desktopForm = (id, app, bundle) => ({
  id, app,
  prepare: ctx => serveRealPage(ctx),
  setup: async ctx => {
    await serveRealPage(ctx);
    ctx.windowOpening = true;
    ctx.windowID = await fixtureWindow('open', bundle, ctx.url, undefined, ctx.signal);
    ctx.windowOpening = false;
  },
  prompt: ctx => `Using computer use, work only in the new ${app} window showing ${ctx.url}. ` +
    'Fill Name with "Morgan Reed", Email with "morgan@example.test", select "Design" for Team, ' +
    `check "Send updates", and fill Code with "${ctx.nonce}". Submit the form. ` +
    'Leave that window open for cleanup. Do not read, list, switch to or close any other tabs or windows.',
  check: checkForm,
  cleanup: ctx => closePage(ctx, bundle),
});

function checkFiles(ctx) {
  try {
    const names = readdirSync(ctx.folder).filter(n => n !== '.DS_Store').sort();
    if (names.join(',') !== 'Archive,charlie.txt,renamed.txt' ||
      !lstatSync(join(ctx.folder, 'Archive')).isDirectory() ||
      readdirSync(join(ctx.folder, 'Archive')).filter(n => n !== '.DS_Store').join(',') !== 'bravo.txt') return 'folder has missing or extra files';
    for (const [name, text] of [['renamed.txt', `alpha ${ctx.nonce}\n`], ['Archive/bravo.txt', `bravo ${ctx.nonce}\n`], ['charlie.txt', `charlie ${ctx.nonce}\n`]]) {
      const path = join(ctx.folder, name);
      if (!lstatSync(path).isFile() || readFileSync(path, 'utf8') !== text) return `unexpected contents or type: ${name}`;
    }
    return true;
  } catch { return 'fixture folder or file is missing'; }
}
function prepareFiles(ctx) {
  ctx.folder = join(ctx.dir, `Files-${ctx.nonce}`);
  mkdirSync(join(ctx.folder, 'Archive'), { recursive: true });
  for (const name of ['alpha', 'bravo', 'charlie']) writeFileSync(join(ctx.folder, `${name}.txt`), `${name} ${ctx.nonce}\n`);
}
function prepareText(ctx) {
  ctx.document = join(ctx.dir, `Calculation-${ctx.nonce}.txt`);
  writeFileSync(ctx.document, '17\n');
}

export const realTasks = [
  desktopForm('safari-form', 'Safari', 'com.apple.Safari'),
  desktopForm('helium-form', 'Helium', 'net.imput.helium'),
  {
    id: 'preview-pdf', app: 'Preview',
    prepare: ctx => { ctx.pdf = join(ctx.dir, `Pages-${ctx.nonce}.pdf`); return writeTestPDF(ctx.pdf, [0, 0], ctx.signal); },
    setup: async ctx => {
      ctx.pdf = join(ctx.dir, `Pages-${ctx.nonce}.pdf`);
      await acquireFixture(ctx, 'pdfFixture', () => writeTestPDF(ctx.pdf, [0, 0], ctx.signal));
      await acquireFixture(ctx, 'previewIdentity', async () => {
        execFileSync('/usr/bin/open', ['-g', '-b', 'com.apple.Preview', ctx.pdf]);
        ctx.previewOpened = true;
        const { stdout } = await execute('/usr/bin/osascript', [fileURLToPath(new URL('./real-preview.applescript', import.meta.url)),
          'identify', pathToFileURL(ctx.pdf).href, basename(ctx.pdf)], { timeout: 15000, signal: ctx.signal });
        return stdout.trim();
      });
    },
    prompt: ctx => `Using computer use in Preview, open ${ctx.pdf}. Rotate only page 2 clockwise by 90 degrees, ` +
      'save the same PDF, and leave it open. Keep page 1 unchanged.',
    check: checkPDF,
    cleanup: async ctx => {
      if (ctx.previewOpened && !ctx.previewIdentity) throw new Error('Preview fixture identity was not recorded; cleanup unconfirmed');
      if (ctx.previewOpened) await execute('/usr/bin/osascript', [fileURLToPath(new URL('./real-preview.applescript', import.meta.url)),
        'close', pathToFileURL(ctx.pdf).href, ctx.previewIdentity], { timeout: 15000, signal: ctx.cleanupSignal });
    },
  },
  {
    id: 'finder-files', app: 'Finder', prepare: prepareFiles,
    setup: async ctx => {
      prepareFiles(ctx);
      ctx.windowOpening = true;
      ctx.windowID = await fixtureWindow('open', 'com.apple.finder', ctx.folder, undefined, ctx.signal);
      ctx.windowOpening = false;
    },
    prompt: ctx => `Using computer use in Finder, stay inside ${ctx.folder} and its Archive subfolder. ` +
      'Rename alpha.txt to renamed.txt, move bravo.txt into Archive, and leave charlie.txt unchanged. ' +
      'Use Finder for both operations. Leave this window open. Do not open or modify anything outside this folder.',
    check: checkFiles,
    cleanup: async ctx => {
      if (ctx.windowOpening && !ctx.windowID) throw new Error('Finder window creation was interrupted; cleanup unconfirmed');
      if (ctx.windowID) await fixtureWindow('close', 'com.apple.finder', ctx.folder, ctx.windowID, ctx.cleanupSignal);
    },
  },
  {
    id: 'textedit-calculator', app: 'TextEdit', prepare: prepareText,
    setup: async ctx => {
      prepareText(ctx);
      ctx.textOpened = true;
      await fixtureWindow('open', 'com.apple.TextEdit', ctx.document, undefined, ctx.signal);
      await acquireFixture(ctx, 'calculatorOwnership', () => fixtureWindow('open', 'com.apple.calculator', '', undefined, ctx.signal));
    },
    prompt: ctx => `Using computer use, open ${ctx.document} in TextEdit and copy its number. ` +
      'Choose Basic mode and clear Calculator before pasting the number. Multiply it by 23, copy the result, and paste it into TextEdit, ' +
      'replacing the original number. Save that same plain text document and leave it open. Use copy and paste between the apps.',
    check: ctx => {
      try { return readFileSync(ctx.document, 'utf8').trim() === '391' || 'saved document does not contain only 391'; }
      catch { return 'calculation document is missing'; }
    },
    cleanup: async ctx => {
      if (ctx.textOpened) await fixtureWindow('close', 'com.apple.TextEdit', ctx.document, undefined, ctx.cleanupSignal);
      if (ctx.calculatorOwnership === 'owned') await fixtureWindow('close', 'com.apple.calculator', '', 'owned', ctx.cleanupSignal);
    },
  },
  {
    id: 'simulator-flow', app: 'Simulator', prepare: ctx => serveRealPage(ctx, true),
    setup: async ctx => {
      await acquireFixture(ctx, 'sim', () => bootedIPhone({ trackOwnership: true }));
      await serveRealPage(ctx, true);
      simctl('openurl', ctx.sim.udid, ctx.url);
      ctx.simPageOpened = true;
    },
    prompt: ctx => `Using computer use in the ${ctx.sim?.app ?? 'Simulator'} app's ${ctx.sim?.name ?? 'iPhone'} simulator, ` +
      `Safari shows ${ctx.url}. Tap Edit profile, fill Value with "Flow ${ctx.nonce}", tap Save, ` +
      `tap Back to profile, and check that the profile shows "Flow ${ctx.nonce}". Leave the profile screen visible.`,
    check: checkFlow,
    cleanup: async ctx => {
      try {
        if (ctx.simPageOpened) simctl('terminate', ctx.sim.udid, 'com.apple.mobilesafari');
        if (ctx.sim?.bootedByTask) simctl('shutdown', ctx.sim.udid);
        if (ctx.sim?.viewerLaunchedByTask) await fixtureWindow('close', 'simulator-viewer', ctx.sim.app, undefined, ctx.cleanupSignal);
      }
      finally { if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; } }
    },
  },
];
