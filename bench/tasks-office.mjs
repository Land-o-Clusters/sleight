import { basename } from 'node:path';
import { acquireFixture } from './real-run.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';
import { prepareOffice, checkWord, checkExcel, checkPowerPoint } from './real-office.mjs';

const guard = 'Work only in that fixture document. Save the same file and leave it open for cleanup. ' +
  'Do not open, read, modify or close other documents or windows. If a sign-in, activation, licensing, ' +
  'first-run or permission dialog appears, stop and report its visible text. Do not sign in or dismiss it.';
const task = (id, kind, app, bundle, instructions, check) => ({
  id, app, bundle, stopOnAppDialog: true,
  prepare: ctx => prepareOffice(ctx, kind),
  setup: async ctx => {
    prepareOffice(ctx, kind);
    await acquireFixture(ctx, 'office', () => openFixture(ctx, {
      app, bundle, target: ctx.officePath, token: basename(ctx.officePath), mode: 'document', stopOnAppDialog: true,
    }));
  },
  prompt: ctx => `Using computer use in ${app}, edit only ${ctx.officePath}. ${instructions(ctx)} ${guard}`,
  check, cleanup: closeFixtures,
});

export const officeTasks = [
  task('word-edit', 'word', 'Microsoft Word', 'com.microsoft.Word', ctx =>
    `Apply the built-in Heading 1 paragraph style to "Report ${ctx.nonce}". ` +
    'Use Find and Replace to replace amber with violet. Keep all other existing text unchanged. ' +
    'At the end of the document insert one 2-row, 2-column table. Its first row is Item | Count, ' +
    'and its second row is Crates | 7. Do not add any other text.', checkWord),
  task('excel-edit', 'excel', 'Microsoft Excel', 'com.microsoft.Excel', ctx =>
    'On Inventory, sort only A2:B4 by the Item column in ascending alphabetical order, keeping each quantity with its item. ' +
    'Enter Budget in D1, 11 in D2, 4 in D3, and the formula =SUM(D2:D3) in D4. ' +
    `Add one empty worksheet named "Review ${ctx.nonce}" after Inventory. ` +
    'Keep all other existing cells unchanged. Calculate and save, so D4 is 15 in the saved workbook.', checkExcel),
  task('powerpoint-edit', 'powerpoint', 'Microsoft PowerPoint', 'com.microsoft.Powerpoint', ctx =>
    `Add one Title Only slide with the title "Middle ${ctx.nonce}". Reorder slides so their titles are ` +
    `"Finish ${ctx.nonce}", "Start ${ctx.nonce}", "Middle ${ctx.nonce}", in that order. ` +
    'Keep the existing slide titles unchanged and add no other content.', checkPowerPoint),
];
