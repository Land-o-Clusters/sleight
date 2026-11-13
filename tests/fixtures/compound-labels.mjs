import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { consequentialLabels } from '../../plugins/sleight/lib/mac-driver/diff.mjs';

// Read RT11J's literal examples as data. Importing that test would run it twice.
const source = ts.createSourceFile('labels.mjs', readFileSync(new URL('../mac-driver-diff-labels.test.mjs', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const literals = node => ts.isArrayLiteralExpression(node) ? node.elements.filter(ts.isStringLiteralLike).map(s => s.text) : [];
export const sharedTableLabels = Object.values(consequentialLabels).flatMap(words => words.split('|'));
export const rt11jLabels = [];
for (const statement of source.statements) {
  if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.getText(source) === 'families') for (const pair of declaration.initializer.elements)
      rt11jLabels.push(...pair.elements[1].text.split('|'));
  }
  if (ts.isForOfStatement(statement)) {
    const variable = statement.initializer.declarations?.[0]?.name.getText(source);
    if (variable === 'label') rt11jLabels.push(...literals(statement.expression));
    if (variable === 'target') for (const body of literals(statement.expression)) {
      // RT11J deliberately excludes IDs, URLs, Help, field values and link values
      // from action labels. The compound classifier tests their shown title.
      rt11jLabels.push(body.replace(/^(?:button|heading|text field|text|link)(?: \(settable\))? ?/, '').split(', ')[0]
        .replace(/^(?:Value|ID):.*$/, ''));
    }
  }
}
export const compoundParityLabels = [...sharedTableLabels, ...rt11jLabels];
