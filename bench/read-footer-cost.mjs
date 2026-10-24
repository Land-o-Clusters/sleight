// Offline footer measurement. Outputs fixture text and the default-path addition for a local tokenizer.
// No model, app, browser, transcript evaluation or authentication is involved.
import { readFileSync } from 'node:fs';
import { resultCompleteness, readCompleteness } from '../plugins/sleight/lib/read-completeness.mjs';
import { isMainModule } from '../plugins/sleight/lib/main-module.mjs';

export function footerFixtures() {
  const rows = [];
  const engine = (name, before, options = {}) => {
    const footer = resultCompleteness([{ type: 'text', text: before }], { requested: true, ...options });
    rows.push({ name, before, addition: footer ? '\n' + footer : '' });
  };
  for (const name of ['calculator-tree.txt', 'mdn-418-tree.txt'])
    engine(name, readFileSync(new URL('../tests/fixtures/' + name, import.meta.url), 'utf8'));
  for (const [index, row] of JSON.parse(readFileSync(new URL('../tests/fixtures/browser-open-real-trees.json', import.meta.url))).entries())
    engine('browser-open-real-trees.json:' + index, row.tree);
  for (const [name, before] of [['getState inventory', 'Apps:\n- Fixture'], ['boolean', 'true'], ['number', '42'], ['JSON object', '{"ok":true,"count":2}']])
    engine(name, before);
  engine('engine changes', 'The following is a diff from the previous accessibility tree for Window: "Guide"\n+ \t9 button New');
  engine('engine omissions', 'Window: "Guide", App: Fixture.\n0 window Guide\nsleight: 10 tree lines omitted.');
  // These scopes match honest-results.real.test.mjs. The footer is charged once, as delivered by browser_read.
  for (const [name, options] of [
    ['plain list', {}], ['scrolling list', { renderedUnknown: true }], ['declared virtual rows', { omitted: 146 }],
    ['closed root', { closed: true }], ['delta', { changesOnly: true }], ['filtered continuation', { filtered: true }],
    ['cut continuation', { cut: 1000, ref: 'more1_0' }],
  ]) rows.push({ name: 'turbo ' + name, before: '# Snapshot 1 (untrusted page content)\n- button "Fixture" [ref=e1]',
    addition: '\n# ' + readCompleteness(options) });
  return rows;
}

if (isMainModule(import.meta.url)) process.stdout.write(JSON.stringify(footerFixtures(), null, 2) + '\n');
