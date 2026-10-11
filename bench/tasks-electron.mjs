import { serveRealPage, serveWebPage, checkForm, checkWeb } from './real-server.mjs';
import { acquireFixture } from './real-run.mjs';
import { prepareEditor, setupEditor, checkEditor, openElectron, cleanupElectron } from './real-electron.mjs';
import { CHAT_APPS, prepareChat, setupChat, promptChat, checkChat, cleanupChat,
  expectedChat, labelsChat } from './real-chat.mjs';

const editors = [
  ['vscode-edit', 'Visual Studio Code', 'com.microsoft.VSCode'],
  ['cursor-edit', 'Cursor', 'com.todesktop.230313mzl4w4u92'],
];

const editorTasks = editors.map(([id, app, bundle]) => ({
  id, app, bundle,
  prepare: prepareEditor,
  setup: ctx => setupEditor(ctx, { app, bundle }),
  prompt: ctx => `Using computer use in the background, open ${ctx.document} in ${app}, replace the word "beta" with "delta", and save that same file. ` +
    'Leave it open. Do not open, read, modify or close other files or windows.',
  check: checkEditor, cleanup: cleanupElectron,
}));

const firefoxPrompt = {
  form: ctx => 'Fill Name with "Morgan Reed", Email with "morgan@example.test", select "Design" for Team, '
    + `check "Send updates", and fill Code with "${ctx.nonce}". Submit the form.`,
  grid: () => 'Find the row whose Project is Orchid, change only its Budget from 275 to 125, then sort Budget ascending. Keep every other row and value unchanged.',
  spa: ctx => 'Choose Requests, then New request. Select Research for Category, enter Orchid for Project, choose Continue, '
    + `enter "${ctx.nonce}" for Code, then Submit request. Leave the Request submitted screen visible.`,
};

function firefoxTask(kind, serve, check) {
  return {
    id: `firefox-${kind}`, app: 'Firefox', bundle: 'org.mozilla.firefox',
    prepare: ctx => kind === 'form' ? serve(ctx) : serve(ctx, kind),
    setup: async ctx => {
      if (kind === 'form') await serve(ctx);
      else await serve(ctx, kind);
      await acquireFixture(ctx, 'browser', () => openElectron(ctx, {
        app: 'Firefox', bundle: 'org.mozilla.firefox', target: ctx.url,
      }));
    },
    prompt: ctx => `Using computer use in the background, work only in the Firefox window showing ${ctx.url}. ${firefoxPrompt[kind](ctx)} ` +
      'Use the page controls for this task. Leave this window open for cleanup. ' +
      'Do not read, list, switch to or close any other tabs or windows.',
    check, cleanup: cleanupElectron,
  };
}

const firefoxTasks = [
  firefoxTask('form', serveRealPage, checkForm),
  firefoxTask('grid', serveWebPage, checkWeb),
  firefoxTask('spa', serveWebPage, checkWeb),
];

const chatTasks = Object.entries(CHAT_APPS).map(([kind, spec]) => ({
  id: spec.id, app: spec.app, bundle: spec.bundle, privateMail: true,
  // The owner's real chat accounts: only with the owner watching (LAWS, 2026-10-11).
  ownerPresent: true,
  prepare: prepareChat, setup: ctx => setupChat(ctx, kind),
  prompt: promptChat, check: checkChat, cleanup: cleanupChat,
  privateExpected: expectedChat, privateTerms: labelsChat,
}));

export const electronTasks = [...editorTasks, ...firefoxTasks, ...chatTasks];
