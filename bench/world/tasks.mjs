import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { genericTask } from '../generic-task.mjs';
import { acquireFixture } from '../real-run.mjs';
import { openFixture, closeFixtures } from '../real-fixture.mjs';
import { calculatorValue } from '../calculator-value.mjs';
import { runOwned } from '../preapproved-process.mjs';
import { browserKinds, serveWorldPage, checkBrowserFixture } from './browser-fixtures.mjs';
import { heldOutTasks } from '../tasks-held-out.mjs';
import { ccHeldOutTasks } from './cc-held-out.mjs';
import { mailToSheetTask } from '../tasks-mail-to-sheet.mjs';
import { consentWallTasks } from './consent-tasks.mjs';

// Test constant only. Runtime approvals use the selected tasks through worldPassApps.
export const WORLD_APPS = ['Calculator', 'com.apple.calculator', 'TextEdit', 'com.apple.TextEdit', 'Chess', 'com.apple.Chess',
  'Finder', 'com.apple.finder', 'Preview', 'com.apple.Preview', 'Microsoft Word', 'Word', 'com.microsoft.Word',
  'Microsoft Excel', 'Excel', 'com.microsoft.Excel', 'Helium', 'net.imput.helium',
  // The claim's app tasks (owner, 2026-10-18): VS Code, Slack's throwaway workspace and Spotify.
  'Visual Studio Code', 'VS Code', 'Code', 'com.microsoft.VSCode', 'Slack', 'com.tinyspeck.slackmacgap', 'Spotify', 'com.spotify.client'];
export const worldPassApps = tasks => [...new Set(tasks.flatMap(task => task.allowedApps ?? []))];
const fixtureApps = {
  Calculator: ['Calculator', 'com.apple.calculator'], TextEdit: ['TextEdit', 'com.apple.TextEdit'], Chess: ['Chess', 'com.apple.Chess'],
  Finder: ['Finder', 'com.apple.finder'], Preview: ['Preview', 'com.apple.Preview'],
  'Microsoft Word': ['Microsoft Word', 'Word', 'com.microsoft.Word'], 'Microsoft Excel': ['Microsoft Excel', 'Excel', 'com.microsoft.Excel'],
  Helium: ['Helium', 'net.imput.helium'],
  Safari: ['Safari', 'com.apple.Safari'], Firefox: ['Firefox', 'org.mozilla.firefox'],
  'Visual Studio Code': ['Visual Studio Code', 'VS Code', 'Code', 'com.microsoft.VSCode'], Slack: ['Slack', 'com.tinyspeck.slackmacgap'],
  Spotify: ['Spotify', 'com.spotify.client'],
};
const neutral = text => text.replace(/Using computer use in the background,\s*/g, '').replace(/Using computer use,?\s*/g, '');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const calculatorMode = text => {
  const matches = [...text.matchAll(/\bID: Mode: ([a-z]+);/g)];
  return matches.length === 1 ? matches[0][1] : undefined;
};

async function currentCalculator(ctx) {
  if (ctx.readCalculator) return ctx.readCalculator();
  const pid = ctx.app?.pid ?? ctx.calculator?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('WORLD_CALCULATOR_PID_MISSING');
  const result = await runOwned('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./calculator-read.js', import.meta.url)),
    JSON.stringify({ pid, start: ctx.calculatorIdentity?.start })], { signal: ctx.signal, timeoutMs: 10000 });
  // The reason travels with the code: four native rows on 2026-10-19 failed here with nothing else recorded.
  if (!result.groupClean || result.exit?.code !== 0) throw new Error(`WORLD_CALCULATOR_READ_FAILED: exit ${result.exit?.code ?? result.exit?.signal ?? 'unknown'}` +
    `${result.groupClean ? '' : ', group not clean'}: ${String(result.stderr ?? '').trim().slice(-200)}`);
  const value = JSON.parse(result.stdout);
  if (value.pid !== pid || !Number.isFinite(value.start) || value.start <= 0 || typeof value.value !== 'string') throw new Error('WORLD_CALCULATOR_IDENTITY_CHANGED');
  ctx.calculatorIdentity ??= { pid: value.pid, start: value.start };
  return `1 text Description: Edit field, Value: ${value.value}\n2 button ID: Mode: ${value.mode}; unitConversion: false`;
}

