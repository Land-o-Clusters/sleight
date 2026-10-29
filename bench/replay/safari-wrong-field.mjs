// Offline replay only. No relay startup, native helpers, apps or engine transport.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createReadCompactor } from '../../plugins/sleight/lib/compact-reads.mjs';
import { guardedCode, elementLines, windowFromText } from '../../plugins/sleight/lib/document-scope.mjs';
import { literalElements } from '../../plugins/sleight/lib/literal-elements.mjs';

export const recordings = ['safari-r1-c6', 'safari-r3-c9', 'safari-r3-c11'].map(name =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/safari-wrong-field/${name}.json`, import.meta.url), 'utf8')));

export async function replay({ code, before, requested = 26, effect = 53 }, {
  recordedEffect = true, snapshots, dispatchIdentityGuard = false, bind = true, ck1 = true, ck2 = true, timing = false,
} = {}) {
  const compactor = createReadCompactor();
  compactor.process([{ type: 'text', text: before }]);
  const action = compactor.beginAction(code);
  const window = windowFromText(before), numbers = [...new Set(literalElements(code))];
  const remapped = compactor.remapStale(window, code);
  const seenLines = compactor.seenLines(window, numbers);
  const writes = [], output = [], dispatches = [], reads = [];
  let current = before, read = 0;
  const raw = {
    getAXState: async () => {
      current = snapshots?.[Math.min(read++, snapshots.length - 1)] ?? current;
      reads.push(current.length);
      return current;
    },
    setValue: async (number, value) => {
      // The transcript retains an effect on 53, but not the original engine's resolved target.
      // This deliberately modeled engine fault must never be called historical dispatch proof.
      const actual = recordedEffect && number === requested ? effect : number;
      const lines = elementLines(current);
      dispatches.push({ number, line: lines.get(number), actual, actualLine: lines.get(actual),
        chosenBy: actual === number ? 'sleight dispatch' : 'fake-engine recorded-effect model' });
      // A proposed engine-side seam, absent from today's API: inspect the actual resolved object
      // immediately before mutation. Reading the public numbered tree alone cannot prove this.
      if (dispatchIdentityGuard && lines.get(number) !== lines.get(actual)) {
        throw new Error('proposed dispatch identity guard: role/label mismatch; zero write');
      }
      writes.push({ number, actual, value });
      current = current.replace(new RegExp(`^(\\t*${actual} )(.*)$`, 'm'), (_, prefix, line) => {
        const without = line.replace(/, Value: .*?(?=, (?:Placeholder|ID|Description|Help|URL|Secondary Actions): |$)/, '');
        const at = without.search(/, (?:Placeholder|ID|Description|Help|URL|Secondary Actions): /);
        return prefix + (at < 0 ? without + ', Value: ' + value : without.slice(0, at) + ', Value: ' + value + without.slice(at));
      });
      const focus = /^The focused UI element is .+$/m;
      // The recorded failed combo write left focus where it was. Ordinary field writes focus
      // their target; this also reconstructs the r1 intermediate reads' recorded character counts.
      if (focus.test(current)) {
        const previous = /^The focused UI element is (\d+) /m.exec(current)?.[1];
        const focused = actual === number ? number : Number(previous);
        const line = elementLines(current).get(focused);
        if (line) current = current.replace(focus, `The focused UI element is ${focused} ${line}`);
      }
    },
    click: async number => { writes.push({ click: number }); },
  };
  const checks = { bind, ck1, ck2, timing, guardStopMark: '[replay]', literals: numbers,
    seenLines, seenParents: compactor.seenParents(window, numbers), uniqueSeen: compactor.uniqueSeen(window, numbers) };
  const context = { safari: raw, app: raw, cua: { getApp: async () => raw },
    nodeRepl: { write: value => output.push(value) }, setTimeout, clearTimeout, performance };
  let error;
  try {
    // Recorded handles were acquired through the installed cua.getApp wrapper in earlier calls.
    // Acquire through that same wrapper here, so safari and app cannot bypass the guard as raw aliases.
    const source = `safari = await cua.getApp(${JSON.stringify(window.app)}); app = safari;\n` + (remapped?.code ?? code);
    await runInNewContext(`(async () => { ${guardedCode(source, window, undefined, undefined, checks)} })()`, context);
  } catch (caught) { error = caught; }
  const result = compactor.process([{ type: 'text', text: current }], { action, failed: !!error });
  return { writes, dispatches, output, current, error, remapped, seenLines, reads, result, effects: action?.writeEffects ?? [] };
}

export async function main() {
  for (const recording of recordings) {
    const result = await replay(recording);
    if (result.error) throw result.error;
    const last = result.dispatches.at(-1);
    if (last.number !== 26 || last.actual !== 53) throw new Error('unexpected replay dispatch');
    console.log(`${recording.id}: model=26; relay stale remap=${result.remapped ? 'yes' : 'none'}; guard dispatch=${last.number}; effect=${last.actual}; chose 53=${last.chosenBy}`);
  }
  console.log('3/3 recorded effects reproduced under the modeled engine fault. Original engine target is unproved: retained wire code is truncated.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
