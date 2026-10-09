import { serveWebPage, checkWeb } from './real-server.mjs';
import { acquireFixture } from './real-run.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';

const instructions = {
  grid: () => 'Find the row whose Project is Orchid, change only its Budget from 275 to 125, then sort Budget ascending. Keep every other row and value unchanged.',
  editor: ctx => 'In the editable planning document, find the Release checklist heading. Bold only the phrase "ship carefully" in its paragraph, ' +
    `then append a third bullet "Archive notes ${ctx.nonce}". Keep the title, heading, paragraph text and existing two bullets unchanged.`,
  dense: () => 'In the research archive, open the link named "Tidal observatory field notes" and leave that article visible.',
  spa: ctx => 'Choose Requests, then New request. Select Research for Category, enter Orchid for Project, choose Continue, ' +
    `enter "${ctx.nonce}" for Code, then Submit request. Leave the Request submitted screen visible.`,
  nested: ctx => 'Expand Collections, then Science, Marine, Station and Reports. ' +
    `Select "Coral report ${ctx.nonce}". Leave the whole path expanded and that selection visible.`,
  infinite: ctx => 'Scroll through the inspection records until Record 87 is loaded. Open Record 87, ' +
    `enter "Reviewed ${ctx.nonce}" for Review note and Confirm review. Leave the dialog closed and the reviewed result visible.`,
};

async function cleanup(ctx) {
  try { await closeFixtures(ctx); }
  finally { if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; } }
}

export const webTasks = ['grid', 'editor', 'dense', 'spa', 'nested', 'infinite'].flatMap(kind =>
  [['safari', 'Safari', 'com.apple.Safari'], ['helium', 'Helium', 'net.imput.helium']].map(([id, app, bundle]) => ({
    id: `${id}-${kind}`, app,
    prepare: ctx => serveWebPage(ctx, kind),
    setup: async ctx => {
      await serveWebPage(ctx, kind);
      await acquireFixture(ctx, 'browser', () => openFixture(ctx, { app, bundle, target: ctx.url, token: ctx.nonce, mode: 'window' }));
    },
    prompt: ctx => `Using computer use, work only in the new ${app} window showing ${ctx.url}. ${instructions[kind](ctx)} ` +
      'Use the page controls and editing surface for this task. Leave this window open for cleanup. ' +
      'Do not read, list, switch to or close any other tabs or windows.',
    check: checkWeb, cleanup,
  })));
