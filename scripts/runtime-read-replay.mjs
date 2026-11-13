// Offline UC2E replay. Reads only checked-in, recorded Calculator and Excel trees.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createMacReadState, MAC_DELIVERED_CONTEXT_NOTICE } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), 'utf8'));
const item = text => ({ type: 'text', text });
const numbers = text => new Map(text.split('\n').flatMap(line => {
  const match = /^(\t*)(\d+) (.*)$/.exec(line);
  return match ? [[Number(match[2]), line]] : [];
}));
const compactor = () => createReadCompactor({ compactReacquire: true, compactAcquisition: false, callTrees: false,
  resultTrim: false, compactToolbars: false, scrollNote: false, screenshotReads: false, routeSteering: false, undoReceipts: false });

// RRD1: GLS2C may omit a known row's new number after a removal diff. Count it
// separately only when its exact text and ancestor path were already printed,
// and the real parent refuses that unprinted number after display commits.
export function auditDisplayedRead(previous, tree, shown, state, snapshot) {
  const result = { falseAddedLines: 0, missingCurrentLines: 0, refusedRenumberedLines: 0 };
  const before = numbers(previous), current = numbers(tree), added = new Set();
  const currentLines = new Set(tree.split('\n')), previousLines = new Set(previous.split('\n'));
  for (const line of shown.split('\n').filter(line => line.startsWith('+ ')).map(line => line.slice(2))) {
    if (!currentLines.has(line) || previousLines.has(line)) result.falseAddedLines++;
    if (/^\t*\d+ /.test(line)) added.add(line);
  }
  const contexts = text => {
    const rows = new Map(), parents = [];
    for (const [number, line] of numbers(text)) {
      const [, indent, body] = /^(\t*)\d+ (.*)$/.exec(line);
      while (parents.length && parents.at(-1).depth >= indent.length) parents.pop();
      rows.set(number, JSON.stringify([...parents.map(row => row.body), indent + body]));
      parents.push({ depth: indent.length, body: indent + body });
    }
    return rows;
  };
  const newContexts = contexts(tree);
  // An earlier complete observation may itself have been compacted. Only the
  // last full display certifies that an omitted row's text was actually shown.
  const fullDisplay = state.displayContext(snapshot.window)?.F ?? '';
  const known = new Set(contexts(fullDisplay).values());
  for (const [number, line] of current) {
    if (before.get(number) === line || added.has(line) || number === 0 && shown.split('\n')[1] === line) continue;
    if (known.has(newContexts.get(number))) {
      try {
        state.assertCurrent('click', { ...snapshot.window, readId: snapshot.readId, args: [number] }, 'replay-audit');
      } catch (error) {
        if (error.code === 'STALE_READ' && error.message.includes(MAC_DELIVERED_CONTEXT_NOTICE)) {
          result.refusedRenumberedLines++; continue;
        }
      }
    }
    result.missingCurrentLines++;
  }
  return result;
}

export function recordedReadBanks() {
  const calculator = fixture('rt11f-replay.json').pairs.filter(pair => pair.delivered.startsWith('0 standard window Calculator,'));
  const excel = fixture('excel-reacquire.json');
  const calculatorHeader = 'Window: "Calculator", App: Calculator.\n';
  const banks = [{ name: 'Calculator', source: 'tests/fixtures/rt11f-replay.json',
    sequences: calculator.map(pair => [calculatorHeader + pair.delivered, calculatorHeader + pair.current]) }];
  const reads = [];
  for (const result of excel.results) {
    for (const block of result.head) if (block === '@inventory') reads.push(excel.inventory);
    // Preserve complete recorded rest trees; sliced and diff-only blocks cannot
    // establish a new full baseline. No missing rows are invented for replay.
    for (const block of result.rest) {
      let partial = block ?? '';
      for (const match of (block ?? '').matchAll(/^Window: [^\n]*\n0 [^\n]*(?:\n\t*\d+ [^\n]*)+\n\n?The focused UI element[^\n]*/gm)) {
        const tree = match[0], rows = [...numbers(tree).keys()];
        if (rows.every((number, index) => number === index)) {
          reads.push(tree); partial = partial.replace(tree, '');
        }
      }
      if (result.code?.includes('.slice(') && /^Window: /m.test(partial)) reads.push({ output: partial });
    }
  }
  banks.push({ name: 'Excel', source: 'tests/fixtures/excel-reacquire.json', sequences: [reads] });
  return banks;
}

export function replayReadBanks(banks = recordedReadBanks()) {
  return banks.map(bank => {
    const result = { bank: bank.name, source: bank.source, sequences: bank.sequences.length, reads: 0, repeatReads: 0,
      fullCharacters: 0, glideCharacters: 0, chatgptCompactorCharacters: 0, compactReads: 0, slicedPrints: 0,
      falseAddedLines: 0, missingCurrentLines: 0, refusedRenumberedLines: 0 };
    for (const sequence of bank.sequences) {
      const state = createMacReadState(), chatgpt = compactor();
      let previous, readId = 0;
      for (const tree of sequence) {
        if (typeof tree !== 'string') {
          // A recorded partial print has no complete parent observation in this
          // bank. Display it unchanged and mark the parent view for a full
          // recovery read. The standalone compactor has no delivery marks.
          const batch = state.prepareDisplay([item(tree.output)], [], { compact: true });
          if (batch.content[0].text !== tree.output) throw Error('REPLAY_PARTIAL_CHANGED');
          batch.commit(); result.slicedPrints++; continue;
        }
        const header = /^Window: "(.*)", App: (.*)\.$/m.exec(tree);
        if (!header) throw Error('REPLAY_HEADER');
        const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'org.test.replay',
          app: header[2], title: header[1], identityVerified: true };
        const snapshot = state.read({ window, readId: ++readId, text: tree, truncated: false });
        const batch = state.prepareDisplay([item(tree)], [snapshot], { compact: true });
        const shown = batch.content.map(row => row.text ?? '').join('\n');
        const parity = chatgpt.process([item(tree)], { acquisition: true, code: 'app.getAXState()' }).map(row => row.text ?? '').join('\n');
        batch.commit();
        result.reads++;
        if (previous !== undefined) {
          result.repeatReads++; result.fullCharacters += tree.length; result.glideCharacters += shown.length;
          result.chatgptCompactorCharacters += parity.length;
          if (shown !== tree) {
            result.compactReads++;
            const audit = auditDisplayedRead(previous, tree, shown, state, snapshot);
            for (const key of Object.keys(audit)) result[key] += audit[key];
          }
        }
        previous = tree;
      }
    }
    result.savedPercent = Number((100 * (1 - result.glideCharacters / result.fullCharacters)).toFixed(2));
    return result;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = replayReadBanks();
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  if (results.some(row => row.repeatReads === 0 || row.savedPercent < 40 || row.falseAddedLines || row.missingCurrentLines)) process.exitCode = 1;
}
