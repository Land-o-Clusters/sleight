import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChessTrial } from '../bench/background-drag-product-chess.mjs';

test('resumed recovery verifies, saves and closes the exact game without another drag', async () => {
  let closed = false, saved = false; const calls = [], receipt = { runs: [] };
  await runChessTrial({ mode: 'chess-finish', resumeId: 11, receipt, save: async () => {},
    fixture: async request => request.op === 'windows' ? (closed ? [] : [{ id: 11 }]) :
      { title: 'benchmark-game', squares: [{ name: 'e2' }, { name: 'white pawn, e4' }] },
    js: async code => { calls.push(code); if (code.includes('super+w')) closed = true;
      if (code.includes('chess.click(13)')) saved = true;
      return { content: [{ type: 'text', text: 'Window: "benchmark-game", App: Chess.\n0 dialog Save, ID: save-panel\n4 pop up button Where:, Value: benchmark-game, ID: where popup\n13 button Save, ID: OKButton' }] }; },
    observeDrag: () => assert.fail('recovery must never drag'), tool: () => assert.fail('no drag tool'),
    command: async () => 'e2e4\ne7e6\n', makeDirectory: async () => '/private/tmp/benchmark-game', listFiles: async () => saved ? ['benchmark.game'] : [],
  });
  assert.equal(receipt.runs.length, 1); assert.equal(receipt.runs[0].noDrag, true);
  assert.equal(receipt.runs[0].saved, true); assert.equal(receipt.runs[0].closed, true);
  assert.equal(calls.filter(x => x.includes('super+w')).length, 1);
});
test('recovery with an unchanged board refuses without saving or pressing', async () => {
  await assert.rejects(runChessTrial({ mode: 'chess-finish', resumeId: 11, receipt: { runs: [] }, save: async () => {},
    fixture: async request => request.op === 'windows' ? [{ id: 11 }] : { title: 'benchmark-game', squares: [{ name: 'white pawn, e2' }, { name: 'e4' }] },
    js: () => assert.fail('no input or save'), observeDrag: () => assert.fail('no drag'),
  }), /does not confirm/);
});
test('save-panel recovery finishes only the recorded destination without another drag', async () => {
  let closed = false; const calls = [], receipt = { runs: [] };
  await runChessTrial({ mode: 'chess-finish', resumeId: 11, resumeSaveDirectory: '/private/tmp/sleight-product-chess-test', receipt, save: async () => {},
    fixture: async request => request.op === 'windows' ? (closed ? [] : [{ id: 11 }]) :
      { title: 'benchmark-game | test', squares: [{ name: 'e2' }, { name: 'white pawn, e4' }] },
    js: async code => { calls.push(code); if (code.includes('super+w')) closed = true;
      const text = code.includes('getAXState') && !calls.some(c => c.includes('chess.click(13)')) ?
        'Window: "Save", App: Chess.\n0 dialog Save, ID: save-panel\n4 pop up button Where:, Value: sleight-product-chess-test, ID: where popup\n7 text field (settable) Value: benchmark-game.game, ID: saveAsNameTextField\n13 button Save, ID: OKButton' : 'Window: "benchmark-game | test", App: Chess.';
      return { content: [{ type: 'text', text }] }; },
    observeDrag: () => assert.fail('no drag'), tool: () => assert.fail('no drag'),
    makeDirectory: () => assert.fail('use recorded directory'), listFiles: async () => ['benchmark-game.game'], command: async () => 'e2e4\n',
  });
  assert.equal(receipt.runs[0].closed, true);
  assert.equal(calls.some(x => x.includes('super+s') || x.includes('super+shift+g')), false);
});