async function requireColdApp(ctx, app, checkKey) {
  const result = await (ctx[checkKey] ?? runOwned)('/usr/bin/pgrep', ['-x', app], { signal: ctx.signal, timeoutMs: 10000 });
  if (!result.groupClean || result.exit?.code !== 1) throw new Error(`World ${app} fixture requires ${app} to be closed before setup`);
}

function calculator(task, open) {
  const retained = genericTask(task, { open });
  const prepare = ctx => {
    ctx.left = 11 + randomBytes(1)[0] % 70; ctx.right = task.id === 'calculator-menu' ? 2 : 11 + randomBytes(1)[0] % 70;
    ctx.expectedCalculator = String(task.id === 'calculator-menu' ? ctx.left ** ctx.right : ctx.left * ctx.right);
  };
  return { ...retained, prepare,
    setup: async ctx => {
      await requireColdApp(ctx, 'Calculator', 'calculatorProcessCheck');
      await retained.setup(ctx);
      const before = await currentCalculator(ctx);
      ctx.calculatorBefore = calculatorValue(before);
      if (task.id === 'calculator-menu') {
        ctx.calculatorModeBefore = calculatorMode(before);
        if (!['basic', 'scientific'].includes(ctx.calculatorModeBefore)) throw new Error('WORLD_CALCULATOR_MODE_UNAVAILABLE');
        ctx.expectedCalculatorMode = ctx.calculatorModeBefore === 'scientific' ? 'basic' : 'scientific';
      }
      do { prepare(ctx); } while (ctx.expectedCalculator === ctx.calculatorBefore);
    },
    prompt: ctx => task.id === 'calculator-menu' ? `In Calculator, choose ${ctx.expectedCalculatorMode === 'basic' ? 'Basic' : 'Scientific'} mode from the View menu and clear the input. Compute ${ctx.left} multiplied by itself. Leave the result displayed in that mode and reply with that number.`
      : `In Calculator, clear the input, then calculate ${ctx.left} multiplied by ${ctx.right} by clicking its buttons. Leave the result displayed and reply with that number.`,
    check: async ctx => {
      try {
        const state = await currentCalculator(ctx), value = calculatorValue(state);
        if (task.id === 'calculator-menu' && (!ctx.expectedCalculatorMode || ctx.calculatorModeBefore === ctx.expectedCalculatorMode ||
          calculatorMode(state) !== ctx.expectedCalculatorMode)) return 'WORLD_CALCULATOR_MODE_MISMATCH';
        return value === ctx.expectedCalculator && ctx.calculatorBefore !== value || 'WORLD_CALCULATOR_DISPLAY_MISMATCH';
      } catch (error) { return `WORLD_CALCULATOR_DISPLAY_UNAVAILABLE: ${String(error?.message ?? error).slice(0, 300)}`; }
    },
  };
}

function crossCalculatorTask(open) {
  const prepare = ctx => {
    ctx.document = join(ctx.dir, `Calculation-${ctx.nonce}.txt`);
    ctx.left = 11 + randomBytes(1)[0] % 70; ctx.expectedCalculator = String(ctx.left * 23);
    writeFileSync(ctx.document, String(ctx.left) + '\n');
  };
  return { id: 'textedit-calculator', app: 'TextEdit', prepare, setup: async ctx => {
    await requireColdApp(ctx, 'Calculator', 'calculatorProcessCheck');
    await acquireFixture(ctx, 'calculator', () => open(ctx, { app: 'Calculator', bundle: 'com.apple.calculator', target: '', mode: 'inherit' }));
    ctx.calculatorBefore = calculatorValue(await currentCalculator(ctx));
    do { prepare(ctx); } while (ctx.expectedCalculator === ctx.calculatorBefore);
    await acquireFixture(ctx, 'textedit', () => open(ctx, { app: 'TextEdit', bundle: 'com.apple.TextEdit', target: ctx.document,
      token: basename(ctx.document), mode: 'document' }));
  }, prompt: ctx => `In TextEdit, open ${ctx.document} and copy its number. Choose Basic mode and clear Calculator, paste the number and multiply it by 23. ` +
    'Copy the displayed result back into the same TextEdit document, replacing the original number. Save that plain text file and leave both fixture windows open.',
    check: async ctx => { try {
      if (readFileSync(ctx.document, 'utf8').trim() !== ctx.expectedCalculator) return 'WORLD_CROSS_FILE_MISMATCH';
      const value = calculatorValue(await currentCalculator(ctx));
      return value === ctx.expectedCalculator && value !== ctx.calculatorBefore || 'WORLD_CALCULATOR_DISPLAY_MISMATCH';
    } catch { return 'WORLD_CROSS_CALCULATION_UNAVAILABLE'; } }, cleanup: closeFixtures };
}

