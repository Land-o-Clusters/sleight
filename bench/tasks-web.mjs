import { serveWebPage, checkWeb } from './real-server.mjs';
import { acquireFixture } from './real-run.mjs';
import { openFixture, closeFixtures, webBrowsers } from './real-fixture.mjs';

export { webBrowsers };

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
  validation: ctx => 'Submit the draft registration to reveal the validation errors. Correct Email to team@example.test and Seats to 3, ' +
    `enter "${ctx.nonce}" for Code, then resubmit. Leave the registration submitted with no validation errors.`,
  controls: () => 'Choose Orchid from the Project combobox, set Visit date to November 17, 2026 using the date picker, ' +
    'select Research in the Team select, then Save schedule.',
  modal: ctx => `Review Orchid, enter "Approved ${ctx.nonce}" for Approval note in its modal dialog, then Confirm approval. Leave the dialog closed.`,
  hover: () => 'Hover over the Orchid Actions area to reveal its menu, then choose Archive. Leave the menu closed and every other project unchanged.',
  reorder: () => 'Drag Orchid onto Maple to move Orchid immediately after Maple. Leave the order Oak, Cedar, Maple, Orchid, Pine.',
  iframe: ctx => `In the Project form iframe, select Orchid for Project, enter "${ctx.nonce}" for Code, then Submit project. Leave Outer page code blank.`,
  shadow: ctx => `In the Project component, select Orchid for Project, enter "${ctx.nonce}" for Code, then Submit project. Leave Outer page code blank.`,
  tabs: () => 'Open reference tab using the link. Read its reference value, close that tab using Close reference tab, ' +
    'then enter the value into Reference value on the first tab and Submit value. Leave Reference tab answer blank. Only these two fixture tabs are in scope.',
  accordion: () => 'Expand only Marine, read its code, enter that code in Marine code, then Submit code. Leave Marine expanded and the other sections collapsed.',
  delayed: () => 'Wait for the report content to load, read its report code, enter that code in Report code, then Submit report code.',
};

async function cleanup(ctx) {
  try { await closeFixtures(ctx); }
  finally { if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; } }
}

export const webTasks = Object.keys(instructions).flatMap(kind =>
  webBrowsers.flatMap(({ id, app, bundle, extension, legacyKinds }) =>
    ['native', ...(extension ? ['extension'] : [])].filter(surface => surface !== 'native' || !legacyKinds.includes(kind)).map(surface => ({
    id: `${id}-${kind}${surface === 'extension' ? '-extension' : ''}`, app, bundle, surface, webKind: kind,
    prepare: ctx => serveWebPage(ctx, kind),
    setup: async ctx => {
      await serveWebPage(ctx, kind);
      await acquireFixture(ctx, 'browser', () => openFixture(ctx, { app, bundle, target: ctx.url, token: ctx.nonce, mode: 'window', fixtureKind: 'web-page' }));
    },
    prompt: ctx => (surface === 'native'
      ? `Using computer use, work only in the new ${app} window showing ${ctx.url} through the engine's app API. `
      : `Using computer use, create a tab at ${ctx.url} with cua.createBrowserTab through the engine's browser API in the connected ${app} extension; retain its reference for engine turn-end cleanup and stop if that browser's extension cannot be identified. `) + instructions[kind](ctx) + ' ' +
      'Use the page controls and editing surface for this task. Leave this window open for cleanup. ' +
      'Do not read, list, switch to or close any other tabs or windows.',
    check: checkWeb, cleanup,
  }))));
