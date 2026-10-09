import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bootedIPhone, simctl, quitSimApp } from './tasks.mjs';
import { serveRealPage, checkForm, checkFlow } from './real-server.mjs';
import { writeTestPDF, checkPDF } from './real-pdf.mjs';
import { acquireFixture } from './real-run.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';
import { webTasks } from './tasks-web.mjs';
import { officeTasks } from './tasks-office.mjs';
import { mailTasks } from './tasks-mail.mjs';
import { mimestreamTasks } from './tasks-mimestream.mjs';

async function closePage(ctx) {
  try {
    await closeFixtures(ctx);
  } finally {
    if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; }
  }
}
const desktopForm = (id, app, bundle) => ({
  id, app,
  prepare: ctx => serveRealPage(ctx),
  setup: async ctx => {
    await serveRealPage(ctx);
    await acquireFixture(ctx, 'browser', () => openFixture(ctx, { app, bundle, target: ctx.url, token: ctx.nonce,
      mode: 'window' }));
  },
  prompt: ctx => `Using computer use, work only in the new ${app} window showing ${ctx.url}. ` +
    'Fill Name with "Morgan Reed", Email with "morgan@example.test", select "Design" for Team, ' +
    `check "Send updates", and fill Code with "${ctx.nonce}". Submit the form. ` +
    'Leave that window open for cleanup. Do not read, list, switch to or close any other tabs or windows.',
  check: checkForm,
  cleanup: closePage,
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
      await acquireFixture(ctx, 'preview', () => openFixture(ctx, { app: 'Preview', bundle: 'com.apple.Preview',
        target: ctx.pdf, token: basename(ctx.pdf), mode: 'document' }));
    },
    prompt: ctx => `Using computer use in Preview, open ${ctx.pdf}. Rotate only page 2 clockwise by 90 degrees, ` +
      'save the same PDF, and leave it open. Keep page 1 unchanged.',
    check: checkPDF,
    cleanup: closeFixtures,
  },
  {
    id: 'finder-files', app: 'Finder', prepare: prepareFiles,
    setup: async ctx => {
      prepareFiles(ctx);
      await acquireFixture(ctx, 'finder', () => openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder',
        target: ctx.folder, token: basename(ctx.folder), mode: 'folder' }));
    },
    prompt: ctx => `Using computer use in Finder, stay inside ${ctx.folder} and its Archive subfolder. ` +
      'Rename alpha.txt to renamed.txt, move bravo.txt into Archive, and leave charlie.txt unchanged. ' +
      'Use Finder for both operations. Leave this window open. Do not open or modify anything outside this folder.',
    check: checkFiles,
    cleanup: closeFixtures,
  },
  {
    id: 'textedit-calculator', app: 'TextEdit', prepare: prepareText,
    setup: async ctx => {
      prepareText(ctx);
      await acquireFixture(ctx, 'textedit', () => openFixture(ctx, { app: 'TextEdit', bundle: 'com.apple.TextEdit',
        target: ctx.document, token: basename(ctx.document), mode: 'document' }));
      await acquireFixture(ctx, 'calculator', () => openFixture(ctx, { app: 'Calculator', bundle: 'com.apple.calculator',
        target: '', mode: 'inherit' }));
    },
    prompt: ctx => `Using computer use, open ${ctx.document} in TextEdit and copy its number. ` +
      'Choose Basic mode and clear Calculator before pasting the number. Multiply it by 23, copy the result, and paste it into TextEdit, ' +
      'replacing the original number. Save that same plain text document and leave it open. Use copy and paste between the apps.',
    check: ctx => {
      try { return readFileSync(ctx.document, 'utf8').trim() === '391' || 'saved document does not contain only 391'; }
      catch { return 'calculation document is missing'; }
    },
    cleanup: closeFixtures,
  },
  {
    id: 'simulator-flow', app: 'Simulator', prepare: ctx => serveRealPage(ctx, true),
    setup: async ctx => {
      const modern = existsSync('/Applications/Xcode.app/Contents/Applications/DeviceHub.app');
      await acquireFixture(ctx, 'simViewer', () => openFixture(ctx, { app: modern ? 'DeviceHub' : 'Simulator',
        bundle: modern ? 'com.apple.dt.Devices' : 'com.apple.iphonesimulator', target: '', mode: 'inherit' }, {
        launch: async beginLaunch => {
          await acquireFixture(ctx, 'sim', () => bootedIPhone({ trackOwnership: true, beforeViewerLaunch: beginLaunch }));
          await serveRealPage(ctx, true);
          simctl('openurl', ctx.sim.udid, ctx.url);
          ctx.simPageOpened = true;
        },
      }));
    },
    prompt: ctx => `Using computer use in the ${ctx.sim?.app ?? 'Simulator'} app's ${ctx.sim?.name ?? 'iPhone'} simulator, ` +
      `Safari shows ${ctx.url}. Tap Edit profile, fill Value with "Flow ${ctx.nonce}", tap Save, ` +
      `tap Back to profile, and check that the profile shows "Flow ${ctx.nonce}". Leave the profile screen visible.`,
    check: checkFlow,
    cleanup: async ctx => {
      try {
        if (ctx.simPageOpened && ctx.sim?.bootedByTask) simctl('terminate', ctx.sim.udid, 'com.apple.mobilesafari');
        await closeFixtures(ctx);
      }
      finally {
        try { if (ctx.sim?.bootedByTask) simctl('shutdown', ctx.sim.udid); }
        finally {
          try { await quitSimApp({ ownedOnly: true,
            lease: ctx.windowLeases?.find(lease => ['DeviceHub', 'Simulator'].includes(lease.app)) }); }
          finally { if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; } }
        }
      }
    },
  },
  ...webTasks,
  ...officeTasks,
  ...mailTasks,
  ...mimestreamTasks,
];