function checkTree(ctx) {
  try {
    const actual = {};
    const walk = (dir, prefix = '') => { for (const name of readdirSync(dir).filter(name => name !== '.DS_Store').sort()) {
      const path = join(dir, name), label = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('unexpected symlink');
      if (stat.isDirectory()) { actual[label + '/'] = ''; walk(path, label + '/'); }
      else if (stat.isFile()) actual[label] = readFileSync(path, 'utf8');
      else throw new Error('unexpected file type');
    } };
    walk(ctx.folder);
    return JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(ctx.expectedTree).sort()) || 'WORLD_TREE_MISMATCH';
  } catch { return 'WORLD_TREE_UNAVAILABLE'; }
}

function finderTask(id, open) {
  const prepare = ctx => {
    ctx.folder = join(ctx.dir, `Files-${ctx.nonce}`); mkdirSync(ctx.folder, { recursive: true });
    const text = `File ${ctx.nonce}\n`; writeFileSync(join(ctx.folder, 'alpha.txt'), text);
    if (id === 'finder-move') mkdirSync(join(ctx.folder, 'Archive'));
    ctx.expectedTree = id === 'finder-rename' ? { 'renamed.txt': text } : id === 'finder-move'
      ? { 'Archive/': '', 'Archive/alpha.txt': text } : { 'alpha.txt': text, 'Created/': '' };
  };
  return { id, app: 'Finder', prepare, setup: async ctx => {
    prepare(ctx); await acquireFixture(ctx, 'finder', () => open(ctx, { app: 'Finder', bundle: 'com.apple.finder', target: ctx.folder, token: basename(ctx.folder), mode: 'folder' }));
  }, prompt: ctx => `In Finder, work only in ${ctx.folder}. ` + ({
    'finder-rename': 'Rename alpha.txt to renamed.txt.', 'finder-move': 'Move alpha.txt into Archive.',
    'finder-create-folder': 'Create an empty folder named Created and keep alpha.txt unchanged.',
  }[id]) + ' Leave the fixture window open.', check: checkTree, cleanup: closeFixtures };
}

