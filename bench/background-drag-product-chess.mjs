import { basename, join } from 'node:path';
import { validateBackgroundDrag } from './background-drag/helper.mjs';

// Keep recovery separate from posting: an uncertain move must only be read.
export async function runChessTrial({ mode, resumeId, resumeSaveDirectory, plan, receipt, save, fixture, js, tool, observeDrag, command, makeDirectory, listFiles }) {
  let created;
  if (Number.isInteger(resumeId) && resumeId > 0) {
    created = (await fixture({ op: 'windows' })).filter(w => w.id === resumeId);
    receipt.resumedOwnedWindow = resumeId;
  } else {
    if (mode === 'chess-finish') throw new Error('Recovery requires the recorded game window');
    const before = await fixture({ op: 'windows' }); receipt.windowsBefore = before; await save();
    if (!before.length) throw new Error('Chess inventory does not match its engine window; no setup attempted');
    const newGame = await js('await chess.pressKey("super+n"); await chess.getAXState()');
    const state = newGame.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const start = /(?:^|\n)\s*(\d+) button (?:Play|Start|New Game)\b/.exec(state);
    if (!start) throw new Error('New game dialog has no recognized start button');
    await js(`await chess.click(${Number(start[1])}); await chess.getAXState()`);
    const after = await fixture({ op: 'windows' }); receipt.windowsAfter = after; await save();
    created = after.filter(w => !before.some(old => old.id === w.id));
  }
  if (created.length !== 1) throw new Error('Cannot identify one owned Chess game');
  const run = { windowId: created[0].id }; receipt.runs.push(run); await save();
  run.geometry = await fixture({ op: 'geometry', windowId: run.windowId });
  const matchedView = async () => {
    const view = await js('await chess.getAXState({disableDiffing:true})');
    const state = view.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!state.includes(`Window: "${run.geometry.title}", App: Chess.`)) throw new Error('Engine window differs from owned benchmark game');
  };
  const moved = view => view.squares.some(x => x.name === 'white pawn, e4') && !view.squares.some(x => x.name === 'white pawn, e2');
  if (mode === 'chess-image') { await matchedView(); await js('await chess.getScreenshot()'); await save(); return; }
  if (mode === 'chess-finish') {
    run.noDrag = true; run.readback = run.geometry; run.passed = moved(run.readback);
    if (!run.passed) throw new Error('Recovery read does not confirm e2-e4; no further drag sent');
    await fixture({ op: 'raise', windowId: run.windowId });
  } else {
    let from = run.geometry.squares.find(x => x.name === 'white pawn, e2');
    let to = run.geometry.squares.find(x => x.name === 'e4');
    if (!from || !to || from.size.some(x => x <= 0) || to.size.some(x => x <= 0)) throw new Error('Chess square geometry unavailable');
    if (plan) {
      const checked = validateBackgroundDrag(plan);
      if (checked.app !== 'Chess' || checked.windowId !== run.windowId) throw new Error('Measured plan differs from owned Chess game');
      run.measuredPoints = plan;
      from = { ...from, point: checked.from }; to = { ...to, point: checked.to };
    }
    if (mode === 'chess-control') await matchedView();
    await observeDrag(run, { app: 'Chess', windowId: run.windowId, from: from.point, to: to.point }, args => mode === 'chess-control'
      ? js(`await chess.drag(${JSON.stringify(args.from)},${JSON.stringify(args.to)}); await chess.getAXState()`)
      : tool('drag', args));
    run.readback = await fixture({ op: 'geometry', windowId: run.windowId });
    run.passed = !run.reply.isError && moved(run.readback);
    if (!run.passed) throw new Error('Chess e2-e4 move did not verify');
  }
  let dir, panel;
  if (resumeSaveDirectory) {
    if (mode !== 'chess-finish' || !/^\/private\/tmp\/sleight-product-chess-[\w-]+$/.test(resumeSaveDirectory)) throw new Error('Invalid recorded save directory');
    dir = resumeSaveDirectory;
    panel = await js('await chess.getAXState({disableDiffing:true})');
    const state = panel.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!state.includes('ID: save-panel')) {
      await matchedView();
      await js('await chess.pressKey("super+s"); await chess.getAXState()');
      await js(`await chess.pressKey("super+shift+g"); await chess.typeText(${JSON.stringify(dir)}); await chess.pressKey("Return"); await chess.getAXState()`);
      panel = await js('await chess.pressKey("Return"); await chess.getAXState({disableDiffing:true})');
    }
  } else {
    await matchedView(); dir = await makeDirectory();
    await js('await chess.pressKey("super+s"); await chess.getAXState()');
    await js(`await chess.pressKey("super+shift+g"); await chess.typeText(${JSON.stringify(dir)}); await chess.pressKey("Return"); await chess.getAXState()`);
    panel = await js('await chess.pressKey("Return"); await chess.getAXState({disableDiffing:true})');
  }
  run.saveDirectory = dir;
  const panelText = panel.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const saveButton = /(?:^|\n)\s*(\d+) button .*ID: OKButton\b/.exec(panelText);
  if (!panelText.includes('ID: save-panel') || !panelText.includes(`Value: ${basename(dir)}, ID: where popup`) || !saveButton) throw new Error('Owned save panel and destination did not verify');
  if (resumeSaveDirectory && !panelText.includes(`Value: ${run.geometry.title.split(' | ')[0]}.game, ID: saveAsNameTextField`)) throw new Error('Save panel name differs from recorded game');
  await js(`await chess.click(${Number(saveButton[1])}); await chess.getAXState()`);
  const files = (await listFiles(dir)).filter(x => x.endsWith('.game'));
  if (files.length !== 1) throw new Error('Game save not confirmed');
  run.savedPath = join(dir, files[0]);
  run.moves = await command('/usr/bin/plutil', ['-extract', 'Moves', 'raw', '-o', '-', run.savedPath]);
  if (run.moves.trim().split('\n')[0] !== 'e2e4') throw new Error('Saved game does not begin e2e4');
  run.saved = true;
  run.geometry = await fixture({ op: 'geometry', windowId: run.windowId });
  await matchedView();
  await js('await chess.pressKey("super+w"); await chess.getAXState()');
  run.closed = !(await fixture({ op: 'windows' })).some(w => w.id === run.windowId);
  if (!run.closed) throw new Error('Saved owned Chess game did not close');
}