function textTask(id, open) {
  const pair = ['textedit-two-windows', 'textedit-window-drag'].includes(id);
  const prepare = ctx => {
    ctx.documents = [join(ctx.dir, `Source-${ctx.nonce}.txt`), ...(pair ? [join(ctx.dir, `Target-${ctx.nonce}.txt`)] : [])];
    const initial = id === 'textedit-window-drag' ? `alpha move-${ctx.nonce} omega\n` : id === 'textedit-replace-all' ? 'amber amber amber\n' : 'first line\n';
    writeFileSync(ctx.documents[0], initial);
    if (pair) writeFileSync(ctx.documents[1], 'destination\n');
    ctx.expectedText = id === 'textedit-window-drag' ? ['alpha omega\n', `destination\nmove-${ctx.nonce}\n`]
      : id === 'textedit-two-windows' ? [`first ${ctx.nonce}\n`, `second ${ctx.nonce}\n`]
      : id === 'textedit-replace-all' ? ['violet violet violet\n'] : id === 'textedit-insert-line' ? [`first line\nsecond ${ctx.nonce}\n`] : [`replacement ${ctx.nonce}\n`];
  };
  return { id, app: 'TextEdit', prepare, setup: async ctx => {
    prepare(ctx);
    // A pair sits side by side in the display's visible frame: cascaded, the source covered the drop point (2026-10-19).
    for (const [index, document] of ctx.documents.entries()) await acquireFixture(ctx, `document${index}`, () => open(ctx, {
      app: 'TextEdit', bundle: 'com.apple.TextEdit', target: document, token: basename(document), mode: 'document',
      ...(pair && { placement: { slot: index, count: ctx.documents.length } }) }));
  }, prompt: ctx => {
    const [source, target] = ctx.documents;
    const instructions = {
      'textedit-two-windows': `Replace the complete contents of ${source} with "first ${ctx.nonce}" and ${target} with "second ${ctx.nonce}". Each file must end with one newline. Save both files.`,
      'textedit-window-drag': `In ${source}, select move-${ctx.nonce} and drag it to a new final line in ${target}. Use drag and drop, not typing or cut and paste. Remove any extra space left between alpha and omega in the source. Save both files with one final newline.`,
      'textedit-replace-all': `In ${source}, replace every amber with violet. Preserve the spaces and final newline. Save the file.`,
      'textedit-insert-line': `In ${source}, append a second line "second ${ctx.nonce}" with a final newline. Save using Command-S.`,
      'textedit-replace-save': `Replace the complete contents of ${source} with "replacement ${ctx.nonce}" followed by one newline. Save the file.`,
    };
    return `In TextEdit, use only these fixture documents. ${instructions[id]} Leave them open for cleanup.`;
  }, capture: (ctx, response) => { if (id === 'textedit-window-drag') ctx.methodAudit = response.methodAudit; }, check: ctx => {
    if (id === 'textedit-window-drag' && (!ctx.methodAudit?.complete || !ctx.methodAudit.drag || ctx.methodAudit.replacement)) return 'WORLD_DRAG_METHOD_UNPROVEN';
    try { return ctx.documents.every((path, index) => readFileSync(path, 'utf8') === ctx.expectedText[index]) || 'WORLD_TEXT_MISMATCH'; }
    catch { return 'WORLD_TEXT_UNAVAILABLE'; }
  }, cleanup: closeFixtures };
}

function textPDF(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(body);
  return body + `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}
function previewTask(open) {
  const preview = {
    id: 'preview-read', app: 'Preview', prepare: ctx => {
      ctx.document = join(ctx.dir, `Read-${ctx.nonce}.pdf`); ctx.readback = `Readback ${randomBytes(12).toString('hex')}`;
      writeFileSync(ctx.document, textPDF(ctx.readback)); ctx.beforeHash = hash(ctx.document);
    },
    setup: async ctx => { preview.prepare(ctx); await acquireFixture(ctx, 'preview', () => open(ctx, {
      app: 'Preview', bundle: 'com.apple.Preview', target: ctx.document, token: basename(ctx.document), mode: 'document' })); },
    prompt: ctx => `In Preview, read the single line on the page of ${ctx.document}. Reply with exactly that line, without changing or saving the PDF. Leave it open.`,
    check: ctx => { try { return ctx.answer.trim() === ctx.readback && hash(ctx.document) === ctx.beforeHash || 'WORLD_PREVIEW_READ_MISMATCH'; } catch { return 'WORLD_PREVIEW_UNAVAILABLE'; } },
    cleanup: closeFixtures,
  };
  return preview;
}

export const browserInstructions = {
  'local-wikipedia': 'Read the elevation of Station Cedar. Return only JSON with the numeric metres field.',
  'local-mdn': 'Read the code for a ceramic request. Return only JSON with the numeric code field.',
  'table-scrape': 'Read the complete work log. Return only JSON with rows, an array of objects with name and numeric hours.',
  'file-upload': 'Choose the fixture file {uploadPath}, then submit the upload form.',
  'tab-switching': 'Open the second-tab link. Copy its value, return to the first tab, fill Value and submit.',
  'multi-page-search': 'Find the record for Project Cedar. Return only JSON with its reference field.',
  'form-controls': 'Select the choice whose label begins Choice, enable Enabled, copy the displayed entry text into Text and submit.',
};
function browserTask(id, open) {
  const prepare = async ctx => {
    await serveWorldPage(ctx, id);
    if (id === 'file-upload') { ctx.uploadPath = join(ctx.dir, 'upload.txt'); writeFileSync(ctx.uploadPath, ctx.worldPage.expected.uploadText); }
  };
  return { id, app: 'Helium', half: 'browser', prepare, setup: async ctx => {
    await prepare(ctx); await acquireFixture(ctx, 'browser', () => open(ctx, { app: 'Helium', bundle: 'net.imput.helium', target: ctx.url,
      token: ctx.nonce, mode: 'window', fixtureKind: 'web-page' }));
  }, prompt: ctx => `In the fixture browser window at ${ctx.url}, ${browserInstructions[id].replace('{uploadPath}', ctx.uploadPath)} Use only this fixture and leave its windows open.`,
    check: ctx => checkBrowserFixture(ctx.worldPage, ctx.answer), cleanup: closeFixtures };
}

export function getWorldTasks({ defaults, real, open = openFixture }) {
  const original = ['calculator-click', 'calculator-menu', 'textedit-save', 'textedit-edit', 'textedit-drag', 'chess-drag'].map(id => {
    const task = defaults.find(task => task.id === id);
    if (id.startsWith('calculator-')) return calculator(task, open);
    const retained = genericTask(task, { open });
    if (id === 'textedit-save') {
      const prepare = ctx => { ctx.document = join(ctx.dir, `${ctx.nonce}.txt`); writeFileSync(ctx.document, ''); };
      return { ...retained, prepare, setup: async ctx => { prepare(ctx); await retained.setup(ctx); },
        prompt: ctx => `In TextEdit, write exactly "fixture ${ctx.nonce}" in ${ctx.document} and save the same plain text file. Leave it open.`,
        check: ctx => { try { return readFileSync(ctx.document, 'utf8').trim() === `fixture ${ctx.nonce}` || 'WORLD_SAVE_MISMATCH'; } catch { return 'WORLD_SAVE_UNAVAILABLE'; } } };
    }
    if (id === 'chess-drag') return { ...retained, setup: async ctx => {
      await requireColdApp(ctx, 'Chess', 'chessProcessCheck');
      await retained.setup(ctx);
    } };
    return retained;
  });
  const retained = ['preview-pdf', 'finder-files', 'textedit-calculator', 'word-edit', 'excel-edit'].map(id =>
    id === 'textedit-calculator' ? crossCalculatorTask(open) : real.find(task => task.id === id));
  const apps = ['vscode-edit', 'slack-post', 'spotify-play'].map(id => real.find(task => task.id === id));
  const added = ['finder-rename', 'finder-move', 'finder-create-folder'].map(id => finderTask(id, open)).concat(
    ['textedit-two-windows', 'textedit-window-drag', 'textedit-replace-save', 'textedit-replace-all', 'textedit-insert-line'].map(id => textTask(id, open)), previewTask(open));
  // The held-out document tasks run only by name (--tasks), never in a pass without it.
  return [...original, ...retained, ...apps, ...added, ...browserKinds.map(id => browserTask(id, open)), ...heldOutTasks(open), ...ccHeldOutTasks(open), mailToSheetTask(open), ...consentWallTasks()].map(task => ({ ...task, fixtureLifecycle: true,
    allowedApps: task.allowedApps ?? (task.id === 'textedit-calculator' ? ['TextEdit', 'Calculator'] : [task.app]).flatMap(app => fixtureApps[app] ?? []),
    // The cross-app task copies a number: Claude Code's computer use asks for the clipboard with its apps (live 2026-10-17 15:58Z).
    // Finder's own card always carries "can read/write any file": that is the app, not an extra grant (live 15:59Z).
    allowedGrants: task.allowedGrants ?? (task.id === 'textedit-calculator' ? ['clipboardRead', 'clipboardWrite'] : task.app === 'Finder' ? ['fileAccess'] : []),
    timeoutMs: 300000, half: task.half ?? (task.id === 'textedit-calculator' ? 'cross-app' : 'native'),
    prompt: ctx => neutral(task.prompt(ctx)) }));
}
